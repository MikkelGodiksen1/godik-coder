/**
 * GODIK CODER: the user's own Autopilot rules.
 *
 * A project can keep plain-text "if X, send Y" rules in
 * `.gg/autopilot-rules.md`. The file is read fresh at every work review and
 * rendered as one section of Autopilot Ken's review digest (never the cached
 * system prompt, never the plan digest), so editing it takes effect on the
 * next review without touching the prompt-cache prefix. When a rule clearly
 * matches, Ken answers `PROMPT RULE: <name>` and the transcript shows which
 * rule fired. Rules ride on the existing cycle: round limits, cancel and the
 * host verification gate apply unchanged.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { AUTOPILOT_RULE_NAME_MAX_CHARS, type AutopilotVerdict } from "./autopilot-verdict.js";

/** Project-relative path of the rules file. */
export const AUTOPILOT_RULES_FILE = path.join(".gg", "autopilot-rules.md");

/** Most characters of the rules file a review ever carries. */
export const AUTOPILOT_RULES_MAX_CHARS = 4000;

const TRUNCATION_NOTICE = `[Rules truncated at ${AUTOPILOT_RULES_MAX_CHARS} characters.]`;

/** Absolute path of a project's rules file. */
export function autopilotRulesPath(cwd: string): string {
  return path.join(cwd, AUTOPILOT_RULES_FILE);
}

/**
 * Read the project's rules, capped. Returns "" when the file is missing,
 * unreadable or blank, so a review without rules looks exactly like today's.
 * Reads at most a few times the cap in bytes, so a huge file is never loaded.
 */
export async function readAutopilotRules(cwd: string): Promise<string> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(autopilotRulesPath(cwd), "r");
    const buffer = Buffer.alloc(AUTOPILOT_RULES_MAX_CHARS * 4);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf-8").trim();
    if (!text) return "";
    if (text.length <= AUTOPILOT_RULES_MAX_CHARS) return text;
    return `${text.slice(0, AUTOPILOT_RULES_MAX_CHARS).trimEnd()}\n${TRUNCATION_NOTICE}`;
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Heading of the digest section; also used by tests to find it. */
export const AUTOPILOT_RULES_HEADING = "## User autopilot rules";

/**
 * The digest section carrying the user's rules, or "" when there are none.
 * Pure. Tells Ken how to apply and tag a rule, and what a rule can never do.
 */
export function renderAutopilotRulesSection(rules: string): string {
  const text = rules.trim();
  if (!text) return "";
  return (
    `${AUTOPILOT_RULES_HEADING}\n` +
    `The user wrote these "if X, send Y" rules for this project. Apply one only when its ` +
    `condition clearly matches this turn. Then reply PROMPT with the keyword line ` +
    `\`PROMPT RULE: <the rule's short name, max ${AUTOPILOT_RULE_NAME_MAX_CHARS} chars>\` and ` +
    `the rule's text as the body (add the concrete specifics GG Coder needs). Rules never ` +
    `replace a needed HUMAN decision, never make failing or unverified work ALL_CLEAR, ` +
    `and do nothing when no rule matches.\n\n` +
    text
  );
}

/**
 * Keep a verdict's rule tag only when the review actually showed rules. A tag
 * Ken invents without any rules in his digest is dropped; the prompt itself
 * still runs as an ordinary PROMPT.
 */
export function trustRuleTag(verdict: AutopilotVerdict, rulesShown: string): AutopilotVerdict {
  if (verdict.kind !== "prompt" || !verdict.rule || rulesShown.trim()) return verdict;
  return { kind: "prompt", body: verdict.body };
}
