#!/usr/bin/env tsx
/**
 * Dispatch eval runs to Vercel Sandbox microVMs — a drop-in stand-in for the
 * GitHub Actions matrix in eval-refresh.yml (AI-912 spike).
 *
 *   pnpm eval:vercel -- --experiment claude-haiku-4.5 \
 *     --eval investigate-db-001-table-row-counts,build-cli-001-bootstrap-app \
 *     --runs 1
 *
 * Requires in .env (or the environment):
 *   VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID  — sandbox auth
 *   GITHUB_TOKEN                                     — repo checkout (internal repo)
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY               — forwarded to the agents
 */

import { execFileSync, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPairs, type EvalPair } from "./discover.js";
import {
  runPairInSandbox,
  type SandboxJobPhase,
  type SandboxJobResult,
} from "./sandbox-job.js";
import { ensureSnapshot } from "./snapshot.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Setup (docker + pnpm install) and scoring headroom around the eval runs. */
const SANDBOX_SETUP_HEADROOM_MIN = 20;

/** Fleet progress heartbeat interval — one scoreboard line per minute. */
const HEARTBEAT_INTERVAL_MS = 60_000;

const PHASE_ORDER: SandboxJobPhase[] = ["create", "bootstrap", "eval", "collect"];

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = rawArgs.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = rawArgs.indexOf(`--${name}`);
  if (index !== -1) {
    const value = rawArgs[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`--${name} requires a value`);
    }
    return value;
  }
  return undefined;
}

