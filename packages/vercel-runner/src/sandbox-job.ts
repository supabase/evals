/**
 * One (experiment × eval) pair inside one Vercel Sandbox microVM — the
 * Firecracker equivalent of a `run-evals` matrix job in eval-refresh.yml.
 *
 * The VM plays the role the GitHub Actions runner plays today: it checks out
 * the repo, installs pnpm dependencies, and runs `pnpm eval`. Docker keeps the
 * exact same shape it has on a runner — the harness starts the agent's sandbox
 * container against the VM's own dockerd, and for local-stack evals the
 * Supabase CLI inside that container spawns the stack as sibling containers on
 * that same daemon. Nothing in packages/sandbox changes; only the machine the
 * daemon runs on does.
 */

import { mkdirSync, rmSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Sandbox } from "@vercel/sandbox";
import type { EvalPair } from "./discover.js";

const execFileAsync = promisify(execFile);

/** Where the git source is checked out inside the sandbox. */
const SANDBOX_CWD = "/vercel/sandbox";

/** Ready-poll budget for dockerd inside the VM. */
const DOCKERD_READY_TIMEOUT_SEC = 60;

/**
 * Backoff schedule for retrying sandbox creation. A full-matrix fan-out can
 * brush the vCPU allocation rate limit or hit a transient API error; like the
 * sandbox-image build retry in packages/sandbox, every failure is retried (no
 * stable error taxonomy) and a deterministic failure merely wastes the
 * schedule before surfacing.
 */
const CREATE_RETRY_DELAYS_MS = [20_000, 60_000];

/** Poll cadence for detached step commands (status + incremental log tail). */
const STEP_POLL_INTERVAL_MS = 5_000;

/**
 * Minimum spacing between sandbox creations across the whole dispatch. Pro
 * allocates at most 200 vCPUs/min; at 4 vCPUs per sandbox that's 50
 * creations/min, so ~1.3s spacing (≈46/min) ramps a wide fan-out cleanly
 * instead of bouncing off 429s. Concurrency (sandboxes in flight) is
 * effectively unlimited by comparison (2,000 on Pro).
 */
const CREATE_SPACING_MS = 1_300;
let nextCreateSlotAt = 0;

async function waitForCreateSlot(): Promise<void> {
  for (;;) {
    const now = Date.now();
    if (now >= nextCreateSlotAt) {
      // Synchronous check-and-claim: no await between read and write, so
      // concurrent jobs on the single event loop can't grab the same slot.
      nextCreateSlotAt = now + CREATE_SPACING_MS;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, nextCreateSlotAt - now));
  }
}

/** Coarse lifecycle phase of a pair's sandbox, for fleet progress reporting. */
export type SandboxJobPhase = "create" | "bootstrap" | "eval" | "collect";

export interface SandboxJobOptions {
  pair: EvalPair;
  /** Phase-transition callback for the dispatcher's progress heartbeat. */
  onPhase?: (phase: SandboxJobPhase) => void;
  /** HTTPS clone URL of this repo. */
  repoUrl: string;
  /** Commit SHA to run — must be reachable on the remote. */
  revision: string;
  /** Token able to read the repo (it's internal) — goes into the git source. */
  githubToken: string;
  runs: number;
  timeoutSec: number;
  vcpus: number;
  /** Session timeout for the whole VM. */
  sandboxTimeoutMs: number;
  /** Model-provider keys written to the sandbox's .env for `pnpm eval`. */
  agentEnv: Record<string, string>;
  /** Local directory the sandbox's results/ tree is extracted into. */
  resultsDir: string;
}

/**
 * Explicit Vercel API credentials, when the environment carries them. The SDK
 * does NOT read VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID on its own — its
 * only fallbacks are $VERCEL_OIDC_TOKEN and interactively cached dev
 * credentials (`vercel link`), and CI has neither.
 */
function credentialsFromEnv():
  | { token: string; teamId: string; projectId: string }
  | undefined {
  const { VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID } = process.env;
  if (!VERCEL_TOKEN || !VERCEL_TEAM_ID || !VERCEL_PROJECT_ID) return undefined;
  return {
    token: VERCEL_TOKEN,
    teamId: VERCEL_TEAM_ID,
    projectId: VERCEL_PROJECT_ID,
  };
}

export interface SandboxJobResult {
  pair: EvalPair;
  ok: boolean;
  /** Failure summary when ok is false. */
  error?: string;
  /** Scored eval outcome from the extracted result JSON, when readable. */
  evalPassed?: boolean;
  durationMs: number;
  sandboxId?: string;
}

