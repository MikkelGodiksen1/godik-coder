import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * GODIK CODER — Mentor-ordre, end to end: the REAL app sidecar daemon over
 * HTTP with a scripted OpenAI-compatible model. An order stored with POST
 * /mentor/order fires ONE Autopilot-cycle review when GC's run ends (or right
 * away when GC is idle with a finished turn), sends at most one prompt through
 * autopilot_prompted, and is used up. Risky orders hold without host-observed
 * passing tests. Autopilot itself stays OFF in every scenario.
 *
 * Main agent script: RUN_TESTS runs `npm test` (a real script that exits 0),
 * SLOW answers after a delay, anything else answers "Done.". Autopilot Ken is
 * recognised by his verdict-only system prompt and answers `kenVerdict`.
 */
const SIDECAR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "app-sidecar.js",
);

const KEN_MARKER = "Autopilot mode: verdict only";
const ORDER_HEADING = "## The user's order for this review";

interface SidecarEvent {
  type: string;
  data: Record<string, unknown>;
}

type Daemon = ChildProcessByStdio<null, Readable, Readable>;

let tmpHome: string;
let tmpProject: string;
let daemon: Daemon | undefined;
let daemonPort = 0;
let token = "";
let modelServer: http.Server | undefined;
let kenVerdict = "";
/** The user-message text of every Autopilot-Ken review call. */
const kenReviews: string[] = [];
const openStreams: http.IncomingMessage[] = [];

// ── Scripted model server ───────────────────────────────────────────────────

interface ChatRequest {
  stream?: boolean;
  messages?: { role?: string; content?: unknown }[];
  tools?: { function?: { name?: string } }[];
}

type Reply = { text: string } | { tool: string; args: Record<string, unknown> };

function scriptedReply(body: ChatRequest): Reply {
  const messages = body.messages ?? [];
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => JSON.stringify(m.content))
    .join("\n");
  const last = messages.at(-1);
  const said = JSON.stringify(last?.content ?? "");
  if (system.includes(KEN_MARKER)) {
    kenReviews.push(said);
    return { text: kenVerdict };
  }
  const isMainAgent = (body.tools ?? []).some((t) =>
    ["ask_user", "tool_search", "exit_plan"].includes(t.function?.name ?? ""),
  );
  if (!isMainAgent || last?.role !== "user") return { text: "Done." };
  if (said.includes("RUN_TESTS")) return { tool: "bash", args: { command: "npm test" } };
  return { text: "Done." };
}

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "deepseek-v4-pro",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function writeStreamed(res: http.ServerResponse, reply: Reply): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  if ("text" in reply) {
    res.write(chunk({ role: "assistant", content: reply.text }, null));
    res.write(chunk({}, "stop"));
  } else {
    const call = {
      index: 0,
      id: `call_${reply.tool}`,
      type: "function",
      function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
    };
    res.write(chunk({ role: "assistant", tool_calls: [call] }, null));
    res.write(chunk({}, "tool_calls"));
  }
  res.write(
    `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 0, model: "deepseek-v4-pro", choices: [], usage: USAGE })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}

function writeWhole(res: http.ServerResponse, reply: Reply): void {
  const message =
    "text" in reply
      ? { role: "assistant", content: reply.text }
      : {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_${reply.tool}`,
              type: "function",
              function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
            },
          ],
        };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: "deepseek-v4-pro",
      choices: [{ index: 0, message, finish_reason: "text" in reply ? "stop" : "tool_calls" }],
      usage: USAGE,
    }),
  );
}

async function startModelServer(): Promise<number> {
  modelServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as ChatRequest;
      const reply = scriptedReply(body);
      const lastSaid = JSON.stringify(body.messages?.at(-1)?.content ?? "");
      const send = (): void => {
        if (body.stream === false) writeWhole(res, reply);
        else writeStreamed(res, reply);
      };
      if (lastSaid.includes("SLOW") && body.messages?.at(-1)?.role === "user") {
        setTimeout(send, slowMs);
      } else send();
    });
  });
  await new Promise<void>((resolve) => modelServer?.listen(0, "127.0.0.1", resolve));
  return (modelServer.address() as AddressInfo).port;
}

// ── Daemon + HTTP helpers ───────────────────────────────────────────────────

