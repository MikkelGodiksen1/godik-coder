// Run: node --test .github/ci/godik-gate-decide.test.mjs
// Fixtures are trimmed job lists from real CI push runs; the gate sees the same
// jobs prefixed "ci / " because it calls ci.yml as a reusable workflow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CI_PREFIX, MACOS_TEST, decide, renderSummary } from "./godik-gate-decide.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/godik-gate");

function load(name) {
  const doc = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
  const jobs = doc.jobs.map((job) => ({ ...job, name: `${CI_PREFIX}${job.name}` }));
  // The gate run also lists its own decide job, still running.
  jobs.push({
    name: "decide",
    status: "in_progress",
    conclusion: null,
    runner_name: "x",
    steps: [],
  });
  return { run: { head_sha: doc.head_sha }, jobs, expectedSha: doc.head_sha };
}

function patch(input, shortName, fields) {
  const jobs = input.jobs.map((job) =>
    job.name === `${CI_PREFIX}${shortName}` ? { ...job, ...fields } : job,
  );
  return { ...input, jobs };
}

function allSuccess() {
  const input = load("41524312228.json");
  const jobs = input.jobs.map((job) =>
    job.name.startsWith(CI_PREFIX)
      ? {
          ...job,
          status: "completed",
          conclusion: "success",
          runner_name: "GitHub Actions 1",
          steps: [{ name: "x", conclusion: "success" }],
        }
      : job,
  );
  return { ...input, jobs };
}

test("all ci jobs succeeded -> ok", () => {
  const verdict = decide(allSuccess());
  assert.equal(verdict.ok, true, verdict.reasons.join("; "));
  assert.equal(verdict.rows.length, 6);
  assert.deepEqual(verdict.warnings, []);
});

test("macOS test cancelled with no runner and no steps -> ok with warning", () => {
  // 41524312228: real no-runner cancel of the macOS test job.
  const input = patch(load("41524312228.json"), "app · macos-latest", {
    conclusion: "success",
    runner_name: "GitHub Actions 1",
    steps: [{ name: "x", conclusion: "success" }],
  });
  const verdict = decide(input);
  assert.equal(verdict.ok, true, verdict.reasons.join("; "));
  assert.equal(verdict.warnings.length, 1);
  assert.match(verdict.rows.find((r) => r.job === MACOS_TEST).verdict, /tolerated/);
});

test("macOS test got a runner and failed -> blocked", () => {
  const verdict = decide(load("41522435889-attempt1.json"));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((r) => r.startsWith(`${MACOS_TEST}: failure`)));
});

test("macOS test cancelled after it got a runner -> blocked", () => {
  const input = patch(allSuccess(), MACOS_TEST, { conclusion: "cancelled" });
  assert.equal(decide(input).ok, false);
});

test("macOS app cancelled with no runner -> blocked", () => {
  const verdict = decide(load("41524312228.json"));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((r) => r.startsWith("app · macos-latest: cancelled")));
  assert.equal(verdict.reasons.length, 1);
});

test("Windows test failure -> blocked", () => {
  const verdict = decide(load("41522435889-attempt2.json"));
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.reasons, ["windows-latest · node 22.x: failure"]);
});

test("required job missing -> blocked", () => {
  const input = allSuccess();
  const jobs = input.jobs.filter((job) => job.name !== `${CI_PREFIX}app · windows-latest`);
  const verdict = decide({ ...input, jobs });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join("\n"), /update REQUIRED in godik-gate-decide\.mjs/);
});

test("unknown extra ci job failed -> blocked", () => {
  const input = allSuccess();
  const jobs = [
    ...input.jobs,
    {
      name: `${CI_PREFIX}lint · new`,
      status: "completed",
      conclusion: "failure",
      runner_name: "r",
      steps: [{}],
    },
  ];
  const verdict = decide({ ...input, jobs });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.reasons, ["lint · new: failure"]);
});

test("head_sha differs from expected -> blocked", () => {
  const input = allSuccess();
  assert.equal(decide({ ...input, expectedSha: "deadbeef" }).ok, false);
  assert.equal(decide({ ...input, workflowSha: "deadbeef" }).ok, false);
  assert.equal(decide({ ...input, expectedSha: "" }).ok, false);
});

test("ci job still in progress -> blocked", () => {
  const input = patch(allSuccess(), "app · windows-latest", {
    status: "in_progress",
    conclusion: null,
  });
  const verdict = decide(input);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.reasons, ["app · windows-latest: in_progress"]);
});

test("no ci jobs at all -> blocked", () => {
  assert.equal(decide({ run: { head_sha: "a" }, jobs: [], expectedSha: "a" }).ok, false);
});

test("blocked summary says nothing was pushed", () => {
  const summary = renderSummary(decide(load("41522435889-attempt2.json")), {
    sha: "abc",
    tag: "v1",
  });
  assert.match(summary, /BLOCKED: nothing was pushed\. main, tags and releases are untouched\./);
  assert.match(summary, /\| \[windows-latest · node 22\.x\]\(https:/);
});

test("decide job checks out the run commit, not the sha input", () => {
  // A wrong sha input must reach the SHA check; checking it out instead
  // crashed decide on a commit that lacks this script (gate run 41595580525).
  const workflow = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../workflows/godik-gate.yml"),
    "utf8",
  );
  const decideJob = workflow.slice(
    workflow.indexOf("\n  decide:"),
    workflow.indexOf("\n  publish:"),
  );
  assert.ok(decideJob.includes("actions/checkout@"));
  assert.doesNotMatch(decideJob, /ref:\s*\$\{\{\s*inputs\.sha/);
});
