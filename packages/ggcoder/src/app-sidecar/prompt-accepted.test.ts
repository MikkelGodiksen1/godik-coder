import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRouteContext } from "./route-context.js";
import type { AutopilotRunnerContext } from "./autopilot-runner.js";

// Autopilot's loop is covered by autopilot-cycle tests; here it just injects
// one Ken prompt and one plan implementation, so the test is about which
// events those injected runs broadcast.
vi.mock("../core/autopilot-cycle.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  driveAutopilotCycle: vi.fn(
    async (deps: {
      onInjected: (body: string, round: number) => void;
      runPrompt: (body: string) => Promise<void>;
      runImplement: () => Promise<void>;
    }) => {
      deps.onInjected("Fix the failing test", 1);
      await deps.runPrompt("Fix the failing test");
      await deps.runImplement();
    },
  ),
}));

const { handlePromptRoutes } = await import("./prompt-routes.js");
const { createAutopilotRunner } = await import("./autopilot-runner.js");

afterEach(() => {
  vi.clearAllMocks();
});

type Broadcast = [type: string, data: Record<string, unknown>];

/** A /prompt route context: idle, or with a run in flight (the prompt queues). */
function promptContext(running = false) {
  const events: Broadcast[] = [];
  const order: string[] = [];
  let settled!: () => void;
  const finished = new Promise<void>((resolve) => (settled = resolve));
  const runAgent = vi.fn(async (label: string, run: () => Promise<void>) => {
    order.push(`runAgent:${label}`);
    await run();
  });
  const ctx = {
    mode: "code",
    cwd: "/tmp/prompt-accepted",
    asks: { cancelAll: vi.fn() },
    runLifecycle: {
      running,
      generation: 1,
      state: running ? "running" : "idle",
      isCancellationRequested: () => false,
    },
    running,
    runClaim: { active: false, claim: () => true, release: vi.fn() },
    autopilotActive: false,
    autopilot: false,
    autopilotCancelled: false,
    pendingPlanPath: null,
    scheduledRunActive: false,
    session: {
      queueMessage: vi.fn(() => 1),
      listQueuedMessages: vi.fn(() => [{ id: "q-1", text: "queued" }]),
      willExpandPromptTemplate: vi.fn(async () => false),
      persistAppMarker: vi.fn(async () => {}),
      getMessages: () => [],
      prompt: vi.fn(async () => {}),
      getPlanMode: () => false,
      loadCustomCommands: vi.fn(async () => []),
    },
    trophies: { count: vi.fn(async () => {}), recordPrompt: vi.fn(async () => {}) },
    loadWorkflowCommandSpecs: vi.fn(async () => []),
    clearPendingPlan: vi.fn(),
    offerPendingPlan: vi.fn(() => settled()),
    reenterPlanModeForRevision: vi.fn(async () => {}),
    runAgent,
    runAutopilotCycle: vi.fn(async () => {}),
    runStrandedQueue: vi.fn(async () => {}),
    broadcast: vi.fn((type: string, data: Record<string, unknown>) => {
      events.push([type, data]);
      order.push(type);
    }),
    broadcastError: vi.fn(),
  } as unknown as SessionRouteContext;
  return { ctx, events, order, finished, runAgent };
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
    handlePromptRoutes(ctx, req, res as unknown as http.ServerResponse, "/prompt", "POST");
  });
}

const accepted = (events: Broadcast[]) => events.filter(([type]) => type === "prompt_accepted");

describe("POST /prompt announces the accepted user prompt", () => {
  it("broadcasts text, kenSent and the client's id before the run starts", async () => {
    const { ctx, events, order, finished } = promptContext();
    const reply = await post(ctx, {
      text: "Add a retry to the upload",
      meta: { kenSent: true, promptId: "glasses-42" },
    });
    expect(reply.status).toBe(202);
    await finished;

    expect(accepted(events)).toEqual([
      [
        "prompt_accepted",
        {
          id: "glasses-42",
          text: "Add a retry to the upload",
          kenSent: true,
          queued: false,
          attachments: 0,
        },
      ],
    ]);
    // The webview adds the row before the run's own events, as a local send does.
    expect(order.indexOf("prompt_accepted")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("prompt_accepted")).toBeLessThan(
      order.indexOf("runAgent:Add a retry to the upload"),
    );
  });

  it("gives a prompt without an id its own, and no kenSent for a plain prompt", async () => {
    const { ctx, events, finished } = promptContext();
    await post(ctx, { text: "Run the tests" });
    await finished;

    const list = accepted(events);
    expect(list).toHaveLength(1);
    const data = list[0]![1];
    expect(typeof data.id).toBe("string");
    expect((data.id as string).length).toBeGreaterThan(0);
    expect(data).toMatchObject({ text: "Run the tests", queued: false });
    expect(data).not.toHaveProperty("kenSent");
  });

  it("refuses an oversized client id and makes its own", async () => {
    const { ctx, events, finished } = promptContext();
    await post(ctx, { text: "Hi", meta: { promptId: "x".repeat(500) } });
    await finished;
    const list = accepted(events);
    expect(list).toHaveLength(1);
    expect(typeof list[0]![1].id).toBe("string");
    expect(list[0]![1].id).not.toBe("x".repeat(500));
  });

  it("marks a prompt that queues behind a running turn as queued", async () => {
    const { ctx, events, order, runAgent } = promptContext(true);
    const reply = await post(ctx, {
      text: "Add a retry to the upload",
      meta: { kenSent: true, promptId: "glasses-43" },
    });
    expect(reply.status).toBe(202);
    expect(reply.body).toMatchObject({ queued: true });
    expect(accepted(events)).toEqual([
      [
        "prompt_accepted",
        {
          id: "glasses-43",
          text: "Add a retry to the upload",
          kenSent: true,
          queued: true,
          attachments: 0,
        },
      ],
    ]);
    // Row first, then the queue snapshot that acknowledges it.
    expect(order.indexOf("prompt_accepted")).toBeLessThan(order.indexOf("queued"));
    expect(runAgent).not.toHaveBeenCalled();
  });
});

