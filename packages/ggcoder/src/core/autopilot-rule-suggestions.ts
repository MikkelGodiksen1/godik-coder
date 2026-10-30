/**
 * GODIK CODER: Autopilot learns rules from the user's own answers (v2).
 *
 * When an Autopilot cycle stops with HUMAN, the sidecar remembers the stop.
 * The user's next reply triggers ONE extra Autopilot Ken call, outside the
 * cycle and never counted as a round, that proposes a single "if X, send Y"
 * rule or NONE. A proposal is offered to the webview as a card; only the
 * user's Save click appends it to `.gg/autopilot-rules.md`. Cancel, abort and
 * a new prompt drop a pending proposal, and a stale Save is refused.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "@kenkaiiii/gg-core";
import { autopilotRulesPath } from "./autopilot-rules.js";

/** The Autopilot stop the user is answering. */
export interface HumanStop {
  reason: string;
  originalRequest: string;
}

/** A rule offered to the user, waiting for Save or Dismiss. */
export interface RuleSuggestion {
  id: string;
  text: string;
}

/** Longest rule Ken may propose; a longer reply is not a one-line rule. */
export const RULE_SUGGESTION_MAX_CHARS = 300;

/** Longest rule line the user may save (after editing). */
export const SAVED_RULE_MAX_CHARS = 500;

/** Cap on each piece of context fed to the suggestion call. */
const CONTEXT_CAP = 2000;

function cap(text: string, max = CONTEXT_CAP): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)} […]`;
}

/**
 * The one-off prompt that asks Autopilot Ken for a rule. Pure. Ken's
 * autopilot persona and read-only tools are reused; only this task differs.
 */
export function buildRuleSuggestionPrompt(input: {
  stop: HumanStop;
  reply: string;
  existingRules: string;
}): string {
  return [
    "## Rule suggestion (not a review)",
    "Autopilot stopped and handed this to the user. Do not review any work now.",
    `### Why Autopilot stopped\n${cap(input.stop.reason) || "(no reason given)"}`,
    `### The request Autopilot was working on\n${cap(input.stop.originalRequest) || "(unknown)"}`,
    `### The user's reply\n${cap(input.reply)}`,
    `### Rules already in .gg/autopilot-rules.md\n${cap(input.existingRules) || "(none)"}`,
    "### Your task\n" +
      "If the reply shows a reusable preference that would let Autopilot handle this kind " +
      "of stop by itself next time, write ONE rule as a single line:\n" +
      "RULE: if <situation>, send: <instruction for GG Coder>\n" +
      "Otherwise reply exactly NONE: a one-off decision, anything about secrets, money, " +
      "access or destructive actions, a taste call the user should keep making, or a rule " +
      "that already exists. Reply with that one line only.",
  ].join("\n\n");
}

const NO_RULE_KEYWORDS = new Set(["NONE", "NO", "IGNORE", "SKIP", "ALL_CLEAR", "HUMAN"]);

/**
 * Read Ken's reply as a rule, or null for NONE (and anything that isn't a
 * one-line "if …" rule). Never throws.
 */
export function parseRuleSuggestion(reply: string): string | null {
  const text = (reply ?? "")
    .trim()
    .replace(/^```[^\n]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  const firstLine = text.split("\n").find((line) => line.trim() !== "") ?? "";
  const line = firstLine
    .trim()
    .replace(/^[-*]\s+/, "")
    .trim();
  const keyword = line
    .toUpperCase()
    .replace(/[:.!]+$/, "")
    .trim()
    .replace(/\s+/g, "_");
  if (!line || NO_RULE_KEYWORDS.has(keyword)) return null;
  const rule = line
    .replace(/^RULE\s*[:-]\s*/i, "")
    .replace(/^["'`]+/, "")
    .replace(/["'`]+$/, "")
    .trim();
  if (!/^if\b/i.test(rule) || rule.length > RULE_SUGGESTION_MAX_CHARS) return null;
  return rule;
}

/**
 * The rule as one markdown list line, or null when it's empty or too long.
 * Newlines collapse to spaces so one rule is always exactly one line.
 */
export function normalizeRuleLine(text: string): string | null {
  const rule = (text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-*]\s+/, "")
    .trim();
  if (!rule || rule.length > SAVED_RULE_MAX_CHARS) return null;
  return `- ${rule}`;
}

