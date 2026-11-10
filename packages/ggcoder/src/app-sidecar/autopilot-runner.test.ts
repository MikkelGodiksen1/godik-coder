import { describe, expect, it } from "vitest";
import { createAutopilotRunner, type AutopilotRunnerContext } from "./autopilot-runner.js";
import { buildPlanRevisionPrompt, frameAutopilotInjection } from "../core/autopilot-cycle.js";
import {
  MentorOrders,
  PLAN_DECIDED_BY_USER_REASON,
  PLAN_NOT_APPROVED_ORDER_REASON,
  planHumanOrderReason,
  type MentorOrderResult,
} from "../core/mentor-order.js";
import { RunClaim } from "../core/run-claim.js";

/**
 * GODIK CODER — a Mentor-ordre given against a submitted plan runs through the
 * cycle's plan branch with the REAL runner (createAutopilotRunner), the REAL
 * order store and run claim, and a scripted reviewer. Only the session, the
 * sidecar's plan state and the run bracket are stand-ins, written the way
 * app-sidecar.ts behaves (clearPendingPlan bumps planGeneration, runAgent flips
 * `running`).
 */
const IMPLEMENT = "The plan has been approved. Implement it now, following each step in order.";
const ORDER = "godkend planen når den er færdig";
const PLAN = "# Plan\n\n## Steps\n1. Add the thing\n2. Test the thing\n";

type Msg = { role: "user" | "assistant"; content: string };

interface Harness {
  ctx: AutopilotRunnerContext;
  api: ReturnType<typeof createAutopilotRunner>;
  orders: MentorOrders;
  /** Every digest the reviewer got, in order. */
  reviews: string[];
  /** Every prompt GC's session got, in order. */
  gcPrompts: string[];
  broadcasts: string[];
  calls: { accepted: number; newSessions: number; revisionModes: number };
  results: () => MentorOrderResult[];
}

function harness(opts: {
  /** The reviewer's replies, one per review, in order. */
  verdicts: string[];
  /** Runs inside the reviewer's call number `n` (0-based), before it answers. */
  duringReview?: (n: number, h: Harness) => void;
  /** Runs inside each GC prompt. */
  duringGcPrompt?: (text: string, h: Harness) => void;
}): Harness {
  const verdicts = [...opts.verdicts];
  const gcMessages: Msg[] = [
    { role: "user", content: "Plan a settings page" },
    { role: "assistant", content: "Plan submitted." },
  ];
  const kenMessages: Msg[] = [];
  const broadcasts: string[] = [];
  const reviews: string[] = [];
  const gcPrompts: string[] = [];
  const calls = { accepted: 0, newSessions: 0, revisionModes: 0 };
  const orders = new MentorOrders({
    broadcast: () => {},
    persist: async () => {},
  });
  // eslint-disable-next-line prefer-const -- assigned once the harness exists
  let h: Harness;
  const ken = {
    prompt: async (digest: string) => {
      const n = reviews.length;
      reviews.push(digest);
      opts.duringReview?.(n, h);
      kenMessages.push({ role: "assistant", content: verdicts.shift() ?? "" });
    },
    getMessages: () => kenMessages,
    newSession: async () => {},
  };
  const session = {
    getMessages: () => gcMessages,
    getVerificationEvidence: () => [],
    getVerificationProblem: () => null,
    getRunVerificationActivity: () => ({ evidence: [] }),
    getPlanMode: () => false,
    getPersistedTranscriptCount: () => gcMessages.length,
    getQueuedCount: () => 0,
    takeNextQueuedMessage: () => undefined,
    listQueuedMessages: () => [],
    newSession: async () => {
      calls.newSessions++;
      gcMessages.length = 0;
    },
    prompt: async (text: string) => {
      gcPrompts.push(text);
      opts.duringGcPrompt?.(text, h);
      gcMessages.push({ role: "user", content: text }, { role: "assistant", content: "Done." });
    },
    persistAutopilotMarker: async () => {},
    persistAppMarker: async () => {},
  };
  const ctx = {
    autopilotReviewing: false,
    broadcast: (type: string) => broadcasts.push(type),
    ensureKenAutoSession: async () => ken,
    cwd: "/nonexistent/godik-runner-test",
    gitBranch: "main",
    session,
    injectedAutopilotPrompts: [],
    loadWorkflowCommandSpecs: async () => [],
    autopilotCancelled: false,
    broadcastError: (type: string) => broadcasts.push(type),
    pendingKenAutoModel: null,
    syncKenAutoModel: async () => {},
    pendingPlanPath: "/nonexistent/godik-runner-test/plan.md" as string | null,
    planGeneration: 1,
    pendingPlanContent: PLAN,
    autopilot: false,
    runLifecycle: { begin: () => ({ generation: 1 }), running: false },
    abortOwnedWork: () => {},
    pendingCancelDrain: null,
    autopilotActive: false,
    MAX_AUTOPILOT_ROUNDS: 5,
    activateApprovedPlan: async () => {
      calls.accepted++;
      return 2;
    },
    clearPendingPlan: () => {
      if (ctx.pendingPlanPath === null) return;
      ctx.pendingPlanPath = null;
      ctx.planGeneration++;
    },
    planProgressPayload: () => ({ total: 2, completed: [] }),
    IMPLEMENT_PLAN_PROMPT: IMPLEMENT,
    runAgent: async (_label: string, run: () => Promise<void>) => {
      ctx.running = true;
      try {
        await run();
      } finally {
        ctx.running = false;
      }
    },
    kenAutoSession: ken,
    reenterPlanModeForRevision: async () => {
      calls.revisionModes++;
    },
    finishOwnedGeneration: () => false,
    drainingStrandedQueue: false,
    running: false,
    offerPendingPlan: () => {},
    deactivateApprovedPlan: () => {},
    taskRunAll: false,
    ruleSuggestions: { noteHumanStop: () => {} },
    mentorOrders: orders,
    runClaim: new RunClaim(),
  } as unknown as AutopilotRunnerContext & { pendingPlanPath: string | null };
  const api = createAutopilotRunner(ctx);
  h = {
    ctx,
    api,
    orders,
    reviews,
    gcPrompts,
    broadcasts,
    calls,
    results: () => orders.snapshot().recent,
  };
  return h;
}

