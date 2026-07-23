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

import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
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

export interface SandboxJobOptions {
  pair: EvalPair;
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
    for (let attempt = 0; ; attempt++) {
      try {
        sandbox = await Sandbox.create({
          ...credentialsFromEnv(),
          runtime: "node22",
          resources: { vcpus: options.vcpus },
          timeout: options.sandboxTimeoutMs,
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

    const run = async (
      step: string,
      cmd: string,
      opts: { sudo?: boolean; env?: Record<string, string> } = {},
    ) => {
      log(`--- ${step}`);
      const result = await sandbox!.runCommand({
        cmd: "bash",
        args: ["-c", `set -euo pipefail\n${cmd}`],
        cwd: SANDBOX_CWD,
        sudo: opts.sudo,
        env: opts.env,
        stdout,
        stderr,
      });
      if (result.exitCode !== 0) {
        throw new Error(`step "${step}" exited with code ${result.exitCode}`);
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

    // Long-running step, decoupled from any live log stream: launch detached
    // with output going to a file in the VM, then poll with short commands
    // (status sentinel + incremental tail). A multi-minute `pnpm eval` held on
    // one streaming connection dies with "Stream ended before command
    // finished" when that connection drops, even though the command and the
    // VM are fine.
    const runPolled = async (step: string, cmd: string) => {
      log(`--- ${step}`);
      const logPath = "/tmp/step.log";
      const exitPath = "/tmp/step.exit";
      await sandbox!.runCommand({
        cmd: "bash",
        args: [
          "-c",
          `rm -f ${logPath} ${exitPath}; (set -euo pipefail\n${cmd}\n) >${logPath} 2>&1; echo $? >${exitPath}`,
        ],
        cwd: SANDBOX_CWD,
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
        await new Promise((resolve) => setTimeout(resolve, 10_000));
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
    await runPolled("run eval", `pnpm eval -- ${evalArgs}`);

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

    return {
      pair,
      ok: true,
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