/**
 * Append one rule line to the project's rules file under a file lock,
 * creating `.gg/` and the file if needed. Returns the line written.
 * Throws on invalid text (callers validate first) or a write failure.
 */
export async function appendAutopilotRule(cwd: string, text: string): Promise<string> {
  const line = normalizeRuleLine(text);
  if (!line) throw new Error("A rule must be one line of at most 500 characters.");
  const file = autopilotRulesPath(cwd);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await withFileLock(file, async () => {
    const existing = await fs.readFile(file, "utf-8").catch(() => "");
    const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
    await fs.appendFile(file, `${separator}${line}\n`, "utf-8");
  });
  return line;
}

/**
 * Per-window state for rule suggestions: the last HUMAN stop, the proposal
 * waiting on the user, and a generation that makes an in-flight proposal
 * stale the moment it's cleared.
 */
export class AutopilotRuleSuggestions {
  private lastHumanStop: HumanStop | null = null;
  private pendingSuggestion: RuleSuggestion | null = null;
  private generation = 0;
  private takenAtGeneration = -1;
  private nextId = 0;

  constructor(private readonly broadcast: (type: string, data: unknown) => void) {}

  /** Autopilot stopped for the user: their next reply may teach a rule. */
  noteHumanStop(stop: HumanStop): void {
    this.lastHumanStop = stop;
  }

  /**
   * A new user prompt arrived: drop any pending proposal and hand back (and
   * forget) the stop it answers, if there was one.
   */
  takeHumanStop(): HumanStop | null {
    this.clear();
    const stop = this.lastHumanStop;
    this.lastHumanStop = null;
    return stop;
  }

  /** Start a suggestion call; pass the token to {@link offer}. */
  begin(): number {
    return this.generation;
  }

  /**
   * Offer Ken's reply to the user, unless it was NONE or the call went stale
   * (cleared since {@link begin}). Returns the offered suggestion.
   */
  offer(token: number, reply: string): RuleSuggestion | null {
    if (token !== this.generation) return null;
    const text = parseRuleSuggestion(reply);
    if (!text) return null;
    this.nextId += 1;
    const suggestion = { id: `rule-${this.generation}-${this.nextId}`, text };
    this.pendingSuggestion = suggestion;
    this.broadcast("autopilot_rule_suggestion", suggestion);
    return suggestion;
  }

  /** Cancel, abort or a new prompt: the pending proposal (and any call in
   *  flight) no longer applies. Tells the webview to take its card down. */
  clear(): void {
    this.generation += 1;
    if (!this.pendingSuggestion) return;
    const { id } = this.pendingSuggestion;
    this.pendingSuggestion = null;
    this.broadcast("autopilot_rule_suggestion_cleared", { id });
  }

  /** New session: nothing from the old conversation carries over. */
  reset(): void {
    this.clear();
    this.lastHumanStop = null;
  }

  /** The suggestion with this id if it's still pending, removed from pending
   *  (Save). null when it was cleared or never existed. */
  take(id: string): RuleSuggestion | null {
    if (!this.pendingSuggestion || this.pendingSuggestion.id !== id) return null;
    const suggestion = this.pendingSuggestion;
    this.pendingSuggestion = null;
    this.takenAtGeneration = this.generation;
    return suggestion;
  }

  /** Put a taken suggestion back after a failed write, so Save can retry —
   *  unless it was cleared (new prompt, cancel) in the meantime. */
  restore(suggestion: RuleSuggestion): void {
    if (this.pendingSuggestion || this.takenAtGeneration !== this.generation) return;
    this.pendingSuggestion = suggestion;
  }

  get pending(): RuleSuggestion | null {
    return this.pendingSuggestion;
  }
}