async function startDaemon(): Promise<void> {
  const running = spawn(process.execPath, [SIDECAR], {
    cwd: tmpProject,
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      GG_APP_CWD: tmpProject,
      GG_APP_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon = running;
  daemonPort = await new Promise<number>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`daemon never listened: ${out}`)), 60_000);
    running.stdout.on("data", (data) => {
      out += data;
      const match = /GG_APP_LISTENING (\d+) (\S+)/.exec(out);
      if (match?.[1] && match[2]) {
        clearTimeout(timer);
        token = match[2];
        resolve(Number(match[1]));
      }
    });
    running.on("error", reject);
    running.on("exit", (code) => reject(new Error(`daemon exited (${code}): ${out}`)));
  });
}

function request(
  method: string,
  urlPath: string,
  opts: { session?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: daemonPort,
        path: urlPath,
        method,
        headers: {
          "x-gg-token": token,
          ...(payload ? { "content-type": "application/json" } : {}),
          ...(opts.session ? { "x-gg-session": opts.session } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => {
          raw += c;
        });
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          } catch {
            // Non-JSON bodies are only checked by status.
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function openEventStream(session: string): Promise<SidecarEvent[]> {
  return new Promise((resolve, reject) => {
    const events: SidecarEvent[] = [];
    const req = http.request(
      {
        host: "127.0.0.1",
        port: daemonPort,
        path: `/events?session=${session}`,
        method: "GET",
        headers: { "x-gg-token": token },
      },
      (res) => {
        openStreams.push(res);
        let buf = "";
        res.on("data", (data) => {
          buf += data;
          let split = buf.indexOf("\n\n");
          while (split !== -1) {
            const frame = buf.slice(0, split);
            buf = buf.slice(split + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                events.push(JSON.parse(line.slice(6)) as SidecarEvent);
              } catch {
                // Keepalives are not events.
              }
            }
            split = buf.indexOf("\n\n");
          }
        });
        resolve(events);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const count = (events: SidecarEvent[], type: string): number =>
  events.filter((e) => e.type === type).length;

/** One window: a code session plus its event stream. */
async function openWindow(): Promise<{ session: string; events: SidecarEvent[] }> {
  const created = await request("POST", "/session", { body: { mode: "code", cwd: tmpProject } });
  expect(created.status).toBe(200);
  const session = created.json.sessionId as string;
  const events = await openEventStream(session);
  await waitFor(() => count(events, "ready") > 0, "ready");
  return { session, events };
}

let slowMs = 2_500;

async function order(session: string, text: string): Promise<Record<string, unknown>> {
  const res = await request("POST", "/mentor/order", { session, body: { text } });
  expect(res.status).toBe(200);
  return res.json;
}

/** Send a prompt and wait for its run to end. */
async function promptAndSettle(window: Window, text: string): Promise<void> {
  const ends = count(window.events, "run_end");
  const res = await request("POST", "/prompt", { session: window.session, body: { text } });
  expect(res.status).toBeLessThan(300);
  await waitFor(() => count(window.events, "run_end") > ends, `run_end after "${text}"`);
}

const results = (events: SidecarEvent[]) =>
  events.filter((e) => e.type === "mentor_order_result").map((e) => e.data);

interface HistoryRow {
  role: string;
  text: string;
  mentorOrder?: { id: string; text: string; status: string; reason?: string };
}

async function historyOrders(session: string): Promise<NonNullable<HistoryRow["mentorOrder"]>[]> {
  const res = await request("GET", "/history", { session });
  expect(res.status).toBe(200);
  return (res.json.history as HistoryRow[]).flatMap((h) => (h.mentorOrder ? [h.mentorOrder] : []));
}

/** No further events of `type` show up within a short grace period. */
async function settleQuietly(): Promise<void> {
  await new Promise((r) => setTimeout(r, 1_500));
}

type Window = { session: string; events: SidecarEvent[] };

// ── Lifecycle ───────────────────────────────────────────────────────────────

beforeEach(async () => {
  kenReviews.length = 0;
  slowMs = 2_500;
  kenVerdict = "PROMPT\nAdd the line ORDER_DONE to README.md.";
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-order-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-order-project-"));
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.mkdir(path.join(tmpProject, "src"), { recursive: true });
  // A real test script, so a turn can produce host-observed test evidence.
  await fs.writeFile(
    path.join(tmpProject, "package.json"),
    JSON.stringify({ name: "order-fixture", private: true, scripts: { test: "node ok.js" } }),
  );
  await fs.writeFile(path.join(tmpProject, "ok.js"), "process.exit(0);\n");
  const modelPort = await startModelServer();
  await fs.writeFile(
    path.join(tmpHome, ".gg", "auth.json"),
    JSON.stringify({
      deepseek: {
        accessToken: "sk-test",
        refreshToken: "",
        expiresAt: Date.now() + 1_000_000_000,
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
      },
    }),
  );
  await fs.writeFile(
    path.join(tmpHome, ".gg", "settings.json"),
    JSON.stringify({ provider: "deepseek", model: "deepseek-v4-pro", autoCompact: false }),
  );
  await startDaemon();
});

afterEach(async () => {
  for (const stream of openStreams.splice(0)) stream.destroy();
  const runningDaemon = daemon;
  daemon = undefined;
  if (runningDaemon && runningDaemon.exitCode === null && runningDaemon.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      runningDaemon.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      runningDaemon.kill("SIGKILL");
    });
  }
  const server = modelServer;
  modelServer = undefined;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const removeOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };
  await fs.rm(tmpHome, removeOptions);
  await fs.rm(tmpProject, removeOptions);
});

// ── Scenarios ───────────────────────────────────────────────────────────────

const fired = (w: Window) => count(w.events, "mentor_order_fired");
const prompted = (w: Window) => count(w.events, "autopilot_prompted");

/** Wait until the order's result frame arrives, then until GC is idle again. */
async function waitForResult(w: Window, n = 1): Promise<void> {
  await waitFor(() => results(w.events).length >= n, "mentor_order_result");
  await waitFor(
    () => count(w.events, "run_end") >= count(w.events, "run_start"),
    "GC idle after the order",
  );
}

describe("Mentor-ordre (real daemon, Autopilot off)", () => {
  it("an order given while GC runs fires once when the run ends, sends exactly one prompt, and is used up", async () => {
    const w = await openWindow();
    const ends = count(w.events, "run_end");
    const res = await request("POST", "/prompt", {
      session: w.session,
      body: { text: "SLOW work" },
    });
    expect(res.status).toBeLessThan(300);
    await waitFor(() => count(w.events, "run_start") > 0, "run_start");

    const stored = (await order(w.session, "add a README line saying ORDER_DONE")).order as {
      id: string;
    };
    await waitFor(() => count(w.events, "mentor_order") > 0, "mentor_order");
    expect(count(w.events, "mentor_order")).toBe(1);
    // Nothing fires while GC is still running.
    expect(fired(w)).toBe(0);
    expect(kenReviews).toHaveLength(0);

    await waitFor(() => count(w.events, "run_end") > ends, "run_end");
    await waitForResult(w);

    expect(fired(w)).toBe(1);
    expect(kenReviews).toHaveLength(1);
    expect(kenReviews[0]).toContain(ORDER_HEADING);
    expect(kenReviews[0]).toContain("ORDER_DONE");
    expect(prompted(w)).toBe(1);
    expect(results(w.events)).toEqual([
      expect.objectContaining({ id: stored.id, outcome: "prompted" }),
    ]);
    // GC ran the one prompt through the usual Autopilot path.
    const injected = w.events.find((e) => e.type === "autopilot_prompted");
    expect(String(injected?.data.body)).toContain("ORDER_DONE");

    // Used up: the next turn fires nothing and Autopilot stays off.
    await promptAndSettle(w, "thanks");
    await settleQuietly();
    expect(fired(w)).toBe(1);
    expect(kenReviews).toHaveLength(1);
    expect(prompted(w)).toBe(1);
    const snapshot = await request("GET", "/mentor/order", { session: w.session });
    expect(snapshot.json.pending).toBeNull();

    // The outcome survives a reload (GET /history).
    expect(await historyOrders(w.session)).toEqual([
      expect.objectContaining({ id: stored.id, status: "prompted" }),
    ]);
  }, 120_000);

  it("GC idle with a finished turn: the order reviews that turn right away", async () => {
    const w = await openWindow();
    await promptAndSettle(w, "hello");
    kenVerdict = "ALL_CLEAR";
    await order(w.session, "check that the greeting went out");
    await waitForResult(w);
    expect(kenReviews).toHaveLength(1);
    expect(prompted(w)).toBe(0);
    expect(results(w.events)).toEqual([expect.objectContaining({ outcome: "done" })]);
    expect(await historyOrders(w.session)).toEqual([expect.objectContaining({ status: "done" })]);
  }, 120_000);

  it("no finished turn yet: the order waits for GC's first run", async () => {
    const w = await openWindow();
    await order(w.session, "add a README line saying ORDER_DONE");
    await settleQuietly();
    expect(fired(w)).toBe(0);
    await promptAndSettle(w, "hello");
    await waitForResult(w);
    expect(fired(w)).toBe(1);
    expect(prompted(w)).toBe(1);
  }, 120_000);

  it("a risky order without host-observed passing tests holds, explains, and prompts nothing", async () => {
    const w = await openWindow();
    // GC only CLAIMS the tests pass; the host saw no test run.
    await promptAndSettle(w, "hello, all tests pass");
    await order(w.session, "sæt det live på vercel");
    await waitForResult(w);
    expect(kenReviews).toHaveLength(0);
    expect(prompted(w)).toBe(0);
    const [result] = results(w.events);
    expect(result?.outcome).toBe("held");
    expect(String(result?.reason)).toMatch(/test/i);
    const [row] = await historyOrders(w.session);
    expect(row?.status).toBe("held");
    expect(String(row?.reason)).toMatch(/test/i);
  }, 120_000);

  it("a risky order after a turn with a host-observed passing test run goes through", async () => {
    const w = await openWindow();
    await promptAndSettle(w, "RUN_TESTS");
    await order(w.session, "deploy it");
    await waitForResult(w);
    expect(kenReviews).toHaveLength(1);
    expect(kenReviews[0]).toContain("deploy it");
    expect(prompted(w)).toBe(1);
    expect(results(w.events)).toEqual([expect.objectContaining({ outcome: "prompted" })]);
  }, 120_000);

  it("Stop clears a pending order; it never fires", async () => {
    const w = await openWindow();
    await request("POST", "/prompt", { session: w.session, body: { text: "SLOW work" } });
    await waitFor(() => count(w.events, "run_start") > 0, "run_start");
    await order(w.session, "add a README line saying ORDER_DONE");
    const cancelled = await request("POST", "/cancel", { session: w.session });
    expect(cancelled.status).toBeLessThan(300);
    await waitFor(() => count(w.events, "mentor_order_cleared") > 0, "order cleared");
    expect(w.events.find((e) => e.type === "mentor_order_cleared")?.data.reason).toBe("stopped");
    await waitFor(() => count(w.events, "run_end") > 0, "run_end");
    await settleQuietly();
    expect(fired(w)).toBe(0);
    expect(kenReviews).toHaveLength(0);
  }, 120_000);

  it("empty text cancels a pending order", async () => {
    const w = await openWindow();
    await request("POST", "/prompt", { session: w.session, body: { text: "SLOW work" } });
    await waitFor(() => count(w.events, "run_start") > 0, "run_start");
    await order(w.session, "add a README line saying ORDER_DONE");
    const cleared = await order(w.session, "");
    expect(cleared.cleared).toEqual(expect.any(String));
    await waitFor(() => count(w.events, "mentor_order_cleared") > 0, "order cleared");
    expect(w.events.find((e) => e.type === "mentor_order_cleared")?.data.reason).toBe("cancelled");
    await waitFor(() => count(w.events, "run_end") > 0, "run_end");
    await settleQuietly();
    expect(fired(w)).toBe(0);
  }, 120_000);

  it("a pending order lost to a sidecar restart says so after reload", async () => {
    slowMs = 20_000;
    const created = await request("POST", "/session", { body: { mode: "code", cwd: tmpProject } });
    const session = created.json.sessionId as string;
    const events = await openEventStream(session);
    await waitFor(() => count(events, "ready") > 0, "ready");
    const w = { session, events };
    await promptAndSettle(w, "hello");
    const sessionPath = (await request("GET", "/state", { session })).json.sessionPath as
      string | undefined;
    const file = sessionPath ?? (created.json.sessionPath as string);
    expect(typeof file).toBe("string");

    await request("POST", "/prompt", { session, body: { text: "SLOW work" } });
    await waitFor(() => count(events, "run_start") > 1, "second run_start");
    await order(session, "add a README line saying ORDER_DONE");
    const deadline = Date.now() + 10_000;
    while (!(await fs.readFile(file, "utf-8")).includes('"mentor_order"')) {
      if (Date.now() > deadline) throw new Error("order marker never persisted");
      await new Promise((r) => setTimeout(r, 50));
    }

    // Kill the daemon mid-run, then reopen the same conversation.
    for (const stream of openStreams.splice(0)) stream.destroy();
    const old = daemon;
    daemon = undefined;
    await new Promise<void>((resolve) => {
      old?.once("close", () => resolve());
      old?.kill("SIGKILL");
    });
    await startDaemon();
    const reopened = await request("POST", "/session", {
      body: { mode: "code", cwd: tmpProject, sessionPath: file },
    });
    expect(reopened.status).toBe(200);
    const rows = await historyOrders(reopened.json.sessionId as string);
    expect(rows).toEqual([
      expect.objectContaining({ text: "add a README line saying ORDER_DONE", status: "lost" }),
    ]);
  }, 120_000);
});
