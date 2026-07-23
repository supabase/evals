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
 *
 * With a warm-boot snapshot (see snapshot.ts) the VM starts from a filesystem
 * that already carries docker, node_modules, and the pulled images; the boot
 * then only restarts dockerd and fetches the target revision.
 */

import { mkdirSync, rmSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Sandbox } from "@vercel/sandbox";
import type { EvalPair } from "./discover.js";
import {
  SANDBOX_CWD,
  createSandbox,
  createStepRunner,
  prefixedWriter,
  startDocker,
} from "./vm-steps.js";

const execFileAsync = promisify(execFile);

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
  /** Warm-boot snapshot to start from; omitted means a cold git-source boot. */
  snapshotId?: string;
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
    log(
      `creating sandbox (vcpus=${options.vcpus}, timeout=${Math.round(options.sandboxTimeoutMs / 60000)}m, ` +
        `rev=${options.revision.slice(0, 8)}${options.snapshotId ? ", warm boot" : ", cold boot"})`,
    );
    options.onPhase?.("create");
    sandbox = await createSandbox(
      {
        resources: { vcpus: options.vcpus },
        timeout: options.sandboxTimeoutMs,
        // Sandboxes auto-snapshot on stop by default ("persistent"); a
        // throwaway eval VM must not — a full-matrix run would otherwise
        // bank 166 multi-GB snapshots (it did: 435 GB accumulated before
        // this flag).
        persistent: false,
        // Makes the Vercel dashboard's Sandboxes view a live per-CI-run
        // board, filterable by these keys (max 5 tags).
        tags: {
          runner: "supabase-evals",
          run: process.env.GITHUB_RUN_ID ?? "local",
          experiment: pair.experiment,
          eval: pair.evalId,
        },
        // A snapshot source carries its runtime; git sources need one.
        ...(options.snapshotId
          ? { source: { type: "snapshot" as const, snapshotId: options.snapshotId } }
          : {
              runtime: "node22",
              source: {
                type: "git" as const,
                url: options.repoUrl,
                revision: options.revision,
                // Vercel clones with these as basic-auth; x-access-token is
                // GitHub's conventional username for token auth.
                username: "x-access-token",
                password: options.githubToken,
              },
            }),
      },
      stderr,
    );
    log(`sandbox ${sandbox.name} created`);
    options.onPhase?.("bootstrap");

    const run = createStepRunner(sandbox, { stdout, stderr, log });

    if (options.snapshotId) {
      // Warm boot: the snapshot filesystem already has docker + images +
      // node_modules; restart the daemon (processes aren't snapshotted) and
      // move the checkout to the target revision.
      await startDocker(sandbox, run, { install: false });
      await run(
        "checkout revision",
        // The token flows through the credential helper, never a command
        // line, so it can't leak into step logs on error.
        `git config --global credential.helper store\n` +
          `printf 'https://x-access-token:%s@github.com\\n' "$GITHUB_TOKEN" > ~/.git-credentials\n` +
          `git fetch --quiet origin "$REVISION"\n` +
          `git checkout --quiet --force "$REVISION"\n` +
          `git submodule update --init --recursive`,
        { env: { GITHUB_TOKEN: options.githubToken, REVISION: options.revision } },
      );
      // Reconciles any dependency drift between the snapshot's lockfile and
      // the target revision's; a no-op seconds when they match.
      await run("pnpm install", "pnpm install --frozen-lockfile");
    } else {
      // Cold boot: what actions/checkout + setup-node + the runner image give
      // us for free on GitHub Actions.
      await startDocker(sandbox, run, { install: true });
      // The agent-skills submodule is public; rewrite its SSH URL to HTTPS
      // since the VM has no GitHub SSH identity. The rewrite must live in
      // --global config: the child `git clone` a submodule update spawns
      // doesn't read the superproject's repo-local config.
      await run(
        "checkout submodules",
        `git config --global url."https://github.com/".insteadOf "git@github.com:"\ngit submodule update --init --recursive`,
      );
      await run("install pnpm", "npm install -g pnpm@10.24.0", { sudo: true });
      await run("pnpm install", "pnpm install --frozen-lockfile");
    }

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
