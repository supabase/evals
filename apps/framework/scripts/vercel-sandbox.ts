/**
 * Shared Vercel Sandbox plumbing for the eval runner and the snapshot builder:
 * credentials, rate-limit-aware creation, the detached-and-polled command
 * runner, and the cold-boot provisioning both a per-pair VM and the snapshot
 * builder go through. Kept in its own module so neither consumer imports the
 * other.
 */

import { APIError, Sandbox } from '@vercel/sandbox';
import pRetry from 'p-retry';
import { z } from 'zod';

/** Checkout path of both git-source and snapshot-source sandboxes. */
export const SANDBOX_CWD = '/vercel/sandbox';

export interface SandboxCommandOptions {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  sudo?: boolean;
  timeoutMs?: number;
}

class SandboxCommandError extends Error {
  constructor(step: string, exitCode: number, output: string) {
    const detail = output.trim().slice(-4_000);
    super(`${step} exited with code ${exitCode}${detail ? `\n${detail}` : ''}`);
    this.name = 'SandboxCommandError';
  }
}

/**
 * Retries Sandbox.create() through the vCPU-provisioning rate limit.
 * The SDK's own retry gives up after ~3 attempts or a >20s Retry-After,
 * which isn't enough to ride out a large burst, so this layer takes over
 * with a much bigger budget and honors the same Retry-After header.
 */
export async function createSandbox(
  label: string,
  createOptions: Parameters<typeof Sandbox.create>[0]
): Promise<Sandbox> {
  return pRetry(() => Sandbox.create(createOptions), {
    retries: 12,
    minTimeout: 0,
    shouldRetry: ({ error }) => isRetryableSandboxCreateError(error),
    onFailedAttempt: async ({ error, attemptNumber, retriesLeft }) => {
      const retrying = retriesLeft > 0 && isRetryableSandboxCreateError(error);
      const retryAfter = getRetryAfterMs(error);
      // Jitter on top of the server's `Retry-After` so concurrent pairs hitting
      // the same rate limit don't all retry in lockstep.
      const wait = retryAfter
        ? retryAfter * (1 + Math.random() * 0.4)
        : Math.min(2 ** attemptNumber * 1_000, 20_000) *
          (0.8 + Math.random() * 0.4);
      console.warn(
        `${label} sandbox create attempt ${attemptNumber} failed${retrying ? `, retrying in ${Math.round(wait / 1_000)}s` : ', not retrying'}: ${errorMessage(error)}`
      );
      if (retrying) await new Promise((resolve) => setTimeout(resolve, wait));
    },
  });
}

/**
 * Matches the SDK's retry policy of network errors, 429s, and 5xx.
 * Other 4xx responses (bad token, invalid options) can never succeed.
 * https://github.com/vercel/sandbox/blob/bf2bc66003fc89cf07a1346a7ea63951747cbec6/packages/vercel-sandbox/src/api-client/with-retry.ts#L10-L17
 */
export function isRetryableSandboxCreateError(error: unknown): boolean {
  if (!(error instanceof APIError)) return true;
  const { status } = error.response;
  return status === 429 || status >= 500;
}

/**
 * Reads the Sandbox API's Retry-After header (seconds), converted to milliseconds.
 * The SDK's own retry layer reads the same header on 429s:
 * https://github.com/vercel/sandbox/blob/bf2bc66003fc89cf07a1346a7ea63951747cbec6/packages/vercel-sandbox/src/api-client/with-retry.ts#L56
 */
function getRetryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof APIError)) return undefined;
  const seconds = Number(error.response.headers.get('Retry-After'));
  return seconds > 0 ? seconds * 1_000 : undefined;
}

/** Runs a detached command, streams logs best-effort, and waits for its exit code. */
export async function runSandboxCommand(
  sandbox: Sandbox,
  label: string,
  step: string,
  options: SandboxCommandOptions,
  logOutput = false
): Promise<void> {
  const command = await sandbox.runCommand({
    ...options,
    detached: true,
  });
  const result = await pRetry(() => command.wait(), {
    retries: 5,
    factor: 2,
    minTimeout: 1_000,
    maxTimeout: 10_000,
    onFailedAttempt: ({ error, attemptNumber }) => {
      console.warn(
        `${label} ${step} wait failed (attempt ${attemptNumber}): ${errorMessage(error)}`
      );
    },
  });
  if (result.exitCode === 0) {
    if (logOutput) {
      const output = await result.output('both').catch(() => '');
      if (output.trim()) process.stdout.write(`${label} ${output}`);
    }
    return;
  }

  const output = await result.output('both').catch(() => '');
  throw new SandboxCommandError(step, result.exitCode, output);
}

