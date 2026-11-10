import { describe, expect, it, vi } from "vitest";
import {
  hasPassingTestEvidence,
  isRiskyOrder,
  isTestCommand,
  mentorOrderHistoryRow,
  MentorOrders,
  orderPlanVerdict,
  PLAN_NOT_APPROVED_ORDER_REASON,
  planHumanOrderReason,
  readMentorOrderMarker,
  renderMentorOrderSection,
  testEvidenceProblem,
  unverifiedOrderHoldReason,
  type MentorOrderMarkerData,
} from "./mentor-order.js";
import { buildKenAutopilotContext, buildKenAutopilotPlanContext } from "./ken-context.js";
import type { VerificationEvidence } from "./verification-evidence.js";
import { VerificationGate } from "./verification-gate.js";

const ev = (command: string, status: VerificationEvidence["status"]): VerificationEvidence => ({
  command,
  status,
  reason: status === "passed" ? "ok" : "exit 1",
});

describe("isRiskyOrder", () => {
  it.each([
    "deploy it",
    "redeploy the api",
    "push to main",
    "git push",
    "cut a release",
    "publish the package",
    "ship it",
    "let's go live",
    "make it live",
    "put it on prod",
    "roll out to production",
    "vercel --prod",
    "run the migrations",
    "db push",
    "merge the branch",
  ])("English: %s", (text) => {
    expect(isRiskyOrder(text)).toBe(true);
  });

  it.each([
    "sæt det live",
    "Sæt siden live",
    "smid det op",
    "smid det i prod",
    "smid den nye version i produktion",
    "udgiv appen",
    "udgiv en ny version",
    "deploy til vercel",
    "udrul ændringen",
    "frigiv version 2",
    "migrer databasen",
    "kør migreringen",
    "læg det op på serveren",
    "skub ændringerne",
    "læg den på nettet",
    "gå live i aften",
    "merge til main",
  ])("Danish: %s", (text) => {
    expect(isRiskyOrder(text)).toBe(true);
  });

  it.each([
    "tilføj en knap til forsiden",
    "fix the failing test",
    "refactor the parser",
    "skriv en test for login",
    "gør teksten større",
    "rename the variable",
    "deliver a summary of what changed",
  ])("not risky: %s", (text) => {
    expect(isRiskyOrder(text)).toBe(false);
  });
});

describe("test evidence", () => {
  it("recognises test commands, not lint or build", () => {
    expect(isTestCommand("pnpm test")).toBe(true);
    expect(isTestCommand("pnpm vitest run src/a.test.ts")).toBe(true);
    expect(isTestCommand("npm run test:unit")).toBe(true);
    expect(isTestCommand("pytest -q")).toBe(true);
    expect(isTestCommand("pnpm lint")).toBe(false);
    expect(isTestCommand("pnpm build")).toBe(false);
    expect(isTestCommand("tsc --noEmit")).toBe(false);
  });

  // Same classification as the host's verification evidence (not a separate
  // regex): the old regex never matched `node --test`.
  it.each([
    ["node --test x.mjs", true],
    ["node --test", true],
    ["cd scratch && node --test 2>&1 | tail -20", true],
    ["pnpm test", true],
    ["vitest run", true],
    ["npx vitest run src/a.test.ts", true],
    ["cargo test", true],
    ["go test ./...", true],
    ["node script.js --test", false],
    ["node --check x.mjs", false],
    ["pnpm lint", false],
    ["eslint .", false],
    ["git commit -m test", false],
  ])("isTestCommand(%j) is %s", (command, expected) => {
    expect(isTestCommand(command)).toBe(expected);
  });

  it("a green `node --test x.mjs` run is passing test evidence", () => {
    expect(testEvidenceProblem([ev("node --test x.mjs", "passed")])).toBeNull();
    expect(testEvidenceProblem([ev("node --test x.mjs", "failed")])).toMatch(/fejlede/);
  });

  it("no test run at all is not evidence", () => {
    expect(hasPassingTestEvidence([])).toBe(false);
    expect(hasPassingTestEvidence([ev("pnpm lint", "passed")])).toBe(false);
    expect(testEvidenceProblem([])).toMatch(/ingen testkørsel/);
  });

  // Through the real host tracker: its run evidence keeps the LATEST result
  // per command, which is exactly what the order's safety check reads.
  it("a failed run followed by a green rerun of the same command is OK (latest wins)", () => {
    const gate = new VerificationGate();
    gate.beginRun();
    gate.recordFailedVerification("pnpm test");
    expect(hasPassingTestEvidence(gate.evidence("run"))).toBe(false);
    gate.recordVerification(undefined, "pnpm test");
    expect(gate.evidence("run").map((e) => e.status)).toEqual(["passed"]);
    expect(hasPassingTestEvidence(gate.evidence("run"))).toBe(true);
  });

  it("a green run followed by a failing rerun is NOT OK", () => {
    const gate = new VerificationGate();
    gate.beginRun();
    gate.recordVerification(undefined, "pnpm test");
    gate.recordFailedVerification("pnpm test");
    expect(hasPassingTestEvidence(gate.evidence("run"))).toBe(false);
    expect(testEvidenceProblem(gate.evidence("run"))).toMatch(/pnpm test.*fejlede/);
  });

  it("evidence from an earlier turn does not count for this one", () => {
    const gate = new VerificationGate();
    gate.recordVerification(undefined, "pnpm test");
    gate.beginRun();
    expect(hasPassingTestEvidence(gate.evidence("run"))).toBe(false);
  });

  it("every test command's latest run must be green", () => {
    expect(
      hasPassingTestEvidence([ev("pnpm test", "passed"), ev("pnpm vitest run a", "failed")]),
    ).toBe(false);
    expect(
      hasPassingTestEvidence([ev("pnpm test", "passed"), ev("pnpm vitest run a", "rejected")]),
    ).toBe(false);
  });
});

