#!/usr/bin/env tsx

import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { Sandbox } from '@vercel/sandbox';
import pLimit from 'p-limit';
import pRetry from 'p-retry';
import { z } from 'zod';
import { positiveInteger, readFlag } from '../lib/cli-args.js';
import {
  SANDBOX_CWD,
  coldProvision,
  createSandbox,
  errorMessage,
  installDependencies,
  runSandboxCommand,
  startDocker,
  tagValue,
  vercelCredentialsFromEnv,
  type VercelCredentials,
} from './vercel-sandbox.js';
import { ensureSnapshot } from './vercel-snapshot.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const execFileAsync = promisify(execFile);
/** Base for sandbox URLs printed during runs */
const SANDBOX_DASHBOARD_URL =
  'https://vercel.com/supabase/evals-runner/sandboxes';
const AGENT_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'AI_GATEWAY_API_KEY',
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

/**
 * Wall-clock budget for the `pnpm eval` command: every attempt at its full
 * timeout plus buffer for the non-agent work around it. Shared by the sandbox
 * session ceiling and the command timer so the two can't drift.
 */
function evalCommandTimeoutMs(options: {
  runs: number;
  timeoutSec: number;
}): number {
  return options.runs * options.timeoutSec * 1_000 + EVAL_TIMEOUT_BUFFER_MS;
}

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
  /**
   * Warm-boot snapshot to start each pair's VM from (docker + node_modules +
   * Supabase images pre-baked). Undefined means a cold git-source boot.
   */
  snapshotId?: string;
}

interface PairOptions extends RunnerOptions {
  pair: EvalPair;
  attempt: number;
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
    const warm = Boolean(options.snapshotId);
    sandbox = await createSandbox(label, {
      ...credentials,
      name: sandboxName(pair),
      // A snapshot source carries its own runtime + filesystem; a git source
      // needs the runtime named and clones the repo fresh.
      ...(options.snapshotId
        ? { source: { type: 'snapshot', snapshotId: options.snapshotId } }
        : {
            runtime: 'node24',
            source: {
              type: 'git',
              url: options.repoUrl,
              revision: options.revision,
              depth: 1,
            },
          }),
      resources: { vcpus: options.vcpus },
      timeout: evalCommandTimeoutMs(options) + SANDBOX_TIMEOUT_BUFFER_MS,
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
      `${label} attempt ${options.attempt} (${warm ? 'warm' : 'cold'} boot): ${SANDBOX_DASHBOARD_URL}/${sandbox.name}`
    );

    if (warm) {
      // The snapshot already carries docker, node_modules, and the pulled
      // images; only restart the daemon (processes aren't snapshotted), move
      // the checkout to the target revision, and reconcile dependency drift.
      await startDocker(sandbox, label, { install: false });
      await runSandboxCommand(sandbox, label, 'checkout revision', {
        cmd: 'bash',
        args: [
          '-c',
          // supabase/evals is public, so no credentials are needed to fetch.
          'git config --global url."https://github.com/".insteadOf "git@github.com:"\n' +
            'git fetch --quiet --depth 1 origin "$REVISION"\n' +
            'git checkout --quiet --force "$REVISION"\n' +
            'git submodule update --init --recursive',
        ],
        cwd: SANDBOX_CWD,
        env: { REVISION: options.revision },
        timeoutMs: 3 * 60 * 1_000,
      });
      await installDependencies(sandbox, label);
    } else {
      await coldProvision(sandbox, label);
    }

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
        cwd: SANDBOX_CWD,
        timeoutMs: evalCommandTimeoutMs(options),
      },
      true
    );
    await runSandboxCommand(sandbox, label, 'validate result', {
      cmd: 'test',
      args: ['-f', `results/${pair.experiment}/${pair.eval_id}.json`],
      cwd: SANDBOX_CWD,
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
      cwd: SANDBOX_CWD,
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
    // An explicit id reuses a prebuilt snapshot across runs; `--snapshot`
    // builds one for this run (resolved below, after the dry-run guard).
    snapshotId: readFlag(rawArgs, 'snapshot-id'),
  };

  console.log(
    `${options.pairs.length} pair(s), concurrency=${options.concurrency}, runs=${options.runs}, timeout=${options.timeoutSec}s, revision=${options.revision.slice(0, 8)}`
  );
  for (const pair of options.pairs) console.log(`PLAN ${pairLabel(pair)}`);
  if (rawArgs.includes('--dry-run')) return;

  if (!options.snapshotId && rawArgs.includes('--snapshot')) {
    options.snapshotId = await ensureSnapshot({
      root: ROOT,
      repoUrl: options.repoUrl,
      revision: options.revision,
      vcpus: options.vcpus,
    });
  }
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