function readList(name: string): string[] {
  return (readFlag(name) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — ${hint}`);
  return value;
}

async function main() {
  const dry = rawArgs.includes("--dry");
  const runs = Number(readFlag("runs") ?? 2);
  const timeoutSec = Number(readFlag("timeout-sec") ?? 720);
  const vcpus = Number(readFlag("vcpus") ?? 4);
  const concurrency = Number(readFlag("concurrency") ?? 4);
  const suites = readList("suite");
  const experimentSuites = readList("experiment-suite");

  const pairs = await discoverPairs({
    root: ROOT,
    evalIds: readList("eval"),
    experiments: readList("experiment"),
    suites: suites.length > 0 ? suites : ["benchmark"],
    experimentSuites:
      experimentSuites.length > 0 ? experimentSuites : ["benchmark", "no-skills"],
  });
  if (pairs.length === 0) throw new Error("no experiment and eval pairs matched");

  const revision = readFlag("revision") ?? git("rev-parse", "HEAD");
  const sandboxTimeoutMs =
    Number(
      readFlag("sandbox-timeout-min") ??
        Math.ceil((runs * timeoutSec) / 60) + SANDBOX_SETUP_HEADROOM_MIN,
    ) *
    60_000;

  console.log(
    `${pairs.length} pair(s), runs=${runs}, timeout=${timeoutSec}s, ` +
      `vcpus=${vcpus}, concurrency=${concurrency}, sandbox timeout=${sandboxTimeoutMs / 60000}m, rev=${revision.slice(0, 8)}`,
  );
  for (const pair of pairs) {
    console.log(`PLAN ${pair.experiment} x ${pair.evalId}`);
  }
  if (dry) return;

  // The SDK reads VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID (or an OIDC
  // token) from the environment; fail fast with a useful message instead.
  if (!process.env.VERCEL_OIDC_TOKEN) {
    requireEnv("VERCEL_TOKEN", "create one at https://vercel.com/account/settings/tokens");
    requireEnv("VERCEL_TEAM_ID", "team settings → General → Team ID");
    requireEnv("VERCEL_PROJECT_ID", "project settings → General → Project ID");
  }
  const githubToken = requireEnv(
    "GITHUB_TOKEN",
    "the sandbox clones this internal repo over HTTPS (`gh auth token` works)",
  );

  // The commit must be on the remote for the sandbox to fetch it.
  if (!readFlag("revision")) {
    const onRemote = git("branch", "-r", "--contains", revision);
    if (!onRemote) {
      throw new Error(
        `HEAD (${revision.slice(0, 8)}) is not on any remote branch — push first, or pass --revision`,
      );
    }
    if (git("status", "--porcelain")) {
      console.warn("warning: working tree is dirty; the sandbox runs the pushed commit, not local changes");
    }
  }

  const agentEnv: Record<string, string> = {};
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
    if (process.env[key]) agentEnv[key] = process.env[key]!;
  }

  const repoUrl = git("remote", "get-url", "origin").replace(
    /^git@github\.com:/,
    "https://github.com/",
  );

  // Warm-boot snapshot: docker, node_modules, the agent sandbox image, and
  // the Supabase stack images pre-baked, cutting per-pair bootstrap from
  // ~5 minutes to well under one. Built once per input key (~10m); any
  // failure falls back to cold git-source boots.
  const snapshotId = rawArgs.includes("--no-snapshot")
    ? undefined
    : await ensureSnapshot({
        root: ROOT,
        repoUrl,
        revision,
        githubToken,
        vcpus,
      });

  // Same fan-out/parallelism model as the Actions matrix: every pair gets its
  // own isolated machine; only the number in flight at once is capped.
  const queue: EvalPair[] = [...pairs];
  const results: SandboxJobResult[] = [];
  const inFlight = new Map<string, { phase: SandboxJobPhase; since: number }>();
  const startedAt = Date.now();

  // Once-a-minute scoreboard so a wide fan-out stays legible in CI logs:
  // completions, per-phase in-flight counts, and the longest-running pair
  // (the one to look at when something hangs).
  const heartbeat = setInterval(() => {
    if (results.length === pairs.length) return;
    const doneOk = results.filter((result) => result.ok).length;
    const passed = results.filter((result) => result.evalPassed === true).length;
    const failed = results.filter((result) => result.evalPassed === false).length;
    const phases = PHASE_ORDER.map(
      (phase) =>
        `${[...inFlight.values()].filter((state) => state.phase === phase).length} ${phase}`,
    ).join(" · ");
    const oldest = [...inFlight.entries()].sort((a, b) => a[1].since - b[1].since)[0];
    const oldestNote = oldest
      ? ` · oldest: ${oldest[0]} in ${oldest[1].phase} ${Math.round((Date.now() - oldest[1].since) / 60000)}m`
      : "";
    console.log(
      `[progress ${Math.round((Date.now() - startedAt) / 60000)}m] ` +
        `${results.length}/${pairs.length} done (${passed} pass · ${failed} fail · ${results.length - doneOk} error) · ` +
        `in flight: ${phases} · ${queue.length} queued${oldestNote}`,
    );
  }, HEARTBEAT_INTERVAL_MS);

  const workers = Array.from(
    { length: Math.min(concurrency, pairs.length) },
    async () => {
      let pair: EvalPair | undefined;
      while ((pair = queue.shift()) !== undefined) {
        const key = `${pair.experiment} x ${pair.evalId}`;
        const dispatch = () =>
          runPairInSandbox({
            pair: pair!,
            onPhase: (phase) => inFlight.set(key, { phase, since: Date.now() }),
            repoUrl,
            revision,
            githubToken,
            snapshotId,
            runs,
            timeoutSec,
            vcpus,
            sandboxTimeoutMs,
            agentEnv,
            resultsDir: join(ROOT, "results"),
          });
        let result = await dispatch();
        // One fresh-sandbox retry for job errors (infra by definition —
        // scored FAILs return ok and don't come through here). At matrix
        // scale a fraction-of-a-percent transient rate would otherwise fail
        // most full runs; the matrix equivalent was a manual re-run of the
        // failed job.
        if (!result.ok) {
          console.log(`🔁 retrying ${key} in a fresh sandbox after: ${result.error}`);
          result = await dispatch();
        }
        results.push(result);
        inFlight.delete(key);
      }
    },
  );
  try {
    await Promise.all(workers);
  } finally {
    clearInterval(heartbeat);
  }

  console.log("\n=== summary ===");
  for (const result of results) {
    const minutes = (result.durationMs / 60000).toFixed(1);
    const verdict =
      result.evalPassed === undefined
        ? ""
        : `, eval ${result.evalPassed ? "PASS" : "FAIL"}`;
    console.log(
      `${result.ok ? "✅" : "💥"} ${result.pair.experiment} x ${result.pair.evalId} ` +
        `(${minutes}m${verdict}${result.ok ? "" : `, ${result.error}`})`,
    );
  }
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    throw new Error(`${failed.length} sandbox job(s) failed`);
  }

  exportResults(pairs, rawArgs.includes("--merge"));
}

/**
 * The publish step of eval-refresh.yml's `publish-results` job: export the
 * collected results into the web app's data files, per eval suite present in
 * the matrix. Like CI, it runs only when every job succeeded, and evals
 * outside the benchmark/regression suites are not published. Committing or
 * PR-ing the JSON stays with the caller.
 */
const EXPORT_OUTPUT_BY_SUITE: Record<string, string> = {
  benchmark: "apps/web/src/data/eval-results.json",
  regression: "apps/web/src/data/regression-eval-results.json",
};

function exportResults(pairs: EvalPair[], merge: boolean): void {
  for (const [suite, output] of Object.entries(EXPORT_OUTPUT_BY_SUITE)) {
    const suitePairs = pairs.filter((pair) => pair.evalSuite === suite);
    if (suitePairs.length === 0) continue;
    console.log(`\nexporting ${suite} results → ${output}`);
    // Unlike CI — whose workspace only ever contains this run's downloaded
    // artifacts — a dev machine's results/ tree carries older local runs, so
    // scope the export to exactly what this dispatch produced.
    const experiments = [...new Set(suitePairs.map((pair) => pair.experiment))];
    const evalIds = [...new Set(suitePairs.map((pair) => pair.evalId))];
    const result = spawnSync(
      "pnpm",
      [
        "--filter",
        "@supabase-evals/framework",
        "export-results",
        "--",
        "--suite",
        suite,
        ...experiments.flatMap((name) => ["--experiment", name]),
        ...evalIds.flatMap((id) => ["--eval", id]),
        "--output",
        output,
        ...(merge ? ["--merge"] : []),
      ],
      { cwd: ROOT, stdio: "inherit" },
    );
    if (result.status !== 0) {
      throw new Error(`export-results failed for suite ${suite}`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
