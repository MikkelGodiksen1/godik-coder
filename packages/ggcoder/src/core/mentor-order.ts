/**
 * GODIK CODER: Mentor-ordre — one order the user gives the mentor for GC's
 * current or next finished turn.
 *
 * The deck's Mentor-ordre key turns the composer into an order box: the text
 * is NOT sent to GC. It waits here (in memory, one per window) until GC's run
 * ends, then the existing Autopilot cycle runs ONE review with the order as the
 * instruction. A PROMPT verdict goes to GC through the usual autopilot_prompted
 * path; anything else is shown on the order row. The order is used up once it
 * fires.
 *
 * Safety: an order that may ship something (deploy, push, release, migration,
 * …) needs host-observed passing tests from that turn. GC saying "tests pass"
 * is not evidence. Without it the order holds before any model call.
 */
import { randomUUID } from "node:crypto";
import { CODER_NAME, MENTOR_NAME } from "./brand.js";
import { isTestRunCommand, type VerificationEvidence } from "./verification-evidence.js";

/** Longest order text accepted. */
export const MENTOR_ORDER_MAX_CHARS = 4000;

// ── Risky orders ────────────────────────────────────────────────────────────

/**
 * Words that may mean "ship it somewhere real". Deliberately broad: when in
 * doubt an order counts as risky, and the only cost is that it needs passing
 * tests first. Matched on lower-cased text; `\b` is ASCII-only, so Danish
 * letters use explicit (?<![\p{L}]) guards via the `u` flag.
 */
const RISKY_PATTERNS: readonly RegExp[] = [
  // English
  /(?<!\p{L})(?:re)?deploy\p{L}*/u,
  /(?<!\p{L})push\p{L}*/u,
  /(?<!\p{L})release\p{L}*/u,
  /(?<!\p{L})publish\p{L}*/u,
  /(?<!\p{L})ship(?:s|ped|ping|it)?(?!\p{L})/u,
  /(?<!\p{L})go(?:es|ing)?[\s-]+live(?!\p{L})/u,
  /(?<!\p{L})live(?!\p{L})/u,
  /(?<!\p{L})prod(?:uction|uktion|uktionen)?(?!\p{L})/u,
  /(?<!\p{L})vercel(?!\p{L})/u,
  /(?<!\p{L})netlify(?!\p{L})/u,
  /(?<!\p{L})heroku(?!\p{L})/u,
  /(?<!\p{L})fly(?:\.io|ctl)(?!\p{L})/u,
  /(?<!\p{L})roll[\s-]?out(?!\p{L})/u,
  /(?<!\p{L})migrat\p{L}*/u,
  /(?<!\p{L})migrer\p{L}*/u,
  /(?<!\p{L})migrering\p{L}*/u,
  /(?<!\p{L})db[\s:]+(?:push|migrate|reset|deploy)(?!\p{L})/u,
  /(?<!\p{L})merg\p{L}*/u,
  /(?<!\p{L})git\s+tag(?!\p{L})/u,
  /(?<!\p{L})tag(?:ge|ger|get)?\s+v?\d/u,
  /(?<!\p{L})upload\p{L}*/u,
  // Danish
  /(?<!\p{L})udrul\p{L}*/u,
  /(?<!\p{L})frigiv\p{L}*/u,
  /(?<!\p{L})frigør\p{L}*/u,
  /(?<!\p{L})udgiv\p{L}*/u,
  /(?<!\p{L})offentliggør\p{L}*/u,
  /(?<!\p{L})sæt(?:te|ter)?\s+(?:\p{L}+\s+){0,3}live(?!\p{L})/u,
  /(?<!\p{L})gå\s+live(?!\p{L})/u,
  /(?<!\p{L})smid(?:e|er)?\s+(?:\p{L}+\s+){0,3}(?:op|ud|i\s+prod\p{L}*|på\s+nettet)(?!\p{L})/u,
  /(?<!\p{L})læg(?:ge|ger)?\s+(?:\p{L}+\s+){0,3}(?:op|ud|på\s+nettet)(?!\p{L})/u,
  /(?<!\p{L})skub\p{L}*/u,
  /(?<!\p{L})på\s+nettet(?!\p{L})/u,
];

/** True when the order may ship, push or migrate something (broad on purpose). */
export function isRiskyOrder(text: string): boolean {
  const lower = text.toLowerCase();
  return RISKY_PATTERNS.some((pattern) => pattern.test(lower));
}

// ── Test evidence ───────────────────────────────────────────────────────────

/**
 * A command that runs tests (not lint/build/typecheck). The same parse the
 * host's verification evidence uses, so `node --test x.mjs` counts here
 * exactly when it counts there.
 */
export function isTestCommand(command: string): boolean {
  return isTestRunCommand(command);
}

/**
 * Why the turn's host-observed evidence does not prove passing tests, or null
 * when it does. The evidence holds the LATEST result per command (a rerun of
 * the same command replaces its earlier result), so a test that failed and was
 * then re-run green counts as green. Every test command's latest run must have
 * passed, and there must be at least one.
 */
