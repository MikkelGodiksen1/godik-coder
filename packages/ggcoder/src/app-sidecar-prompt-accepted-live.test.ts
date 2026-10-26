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
 * `prompt_accepted`, end to end: the REAL app sidecar daemon (built
 * dist/app-sidecar.js) in an empty temp HOME on a random port, driven over
 * HTTP like gg-bridge drives it from the glasses, with its real SSE stream as
 * the window. The model is a scripted OpenAI-compatible server on 127.0.0.1,
 * so no real model is ever called. It answers "Done." at once, except a prompt
 * containing HOLD_IT, whose answer waits until the test releases it (that is
 * how a second prompt lands while a run is in flight and queues).
 *
 * After each scenario the test reads GET /history, the exact payload a window
 * reload (App remount -> agent_history) rebuilds its transcript from.
 */
const SIDECAR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "app-sidecar.js",
);

interface SidecarEvent {
  type: string;
  data: Record<string, unknown>;
}

interface HistoryRow {
  role: string;
  text: string;
  kenSent?: boolean;
  [key: string]: unknown;
}

type Daemon = ChildProcessByStdio<null, Readable, Readable>;

let tmpHome: string;
let tmpProject: string;
let daemon: Daemon | undefined;
let daemonPort = 0;
let token = "";
let modelServer: http.Server | undefined;
let releaseHeld: (() => void) | null = null;
let heldRequests = 0;
const openStreams: http.IncomingMessage[] = [];

// ── Scripted model server (no real model) ───────────────────────────────────

