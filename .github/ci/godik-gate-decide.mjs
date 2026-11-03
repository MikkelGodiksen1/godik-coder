#!/usr/bin/env node
// godik-gate-decide — the release verdict for godik-gate.yml.
// Reads the gate run's own job list and passes only if every job from the
// called ci.yml succeeded on the expected SHA. One narrow exception: the macOS
// *test* job may be cancelled before it ever got a runner (GitHub had no Mac
// available). Anything unknown fails closed.
// Usage (in godik-gate.yml's decide job):
//   GH_TOKEN=… REPO=owner/name RUN_ID=… EXPECTED_SHA=… node .github/ci/godik-gate-decide.mjs
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CI_PREFIX = "ci / ";
export const REQUIRED = [
  "ubuntu-latest · node 22.x",
  "windows-latest · node 22.x",
  "app · ubuntu-latest",
  "app · macos-latest",
  "app · windows-latest",
];
export const MACOS_TEST = "macos-latest · node 22.x";

function isNoRunnerCancel(job) {
  return (
    job.conclusion === "cancelled" &&
    !job.runner_name &&
    (!Array.isArray(job.steps) || job.steps.length === 0)
  );
}

export function decide({ run, jobs, expectedSha, workflowSha = expectedSha }) {
  const reasons = [];
  const warnings = [];
  const rows = [];

  if (!expectedSha || run?.head_sha !== expectedSha || workflowSha !== expectedSha) {
    reasons.push(
      `SHA mismatch: run head_sha=${run?.head_sha ?? "?"}, sha input=${expectedSha || "?"}, github.sha=${workflowSha || "?"}`,
    );
  }

  const ciJobs = jobs
    .filter((job) => typeof job.name === "string" && job.name.startsWith(CI_PREFIX))
    .map((job) => ({ ...job, short: job.name.slice(CI_PREFIX.length) }))
    .sort((a, b) => (a.short < b.short ? -1 : a.short > b.short ? 1 : 0));

  for (const name of REQUIRED) {
    if (!ciJobs.some((job) => job.short === name)) {
      reasons.push(
        `Required job "${name}" is missing. Ken renamed or removed a CI job, update REQUIRED in godik-gate-decide.mjs`,
      );
      rows.push({ job: name, result: "missing", runner: "", verdict: "BLOCK", url: "" });
    }
  }

  for (const job of ciJobs) {
    const result = job.status === "completed" ? (job.conclusion ?? "none") : job.status;
    let verdict;
    if (job.status === "completed" && job.conclusion === "success") {
      verdict = "ok";
    } else if (job.short === MACOS_TEST && job.status === "completed" && isNoRunnerCancel(job)) {
      verdict = "tolerated: no macOS runner";
      warnings.push(`${job.short} was cancelled before any macOS runner picked it up; tolerated.`);
    } else {
      verdict = "BLOCK";
      reasons.push(`${job.short}: ${result}`);
    }
    rows.push({
      job: job.short,
      result,
      runner: job.runner_name || "",
      verdict,
      url: job.html_url ?? "",
    });
  }

  if (ciJobs.length === 0) reasons.push("No ci.yml jobs found in this run.");

  return { ok: reasons.length === 0, rows, reasons, warnings };
}

const cell = (value) => String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderSummary({ ok, rows, reasons, warnings }, { sha, tag } = {}) {
  const lines = [];
  lines.push(`### GODIK gate: ${ok ? "PASSED" : "BLOCKED"}`, "");
  if (tag || sha) lines.push(`Upstream tag \`${tag ?? "?"}\`, candidate \`${sha ?? "?"}\``, "");
  lines.push("| Job | Result | Runner | Verdict |", "|---|---|---|---|");
  for (const row of rows) {
    const job = row.url ? `[${cell(row.job)}](${row.url})` : cell(row.job);
    lines.push(
      `| ${job} | ${cell(row.result)} | ${cell(row.runner || "—")} | ${cell(row.verdict)} |`,
    );
  }
  lines.push("");
  for (const warning of warnings) lines.push(`> ⚠️ ${warning}`);
  if (!ok) {
    lines.push(
      "**BLOCKED: nothing was pushed. main, tags and releases are untouched. The candidate branch is kept for inspection.**",
      "",
    );
    for (const reason of reasons) lines.push(`- ${reason}`);
  }
  lines.push("");
  return lines.join("\n");
}

function ghJson(args) {
  return execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function main() {
  const { REPO, RUN_ID, EXPECTED_SHA, GITHUB_SHA, GITHUB_STEP_SUMMARY, UPSTREAM_TAG } = process.env;
  if (!REPO || !RUN_ID) throw new Error("REPO and RUN_ID must be set");
  const run = JSON.parse(ghJson([`repos/${REPO}/actions/runs/${RUN_ID}`]));
  const jobs = ghJson([
    "--paginate",
    `repos/${REPO}/actions/runs/${RUN_ID}/jobs?filter=latest&per_page=100`,
    "--jq",
    ".jobs[]",
  ])
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  const verdict = decide({ run, jobs, expectedSha: EXPECTED_SHA, workflowSha: GITHUB_SHA });
  const summary = renderSummary(verdict, { sha: EXPECTED_SHA, tag: UPSTREAM_TAG });
  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  for (const warning of verdict.warnings) console.log(`::warning::${warning}`);
  for (const reason of verdict.reasons) console.log(`::error::${reason}`);
  process.exitCode = verdict.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