/** Prefix every output line so interleaved parallel jobs stay readable. */
function prefixedWriter(prefix: string, target: NodeJS.WriteStream): Writable {
  let pending = "";
  return new Writable({
    write(chunk, _encoding, callback) {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) target.write(`${prefix} ${line}\n`);
      callback();
    },
    final(callback) {
      if (pending) target.write(`${prefix} ${pending}\n`);
      callback();
    },
  });
}

export async function runPairInSandbox(
  options: SandboxJobOptions,
): Promise<SandboxJobResult> {
  const { pair } = options;
  const label = `[${pair.experiment} × ${pair.evalId}]`;
  const stdout = prefixedWriter(label, process.stdout);
  const stderr = prefixedWriter(label, process.stderr);
  const log = (message: string) => stdout.write(`${message}\n`);
  const start = Date.now();

  let sandbox: Sandbox | undefined;
  try {
    log(`creating sandbox (vcpus=${options.vcpus}, timeout=${Math.round(options.sandboxTimeoutMs / 60000)}m, rev=${options.revision.slice(0, 8)})`);
    options.onPhase?.("create");
    for (let attempt = 0; ; attempt++) {
      try {
        await waitForCreateSlot();
        sandbox = await Sandbox.create({
          ...credentialsFromEnv(),
          runtime: "node22",
          resources: { vcpus: options.vcpus },
          timeout: options.sandboxTimeoutMs,
          // Makes the Vercel dashboard's Sandboxes view a live per-CI-run
          // board, filterable by these keys (max 5 tags).
          tags: {
            runner: "supabase-evals",
            run: process.env.GITHUB_RUN_ID ?? "local",
            experiment: pair.experiment,
            eval: pair.evalId,
          },
          source: {
            type: "git",
            url: options.repoUrl,
            revision: options.revision,
            // Vercel clones with these as basic-auth; x-access-token is
            // GitHub's conventional username for token auth.
            username: "x-access-token",
            password: options.githubToken,
          },
        });
        break;
      } catch (err) {
        const delayMs = CREATE_RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined) throw err;
        stderr.write(
          `sandbox creation failed (attempt ${attempt + 1}/${CREATE_RETRY_DELAYS_MS.length + 1}), ` +
            `retrying in ${delayMs / 1000}s: ${err instanceof Error ? err.message : err}\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    log(`sandbox ${sandbox.name} created`);
    options.onPhase?.("bootstrap");

    // Every step runs decoupled from any live log stream: launch detached
    // with output going to a file in the VM, then poll with short commands
    // (status sentinel + incremental tail). A command held on one streaming
    // connection dies with "Stream ended before command finished" when that
    // connection drops even though the command and the VM are fine — at
    // full-matrix scale (~1,000 step commands per run) that's a certainty,
    // and it killed bootstrap steps in practice, not just the long eval.
    let stepCounter = 0;
    const run = async (
      step: string,
      cmd: string,
      opts: { sudo?: boolean } = {},
    ) => {
      log(`--- ${step}`);
      const id = ++stepCounter;
      const logPath = `/tmp/step-${id}.log`;
      const exitPath = `/tmp/step-${id}.exit`;
      await sandbox!.runCommand({
        cmd: "bash",
        args: [
          "-c",
          `(set -euo pipefail\n${cmd}\n) >${logPath} 2>&1; echo $? >${exitPath}`,
        ],
        cwd: SANDBOX_CWD,
        sudo: opts.sudo,
        detached: true,
      });

      let offset = 0;
      let pollFailures = 0;
      const emitNewOutput = async (limit?: number) => {
        const chunk = await sandbox!.runCommand({
          cmd: "bash",
          args: [
            "-c",
            `tail -c +${offset + 1} ${logPath}${limit ? ` | head -c ${limit}` : ""}`,
          ],
        });
        const data = await chunk.stdout();
        if (data) {
          offset += Buffer.byteLength(data);
          stdout.write(data);
        }
      };
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, STEP_POLL_INTERVAL_MS));
        try {
          await emitNewOutput(262_144);
          const status = await sandbox!.runCommand({
            cmd: "bash",
            args: ["-c", `[ -f ${exitPath} ] && cat ${exitPath} || echo RUNNING`],
          });
          const text = (await status.stdout()).trim();
          pollFailures = 0;
          if (text === "RUNNING") continue;
          // Output written between the last chunk and completion is still in
          // the file; drain it before reporting the outcome.
          await emitNewOutput();
          if (text === "0") return;
          throw new Error(`step "${step}" exited with code ${text}`);
        } catch (err) {
          if (err instanceof Error && err.message.startsWith(`step "`)) throw err;
          // Transient control-plane hiccups shouldn't kill a healthy run.
          pollFailures += 1;
          if (pollFailures >= 6) throw err;
          stderr.write(
            `poll failed (${pollFailures}/6), retrying: ${err instanceof Error ? err.message : err}\n`,
          );
        }
      }
    };

    // -- Bootstrap: what actions/checkout + setup-node + the runner image give
    // us for free on GitHub Actions.
    await run("install docker", "dnf install -y -q docker", { sudo: true });
    await sandbox.runCommand({ cmd: "dockerd", sudo: true, detached: true });
    await run(
      "wait for dockerd",
      `for i in $(seq ${DOCKERD_READY_TIMEOUT_SEC}); do docker info >/dev/null 2>&1 && exit 0; sleep 1; done; echo "dockerd not ready" >&2; exit 1`,
      { sudo: true },
    );
    // The harness shells out to `docker` as the unprivileged user; inside a
    // single-tenant ephemeral VM, opening the socket is the simple safe way.
    await run("open docker socket", "chmod 666 /var/run/docker.sock", {
      sudo: true,
    });

    // The agent-skills submodule is public; rewrite its SSH URL to HTTPS since
    // the VM has no GitHub SSH identity. The rewrite must live in --global
    // config: the child `git clone` a submodule update spawns doesn't read the
    // superproject's repo-local config.
    await run(
      "checkout submodules",
      `git config --global url."https://github.com/".insteadOf "git@github.com:"\ngit submodule update --init --recursive`,
    );

    await run("install pnpm", "npm install -g pnpm@10.24.0", { sudo: true });
    await run("pnpm install", "pnpm install --frozen-lockfile");

    // `pnpm eval` reads the repo-root .env (node --env-file).
    await sandbox.writeFiles([
      {
        path: ".env",
        content: Buffer.from(
          Object.entries(options.agentEnv)
            .map(([key, value]) => `${key}=${value}`)
            .join("\n") + "\n",
        ),
      },
    ]);

    // -- The actual matrix job: same command line as eval-refresh.yml.
    const evalArgs = [
      `--experiment "${pair.experiment}"`,
      pair.experimentSuite && `--experiment-suite "${pair.experimentSuite}"`,
      `--eval "${pair.evalId}"`,
      `--runs ${options.runs}`,
      `--timeout-sec ${options.timeoutSec}`,
    ]
      .filter(Boolean)
      .join(" ");
    options.onPhase?.("eval");
    await run("run eval", `pnpm eval -- ${evalArgs}`);
    options.onPhase?.("collect");

    // -- Collect: the artifact-upload equivalent. The results tree (scores,
    // transcripts, and the attempt workspaces run-eval exports under
    // results/<experiment>/<eval>/attempt-N/workspace) is tarred into one
    // archive and streamed out with downloadFile — SDK file retrieval is
    // per-file, and streaming to disk avoids buffering workspaces in memory.
    await run("pack results", "tar -czf /tmp/eval-results.tgz -C results .");
    const staging = mkdtempSync(join(tmpdir(), "vercel-eval-results-"));
    try {
      const archivePath = join(staging, "results.tgz");
      const downloaded = await sandbox.downloadFile(
        { path: "/tmp/eval-results.tgz" },
        { path: archivePath },
      );
      if (!downloaded) throw new Error("results archive missing from sandbox");
      mkdirSync(options.resultsDir, { recursive: true });
      await execFileAsync("tar", [
        "-xzf",
        archivePath,
        "-C",
        options.resultsDir,
      ]);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    log(`results extracted to ${options.resultsDir}`);

    // Surface the scored outcome (run-eval exits 0 on a scored FAIL, so job
    // ok ≠ eval pass). Best-effort: a missing/renamed file just omits it.
    let evalPassed: boolean | undefined;
    try {
      const result = JSON.parse(
        readFileSync(
          join(options.resultsDir, pair.experiment, `${pair.evalId}.json`),
          "utf8",
        ),
      ) as { passed?: unknown };
      if (typeof result.passed === "boolean") evalPassed = result.passed;
    } catch {
      // No scored verdict available.
    }

    return {
      pair,
      ok: true,
      evalPassed,
      durationMs: Date.now() - start,
      sandboxId: sandbox.name,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`job failed: ${message}\n`);
    return {
      pair,
      ok: false,
      error: message,
      durationMs: Date.now() - start,
      sandboxId: sandbox?.name,
    };
  } finally {
    if (sandbox) {
      try {
        await sandbox.stop();
        log("sandbox stopped");
      } catch (err) {
        stderr.write(
          `sandbox stop failed (it will expire on its own): ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    stdout.end();
    stderr.end();
  }
}
