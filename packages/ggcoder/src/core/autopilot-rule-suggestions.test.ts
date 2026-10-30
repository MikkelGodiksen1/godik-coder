import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AutopilotRuleSuggestions,
  appendAutopilotRule,
  buildRuleSuggestionPrompt,
  normalizeRuleLine,
  parseRuleSuggestion,
} from "./autopilot-rule-suggestions.js";
import { autopilotRulesPath } from "./autopilot-rules.js";

const RULE = "if the tests have not run, send: run the tests and fix what fails";

describe("parseRuleSuggestion", () => {
  it("reads a RULE line", () => {
    expect(parseRuleSuggestion(`RULE: ${RULE}`)).toBe(RULE);
  });

  it("accepts a bare, bulleted, quoted or fenced rule", () => {
    expect(parseRuleSuggestion(RULE)).toBe(RULE);
    expect(parseRuleSuggestion(`- RULE: ${RULE}`)).toBe(RULE);
    expect(parseRuleSuggestion(`RULE: "${RULE}"`)).toBe(RULE);
    expect(parseRuleSuggestion("```\nRULE: " + RULE + "\n```")).toBe(RULE);
  });

  it("reads NONE (and other no-rule answers) as no suggestion", () => {
    for (const reply of ["NONE", "none.", "  None  ", "IGNORE", "HUMAN\nneeds you", "ALL_CLEAR"]) {
      expect(parseRuleSuggestion(reply)).toBeNull();
    }
    expect(parseRuleSuggestion("")).toBeNull();
  });

  it("rejects anything that isn't a one-line if-rule", () => {
    expect(parseRuleSuggestion("RULE: always run the tests")).toBeNull();
    expect(parseRuleSuggestion("The user prefers tests. RULE: " + RULE)).toBeNull();
    expect(parseRuleSuggestion(`RULE: if ${"x".repeat(400)}`)).toBeNull();
  });
});

describe("buildRuleSuggestionPrompt", () => {
  it("carries the stop, the reply and the existing rules, and asks for one line or NONE", () => {
    const prompt = buildRuleSuggestionPrompt({
      stop: { reason: "Unverified: no checks ran", originalRequest: "add a login form" },
      reply: "just run the tests yourself next time",
      existingRules: "- if lint fails, send: fix lint",
    });
    expect(prompt).toContain("Unverified: no checks ran");
    expect(prompt).toContain("add a login form");
    expect(prompt).toContain("just run the tests yourself next time");
    expect(prompt).toContain("- if lint fails, send: fix lint");
    expect(prompt).toContain("RULE: if <situation>, send: <instruction for GG Coder>");
    expect(prompt).toContain("reply exactly NONE");
  });

  it("says when there are no rules yet", () => {
    const prompt = buildRuleSuggestionPrompt({
      stop: { reason: "r", originalRequest: "q" },
      reply: "a",
      existingRules: "",
    });
    expect(prompt).toContain("### Rules already in .gg/autopilot-rules.md\n(none)");
  });
});

describe("normalizeRuleLine", () => {
  it("makes exactly one markdown list line", () => {
    expect(normalizeRuleLine(`  ${RULE}\n  and more `)).toBe(`- ${RULE} and more`);
    expect(normalizeRuleLine(`- ${RULE}`)).toBe(`- ${RULE}`);
  });

  it("rejects empty or overlong text", () => {
    expect(normalizeRuleLine("  \n ")).toBeNull();
    expect(normalizeRuleLine("x".repeat(501))).toBeNull();
  });
});

describe("appendAutopilotRule", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "autopilot-rule-append-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates .gg/ and writes exactly one line", async () => {
    const line = await appendAutopilotRule(dir, RULE);
    expect(line).toBe(`- ${RULE}`);
    expect(await fs.readFile(autopilotRulesPath(dir), "utf-8")).toBe(`- ${RULE}\n`);
    // The lock file is gone once the write is done.
    expect(await fs.readdir(path.join(dir, ".gg"))).toEqual(["autopilot-rules.md"]);
  });

  it("appends after existing rules, adding a missing final newline", async () => {
    await fs.mkdir(path.join(dir, ".gg"));
    await fs.writeFile(autopilotRulesPath(dir), "# My rules\n- if lint fails, send: fix lint");
    await appendAutopilotRule(dir, RULE);
    expect(await fs.readFile(autopilotRulesPath(dir), "utf-8")).toBe(
      `# My rules\n- if lint fails, send: fix lint\n- ${RULE}\n`,
    );
  });

  it("keeps both of two concurrent saves", async () => {
    await Promise.all([
      appendAutopilotRule(dir, "if a, send: b"),
      appendAutopilotRule(dir, "if c, send: d"),
    ]);
    const lines = (await fs.readFile(autopilotRulesPath(dir), "utf-8")).trim().split("\n");
    expect(lines.sort()).toEqual(["- if a, send: b", "- if c, send: d"]);
  });

  it("refuses invalid text and writes nothing", async () => {
    await expect(appendAutopilotRule(dir, "   ")).rejects.toThrow();
    await expect(fs.access(autopilotRulesPath(dir))).rejects.toThrow();
  });
});

