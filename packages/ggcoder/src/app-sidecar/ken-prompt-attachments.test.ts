import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KEN_TURN_CUSTOM_KIND,
  SessionManager,
  type SessionEntry,
} from "../core/session-manager.js";
import type { SessionRouteContext } from "./route-context.js";

// The digest itself is covered by ken-context tests; here it's a fixed string
// so the test is about what reaches Ken's session.
vi.mock("./ken-context.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildKenContext: vi.fn(async () => "DIGEST"),
}));
vi.mock("../core/goal-board.js", () => ({ buildGoalBoard: vi.fn(async () => "") }));
vi.mock("./keep-awake.js", () => ({ keepAwake: { acquire: () => () => {} } }));

const { handlePromptRoutes } = await import("./prompt-routes.js");

let cwd: string;
let png: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ken-attach-"));
  const buf = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
  png = buf.toString("base64");
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
  vi.clearAllMocks();
});

function fakeKen(model = "claude-sonnet-5-5") {
  const calls: Array<{ text: string; attachments?: Array<Record<string, unknown>> }> = [];
  return {
    calls,
    getState: () => ({ provider: "anthropic", model }),
    prompt: vi.fn(async (text: string) => {
      calls.push({ text });
    }),
    promptWithAttachments: vi.fn(
      async (text: string, attachments: Array<Record<string, unknown>>) => {
        calls.push({ text, attachments });
      },
    ),
    getMessages: () => [{ role: "assistant", content: [{ type: "text", text: "I see it." }] }],
  };
}

function setup(model?: string) {
  const ken = fakeKen(model);
  const persistKenTurn = vi.fn(async () => {});
  const broadcast = vi.fn();
  const broadcastError = vi.fn();
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const ctx = {
    mode: "code",
    cwd,
    gitBranch: "main",
    goal: null,
    paths: { agentDir: path.join(cwd, ".gg-home") },
    kenRunning: false,
    pendingKenModel: null,
    injectedAutopilotPrompts: [],
    session: { persistKenTurn },
    ensureKenSession: vi.fn(async () => ken),
    loadWorkflowCommandSpecs: vi.fn(async () => []),
    trophies: { count: vi.fn(async () => {}) },
    broadcast: vi.fn((type: string, data: unknown) => {
      broadcast(type, data);
      if (type === "ken_run_end") done();
    }),
    broadcastError,
  } as unknown as SessionRouteContext;
  return { ctx, ken, persistKenTurn, broadcastError, finished };
}

function post(ctx: SessionRouteContext, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    let status = 0;
    const res = {
      headersSent: false,
      writeHead(code: number) {
        status = code;
        return this;
      },
      setHeader() {},
      end(payload: string) {
        resolve({ status, body: JSON.parse(payload) as unknown });
      },
    };
    const req = Readable.from([
      Buffer.from(JSON.stringify(body)),
    ]) as unknown as http.IncomingMessage;
    req.headers = {};
    handlePromptRoutes(ctx, req, res as unknown as http.ServerResponse, "/ken/prompt", "POST");
  });
}

const image = () => ({ kind: "image", name: "shot.png", mediaType: "image/png", data: png });

describe("POST /ken/prompt with images", () => {
  it("sends an image-only prompt to Ken with the image part", async () => {
    const { ctx, ken, persistKenTurn, finished } = setup();
    const reply = await post(ctx, { text: "", attachments: [image()] });
    expect(reply.status).toBe(202);
    await finished;

    expect(ken.prompt).not.toHaveBeenCalled();
    expect(ken.calls).toHaveLength(1);
    expect(ken.calls[0]?.text).toBe("DIGEST");
    expect(ken.calls[0]?.attachments).toEqual([
      expect.objectContaining({ kind: "image", mediaType: "image/png" }),
    ]);
    expect(persistKenTurn).toHaveBeenCalledOnce();
  });

  it("sends text plus image, and persists the saved path, never base64", async () => {
    const { ctx, ken, persistKenTurn, finished } = setup();
    const reply = await post(ctx, { text: "what is wrong here?", attachments: [image()] });
    expect(reply.status).toBe(202);
    await finished;

    expect(ken.calls[0]?.attachments?.[0]).toMatchObject({ kind: "image" });
    const [question, answer, paths] = persistKenTurn.mock.calls[0] as unknown as [
      string,
      string,
      string[],
    ];
    expect(question).toBe("what is wrong here?");
    expect(answer).toBe("I see it.");
    expect(paths).toHaveLength(1);
    expect(paths[0]?.startsWith(path.join(cwd, ".gg", "uploads"))).toBe(true);
    await expect(fs.stat(paths[0] as string)).resolves.toBeTruthy();
    expect(JSON.stringify(persistKenTurn.mock.calls)).not.toContain(png);
  });

  it("keeps a text-only prompt on the plain path", async () => {
    const { ctx, ken, persistKenTurn, finished } = setup();
    await post(ctx, { text: "is this plan sound?" });
    await finished;
    expect(ken.prompt).toHaveBeenCalledWith("DIGEST");
    expect(ken.promptWithAttachments).not.toHaveBeenCalled();
    expect(persistKenTurn).toHaveBeenCalledWith("is this plan sound?", "I see it.", []);
  });

  it("refuses an image when Ken's model can't see images", async () => {
    const { ctx, ken, persistKenTurn, broadcastError } = setup("glm-5.3");
    const reply = await post(ctx, { text: "look", attachments: [image()] });
    expect(reply.status).toBe(400);
    expect((reply.body as { error: string }).error).toContain("can't see images");
    expect(broadcastError).toHaveBeenCalledWith(
      "ken_error",
      "ken image refused",
      expect.any(Error),
    );
    expect(ken.calls).toHaveLength(0);
    expect(persistKenTurn).not.toHaveBeenCalled();
  });

  it("refuses non-image attachments", async () => {
    const { ctx, ken } = setup();
    const reply = await post(ctx, {
      text: "read this",
      attachments: [{ kind: "file", name: "a.txt", mediaType: "text/plain", data: "aGk=" }],
    });
    expect(reply.status).toBe(400);
    expect(ken.calls).toHaveLength(0);
  });
});

describe("Ken turn attachments on disk", () => {
  const manager = new SessionManager("/unused");
  const entry = (id: string, data: Record<string, unknown>): SessionEntry =>
    ({
      type: "custom",
      kind: KEN_TURN_CUSTOM_KIND,
      id,
      parentId: null,
      timestamp: "2026-10-25T12:00:00.000Z",
      data,
    }) as SessionEntry;

  it("reads saved paths, and still loads old turns without them", () => {
    const turns = manager.getKenTurns(
      [
        entry("old", { version: 1, question: "q1", reply: "r1", afterMessageCount: 0 }),
        entry("new", {
          version: 1,
          question: "",
          reply: "r2",
          afterMessageCount: 0,
          attachments: ["/p/.gg/uploads/x-shot.png"],
        }),
      ],
      null,
    );
    expect(turns).toHaveLength(2);
    expect(turns[0]).not.toHaveProperty("attachments");
    expect(turns[1]?.attachments).toEqual(["/p/.gg/uploads/x-shot.png"]);
  });
});