describe("review digest", () => {
  const base = {
    cwd: "/p",
    gitBranch: null,
    messages: [{ role: "user" as const, content: "hi" }],
    workflowCommands: [],
    injectedPrompts: [],
  };

  it("puts the order after the rules, right before the task", () => {
    const digest = buildKenAutopilotContext({
      ...base,
      autopilotRules: "- always run lint",
      mentorOrder: { text: "add a README section", risky: false },
    });
    const rules = digest.indexOf("always run lint");
    const order = digest.indexOf("## The user's order for this review");
    expect(rules).toBeGreaterThan(-1);
    expect(order).toBeGreaterThan(rules);
    expect(digest.indexOf("add a README section")).toBeGreaterThan(order);
  });

  it("no order leaves the digest unchanged", () => {
    expect(buildKenAutopilotContext(base)).toBe(
      buildKenAutopilotContext({ ...base, mentorOrder: undefined }),
    );
    expect(buildKenAutopilotContext(base)).not.toContain("order for this review");
  });

  it("an empty order renders nothing", () => {
    expect(renderMentorOrderSection("   ", false)).toBe("");
  });
});

describe("MentorOrders", () => {
  function make() {
    const broadcast = vi.fn();
    const persisted: MentorOrderMarkerData[] = [];
    const orders = new MentorOrders({
      broadcast,
      persist: async (d) => {
        persisted.push(d);
      },
    });
    return { orders, broadcast, persisted };
  }

  it("set → take → resolve: used up once, persisted at each step", () => {
    const { orders, broadcast, persisted } = make();
    const order = orders.set("do the thing");
    expect(orders.hasPending()).toBe(true);
    expect(orders.take()?.id).toBe(order.id);
    expect(orders.take()).toBeNull();
    expect(orders.liveStatus(order.id)).toBe("reviewing");
    orders.resolve(order, "prompted", { body: "go" });
    expect(orders.liveStatus(order.id)).toBeNull();
    expect(persisted.map((p) => p.phase)).toEqual(["pending", "prompted"]);
    expect(broadcast.mock.calls.map((c) => c[0])).toEqual([
      "mentor_order",
      "mentor_order_fired",
      "mentor_order_result",
    ]);
    expect(orders.snapshot().recent).toEqual([{ id: order.id, outcome: "prompted", body: "go" }]);
  });

  it("a new order replaces a pending one; clear removes it", () => {
    const { orders, broadcast } = make();
    const first = orders.set("one");
    const second = orders.set("two");
    expect(broadcast).toHaveBeenCalledWith("mentor_order_cleared", {
      id: first.id,
      reason: "replaced",
    });
    expect(orders.clear("cancelled")).toBe(second.id);
    expect(orders.hasPending()).toBe(false);
    expect(orders.clear("cancelled")).toBeNull();
  });
});

describe("history row", () => {
  const step = (phase: MentorOrderMarkerData["phase"], extra = {}): MentorOrderMarkerData => ({
    id: "o1",
    text: "deploy",
    phase,
    ...extra,
  });

  it("shows the latest step", () => {
    expect(
      mentorOrderHistoryRow([step("pending"), step("held", { reason: "no tests" })], () => null),
    ).toEqual({ id: "o1", text: "deploy", status: "held", reason: "no tests" });
  });

  it("a pending step the live sidecar no longer holds reads as lost", () => {
    expect(mentorOrderHistoryRow([step("pending")], () => null)?.status).toBe("lost");
    expect(mentorOrderHistoryRow([step("pending")], () => "pending")?.status).toBe("pending");
    expect(mentorOrderHistoryRow([step("pending")], () => "reviewing")?.status).toBe("reviewing");
  });

  it("a cancelled order stays as a cancelled row; junk markers are ignored", () => {
    expect(
      mentorOrderHistoryRow(
        [step("pending"), step("cleared", { reason: "cancelled" })],
        () => null,
      ),
    ).toEqual({ id: "o1", text: "deploy", status: "cancelled", reason: "cancelled" });
    expect(readMentorOrderMarker({ id: 1 })).toBeNull();
    expect(readMentorOrderMarker({ id: "x", text: "t", phase: "weird" })).toBeNull();
  });
});

