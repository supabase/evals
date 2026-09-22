import { APIError } from '@vercel/sandbox';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentEnvironment,
  cleanupSandbox,
  downloadResults,
  finalizeResult,
  FORWARDED_ENV_NAMES,
  isRetryableSandboxCreateError,
  isTerminalSandboxCreateError,
  packWorkspaceScript,
  parsePairs,
  runBounded,
  tagValue,
  expandJobs,
} from './run-vercel-evals.js';

describe('agentEnvironment', () => {
  const originalValues = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of FORWARDED_ENV_NAMES) {
      originalValues.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of originalValues) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('forwards every configured name when set', () => {
    for (const name of FORWARDED_ENV_NAMES) {
      process.env[name] = `${name}-value`;
    }

    const lines = agentEnvironment().split('\n');
    for (const name of FORWARDED_ENV_NAMES) {
      expect(lines).toContain(`${name}=${name}-value`);
    }
  });

  it('omits the CLI channel pins when unset', () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-value';

    const env = agentEnvironment();
    expect(env).toBe('ANTHROPIC_API_KEY=anthropic-value');
    expect(env).not.toContain('SUPABASE_CLI_STABLE_VERSION');
    expect(env).not.toContain('SUPABASE_CLI_BETA_VERSION');
  });
});

describe('Vercel eval controller', () => {
  it('bounds concurrent work and lets independent failures settle', async () => {
    let active = 0;
    let maximum = 0;
    const results = await runBounded([1, 2, 3, 4], 2, async (item) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      if (item === 2) throw new Error('terminal');
      return item;
    });

    expect(maximum).toBe(2);
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
  });

  it('sanitizes Sandbox names and tags to the allowed charset', () => {
    expect(tagValue('openai-gpt-5.4-nano')).toBe('openai-gpt-5-4-nano');
    expect(tagValue('Build CLI / Bootstrap App!')).toBe(
      'build-cli-bootstrap-app-'
    );
    expect(tagValue('a'.repeat(100))).toHaveLength(64);
  });

  it('validates pair input before starting Sandboxes', () => {
    expect(
      parsePairs(
        JSON.stringify([
          {
            eval_id: 'eval-1',
            experiment: 'experiment-1',
            experiment_suite: 'benchmark',
            eval_suite: 'benchmark',
          },
        ])
      )
    ).toHaveLength(1);
    expect(() => parsePairs('[{"eval_id":"eval-1"}]')).toThrow(
      'each pair must contain'
    );
  });

  it('packs an archive whether or not the eval left a workspace', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'vercel-eval-pack-'));

    try {
      for (const [name, createWorkspace] of [
        ['with-workspace', true],
        ['no-workspace', false],
      ] as const) {
        const workspace = join(temporary, name, 'workspace');
        const archive = join(temporary, `${name}.tgz`);
        if (createWorkspace) {
          mkdirSync(workspace, { recursive: true });
          writeFileSync(join(workspace, 'agent-output.txt'), 'hello');
        }

        execFileSync('sh', ['-c', packWorkspaceScript(workspace, archive)]);

        const listing = execFileSync('tar', ['-tzf', archive], {
          encoding: 'utf8',
        });
        expect(listing.includes('agent-output.txt')).toBe(createWorkspace);
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('downloads result metadata separately from agent workspace files', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'vercel-eval-test-'));
    const sandboxFiles = join(temporary, 'sandbox');
    const workspaceSource = join(sandboxFiles, 'workspace');
    const workspaceArchive = join(sandboxFiles, 'workspace.tgz');
    const resultSource = join(sandboxFiles, 'result.json');
    const output = join(temporary, 'downloaded');
    const pair = {
      eval_id: 'eval-1',
      experiment: 'experiment-1',
      experiment_suite: 'benchmark',
      eval_suite: 'benchmark',
    };
    const poisonFilename = 'poison"name';

    try {
      mkdirSync(workspaceSource, { recursive: true });
      writeFileSync(join(workspaceSource, poisonFilename), '');
      writeFileSync(
        resultSource,
        JSON.stringify({
          experiment: pair.experiment,
          eval: pair.eval_id,
          interface: 'cli',
        })
      );
      execFileSync('tar', [
        '-czf',
        workspaceArchive,
        '-C',
        workspaceSource,
        '.',
      ]);

      const pendingResult = await downloadResults(
        {
          downloadFile: async (source, destination) => {
            const fixture = source.path.endsWith('result.json')
              ? resultSource
              : workspaceArchive;
            mkdirSync(dirname(destination.path), { recursive: true });
            copyFileSync(fixture, destination.path);
            return destination.path;
          },
        },
        pair,
        1,
        output
      );

      const runDirectory = join(
        output,
        'raw-results-experiment-1__eval-1',
        pair.eval_id,
        'run-1'
      );
      expect(readdirSync(runDirectory).sort()).toEqual([
        'result.json.partial',
        'workspace.tgz',
      ]);
      expect(
        JSON.parse(readFileSync(pendingResult.partialPath, 'utf8'))
      ).toMatchObject({ experiment: pair.experiment, eval: pair.eval_id });

      const sandboxUsage = { memory: 8_192 };
      finalizeResult(pendingResult, sandboxUsage);
      expect(readdirSync(runDirectory).sort()).toEqual([
        'result.json',
        'workspace.tgz',
      ]);
      expect(
        JSON.parse(readFileSync(pendingResult.finalPath, 'utf8'))
      ).toMatchObject({ sandboxUsage });

      const extracted = join(temporary, 'extracted');
      mkdirSync(extracted);
      execFileSync('tar', [
        '-xzf',
        join(runDirectory, 'workspace.tgz'),
        '-C',
        extracted,
      ]);
      expect(readFileSync(join(extracted, poisonFilename), 'utf8')).toBe('');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('keeps malformed results hidden as partial', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'vercel-eval-test-'));
    const partialPath = join(temporary, 'result.json.partial');
    const finalPath = join(temporary, 'result.json');

    try {
      writeFileSync(partialPath, '{');
      expect(() =>
        finalizeResult({ partialPath, finalPath }, { memory: 8_192 })
      ).toThrow();
      expect(readdirSync(temporary)).toEqual(['result.json.partial']);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('returns stopped sandbox usage', async () => {
    const stopped = {
      activeCpuDurationMs: 12_345,
      duration: 23_456,
      memory: 8_192,
      networkTransfer: { ingress: 100, egress: 200 },
    };

    await expect(
      cleanupSandbox(
        {
          name: 'sandbox-1',
          stop: async () => stopped,
          delete: async () => undefined,
        },
        '[experiment-1 x eval-1 run 1]'
      )
    ).resolves.toEqual(stopped);
  });

  it('accepts stopped usage without optional SDK metrics', async () => {
    const stopped = { memory: 8_192 };

    await expect(
      cleanupSandbox(
        {
          name: 'sandbox-1',
          stop: async () => stopped,
          delete: async () => undefined,
        },
        '[experiment-1 x eval-1 run 1]'
      )
    ).resolves.toEqual(stopped);
  });

  it('returns no usage when the sandbox cannot stop', async () => {
    await expect(
      cleanupSandbox(
        {
          name: 'sandbox-1',
          stop: async () => {
            throw new Error('sandbox timed out');
          },
          delete: async () => undefined,
        },
        '[experiment-1 x eval-1 run 1]'
      )
    ).resolves.toBeUndefined();
  });

  it('retries sandbox creation only on 429s and 5xx API responses', () => {
    const apiError = (status: number) =>
      new APIError(new Response(null, { status }));
    expect(isRetryableSandboxCreateError(apiError(429), 1)).toBe(true);
    expect(isRetryableSandboxCreateError(apiError(500), 1)).toBe(true);
    expect(isRetryableSandboxCreateError(apiError(401), 1)).toBe(false);
    expect(isRetryableSandboxCreateError(apiError(400), 1)).toBe(false);
  });

  it('retries a real network error through the full attempt budget', () => {
    const networkError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('read ECONNRESET'), {
        code: 'ECONNRESET',
      }),
    });
    expect(isRetryableSandboxCreateError(networkError, 1)).toBe(true);
    expect(isRetryableSandboxCreateError(networkError, 12)).toBe(true);
  });

  it('caps an unrecognized error to a couple of attempts', () => {
    const mystery = new Error('something we have never seen');
    expect(isRetryableSandboxCreateError(mystery, 1)).toBe(true);
    expect(isRetryableSandboxCreateError(mystery, 2)).toBe(true);
    expect(isRetryableSandboxCreateError(mystery, 3)).toBe(false);
  });

  it('marks definitive 4xx API responses as terminal', () => {
    const apiError = (status: number) =>
      new APIError(new Response(null, { status }));

    expect(isTerminalSandboxCreateError(apiError(401))).toBe(true);
    expect(isTerminalSandboxCreateError(apiError(400))).toBe(true);
  });

  it('does not mark retryable or unknown errors as terminal', () => {
    const apiError = (status: number) =>
      new APIError(new Response(null, { status }));
    const networkError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('read ECONNRESET'), {
        code: 'ECONNRESET',
      }),
    });
    const mystery = new Error('something we have never seen');

    expect(isTerminalSandboxCreateError(apiError(429))).toBe(false);
    expect(isTerminalSandboxCreateError(apiError(500))).toBe(false);
    expect(isTerminalSandboxCreateError(networkError)).toBe(false);
    expect(isTerminalSandboxCreateError(mystery)).toBe(false);
  });
});

describe('expandJobs', () => {
  const pair = (evalId: string) => ({
    eval_id: evalId,
    experiment: 'model-a',
    experiment_suite: 'benchmark',
    eval_suite: 'benchmark',
  });

  it('gives every pair one job per run', () => {
    const jobs = expandJobs([pair('eval-1'), pair('eval-2')], 3);

    expect(jobs).toHaveLength(6);
    expect(jobs.map((job) => `${job.pair.eval_id}#${job.run}`)).toEqual([
      'eval-1#1',
      'eval-1#2',
      'eval-1#3',
      'eval-2#1',
      'eval-2#2',
      'eval-2#3',
    ]);
  });

  it('numbers runs from one so indexes are stable across sandboxes', () => {
    expect(expandJobs([pair('eval-1')], 3).map((job) => job.run)).toEqual([
      1, 2, 3,
    ]);
  });

  it('reduces to one job per pair for a single run', () => {
    expect(expandJobs([pair('eval-1'), pair('eval-2')], 1)).toHaveLength(2);
  });
});