interface ChatRequest {
  stream?: boolean;
  messages?: { role?: string; content?: unknown }[];
}

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "deepseek-v4-pro",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function writeReply(res: http.ServerResponse, body: ChatRequest, text: string): void {
  if (body.stream === false) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "deepseek-v4-pro",
        choices: [
          { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
        ],
        usage: USAGE,
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(chunk({ role: "assistant", content: text }, null));
  res.write(chunk({}, "stop"));
  res.write(
    `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 0, model: "deepseek-v4-pro", choices: [], usage: USAGE })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
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
      const last = body.messages?.at(-1);
      const said = last?.role === "user" ? JSON.stringify(last.content) : "";
      if (said.includes("HOLD_IT") && releaseHeld === null) {
        heldRequests++;
        new Promise<void>((resolve) => (releaseHeld = resolve)).then(
          () => writeReply(res, body, "Done."),
          () => {},
        );
        return;
      }
      writeReply(res, body, "Done.");
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

/** Index of the last event of `type` (-1 if none). */
function lastIndexOfType(events: SidecarEvent[], type: string): number {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]?.type === type) return i;
  return -1;
}

const lastOfType = (events: SidecarEvent[], type: string): SidecarEvent | undefined =>
  events[lastIndexOfType(events, type)];

const accepted = (events: SidecarEvent[], id: string): SidecarEvent[] =>
  events.filter((e) => e.type === "prompt_accepted" && e.data.id === id);

/** One window: a code session plus its event stream. */
async function openWindow(): Promise<{ session: string; events: SidecarEvent[] }> {
  const created = await request("POST", "/session", { body: { mode: "code", cwd: tmpProject } });
  expect(created.status).toBe(200);
  const session = created.json.sessionId as string;
  const events = await openEventStream(session);
  await waitFor(() => count(events, "ready") > 0, "ready");
  return { session, events };
}

/** The user rows a reload rebuilds the transcript from (GET /history). */
async function historyUsers(session: string): Promise<HistoryRow[]> {
  const res = await request("GET", "/history", { session });
  expect(res.status).toBe(200);
  return (res.json.history as HistoryRow[]).filter((h) => h.role === "user");
}

/** POST /prompt as another client would (gg-bridge on the glasses). */
async function post(session: string, text: string, meta?: Record<string, unknown>) {
  const res = await request("POST", "/prompt", {
    session,
    body: meta ? { text, meta } : { text },
  });
  expect(res.status).toBe(202);
  return res.json;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

beforeEach(async () => {
  releaseHeld = null;
  heldRequests = 0;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-accepted-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-accepted-project-"));
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
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
  releaseHeld?.();
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

describe("prompt_accepted (real daemon, real event stream)", () => {
  it("a Ken-sent prompt from another client: id, text, kenSent, before run_start; reload keeps one Sent row", async () => {
    const window = await openWindow();
    const from = window.events.length;
    const ends = count(window.events, "run_end");
    await post(window.session, "Add a retry to the upload", {
      kenSent: true,
      promptId: "glasses-1",
    });
    await waitFor(() => count(window.events, "run_end") > ends, "run_end");

    const live = window.events.slice(from);
    const announced = accepted(live, "glasses-1");
    expect(announced).toHaveLength(1);
    expect(announced[0]?.data).toEqual({
      id: "glasses-1",
      text: "Add a retry to the upload",
      kenSent: true,
      queued: false,
      attachments: 0,
    });
    const acceptedAt = live.indexOf(announced[0] as SidecarEvent);
    const runStartAt = live.findIndex((e) => e.type === "run_start");
    expect(runStartAt).toBeGreaterThan(acceptedAt);

    // What a reload rebuilds from: one user row, still Ken-sent.
    expect(await historyUsers(window.session)).toEqual([
      expect.objectContaining({ role: "user", text: "Add a retry to the upload", kenSent: true }),
    ]);
  });

  it("a plain prompt from another client: no kenSent, a fresh id, before run_start; reload has one plain row", async () => {
    const window = await openWindow();
    const from = window.events.length;
    const ends = count(window.events, "run_end");
    await post(window.session, "Run the tests");
    await waitFor(() => count(window.events, "run_end") > ends, "run_end");

    const live = window.events.slice(from);
    const announced = live.filter((e) => e.type === "prompt_accepted");
    expect(announced).toHaveLength(1);
    const data = announced[0]?.data ?? {};
    expect(typeof data.id).toBe("string");
    expect((data.id as string).length).toBeGreaterThan(0);
    expect(data).toMatchObject({ text: "Run the tests", queued: false, attachments: 0 });
    expect(data).not.toHaveProperty("kenSent");
    expect(live.findIndex((e) => e.type === "run_start")).toBeGreaterThan(
      live.indexOf(announced[0] as SidecarEvent),
    );

    const users = await historyUsers(window.session);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ role: "user", text: "Run the tests" });
    expect(users[0]).not.toHaveProperty("kenSent");
  });

  it("a Ken-sent prompt sent while a run is in flight: announced once as queued, before the queue snapshot; reload has one row each", async () => {
    const window = await openWindow();
    const ends = count(window.events, "run_end");
    await post(window.session, "HOLD_IT first task");
    await waitFor(() => heldRequests > 0, "the first run to reach the model");

    const from = window.events.length;
    const reply = await post(window.session, "Add a retry to the upload", {
      kenSent: true,
      promptId: "glasses-2",
    });
    expect(reply).toMatchObject({ queued: true });
    await waitFor(() => accepted(window.events, "glasses-2").length > 0, "prompt_accepted");
    await waitFor(
      () => window.events.slice(from).some((e) => e.type === "queued"),
      "queued snapshot",
    );

    const live = window.events.slice(from);
    const announced = accepted(live, "glasses-2");
    expect(announced).toHaveLength(1);
    expect(announced[0]?.data).toEqual({
      id: "glasses-2",
      text: "Add a retry to the upload",
      kenSent: true,
      queued: true,
      attachments: 0,
    });
    const snapshotAt = live.findIndex(
      (e) =>
        e.type === "queued" &&
        JSON.stringify(e.data.messages ?? []).includes("Add a retry to the upload"),
    );
    expect(snapshotAt).toBeGreaterThan(live.indexOf(announced[0] as SidecarEvent));

    releaseHeld?.();
    // Settled: the queue is empty and the last run that started has ended
    // (the queued prompt drains as steering or as its own turn).
    await waitFor(() => {
      const lastStart = lastIndexOfType(window.events, "run_start");
      const lastEnd = lastIndexOfType(window.events, "run_end");
      const lastQueue = lastOfType(window.events, "queued");
      return (
        count(window.events, "run_end") > ends && lastEnd > lastStart && lastQueue?.data.count === 0
      );
    }, "every run to settle");
    // A drain that starts its own turn does so right after; let it finish too.
    await new Promise((r) => setTimeout(r, 500));
    await waitFor(
      () => lastIndexOfType(window.events, "run_end") > lastIndexOfType(window.events, "run_start"),
      "the drained turn to settle",
    );
    // Draining the queue never announces it a second time.
    expect(accepted(window.events, "glasses-2")).toHaveLength(1);
    // The last queue snapshot is empty, so no queued row is left hanging.
    const lastQueued = lastOfType(window.events, "queued");
    expect(lastQueued?.data.count).toBe(0);

    // Reload: exactly one row per prompt, in order.
    const users = await historyUsers(window.session);
    expect(users.map((u) => u.text)).toEqual(["HOLD_IT first task", "Add a retry to the upload"]);
  });
});