describe("unverifiedOrderHoldReason", () => {
  const NO_CHECK =
    "Unverified: no successful check covers the current changes. Run the project's verification before approval.";
  const FAILED =
    "Unverified: a check failed or did not confirm success. Rerun that check successfully before approval.";

  it("says in Danish what to do, then shows the gate's own text", () => {
    const reason = unverifiedOrderHoldReason(NO_CHECK);
    expect(reason).toMatch(/^GC's ændringer er ikke dækket af en bestået test/);
    expect(reason).toContain("Bed GC køre testene som en almindelig kommando");
    expect(reason).toContain("vedvarende shell (persist) tæller ikke");
    expect(reason).toContain("Giv så ordren igen.");
    expect(reason.endsWith(`(Værtens besked: ${NO_CHECK})`)).toBe(true);
    expect(reason.indexOf("Giv så ordren igen.")).toBeLessThan(reason.indexOf(NO_CHECK));
  });

  it("a failed check asks for a fix and a green rerun", () => {
    const reason = unverifiedOrderHoldReason(FAILED);
    expect(reason).toMatch(/^Et check fejlede/);
    expect(reason).toContain("Bed GC rette fejlen og køre checket igen");
    expect(reason.endsWith(`(Værtens besked: ${FAILED})`)).toBe(true);
  });

  it("any other gate text still gets a Danish lead and the raw text", () => {
    const raw =
      "Unverified: a background check is still running or its result has not been confirmed.";
    const reason = unverifiedOrderHoldReason(raw);
    expect(reason).toMatch(/^GC's sidste tur er ikke bekræftet/);
    expect(reason.endsWith(`(Værtens besked: ${raw})`)).toBe(true);
  });
});

describe("an order against a submitted plan", () => {
  it("only an explicit approval or a revision passes through", () => {
    expect(orderPlanVerdict({ kind: "all_clear" })).toEqual({ kind: "all_clear" });
    expect(orderPlanVerdict({ kind: "prompt", body: "fix step 2" })).toEqual({
      kind: "prompt",
      body: "fix step 2",
    });
    expect(orderPlanVerdict({ kind: "ignore" })).toEqual({
      kind: "human",
      reason: PLAN_NOT_APPROVED_ORDER_REASON,
    });
    expect(orderPlanVerdict({ kind: "human", reason: "Drops a table." })).toEqual({
      kind: "human",
      reason: planHumanOrderReason("Drops a table."),
    });
    expect(planHumanOrderReason("Drops a table.")).toMatch(
      /godkendte ikke planen.*Drops a table\./,
    );
    expect(planHumanOrderReason("  ")).not.toContain(":");
  });

  it("the plan digest carries the order after the plan, read as a wish", () => {
    const digest = buildKenAutopilotPlanContext({
      cwd: "/p",
      gitBranch: "main",
      messages: [],
      planContent: "# Plan\n1. step",
      mentorOrder: { text: "godkend planen når den er færdig", risky: false },
    });
    const plan = digest.indexOf("## Plan under review");
    const order = digest.indexOf("## The user's order for this review");
    expect(plan).toBeGreaterThan(-1);
    expect(order).toBeGreaterThan(plan);
    expect(digest).toContain("not an approval by itself");
    expect(digest).toContain("Never IGNORE a plan.");
    expect(digest).toContain("Order:\ngodkend planen når den er færdig");
    // Without an order the plan digest is unchanged.
    const plain = buildKenAutopilotPlanContext({
      cwd: "/p",
      gitBranch: "main",
      messages: [],
      planContent: "# Plan\n1. step",
    });
    expect(plain).not.toContain("## The user's order for this review");
  });

  it("the implemented stage reviews the work against the plan", () => {
    const section = renderMentorOrderSection("godkend planen", false, "implemented");
    expect(section).toContain("You approved the plan");
    expect(section).toContain("reply ALL_CLEAR");
    expect(section).toContain("Order:\ngodkend planen");
    // The work stage (default) is unchanged.
    expect(renderMentorOrderSection("x", false)).toBe(renderMentorOrderSection("x", false, "work"));
  });

  it("the store says while an order is firing, and the result carries the text", () => {
    const broadcast = vi.fn();
    const orders = new MentorOrders({ broadcast, persist: async () => {} });
    const order = orders.set("godkend planen");
    expect(orders.isFiring()).toBe(false);
    orders.take();
    expect(orders.isFiring()).toBe(true);
    orders.resolve(order, "done");
    expect(orders.isFiring()).toBe(false);
    expect(broadcast).toHaveBeenLastCalledWith("mentor_order_result", {
      id: order.id,
      outcome: "done",
      text: "godkend planen",
    });
    expect(orders.snapshot().recent).toEqual([{ id: order.id, outcome: "done" }]);
  });
});
