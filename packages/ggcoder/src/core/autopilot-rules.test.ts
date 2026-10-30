import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AUTOPILOT_RULES_HEADING,
  AUTOPILOT_RULES_MAX_CHARS,
  autopilotRulesPath,
  readAutopilotRules,
  renderAutopilotRulesSection,
  trustRuleTag,
} from "./autopilot-rules.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autopilot-rules-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeRules(text: string): Promise<void> {
  await fs.mkdir(path.join(dir, ".gg"), { recursive: true });
  await fs.writeFile(autopilotRulesPath(dir), text);
}

describe("readAutopilotRules", () => {
  it("returns nothing when the file is missing", async () => {
    expect(await readAutopilotRules(dir)).toBe("");
  });

  it("returns nothing for a blank file", async () => {
    await writeRules("  \n\n\t\n");
    expect(await readAutopilotRules(dir)).toBe("");
  });

  it("returns the trimmed rules", async () => {
    await writeRules("\n- if tests are red, send: fix the failing test and rerun it\n\n");
    expect(await readAutopilotRules(dir)).toBe(
      "- if tests are red, send: fix the failing test and rerun it",
    );
  });

  it("reads the file fresh each time", async () => {
    await writeRules("- rule one");
    expect(await readAutopilotRules(dir)).toBe("- rule one");
    await writeRules("- rule two");
    expect(await readAutopilotRules(dir)).toBe("- rule two");
  });

  it("caps a long file and says it was truncated", async () => {
    await writeRules("x".repeat(AUTOPILOT_RULES_MAX_CHARS * 10));
    const rules = await readAutopilotRules(dir);
    expect(rules.startsWith("x".repeat(AUTOPILOT_RULES_MAX_CHARS))).toBe(true);
    expect(rules).toContain("[Rules truncated at 4000 characters.]");
    expect(rules.length).toBeLessThan(AUTOPILOT_RULES_MAX_CHARS + 60);
  });
});

describe("renderAutopilotRulesSection", () => {
  it("renders nothing without rules", () => {
    expect(renderAutopilotRulesSection("")).toBe("");
    expect(renderAutopilotRulesSection("  \n ")).toBe("");
  });

  it("renders the heading, the tag contract and the rules", () => {
    const section = renderAutopilotRulesSection("- if lint fails, send: fix lint");
    expect(section.startsWith(AUTOPILOT_RULES_HEADING)).toBe(true);
    expect(section).toContain("PROMPT RULE:");
    expect(section).toContain("never replace a needed HUMAN decision");
    expect(section).toContain("never make failing or unverified work ALL_CLEAR");
    expect(section.endsWith("- if lint fails, send: fix lint")).toBe(true);
  });
});

describe("trustRuleTag", () => {
  const tagged = { kind: "prompt" as const, body: "fix it", rule: "tests red" };

  it("keeps the tag when rules were shown", () => {
    expect(trustRuleTag(tagged, "- if tests are red, send: fix it")).toEqual(tagged);
  });

  it("drops the tag but keeps the prompt when no rules were shown", () => {
    expect(trustRuleTag(tagged, "")).toEqual({ kind: "prompt", body: "fix it" });
  });

  it("leaves other verdicts alone", () => {
    expect(trustRuleTag({ kind: "all_clear" }, "")).toEqual({ kind: "all_clear" });
    expect(trustRuleTag({ kind: "human", reason: "r" }, "")).toEqual({
      kind: "human",
      reason: "r",
    });
  });
});