/** Store the order and fire it the way the sidecar does when GC is idle. */
async function fire(h: Harness): Promise<MentorOrderResult> {
  h.orders.set(ORDER);
  h.api.fireMentorOrderWhenIdle();
  const deadline = Date.now() + 2000;
  while (h.ctx.runClaim.active || h.results().length === 0) {
    if (Date.now() > deadline) throw new Error("the order never settled");
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(h.results()).toHaveLength(1);
  return h.results()[0]!;
}

describe("Mentor-ordre against a pending plan (real runner)", () => {
  it("approves the plan, implements it, reviews the work once → done", async () => {
    const h = harness({ verdicts: ["ALL_CLEAR", "ALL_CLEAR"] });
    const result = await fire(h);

    expect(result.outcome).toBe("done");
    // The plan review got the plan AND the order, read as a wish, not approval.
    expect(h.reviews).toHaveLength(2);
    expect(h.reviews[0]).toContain("## Plan under review");
    expect(h.reviews[0]).toContain("Add the thing");
    expect(h.reviews[0]).toContain("## The user's order for this review");
    expect(h.reviews[0]).toContain(`Order:\n${ORDER}`);
    expect(h.reviews[0]).toContain("not an approval by itself");
    // The work review knows the plan was approved and is now implemented.
    expect(h.reviews[1]).not.toContain("## Plan under review");
    expect(h.reviews[1]).toContain("has now implemented it");
    expect(h.reviews[1]).toContain(`Order:\n${ORDER}`);
    // Accepted into a fresh session, then implemented, with no other prompt.
    expect(h.calls).toEqual({ accepted: 1, newSessions: 1, revisionModes: 0 });
    expect(h.gcPrompts).toEqual([frameAutopilotInjection(IMPLEMENT)]);
    expect(h.ctx.pendingPlanPath).toBeNull();
    expect(h.broadcasts).toContain("autopilot_plan_accepted");
    expect(h.broadcasts).toContain("session_reset");
    expect(h.broadcasts).not.toContain("autopilot_error");
    expect(h.broadcasts).not.toContain("autopilot_capped");
    expect(h.ctx.autopilotActive).toBe(false);
  });

  it("a bad plan gets ONE revision prompt (plan mode), then the order stops → prompted", async () => {
    const h = harness({
      verdicts: ["PROMPT\nAdd a rollback step before step 2.", "ALL_CLEAR"],
      // GC revises and resubmits: the plan is pending again afterwards.
      duringGcPrompt: (_text, hh) => {
        hh.ctx.pendingPlanPath = "/nonexistent/godik-runner-test/plan-v2.md";
        hh.ctx.planGeneration++;
      },
    });
    const result = await fire(h);

    const body = buildPlanRevisionPrompt("Add a rollback step before step 2.");
    expect(result).toMatchObject({ outcome: "prompted", body });
    expect(h.reviews).toHaveLength(1);
    expect(h.gcPrompts).toEqual([frameAutopilotInjection(body)]);
    expect(h.calls).toEqual({ accepted: 0, newSessions: 0, revisionModes: 1 });
    // The resubmitted plan is left for the user, not approved by the order.
    expect(h.ctx.pendingPlanPath).toBe("/nonexistent/godik-runner-test/plan-v2.md");
  });

  it("approved and implemented, the work review's ONE fix prompt ends it → prompted", async () => {
    const h = harness({ verdicts: ["ALL_CLEAR", "PROMPT\nAdd the missing test.", "ALL_CLEAR"] });
    const result = await fire(h);
    expect(result).toMatchObject({ outcome: "prompted", body: "Add the missing test." });
    expect(h.reviews).toHaveLength(2);
    expect(h.gcPrompts).toEqual([
      frameAutopilotInjection(IMPLEMENT),
      frameAutopilotInjection("Add the missing test."),
    ]);
    expect(h.broadcasts).not.toContain("autopilot_capped");
  });

  it("IGNORE on the plan is no approval → held with a Danish reason, nothing implemented", async () => {
    const h = harness({ verdicts: ["IGNORE"] });
    const result = await fire(h);
    expect(result).toEqual({
      id: result.id,
      outcome: "held",
      reason: PLAN_NOT_APPROVED_ORDER_REASON,
    });
    expect(h.calls.accepted).toBe(0);
    expect(h.gcPrompts).toEqual([]);
    expect(h.ctx.pendingPlanPath).not.toBeNull();
  });

  it("HUMAN on the plan → held with the reason in Danish framing", async () => {
    const h = harness({ verdicts: ["HUMAN\nThe plan drops the user table."] });
    const result = await fire(h);
    expect(result.outcome).toBe("held");
    expect(result.reason).toBe(planHumanOrderReason("The plan drops the user table."));
    expect(result.reason).toContain("kræver din beslutning");
    expect(h.calls.accepted).toBe(0);
  });

  it("the user's own Accept during the review wins; the order drops quietly", async () => {
    const h = harness({
      verdicts: ["ALL_CLEAR", "ALL_CLEAR"],
      // POST /plan/accept mid-review: clears the plan and stops the cycle.
      duringReview: (n, hh) => {
        if (n !== 0) return;
        hh.ctx.clearPendingPlan();
        hh.ctx.autopilotCancelled = true;
      },
    });
    const result = await fire(h);
    expect(result).toEqual({
      id: result.id,
      outcome: "cancelled",
      reason: PLAN_DECIDED_BY_USER_REASON,
    });
    expect(h.reviews).toHaveLength(1);
    expect(h.calls).toEqual({ accepted: 0, newSessions: 0, revisionModes: 0 });
    expect(h.gcPrompts).toEqual([]);
    expect(h.broadcasts).not.toContain("autopilot_plan_accepted");
    expect(h.broadcasts).not.toContain("autopilot_error");
  });

  it("the user's Reject (a message superseding the plan) during the review wins too", async () => {
    const h = harness({
      verdicts: ["ALL_CLEAR"],
      // POST /prompt queues the Reject and clears the plan (no cancel flag).
      duringReview: (_n, hh) => hh.ctx.clearPendingPlan(),
    });
    const result = await fire(h);
    expect(result).toMatchObject({ outcome: "cancelled", reason: PLAN_DECIDED_BY_USER_REASON });
    expect(h.calls.accepted).toBe(0);
    expect(h.gcPrompts).toEqual([]);
  });

  it("Stop during the review cancels the order (no user decision on the plan)", async () => {
    const h = harness({
      verdicts: ["ALL_CLEAR"],
      duringReview: (_n, hh) => {
        hh.ctx.autopilotCancelled = true;
      },
    });
    const result = await fire(h);
    expect(result).toEqual({ id: result.id, outcome: "cancelled" });
    expect(h.calls.accepted).toBe(0);
    expect(h.gcPrompts).toEqual([]);
    // The plan is still waiting for the user.
    expect(h.ctx.pendingPlanPath).not.toBeNull();
  });
});
