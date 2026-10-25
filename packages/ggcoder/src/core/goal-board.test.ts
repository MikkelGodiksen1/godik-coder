import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOAL_BOARD_LINE_MAX, buildGoalBoard } from "./goal-board.js";

let root: string;
let work: string;
const now = new Date("2026-10-25T12:00:00Z");

async function goal(
  name: string,
  opts: { paused?: boolean; context?: string[]; memory?: string | null; ageDays?: number } = {},
): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  const record = {
    schemaVersion: 1,
    id: name,
    name,
    goal: `Do ${name}`,
    context: (opts.context ?? []).map((p) => ({ path: p, kind: "folder" })),
    createdAt: now.toISOString(),
    ...(opts.paused ? { pausedAt: now.toISOString() } : {}),
  };
  await fs.writeFile(path.join(dir, "goal.json"), JSON.stringify(record));
  if (opts.memory !== null) {
    await fs.writeFile(path.join(dir, "MEMORY.md"), opts.memory ?? "# Memory\n- LEFT: finish it\n");
  }
  const when = new Date(now.getTime() - (opts.ageDays ?? 0) * 86_400_000);
  for (const f of ["goal.json", "MEMORY.md"]) {
    await fs.utimes(path.join(dir, f), when, when).catch(() => {});
  }
  return dir;
}

function gitRepo(name: string, commit = "Initial work"): string {
  const dir = path.join(work, name);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    commit,
  ]);
  return dir;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "goal-board-"));
  work = await fs.mkdtemp(path.join(os.tmpdir(), "goal-board-work-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(work, { recursive: true, force: true });
});

describe("buildGoalBoard", () => {
  it("is empty when nothing qualifies", async () => {
    expect(await buildGoalBoard(root, null, { now })).toBe("");
    await goal("only", { paused: true });
    expect(await buildGoalBoard(root, null, { now })).toBe("");
  });

  it("skips the current goal, paused goals and stale goals; newest first", async () => {
    const current = await goal("current");
    await goal("paused", { paused: true });
    await goal("stale", { ageDays: 9 });
    await goal("older", { ageDays: 3, memory: "# M\n- LEFT: ship older\n" });
    await goal("newer", { ageDays: 1, memory: "# M\nnotes first\n- LEFT: ship newer\n" });
    const board = await buildGoalBoard(root, current, { now });
    expect(board).toBe("- newer (24h ago) · LEFT: ship newer\n- older (3d ago) · LEFT: ship older");
  });

  it("shows every goal in a plain code session (no current goal)", async () => {
    await goal("a");
    await goal("b");
    expect((await buildGoalBoard(root, null, { now })).split("\n")).toHaveLength(2);
  });

  it("falls back to the first memory line, and copes with no MEMORY.md", async () => {
    await goal("noleft", { memory: "# Title\n- first decision\n" });
    expect(await buildGoalBoard(root, null, { now })).toBe("- noleft (just now) · first decision");
    await fs.rm(path.join(root, "noleft"), { recursive: true });
    await goal("nomem", { memory: null });
    expect(await buildGoalBoard(root, null, { now })).toBe("- nomem (just now)");
  });

  it("adds branch and last commit for git folders, skipping non-git folders", async () => {
    const repo = gitRepo("app", "Add login");
    const plain = path.join(work, "docs");
    await fs.mkdir(plain);
    await goal("g", { context: [repo, plain] });
    const board = await buildGoalBoard(root, null, { now });
    expect(board).toMatch(
      /^- g \(just now\) · LEFT: finish it · app@main: "Add login" \(.+, Test\)$/,
    );
    expect(board).not.toContain("docs");
  });

  it("truncates long lines", async () => {
    await goal("long", { memory: `- LEFT: ${"x".repeat(400)}\n` });
    const board = await buildGoalBoard(root, null, { now });
    expect(board.length).toBe(GOAL_BOARD_LINE_MAX);
    expect(board.endsWith("…")).toBe(true);
  });

  it("leaves repos off when the time budget is spent", async () => {
    const repo = gitRepo("slow");
    await goal("g", { context: [repo] });
    const board = await buildGoalBoard(root, null, { now, budgetMs: 0 });
    expect(board).toBe("- g (just now) · LEFT: finish it");
  });
});
