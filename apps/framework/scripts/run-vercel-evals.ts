#!/usr/bin/env tsx

import { APIError, Sandbox } from '@vercel/sandbox';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import pLimit from 'p-limit';
import pRetry, { AbortError } from 'p-retry';
import { z } from 'zod';
import { positiveInteger, readFlag } from '../lib/cli-args.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const execFileAsync = promisify(execFile);
/** Base for sandbox URLs printed during runs */
const SANDBOX_DASHBOARD_URL =
  'https://vercel.com/supabase/evals-runner/sandboxes';
const AGENT_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'AI_GATEWAY_API_KEY',
  // CLI version matrix: the beta channel version resolved by eval-refresh.
  // The in-sandbox `pnpm eval` loads it from .env, where the beta version arm
  // experiment (claude-code-sonnet-5-cli-beta) reads it.
  'SUPABASE_CLI_BETA_VERSION',
];
/**
 * Slack for the non-agent work inside `pnpm eval` (supabase start, resets,
 * scoring, export). Cold image pulls alone can take ~10 min.
 */
const EVAL_TIMEOUT_BUFFER_MS = 25 * 60 * 1_000;
/**
 * Covers the sandbox steps outside the eval command timer (setup before it,
 * pack/download after) so there's buffer time after eval timeout to read logs
 * before the platform kills the sandbox.
 */
const SANDBOX_TIMEOUT_BUFFER_MS = 10 * 60 * 1_000;

const evalPairSchema = z.object({
  eval_id: z.string(),
  experiment: z.string(),
  experiment_suite: z.string(),
  eval_suite: z.string(),
});
export type EvalPair = z.infer<typeof evalPairSchema>;

interface RunnerOptions {
  pairs: EvalPair[];
  revision: string;
  repoUrl: string;
  outputDir: string;
  runs: number;
  timeoutSec: number;
  concurrency: number;
  vcpus: number;
}

interface PairOptions extends RunnerOptions {
  pair: EvalPair;
  attempt: number;
}

interface SandboxCommandOptions {
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

/** Runs every item while keeping at most `concurrency` promises active. */
export async function runBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const limit = pLimit(concurrency);
  return Promise.allSettled(items.map((item) => limit(run, item)));
}

/** Runs all pairs and reports failures only after independent work finishes. */
async function runPairs(options: RunnerOptions): Promise<void> {
  const credentials = vercelCredentialsFromEnv();

  const results = await runBounded(
    options.pairs,
    options.concurrency,
    async (pair) => {
      try {
        await pRetry(
          (attempt) =>
            runPairOnce(
              {
                ...options,
                pair,
                attempt,
              },
              credentials
            ),
          {
            retries: 2,
            factor: 2,
            minTimeout: 5_000,
            maxTimeout: 30_000,
            randomize: true,
            onFailedAttempt: ({
              error,
              attemptNumber,
              retriesLeft,
              retryDelay,
            }) => {
              const retrying = retriesLeft > 0;
              console.warn(
                `${pairLabel(pair)} attempt ${attemptNumber} failed${retrying ? `, retrying in ${Math.round(retryDelay / 1000)}s` : ', not retrying'}: ${firstLine(errorMessage(error))}`
              );
            },
          }
        );
        console.log(`SANDBOX OK ${pairLabel(pair)}`);
      } catch (error) {
        console.error(
          `SANDBOX FAILED ${pairLabel(pair)}: ${errorMessage(error)}`
        );
        throw error;
      }
    }
  );

  const failures: string[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const pair = options.pairs[index];
    const result = results[index];
    if (!pair || !result || result.status === 'fulfilled') continue;
    failures.push(`${pairLabel(pair)}: ${errorMessage(result.reason)}`);
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((message) => new Error(message)),
      `${failures.length} Sandbox eval pair(s) failed`
    );
  }
}

