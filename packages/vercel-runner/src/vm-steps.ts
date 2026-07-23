/**
 * Shared microVM plumbing for the per-pair eval job and the snapshot builder:
 * prefixed log writers, rate-shaped sandbox creation, and the polled step
 * runner every VM command goes through.
 */

import { Writable } from "node:stream";
import { Sandbox } from "@vercel/sandbox";

/** Where the git source is checked out inside the sandbox. */
export const SANDBOX_CWD = "/vercel/sandbox";

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

/**
 * Explicit Vercel API credentials, when the environment carries them. The SDK
 * does NOT read VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID on its own — its
 * only fallbacks are $VERCEL_OIDC_TOKEN and interactively cached dev
 * credentials (`vercel link`), and CI has neither.
 */
export function credentialsFromEnv():
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

/** Prefix every output line so interleaved parallel jobs stay readable. */
export function prefixedWriter(
  prefix: string,
  target: NodeJS.WriteStream,
): Writable {
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

/** Rate-shaped, retried Sandbox.create. */
export async function createSandbox(
  params: Parameters<typeof Sandbox.create>[0],
  stderr: Writable,
): Promise<Sandbox> {
  for (let attempt = 0; ; attempt++) {
    try {
      await waitForCreateSlot();
      return await Sandbox.create({ ...credentialsFromEnv(), ...params });
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
}

export type StepRunner = (
  step: string,
  cmd: string,
  opts?: { sudo?: boolean; env?: Record<string, string> },
) => Promise<void>;

/**
 * Build the polled step runner for a sandbox. Every step runs decoupled from
 * any live log stream: launch detached with output going to a file in the VM,
 * then poll with short commands (status sentinel + incremental tail). A
 * command held on one streaming connection dies with "Stream ended before
 * command finished" when that connection drops even though the command and
 * the VM are fine — at full-matrix scale (~1,000 step commands per run)
 * that's a certainty, and it killed bootstrap steps in practice, not just the
 * long eval.
 */
export function createStepRunner(
  sandbox: Sandbox,
  io: { stdout: Writable; stderr: Writable; log: (message: string) => void },
): StepRunner {
  // Step files carry a per-session nonce: a sandbox booted from a snapshot
  // inherits the builder's /tmp — a poller reading a stale exit file from a
  // colliding path would declare the step done while the command still runs
  // (it did: "run eval" once "passed" in 5 seconds with no eval run).
  const nonce = Math.random().toString(36).slice(2, 10);
  let stepCounter = 0;
  return async (step, cmd, opts = {}) => {
    io.log(`--- ${step}`);
    const id = ++stepCounter;
    const logPath = `/tmp/step-${nonce}-${id}.log`;
    const exitPath = `/tmp/step-${nonce}-${id}.exit`;
    await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-c",
        `rm -f ${logPath} ${exitPath}; (set -euo pipefail\n${cmd}\n) >${logPath} 2>&1; echo $? >${exitPath}`,
      ],
      cwd: SANDBOX_CWD,
      sudo: opts.sudo,
      env: opts.env,
      detached: true,
    });

    let offset = 0;
    let pollFailures = 0;
    const emitNewOutput = async (limit?: number) => {
      const chunk = await sandbox.runCommand({
        cmd: "bash",
        args: [
          "-c",
          `tail -c +${offset + 1} ${logPath}${limit ? ` | head -c ${limit}` : ""}`,
        ],
      });
      const data = await chunk.stdout();
      if (data) {
        offset += Buffer.byteLength(data);
        io.stdout.write(data);
      }
    };
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, STEP_POLL_INTERVAL_MS));
      try {
        await emitNewOutput(262_144);
        const status = await sandbox.runCommand({
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
        io.stderr.write(
          `poll failed (${pollFailures}/6), retrying: ${err instanceof Error ? err.message : err}\n`,
        );
      }
    }
  };
}

/**
 * Start dockerd and open its socket to the unprivileged user (inside a
 * single-tenant ephemeral VM, opening the socket is the simple safe way).
 * `install` additionally dnf-installs docker — snapshot boots skip it, since
 * the package (and the pulled images) are already on the snapshot filesystem;
 * only the daemon process needs restarting (processes aren't snapshotted).
 */
export async function startDocker(
  sandbox: Sandbox,
  run: StepRunner,
  options: { install: boolean },
): Promise<void> {
  if (options.install) {
    await run("install docker", "dnf install -y -q docker", { sudo: true });
  }
  await sandbox.runCommand({ cmd: "dockerd", sudo: true, detached: true });
  await run(
    "wait for dockerd",
    `for i in $(seq ${DOCKERD_READY_TIMEOUT_SEC}); do docker info >/dev/null 2>&1 && exit 0; sleep 1; done; echo "dockerd not ready" >&2; exit 1`,
    { sudo: true },
  );
  await run("open docker socket", "chmod 666 /var/run/docker.sock", {
    sudo: true,
  });
}
