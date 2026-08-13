#!/usr/bin/env tsx

import { APIError, Sandbox } from '@vercel/sandbox';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import pLimit from 'p-limit';
import pRetry from 'p-retry';
import { z } from 'zod';
import { readFlag } from '../lib/cli-args.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const execFileAsync = promisify(execFile);
const SANDBOX_DASHBOARD_URL =
  'https://vercel.com/supabase/evals-runner/sandboxes';
const AGENT_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'AI_GATEWAY_API_KEY',
];

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
  requireVercelCredentials();

  const results = await runBounded(
    options.pairs,
    options.concurrency,
    async (pair) => {
      try {
        await pRetry(
          (attempt) =>
            runPairOnce({
              ...options,
              pair,
              attempt,
            }),
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
        console.error(`SANDBOX FAILED ${pairLabel(pair)}: ${errorMessage(error)}`);
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
async function runPairOnce(options: PairOptions): Promise<void> {
  const { pair } = options;
  const label = pairLabel(pair);
  let sandbox: Sandbox | undefined;

  try {
    sandbox = await createSandbox(label, {
      ...vercelCredentialsFromEnv(),
      name: sandboxName(pair),
      runtime: 'node24',
      source: {
        type: 'git',
        url: options.repoUrl,
        revision: options.revision,
        depth: 1,
      },
      resources: { vcpus: options.vcpus },
      timeout: options.runs * options.timeoutSec * 1_000 + 25 * 60 * 1_000,
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
    await runSandboxCommand(sandbox, label, 'install pnpm', {
      cmd: 'npm',
      args: ['install', '--global', 'pnpm@10.24.0'],
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
    await runSandboxCommand(sandbox, label, 'run eval', {
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
      timeoutMs: options.runs * options.timeoutSec * 1_000 + 5 * 60 * 1_000,
    }, true);
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
  return pRetry(() => Sandbox.create(createOptions), {
    retries: 12,
    minTimeout: 0,
    onFailedAttempt: async ({ error, attemptNumber, retriesLeft }) => {
      const wait = retryAfterMs(error) ?? Math.min(2 ** attemptNumber * 1_000, 20_000);
      console.warn(
        `${label} sandbox create attempt ${attemptNumber} failed${retriesLeft > 0 ? `, retrying in ${Math.round(wait / 1_000)}s` : ', not retrying'}: ${errorMessage(error)}`
      );
      if (retriesLeft > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    },
  });
}

/** Reads the Sandbox API's Retry-After header (seconds), converted to milliseconds. */
function retryAfterMs(error: unknown): number | undefined {
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
  console.log(`${label} ${step}`);
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

const positiveIntegerSchema = z.coerce.number().int().min(1);

/** Parses a positive integer CLI option. */
export function positiveInteger(value: string, name: string): number {
  const parsed = positiveIntegerSchema.safeParse(value);
  if (!parsed.success) throw new Error(`--${name} must be a positive integer`);
  return parsed.data;
}

/** Returns an environment variable or a useful configuration error. */
function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: ${hint}`);
  return value;
}

/** Validates that local token authentication has all three required values. */
function requireVercelCredentials(): void {
  if (process.env.VERCEL_OIDC_TOKEN) return;
  requireEnv('VERCEL_TOKEN', 'configure the evals-runner Vercel project');
  requireEnv('VERCEL_TEAM_ID', 'configure the evals-runner Vercel project');
  requireEnv('VERCEL_PROJECT_ID', 'configure the evals-runner Vercel project');
}

/** Returns explicit credentials because the SDK does not infer all local vars. */
function vercelCredentialsFromEnv():
  | { token: string; teamId: string; projectId: string }
  | Record<string, never> {
  if (process.env.VERCEL_OIDC_TOKEN) return {};
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

/** Converts unknown thrown values into readable diagnostics. */
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
      readFlag(rawArgs, 'output-dir') ?? 'downloaded-results'
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