/** Runs one pair in a fresh Sandbox and downloads its complete result tree. */
async function runPairOnce(
  options: PairOptions,
  credentials: VercelCredentials
): Promise<void> {
  const { pair } = options;
  const label = pairLabel(pair);
  let sandbox: Sandbox | undefined;

  try {
    sandbox = await createSandbox(label, {
      ...credentials,
      name: sandboxName(pair),
      runtime: 'node24',
      source: {
        type: 'git',
        url: options.repoUrl,
        revision: options.revision,
        depth: 1,
      },
      resources: { vcpus: options.vcpus },
      timeout:
        options.runs * options.timeoutSec * 1_000 +
        EVAL_TIMEOUT_BUFFER_MS +
        SANDBOX_TIMEOUT_BUFFER_MS,
      persistent: false,
      tags: {
        runner: 'supabase-evals',
        run: process.env.GITHUB_RUN_ID ?? 'local',
        experiment: tagValue(pair.experiment),
        eval: tagValue(pair.eval_id),
        attempt: String(options.attempt),
      },
    });
    console.log(
      `${label} attempt ${options.attempt}: ${SANDBOX_DASHBOARD_URL}/${sandbox.name}`
    );

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
      cwd: sandbox.cwd,
      timeoutMs: 2 * 60 * 1_000,
    });
    await runSandboxCommand(sandbox, label, 'install Docker', {
      cmd: 'dnf',
      args: ['install', '-y', '-q', 'docker'],
      sudo: true,
      timeoutMs: 3 * 60 * 1_000,
    });
    await sandbox.runCommand({
      cmd: 'dockerd',
      sudo: true,
      detached: true,
    });
    await runSandboxCommand(sandbox, label, 'start Docker', {
      cmd: 'bash',
      args: [
        '-c',
        'for i in $(seq 60); do docker info >/dev/null 2>&1 && chmod 666 /var/run/docker.sock && exit 0; sleep 1; done; echo "dockerd not ready" >&2; exit 1',
      ],
      sudo: true,
      timeoutMs: 90_000,
    });
    // Installs the pnpm version pinned by packageManager in the checked-out
    // root package.json so the two can't drift.
    await runSandboxCommand(sandbox, label, 'install pnpm', {
      cmd: 'bash',
      args: [
        '-c',
        `npm install --global "$(node -p 'require("./package.json").packageManager')"`,
      ],
      cwd: sandbox.cwd,
      sudo: true,
      timeoutMs: 2 * 60 * 1_000,
    });
    await runSandboxCommand(sandbox, label, 'install dependencies', {
      cmd: 'pnpm',
      args: ['install', '--frozen-lockfile'],
      cwd: sandbox.cwd,
      timeoutMs: 6 * 60 * 1_000,
    });

    await sandbox.writeFiles([
      {
        path: '.env',
        content: `${agentEnvironment()}\n`,
      },
    ]);
    console.log(`${label} run eval`);
    await runSandboxCommand(
      sandbox,
      label,
      'run eval',
      {
        cmd: 'pnpm',
        args: [
          'eval',
          '--',
          '--experiment',
          pair.experiment,
          '--experiment-suite',
          pair.experiment_suite,
          '--eval',
          pair.eval_id,
          '--runs',
          String(options.runs),
          '--timeout-sec',
          String(options.timeoutSec),
        ],
        cwd: sandbox.cwd,
        timeoutMs:
          options.runs * options.timeoutSec * 1_000 + EVAL_TIMEOUT_BUFFER_MS,
      },
      true
    );
    await runSandboxCommand(sandbox, label, 'validate result', {
      cmd: 'test',
      args: ['-f', `results/${pair.experiment}/${pair.eval_id}.json`],
      cwd: sandbox.cwd,
      timeoutMs: 30_000,
    });
    await runSandboxCommand(sandbox, label, 'pack results', {
      cmd: 'tar',
      args: [
        '--exclude=*/node_modules',
        '-czf',
        '/tmp/eval-results.tgz',
        '-C',
        `results/${pair.experiment}`,
        '.',
      ],
      cwd: sandbox.cwd,
      timeoutMs: 3 * 60 * 1_000,
    });
    await downloadResults(sandbox, pair, options.outputDir);
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(String(error));
  } finally {
    if (sandbox) await cleanupSandbox(sandbox, label);
  }
}

/**
 * Retries Sandbox.create() through the vCPU-provisioning rate limit.
 * The SDK's own retry gives up after ~3 attempts or a >20s Retry-After,
 * which isn't enough to ride out a large burst, so this layer takes over
 * with a much bigger budget and honors the same Retry-After header.
 */