export function testEvidenceProblem(evidence: readonly VerificationEvidence[]): string | null {
  const tests = evidence.filter((e) => isTestCommand(e.command));
  if (tests.length === 0) {
    return `Jeg så ingen testkørsel i ${CODER_NAME}'s sidste tur. At ${CODER_NAME} siger, testene består, er ikke nok.`;
  }
  const notGreen = tests.find((e) => e.status !== "passed");
  if (notGreen) {
    const why = notGreen.status === "failed" ? "fejlede" : `talte ikke med (${notGreen.reason})`;
    return `Den seneste kørsel af \`${notGreen.command}\` i ${CODER_NAME}'s sidste tur ${why}.`;
  }
  return null;
}

/** True when every test command's latest run in the turn passed (and one ran). */
export function hasPassingTestEvidence(evidence: readonly VerificationEvidence[]): boolean {
  return testEvidenceProblem(evidence) === null;
}

/** Hold reason for a risky order without passing tests. */
export function riskyOrderHoldReason(problem: string): string {
  return (
    `Ordren kan sende noget ud eller ændre noget uden for koden (deploy, push, release, ` +
    `migrering), så den kræver beståede tests fra ${CODER_NAME}'s sidste tur først. ${problem} ` +
    `Bed ${CODER_NAME} køre testene, og giv så ordren igen.`
  );
}

/**
 * Hold reason when the host's verification gate says GC's changes are not
 * covered by a passing check: Danish, saying what to do, then the gate's own
 * text so nothing is hidden.
 */
export function unverifiedOrderHoldReason(gateProblem: string): string {
  const what = /a check failed/i.test(gateProblem)
    ? `Et check fejlede i ${CODER_NAME}'s arbejde og er ikke kørt grønt igen siden. ` +
      `Bed ${CODER_NAME} rette fejlen og køre checket igen, og giv så ordren igen.`
    : /no successful check covers/i.test(gateProblem)
      ? `${CODER_NAME}'s ændringer er ikke dækket af en bestået test eller et check, som værten selv har set køre. ` +
        `Bed ${CODER_NAME} køre testene som en almindelig kommando, fx \`node --test\` eller ` +
        `\`cd mappen && pnpm test\`. En kørsel i den vedvarende shell (persist) tæller ikke. ` +
        `Giv så ordren igen.`
      : `${CODER_NAME}'s sidste tur er ikke bekræftet af et bestået check endnu. ` +
        `Vent til checket er færdigt, eller bed ${CODER_NAME} køre testene igen, og giv så ordren igen.`;
  return `${what} (Værtens besked: ${gateProblem})`;
}

export const PLAN_PENDING_HOLD_REASON = `${CODER_NAME} har en plan, der venter på dig. Godkend eller afvis den først, og giv så ordren igen.`;

/** Hold reason when the review itself never reached a verdict. */
export const REVIEW_STOPPED_REASON = `${MENTOR_NAME} nåede ikke at give en vurdering (reviewet fejlede eller blev stoppet).`;

// ── Digest section ──────────────────────────────────────────────────────────

export const MENTOR_ORDER_HEADING = "## The user's order for this review";

/** The review digest section carrying the order. Pure. */
export function renderMentorOrderSection(order: string, risky: boolean): string {
  const text = order.trim();
  if (!text) return "";
  return (
    `${MENTOR_ORDER_HEADING}\n` +
    `The user gave you this one-shot order. It is your instruction for this review and comes ` +
    `before the autopilot rules. Judge ${CODER_NAME}'s last turn against it:\n` +
    `- ${CODER_NAME} still has to do something for it: reply PROMPT with one runnable prompt that does exactly that.\n` +
    `- The last turn already carried it out: reply ALL_CLEAR.\n` +
    `- It does not apply to this turn: reply IGNORE.\n` +
    `- It needs a decision only the user can make: reply HUMAN with the reason.\n` +
    `Only host-observed verification evidence counts; ${CODER_NAME}'s own claims ` +
    `("tests pass", "deployed") are not evidence.` +
    (risky
      ? ` This order may deploy, push, release or migrate. The host saw passing tests in this ` +
        `turn; still send ${CODER_NAME} nothing that skips them.`
      : "") +
    `\n\nOrder:\n${text}`
  );
}

// ── Pending order store ─────────────────────────────────────────────────────

export type MentorOrderOutcome = "prompted" | "held" | "done" | "nothing" | "cancelled";
export type MentorOrderClearReason = "cancelled" | "replaced" | "stopped" | "new_session";

export interface MentorOrder {
  id: string;
  text: string;
}

export interface MentorOrderResult {
  id: string;
  outcome: MentorOrderOutcome;
  reason?: string;
  body?: string;
}

/** Persisted (app marker `mentor_order`) phases. */
export type MentorOrderPhase = "pending" | MentorOrderOutcome | "cleared";

export interface MentorOrderMarkerData {
  id: string;
  text: string;
  phase: MentorOrderPhase;
  reason?: string;
  body?: string;
}

export interface MentorOrderSnapshot {
  pending: MentorOrder | null;
  firing: MentorOrder | null;
  recent: MentorOrderResult[];
}