/**
 * Starts dockerd inside the VM and waits for the socket. On cold boots Docker
 * must be installed first; on warm boots the snapshot already carries it, so
 * only the daemon (which isn't part of a filesystem snapshot) is restarted.
 */
export async function startDocker(
  sandbox: Sandbox,
  label: string,
  { install }: { install: boolean }
): Promise<void> {
  if (install) {
    await runSandboxCommand(sandbox, label, 'install Docker', {
      cmd: 'dnf',
      args: ['install', '-y', '-q', 'docker'],
      sudo: true,
      timeoutMs: 3 * 60 * 1_000,
    });
  }
  await sandbox.runCommand({ cmd: 'dockerd', sudo: true, detached: true });
  await runSandboxCommand(sandbox, label, 'start Docker', {
    cmd: 'bash',
    args: [
      '-c',
      'for i in $(seq 60); do docker info >/dev/null 2>&1 && chmod 666 /var/run/docker.sock && exit 0; sleep 1; done; echo "dockerd not ready" >&2; exit 1',
    ],
    sudo: true,
    timeoutMs: 90_000,
  });
}

/** Installs the workspace's pinned dependencies (a cache hit on warm boots). */
export async function installDependencies(
  sandbox: Sandbox,
  label: string
): Promise<void> {
  await runSandboxCommand(sandbox, label, 'install dependencies', {
    cmd: 'pnpm',
    args: ['install', '--frozen-lockfile'],
    cwd: SANDBOX_CWD,
    timeoutMs: 6 * 60 * 1_000,
  });
}

/**
 * Full cold-boot provisioning — what both a per-pair VM (cold branch) and the
 * snapshot builder run before they can `pnpm eval`: init submodules, install +
 * start Docker, install the pinned pnpm, and install dependencies.
 */
export async function coldProvision(
  sandbox: Sandbox,
  label: string
): Promise<void> {
  await runSandboxCommand(sandbox, label, 'initialize submodules', {
    cmd: 'git',
    args: [
      '-c',
      'url.https://github.com/.insteadOf=git@github.com:',
      'submodule',
      'update',
      '--init',
      '--recursive',
    ],
    cwd: SANDBOX_CWD,
    timeoutMs: 2 * 60 * 1_000,
  });
  await startDocker(sandbox, label, { install: true });
  // Installs the pnpm version pinned by packageManager in the checked-out root
  // package.json so the two can't drift.
  await runSandboxCommand(sandbox, label, 'install pnpm', {
    cmd: 'bash',
    args: [
      '-c',
      `npm install --global "$(node -p 'require("./package.json").packageManager')"`,
    ],
    cwd: SANDBOX_CWD,
    sudo: true,
    timeoutMs: 2 * 60 * 1_000,
  });
  await installDependencies(sandbox, label);
}

/** Returns an environment variable or a useful configuration error. */
function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: ${hint}`);
  return value;
}

export type VercelCredentials = ReturnType<typeof vercelCredentialsFromEnv>;

/** Returns explicit credentials because the SDK does not infer all local vars. */
export function vercelCredentialsFromEnv():
  | { token: string; teamId: string; projectId: string }
  | Record<string, never> {
  if (process.env.VERCEL_OIDC_TOKEN) return {};
  return {
    token: requireEnv('VERCEL_TOKEN', 'missing Vercel token'),
    teamId: requireEnv('VERCEL_TEAM_ID', 'missing Vercel team ID'),
    projectId: requireEnv('VERCEL_PROJECT_ID', 'missing Vercel project ID'),
  };
}

const apiErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

/** Converts unknown thrown values into readable diagnostics. */
export function errorMessage(error: unknown): string {
  if (error instanceof APIError) {
    const body = apiErrorBodySchema.safeParse(error.json);
    const detail = body.success
      ? `${body.data.error.code}: ${body.data.error.message}`
      : error.message;
    return `HTTP ${error.response.status} ${detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Sanitizes metadata for Sandbox names and tags. */
export function tagValue(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, '-')
    .slice(0, 64);
}
