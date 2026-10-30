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
 * GODIK CODER — Autopilot rule suggestions (v2), end to end: the REAL app
 * sidecar daemon over HTTP, talking to a scripted OpenAI-compatible model.
 * The hook lives in the daemon's settle-point wiring (HUMAN stop → the user's
 * next reply → one Ken call → a card → Save appends), which unit tests of the
 * pure parts cannot see.
 *
 * The scripted main agent writes a code file on EDIT_IT (unverified work, so
 * Autopilot stops with HUMAN) and answers everything else with plain text.
 * Autopilot Ken is recognised by his verdict-only system prompt; the rule
 * suggestion call by its "## Rule suggestion" heading.
 */
const SIDECAR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "app-sidecar.js",
);

const KEN_MARKER = "Autopilot mode: verdict only";
const SUGGESTION_MARKER = "## Rule suggestion";
const RULE = "if the tests have not run, send: run the tests and fix what fails";
const RULES_FILE = () => path.join(tmpProject, ".gg", "autopilot-rules.md");

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
let kenSuggestion = `RULE: ${RULE}`;
let suggestionCalls = 0;
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
    if (said.includes(SUGGESTION_MARKER)) {
      suggestionCalls++;
      return { text: kenSuggestion };
    }
    return { text: "HUMAN\nOver to you." };
  }
  const isMainAgent = (body.tools ?? []).some((t) =>
    ["ask_user", "tool_search", "exit_plan"].includes(t.function?.name ?? ""),
  );
  if (!isMainAgent || last?.role !== "user") return { text: "Done." };
  if (said.includes("EDIT_IT")) {
    return {
      tool: "write",
      args: { file_path: "src/helper.ts", content: "export const helper = 1;\n" },
    };
  }
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
      if (body.stream === false) writeWhole(res, reply);
      else writeStreamed(res, reply);
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

async function setAutopilot(session: string, enabled: boolean): Promise<void> {
  const res = await request("POST", "/autopilot", { session, body: { enabled } });
  expect(res.status).toBe(200);
}

/** Send a prompt and wait for its run (and the hand-off after it) to settle. */
async function promptAndSettle(
  window: { session: string; events: SidecarEvent[] },
  text: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const ends = count(window.events, "run_end");
  const res = await request("POST", "/prompt", {
    session: window.session,
    body: meta ? { text, meta } : { text },
  });
  expect(res.status).toBeLessThan(300);
  await waitFor(() => count(window.events, "run_end") > ends, `run_end after "${text}"`);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

beforeEach(async () => {
  kenSuggestion = `RULE: ${RULE}`;
  suggestionCalls = 0;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-rules-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-rules-project-"));
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.mkdir(path.join(tmpProject, "src"), { recursive: true });
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

type Window = { session: string; events: SidecarEvent[] };

/** Autopilot on, EDIT_IT leaves unverified work, so the cycle stops with HUMAN. */
async function stopForHuman(): Promise<Window> {
  const window = await openWindow();
  await setAutopilot(window.session, true);
  await promptAndSettle(window, "EDIT_IT please");
  await waitFor(() => count(window.events, "autopilot_human") > 0, "autopilot_human");
  return window;
}

/** Reply to the stop and wait until the turn has passed the suggestion point
 *  (the gate's skip frame comes right after it). */
async function reply(window: Window, text: string): Promise<void> {
  const ignored = count(window.events, "autopilot_ignored");
  await promptAndSettle(window, text);
  await waitFor(() => count(window.events, "autopilot_ignored") > ignored, "gate after reply");
}

async function rulesFileExists(): Promise<boolean> {
  return fs.access(RULES_FILE()).then(
    () => true,
    () => false,
  );
}

describe("Autopilot rule suggestions (real daemon)", () => {
  it("a reply to a HUMAN stop offers one rule; Save appends exactly one line, once", async () => {
    const window = await stopForHuman();
    await reply(window, "just run the tests yourself next time");

    expect(suggestionCalls).toBe(1);
    const offered = window.events.filter((e) => e.type === "autopilot_rule_suggestion");
    expect(offered).toHaveLength(1);
    expect(offered[0]?.data.text).toBe(RULE);
    // Nothing is written before the click.
    expect(await rulesFileExists()).toBe(false);

    const id = String(offered[0]?.data.id);
    const saved = await request("POST", "/autopilot/rules/append", {
      session: window.session,
      body: { id, text: RULE },
    });
    expect(saved.status).toBe(200);
    expect(saved.json.line).toBe(`- ${RULE}`);
    expect(await fs.readFile(RULES_FILE(), "utf-8")).toBe(`- ${RULE}\n`);

    const again = await request("POST", "/autopilot/rules/append", {
      session: window.session,
      body: { id, text: RULE },
    });
    expect(again.status).toBe(409);
    expect(await fs.readFile(RULES_FILE(), "utf-8")).toBe(`- ${RULE}\n`);
  }, 120_000);

  it("no prior HUMAN stop: a reply never asks Ken for a rule", async () => {
    const window = await openWindow();
    await setAutopilot(window.session, true);
    await reply(window, "just run the tests yourself next time");
    expect(suggestionCalls).toBe(0);
    expect(count(window.events, "autopilot_rule_suggestion")).toBe(0);
  }, 120_000);

  it("Ken answering NONE offers nothing and writes nothing", async () => {
    kenSuggestion = "NONE";
    const window = await stopForHuman();
    await reply(window, "use the blue one this time");
    expect(suggestionCalls).toBe(1);
    expect(count(window.events, "autopilot_rule_suggestion")).toBe(0);
    expect(await rulesFileExists()).toBe(false);
  }, 120_000);

  it("a new prompt clears the pending suggestion; a late Save is refused and writes nothing", async () => {
    const window = await stopForHuman();
    await reply(window, "just run the tests yourself next time");
    const offered = window.events.find((e) => e.type === "autopilot_rule_suggestion");
    expect(offered).toBeDefined();

    await promptAndSettle(window, "thanks, carry on");
    await waitFor(
      () => count(window.events, "autopilot_rule_suggestion_cleared") > 0,
      "suggestion cleared",
    );
    const late = await request("POST", "/autopilot/rules/append", {
      session: window.session,
      body: { id: String(offered?.data.id), text: RULE },
    });
    expect(late.status).toBe(409);
    expect(await rulesFileExists()).toBe(false);
  }, 120_000);

  it("Stop clears the pending suggestion", async () => {
    const window = await stopForHuman();
    await reply(window, "just run the tests yourself next time");
    expect(count(window.events, "autopilot_rule_suggestion")).toBe(1);

    const cancelled = await request("POST", "/cancel", { session: window.session });
    expect(cancelled.status).toBeLessThan(300);
    await waitFor(
      () => count(window.events, "autopilot_rule_suggestion_cleared") > 0,
      "suggestion cleared",
    );
    expect(await rulesFileExists()).toBe(false);
  }, 120_000);
});