/** Autopilot runner context: one cycle, then an empty or one-item queue. */
function runnerContext(
  queue: Array<{ text: string; attachments: unknown[]; kenSent?: boolean }> = [],
) {
  const events: Broadcast[] = [];
  const labels: string[] = [];
  const order: string[] = [];
  const ctx = {
    autopilotReviewing: false,
    broadcast: vi.fn((type: string, data: Record<string, unknown>) => events.push([type, data])),
    ensureKenAutoSession: vi.fn(),
    cwd: "/tmp/prompt-accepted",
    gitBranch: "main",
    session: {
      prompt: vi.fn(async (text: string) => {
        order.push(`prompt:${text}`);
      }),
      promptWithAttachments: vi.fn(async () => {}),
      persistAutopilotMarker: vi.fn(async () => {}),
      persistAppMarker: vi.fn(async (kind: string, data: unknown, offset?: number) => {
        order.push(`marker:${kind}:${JSON.stringify(data)}:${offset}`);
      }),
      getVerificationProblem: () => null,
      getMessages: () => [],
      getPlanMode: () => false,
      getQueuedCount: () => queue.length,
      listQueuedMessages: () => [],
      takeNextQueuedMessage: () => queue.shift(),
    },
    injectedAutopilotPrompts: [],
    loadWorkflowCommandSpecs: vi.fn(async () => []),
    autopilotCancelled: false,
    broadcastError: vi.fn(),
    pendingKenAutoModel: null,
    syncKenAutoModel: vi.fn(),
    pendingPlanPath: null,
    planGeneration: 0,
    pendingPlanContent: "",
    autopilot: true,
    runLifecycle: { begin: () => ({ generation: 7 }) },
    abortOwnedWork: vi.fn(),
    pendingCancelDrain: null,
    autopilotActive: false,
    MAX_AUTOPILOT_ROUNDS: 3,
    activateApprovedPlan: vi.fn(async () => 0),
    clearPendingPlan: vi.fn(),
    planProgressPayload: () => ({ total: 0, completed: [] }),
    IMPLEMENT_PLAN_PROMPT: "Implement the approved plan.",
    runAgent: vi.fn(async (label: string, run: () => Promise<void>) => {
      labels.push(label);
      await run();
    }),
    kenAutoSession: null,
    reenterPlanModeForRevision: vi.fn(async () => {}),
    finishOwnedGeneration: vi.fn(() => true),
    drainingStrandedQueue: false,
    running: false,
    offerPendingPlan: vi.fn(),
    deactivateApprovedPlan: vi.fn(),
    taskRunAll: false,
  } as unknown as AutopilotRunnerContext;
  return { ctx, events, labels, order };
}

describe("runs nobody typed get no user-prompt event", () => {
  it("autopilot's injected Ken prompt and plan implementation broadcast no prompt_accepted", async () => {
    const { ctx, events, labels } = runnerContext();
    await createAutopilotRunner(ctx).runAutopilotCycle("Add a retry");
    expect(labels).toEqual(["Fix the failing test", "Implement the approved plan."]);
    expect(accepted(events)).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("kenSent");
  });

  it("a queued prompt draining as its own turn is not announced twice", async () => {
    const { ctx, events, labels } = runnerContext([
      { text: "Add a retry to the upload", attachments: [] },
    ]);
    ctx.autopilot = false;
    await createAutopilotRunner(ctx).runStrandedQueue();
    expect(labels).toEqual(["Add a retry to the upload"]);
    // Its row went up when it queued (prompt_accepted queued: true).
    expect(accepted(events)).toEqual([]);
  });

  it("a queued Ken-sent prompt draining as its own turn records kenSent for its user message", async () => {
    const { ctx, order } = runnerContext([
      { text: "Add a retry to the upload", attachments: [], kenSent: true },
      { text: "Then run the linter", attachments: [] },
    ]);
    ctx.autopilot = false;
    await createAutopilotRunner(ctx).runStrandedQueue();
    // Anchored +1 onto the message the prompt is about to add, like POST /prompt;
    // the plain prompt gets no hint.
    expect(order).toEqual([
      'marker:user_hint:{"kenSent":true}:1',
      "prompt:Add a retry to the upload",
      "prompt:Then run the linter",
    ]);
  });
});
