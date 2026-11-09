import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VerificationGate } from "../verification-gate.js";
import { VerificationTracker } from "./verification-tracker.js";

/**
 * GODIK CODER: why did a Mentor-ordre hold with "no successful check covers
 * the current changes" right after GC ran `node --test` green in a folder
 * without package.json?
 *
 * Files written + a REAL `node --test` run in that folder, fed through the
 * host's real tracker and gate exactly as the agent session does. The folder
 * has no package.json in every case, so that is not the cause: what decides
 * is whether the run happened in the persistent shell (`persist: true`).
 */
let dir: string;
let calls = 0;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-node-test-"));
  calls = 0;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const SOURCE = "export const slug = (s) => s.toLowerCase().replace(/\\s+/g, '-');\n";
const TEST =
  'import { test } from "node:test";\nimport assert from "node:assert/strict";\n' +
  'import { slug } from "./slug.mjs";\ntest("slug", () => assert.equal(slug("A B"), "a-b"));\n';

async function call(
  tracker: VerificationTracker,
  name: string,
  args: Record<string, unknown>,
  result: string,
): Promise<void> {
  const toolCallId = `call-${++calls}`;
  await tracker.recordToolCallStart({ type: "tool_call_start", toolCallId, name, args });
  await tracker.recordToolCallEnd(
    { type: "tool_call_end", toolCallId, result, isError: false, durationMs: 1 },
    tracker.getToolCall(toolCallId),
    false,
  );
}

/** Write both files for real, recording them like the write tool does. */
async function writeFiles(tracker: VerificationTracker): Promise<void> {
  for (const [name, body] of [
    ["slug.mjs", SOURCE],
    ["slug.test.mjs", TEST],
  ] as const) {
    const file = path.join(dir, name);
    await fs.writeFile(file, body);
    await call(tracker, "write", { file_path: file, content: body }, `Wrote ${file}`);
  }
}

/** Really run `node --test` in the folder; the result text is what bash returns. */
function runNodeTest(): string {
  const run = spawnSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8" });
  return `Exit code: ${run.status}\n${run.stdout}${run.stderr}`;
}

function setup() {
  const gate = new VerificationGate();
  gate.beginRun();
  const tracker = new VerificationTracker(gate, dir, () => [], true);
  return { gate, tracker };
}

describe("node --test in a folder without package.json", () => {
  it("the folder really has no package.json and the run really passes", async () => {
    const { tracker } = setup();
    await writeFiles(tracker);
    await expect(fs.access(path.join(dir, "package.json"))).rejects.toThrow();
    expect(runNodeTest()).toMatch(/^Exit code: 0\n[\s\S]*pass 1/);
  });

  it("a plain run (no persistent shell) is passed evidence that covers the written files", async () => {
    const { gate, tracker } = setup();
    await writeFiles(tracker);
    expect(tracker.verificationProblem()).toMatch(/no successful check covers/);
    await call(tracker, "bash", { command: "node --test" }, runNodeTest());
    expect(tracker.verificationProblem()).toBeNull();
    expect(gate.evidence("run")).toEqual([
      expect.objectContaining({ command: "node --test", status: "passed" }),
    ]);
  });

  it("`cd <folder> && node --test` also counts", async () => {
    const { tracker } = setup();
    await writeFiles(tracker);
    await call(tracker, "bash", { command: `cd ${dir} && node --test` }, runNodeTest());
    expect(tracker.verificationProblem()).toBeNull();
  });

  // The case from the installed app: `cd` in the persistent shell, then
  // `node --test` in the same persistent shell. The host records NOTHING for
  // a persistent-shell check (on purpose, see recordToolCallEnd), so the
  // written files stay uncovered and the order held.
  it("the same green run in the persistent shell (persist: true) is not evidence: the gate stays owed", async () => {
    const { gate, tracker } = setup();
    await writeFiles(tracker);
    await call(tracker, "bash", { command: `cd ${dir}`, persist: true }, `Exit code: 0\n`);
    await call(tracker, "bash", { command: "node --test", persist: true }, runNodeTest());
    expect(tracker.verificationProblem()).toBe(
      "Unverified: no successful check covers the current changes. Run the project's verification before approval.",
    );
    expect(gate.evidence("run").filter((e) => e.command === "node --test")).toEqual([]);
  });
});