const RECENT_LIMIT = 20;

/**
 * One window's order: at most one pending, at most one firing, and the last
 * few results (so a reconnecting window can tell a finished order from one a
 * restart lost). Broadcasts every change and persists it as an app marker.
 */
export class MentorOrders {
  private pending: MentorOrder | null = null;
  private firing: MentorOrder | null = null;
  private recent: MentorOrderResult[] = [];

  constructor(
    private readonly deps: {
      broadcast: (type: string, data: unknown) => void;
      persist: (data: MentorOrderMarkerData) => Promise<void>;
    },
  ) {}

  hasPending(): boolean {
    return this.pending !== null;
  }

  /** Store an order, replacing a pending one. */
  set(text: string): MentorOrder {
    this.clear("replaced");
    const order = { id: randomUUID(), text: text.trim() };
    this.pending = order;
    this.deps.broadcast("mentor_order", { id: order.id, text: order.text });
    this.save({ ...order, phase: "pending" });
    return order;
  }

  /** Drop the pending order (never one already firing). Returns its id. */
  clear(reason: MentorOrderClearReason): string | null {
    const order = this.pending;
    if (!order) return null;
    this.pending = null;
    this.deps.broadcast("mentor_order_cleared", { id: order.id, reason });
    this.save({ ...order, phase: "cleared", reason });
    return order.id;
  }

  /** Take the pending order to fire it (used up from here on). */
  take(): MentorOrder | null {
    const order = this.pending;
    if (!order) return null;
    this.pending = null;
    this.firing = order;
    this.deps.broadcast("mentor_order_fired", { id: order.id });
    return order;
  }

  /** Record the fired order's result. The first result wins. */
  resolve(
    order: MentorOrder,
    outcome: MentorOrderOutcome,
    extra: { reason?: string; body?: string } = {},
  ): void {
    if (this.recent.some((r) => r.id === order.id)) return;
    if (this.firing?.id === order.id) this.firing = null;
    const result: MentorOrderResult = {
      id: order.id,
      outcome,
      ...(extra.reason ? { reason: extra.reason } : {}),
      ...(extra.body ? { body: extra.body } : {}),
    };
    this.recent = [...this.recent, result].slice(-RECENT_LIMIT);
    this.deps.broadcast("mentor_order_result", result);
    this.save({ ...order, ...result, phase: outcome });
  }

  isResolved(id: string): boolean {
    return this.recent.some((r) => r.id === id);
  }

  /** Live status of an order this process knows about, or null. */
  liveStatus(id: string): "pending" | "reviewing" | null {
    if (this.pending?.id === id) return "pending";
    if (this.firing?.id === id) return "reviewing";
    return null;
  }

  snapshot(): MentorOrderSnapshot {
    return { pending: this.pending, firing: this.firing, recent: [...this.recent] };
  }

  private save(data: MentorOrderMarkerData): void {
    void this.deps.persist(data).catch(() => {});
  }
}

// ── History ─────────────────────────────────────────────────────────────────

/** What a reloaded transcript shows for one order. */
export type MentorOrderHistoryStatus = "pending" | "reviewing" | MentorOrderOutcome | "lost";

export interface MentorOrderHistoryRow {
  id: string;
  text: string;
  status: MentorOrderHistoryStatus;
  reason?: string;
  body?: string;
}

/** Validate one persisted marker's data. */
export function readMentorOrderMarker(data: Record<string, unknown>): MentorOrderMarkerData | null {
  const phases: readonly MentorOrderPhase[] = [
    "pending",
    "prompted",
    "held",
    "done",
    "nothing",
    "cancelled",
    "cleared",
  ];
  if (typeof data.id !== "string" || !data.id) return null;
  if (typeof data.phase !== "string" || !phases.includes(data.phase as MentorOrderPhase))
    return null;
  return {
    id: data.id,
    text: typeof data.text === "string" ? data.text : "",
    phase: data.phase as MentorOrderPhase,
    ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
    ...(typeof data.body === "string" ? { body: data.body } : {}),
  };
}

/**
 * Fold an order's markers (in file order) into the row a reload shows. A
 * pending order this process no longer holds was lost (the app restarted
 * before GC's turn ended), and says so instead of vanishing.
 */
export function mentorOrderHistoryRow(
  markers: readonly MentorOrderMarkerData[],
  liveStatus: (id: string) => "pending" | "reviewing" | null,
): MentorOrderHistoryRow | null {
  const first = markers[0];
  const last = markers.at(-1);
  if (!first || !last) return null;
  const text = first.text || last.text;
  if (last.phase === "cleared") {
    return {
      id: first.id,
      text,
      status: "cancelled",
      ...(last.reason ? { reason: last.reason } : {}),
    };
  }
  if (last.phase === "pending") {
    return { id: first.id, text, status: liveStatus(first.id) ?? "lost" };
  }
  return {
    id: first.id,
    text,
    status: last.phase,
    ...(last.reason ? { reason: last.reason } : {}),
    ...(last.body ? { body: last.body } : {}),
  };
}