describe("AutopilotRuleSuggestions", () => {
  function make(): {
    suggestions: AutopilotRuleSuggestions;
    frames: Array<{ type: string; data: unknown }>;
  } {
    const frames: Array<{ type: string; data: unknown }> = [];
    return {
      suggestions: new AutopilotRuleSuggestions((type, data) => frames.push({ type, data })),
      frames,
    };
  }
  const STOP = { reason: "Unverified: no checks ran", originalRequest: "add a form" };

  it("has no stop to answer without a prior HUMAN stop", () => {
    const { suggestions, frames } = make();
    expect(suggestions.takeHumanStop()).toBeNull();
    expect(frames).toEqual([]);
  });

  it("hands the HUMAN stop to the next prompt only once", () => {
    const { suggestions } = make();
    suggestions.noteHumanStop(STOP);
    expect(suggestions.takeHumanStop()).toEqual(STOP);
    expect(suggestions.takeHumanStop()).toBeNull();
  });

  it("offers a rule, then Save takes it exactly once", () => {
    const { suggestions, frames } = make();
    const offered = suggestions.offer(suggestions.begin(), `RULE: ${RULE}`);
    expect(offered).toEqual({ id: expect.any(String), text: RULE });
    expect(frames).toEqual([{ type: "autopilot_rule_suggestion", data: offered }]);
    expect(suggestions.take("wrong-id")).toBeNull();
    expect(suggestions.take(offered?.id ?? "")).toEqual(offered);
    expect(suggestions.take(offered?.id ?? "")).toBeNull();
  });

  it("offers nothing for NONE", () => {
    const { suggestions, frames } = make();
    expect(suggestions.offer(suggestions.begin(), "NONE")).toBeNull();
    expect(suggestions.pending).toBeNull();
    expect(frames).toEqual([]);
  });

  it("drops a call that went stale (cancel, abort or new prompt) before it answered", () => {
    const { suggestions, frames } = make();
    const token = suggestions.begin();
    suggestions.clear();
    expect(suggestions.offer(token, `RULE: ${RULE}`)).toBeNull();
    expect(frames).toEqual([]);
  });

  it("a new prompt clears the pending suggestion and tells the webview", () => {
    const { suggestions, frames } = make();
    const offered = suggestions.offer(suggestions.begin(), `RULE: ${RULE}`);
    suggestions.takeHumanStop();
    expect(suggestions.pending).toBeNull();
    expect(frames.at(-1)).toEqual({
      type: "autopilot_rule_suggestion_cleared",
      data: { id: offered?.id },
    });
    expect(suggestions.take(offered?.id ?? "")).toBeNull();
  });

  it("restores a taken suggestion after a failed write, unless cleared meanwhile", () => {
    const { suggestions } = make();
    const first = suggestions.offer(suggestions.begin(), `RULE: ${RULE}`);
    const taken = suggestions.take(first?.id ?? "");
    if (!taken) throw new Error("expected a pending suggestion");
    suggestions.restore(taken);
    expect(suggestions.pending).toEqual(first);

    const again = suggestions.take(first?.id ?? "");
    if (!again) throw new Error("expected a pending suggestion");
    suggestions.clear();
    suggestions.restore(again);
    expect(suggestions.pending).toBeNull();
  });

  it("a new session forgets both the stop and the suggestion", () => {
    const { suggestions } = make();
    suggestions.noteHumanStop(STOP);
    suggestions.offer(suggestions.begin(), `RULE: ${RULE}`);
    suggestions.reset();
    expect(suggestions.pending).toBeNull();
    expect(suggestions.takeHumanStop()).toBeNull();
  });
});