async function createSandbox(
  label: string,
  createOptions: Parameters<typeof Sandbox.create>[0]
): Promise<Sandbox> {
  try {
    return await pRetry(() => Sandbox.create(createOptions), {
      retries: 12,
      minTimeout: 0,
      shouldRetry: ({ error, attemptNumber }) =>
        isRetryableSandboxCreateError(error, attemptNumber),
      onFailedAttempt: async ({ error, attemptNumber, retriesLeft }) => {
        const retrying =
          retriesLeft > 0 &&
          isRetryableSandboxCreateError(error, attemptNumber);
        if (isUnrecognizedSandboxCreateError(error)) {
          console.warn(
            `${label} sandbox create hit an unrecognized error type (capped at ${UNKNOWN_ERROR_RETRY_LIMIT} attempts) - consider adding it to isRetryableSandboxCreateError: ${errorMessage(error)}`
          );
        }
        const retryAfter = getRetryAfterMs(error);
        // Jitter so on top of server's `Retry-After` so concurrent pairs hitting
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
  } catch (error) {
    // AbortError stops any pRetry call it bubbles through, so this also
    // keeps runPairs' outer retry from re-attempting a doomed sandbox create.
    if (isTerminalSandboxCreateError(error) && error instanceof Error) {
      throw new AbortError(error);
    }
    throw error;
  }
}

const UNKNOWN_ERROR_RETRY_LIMIT = 2;

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

/**
 * Detects a real network fault surfaced through fetch's TypeError wrapper.
 * https://nodejs.org/api/errors.html#nodejs-error-codes
 */
function isNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.cause instanceof Error &&
    'code' in error.cause &&
    NETWORK_ERROR_CODES.has(String(error.cause.code))
  );
}

/**
 * Based on the SDK's retry policy for API responses (429s and 5xx):
 * https://github.com/vercel/sandbox/blob/bf2bc66003fc89cf07a1346a7ea63951747cbec6/packages/vercel-sandbox/src/api-client/with-retry.ts#L10-L17
 *
 * Other known network faults get the full retry budget. Anything unrecognized
 * gets a few retries and warning on job since we can't tell if it's transient.
 */
export function isRetryableSandboxCreateError(
  error: unknown,
  attemptNumber: number
): boolean {
  if (error instanceof APIError) {
    const { status } = error.response;
    return status === 429 || status >= 500;
  }
  if (isNetworkError(error)) return true;
  return attemptNumber <= UNKNOWN_ERROR_RETRY_LIMIT;
}

/** True for a non-APIError that isn't a known network error. */
function isUnrecognizedSandboxCreateError(error: unknown): boolean {
  return !(error instanceof APIError) && !isNetworkError(error);
}

/** True when no amount of retrying at any level could fix this. */
export function isTerminalSandboxCreateError(error: unknown): boolean {
  return error instanceof APIError && !isRetryableSandboxCreateError(error, 1);
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
async function runSandboxCommand(
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

/** Downloads and extracts one pair into the aggregate artifact directory. */
async function downloadResults(
  sandbox: Sandbox,
  pair: EvalPair,
  outputDir: string
): Promise<void> {
  const staging = mkdtempSync(join(tmpdir(), 'vercel-eval-results-'));
  const archive = join(staging, 'results.tgz');
  const destination = join(outputDir, artifactDirectory(pair));
  try {
    const downloaded = await sandbox.downloadFile(
      { path: '/tmp/eval-results.tgz' },
      { path: archive },
      { mkdirRecursive: true }
    );
    if (!downloaded) throw new Error('results archive was missing');
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    await execFileAsync('tar', ['-xzf', archive, '-C', destination]);
    console.log(`${pairLabel(pair)} results downloaded to ${destination}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Stops and deletes a Sandbox while preserving the pair's original outcome. */
async function cleanupSandbox(sandbox: Sandbox, label: string): Promise<void> {
  try {
    await sandbox.stop();
    console.log(`${label} sandbox ${sandbox.name} stopped`);
  } catch (error) {
    console.warn(`${label} sandbox stop failed: ${errorMessage(error)}`);
  }
  try {
    await sandbox.delete();
    console.log(`${label} sandbox ${sandbox.name} deleted`);
  } catch (error) {
    console.warn(`${label} sandbox delete failed: ${errorMessage(error)}`);
  }
}

/** Parses and validates the pair list supplied by GitHub Actions. */
export function parsePairs(value: string): EvalPair[] {
  const json: unknown = JSON.parse(value);
  if (!Array.isArray(json) || json.length === 0) {
    throw new Error('--pairs-json must be a non-empty JSON array');
  }
  const parsed = z.array(evalPairSchema).safeParse(json);
  if (!parsed.success) {
    throw new Error(
      'each pair must contain eval_id, experiment, experiment_suite, and eval_suite strings'
    );
  }
  return parsed.data;
}

/** Returns an environment variable or a useful configuration error. */
function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: ${hint}`);
  return value;
}

type VercelCredentials = ReturnType<typeof vercelCredentialsFromEnv>;

/** Returns explicit credentials because the SDK does not infer all local vars. */
function vercelCredentialsFromEnv(): {
  token: string;
  teamId: string;
  projectId: string;
} {
  return {
    token: requireEnv('VERCEL_TOKEN', 'missing Vercel token'),
    teamId: requireEnv('VERCEL_TEAM_ID', 'missing Vercel team ID'),
    projectId: requireEnv('VERCEL_PROJECT_ID', 'missing Vercel project ID'),
  };
}

/** Serializes configured provider keys into the repo-root `.env` file. */
function agentEnvironment(): string {
  const lines: string[] = [];
  for (const name of AGENT_ENV_NAMES) {
    const value = process.env[name];
    if (value) lines.push(`${name}=${value}`);
  }
  return lines.join('\n');
}

/** Converts the origin remote into a Vercel-compatible HTTPS clone URL. */
function repositoryUrl(): string {
  return execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .trim()
    .replace(/^git@github\.com:/, 'https://github.com/');
}

/** Reads the checked-out commit used when no explicit revision is supplied. */
function currentRevision(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
}

/** Builds the stable per-pair directory expected by the publish job. */
function artifactDirectory(pair: EvalPair): string {
  return `raw-results-${pair.experiment}__${pair.eval_id}`;
}

/** Formats a pair consistently in interleaved controller output. */
function pairLabel(pair: EvalPair): string {
  return `[${pair.experiment} x ${pair.eval_id}]`;
}

/** Produces a unique dashboard-safe Sandbox name. */
function sandboxName(pair: EvalPair): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${tagValue(pair.experiment).slice(0, 35)}--${tagValue(pair.eval_id).slice(0, 45)}--${suffix}`;
}

/** Sanitizes metadata for Sandbox names and tags. */
export function tagValue(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, '-')
    .slice(0, 64);
}

const apiErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

/** Converts unknown thrown values into readable diagnostics. */
function errorMessage(error: unknown): string {
  if (error instanceof APIError) {
    const body = apiErrorBodySchema.safeParse(error.json);
    const detail = body.success
      ? `${body.data.error.code}: ${body.data.error.message}`
      : error.message;
    return `HTTP ${error.response.status} ${detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Keeps retry notices readable when the final summary carries full output. */
function firstLine(value: string): string {
  return value.split('\n', 1)[0] ?? value;
}

/** Parses CLI inputs and starts the controller. */
async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2).filter((arg) => arg !== '--');
  const pairsValue = readFlag(rawArgs, 'pairs-json') ?? process.env.EVAL_PAIRS;
  if (!pairsValue) throw new Error('--pairs-json or EVAL_PAIRS is required');

  const options: RunnerOptions = {
    pairs: parsePairs(pairsValue),
    revision: readFlag(rawArgs, 'revision') ?? currentRevision(),
    repoUrl: readFlag(rawArgs, 'repo-url') ?? repositoryUrl(),
    outputDir: resolve(
      ROOT,
      readFlag(rawArgs, 'output-dir') ?? 'results/downloaded'
    ),
    runs: positiveInteger(readFlag(rawArgs, 'runs') ?? '2', 'runs'),
    timeoutSec: positiveInteger(
      readFlag(rawArgs, 'timeout-sec') ?? '720',
      'timeout-sec'
    ),
    concurrency: positiveInteger(
      readFlag(rawArgs, 'concurrency') ?? '4',
      'concurrency'
    ),
    vcpus: positiveInteger(readFlag(rawArgs, 'vcpus') ?? '4', 'vcpus'),
  };

  console.log(
    `${options.pairs.length} pair(s), concurrency=${options.concurrency}, runs=${options.runs}, timeout=${options.timeoutSec}s, revision=${options.revision.slice(0, 8)}`
  );
  for (const pair of options.pairs) console.log(`PLAN ${pairLabel(pair)}`);
  if (rawArgs.includes('--dry-run')) return;
  await runPairs(options);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
