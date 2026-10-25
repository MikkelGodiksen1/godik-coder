/**
 * GODIK CODER: a compact board of the user's OTHER goals for the mentor's
 * digest, so Ken knows what else is going on without being flooded. One line
 * per goal: name, last activity, what's left (from MEMORY.md) and, for each
 * attached git repo, branch, ahead/behind and the last commit.
 *
 * Kept small on purpose: max 8 goals, 220 chars per line, 7-day activity
 * window, and every git lookup runs in parallel under ONE overall time budget.
 * A mentor question never waits on a slow repo: whatever isn't back in time is
 * left out of the board.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { GOAL_MEMORY_FILE, listGoals, type GoalRecord } from "./goals-store.js";

export const GOAL_BOARD_MAX_GOALS = 8;
export const GOAL_BOARD_LINE_MAX = 220;
export const GOAL_BOARD_ACTIVE_DAYS = 7;
export const GOAL_BOARD_BUDGET_MS = 3000;

const GOAL_FILE = "goal.json";

export interface GoalBoardOptions {
  /** Overall time budget for every git lookup together (default 3s). */
  budgetMs?: number;
  /** "Now" for relative times and the activity window (tests). */
  now?: Date;
}

interface RepoInfo {
  branch: string;
  /** null when the branch has no upstream tracking ref. */
  ahead: number | null;
  behind: number | null;
  subject: string;
  age: string;
  author: string;
}

/** Newest mtime of the goal record and its memory file; null when neither exists. */
async function lastActiveAt(dir: string): Promise<Date | null> {
  let newest: number | null = null;
  for (const file of [GOAL_FILE, GOAL_MEMORY_FILE]) {
    try {
      const st = await fs.stat(path.join(dir, file));
      if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {
      // absent: ignore
    }
  }
  return newest === null ? null : new Date(newest);
}

/** The first "LEFT:" line of MEMORY.md, else its first non-empty, non-heading line; "" when absent. */
async function memoryGist(dir: string): Promise<string> {
  let text: string;
  try {
    text = await fs.readFile(path.join(dir, GOAL_MEMORY_FILE), "utf-8");
  } catch {
    return "";
  }
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^[\s\-*]+/, "").trim())
    .filter((l) => l.length > 0);
  const left = lines.find((l) => /^LEFT\b/i.test(l));
  if (left) return left;
  return lines.find((l) => !l.startsWith("#")) ?? "";
}

export function relativeTime(then: Date, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function git(dir: string, args: string[], signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", dir, ...args], { signal, timeout: GOAL_BOARD_BUDGET_MS }, (err, out) => {
      resolve(err ? null : String(out).trim());
    });
  });
}

/** Local git only (no fetch). null when `dir` is not a git repo or the lookup fails. */
async function repoInfo(dir: string, signal: AbortSignal): Promise<RepoInfo | null> {
  const inside = await git(dir, ["rev-parse", "--is-inside-work-tree"], signal);
  if (inside !== "true") return null;
  const [branch, counts, last] = await Promise.all([
    git(dir, ["rev-parse", "--abbrev-ref", "HEAD"], signal),
    git(dir, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], signal),
    git(dir, ["log", "-1", "--format=%s%x1f%cr%x1f%an"], signal),
  ]);
  if (branch === null || last === null) return null;
  const [subject = "", age = "", author = ""] = last.split("\x1f");
  let ahead: number | null = null;
  let behind: number | null = null;
  if (counts !== null) {
    const [a, b] = counts.split(/\s+/).map((n) => Number.parseInt(n, 10));
    if (Number.isFinite(a) && Number.isFinite(b)) [ahead, behind] = [a, b];
  }
  return { branch, ahead, behind, subject, age, author };
}

function renderRepo(folder: string, info: RepoInfo): string {
  const track =
    info.ahead === null || info.behind === null ? "" : ` +${info.ahead}/-${info.behind}`;
  return `${path.basename(folder)}@${info.branch}${track}: "${info.subject}" (${info.age}, ${info.author})`;
}

function clip(line: string): string {
  return line.length <= GOAL_BOARD_LINE_MAX ? line : `${line.slice(0, GOAL_BOARD_LINE_MAX - 1)}…`;
}

/**
 * Markdown bullet list of the other active goals, newest first; "" when none
 * qualify. `currentGoalDir` is null in a plain code session (every goal shows).
 */
export async function buildGoalBoard(
  goalsRoot: string,
  currentGoalDir: string | null,
  options: GoalBoardOptions = {},
): Promise<string> {
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - GOAL_BOARD_ACTIVE_DAYS * 24 * 60 * 60 * 1000;
  const current = currentGoalDir === null ? null : path.resolve(currentGoalDir);

  const candidates: Array<{ dir: string; record: GoalRecord; active: Date }> = [];
  for (const { dir, record } of await listGoals(goalsRoot)) {
    if (current !== null && path.resolve(dir) === current) continue;
    if (record.pausedAt) continue;
    const active = await lastActiveAt(dir);
    if (active === null || active.getTime() < cutoff) continue;
    candidates.push({ dir, record, active });
  }
  candidates.sort((a, b) => b.active.getTime() - a.active.getTime());
  const picked = candidates.slice(0, GOAL_BOARD_MAX_GOALS);
  if (picked.length === 0) return "";

  // Every git lookup at once, under one budget. When the clock runs out the
  // pending lookups are aborted and their repos are simply left off the line.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.budgetMs ?? GOAL_BOARD_BUDGET_MS);
  const lines = await Promise.all(
    picked.map(async ({ dir, record, active }) => {
      const [gist, repos] = await Promise.all([
        memoryGist(dir),
        Promise.all(
          record.context
            .filter((c) => c.kind === "folder")
            .map(async (c) => {
              const info = await repoInfo(c.path, controller.signal);
              return info ? renderRepo(c.path, info) : null;
            }),
        ),
      ]);
      const parts = [`${record.name} (${relativeTime(active, now)})`];
      if (gist) parts.push(gist);
      parts.push(...repos.filter((r): r is string => r !== null));
      return clip(`- ${parts.join(" · ")}`);
    }),
  );
  clearTimeout(timer);
  return lines.join("\n");
}
