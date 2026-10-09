import { APIError } from '@vercel/sandbox';
import { resolveCliVersionSpec } from '@supabase-evals/sandbox';
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentEnvironment,
  BROKERED_KEY_PLACEHOLDER,
  BROKERED_KEYS,
  brokeredNetworkPolicy,
  cleanupSandbox,
  downloadResults,
  finalizeResult,
  cliVersionPinsEnv,
  FORWARDED_ENV_NAMES,
  isRetryableSandboxCreateError,
  isTerminalSandboxCreateError,
  packWorkspaceScript,
  parsePairs,
  requiredCliVersionSpecs,
  resolveCliVersionPins,
  runPairs,
  runBounded,
  tagValue,
  expandJobs,
  type EvalPair,
} from './run-vercel-evals.js';

vi.mock('@supabase-evals/sandbox', () => ({
  resolveCliVersionSpec: vi.fn(),
}));

const BROKERED_NAMES = BROKERED_KEYS.map(({ name }) => name);

describe('agentEnvironment', () => {
  const originalValues = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of [...BROKERED_NAMES, ...FORWARDED_ENV_NAMES]) {
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

  it('writes key placeholders and forwards CLI pins', () => {
    for (const name of [...BROKERED_NAMES, ...FORWARDED_ENV_NAMES]) {
      process.env[name] = `${name}-value`;
    }

    const env = agentEnvironment();
    const lines = env.split('\n');
    for (const name of BROKERED_NAMES) {
      expect(lines).toContain(`${name}=${BROKERED_KEY_PLACEHOLDER}`);
      expect(env).not.toContain(`${name}-value`);
    }
    for (const name of FORWARDED_ENV_NAMES) {
      expect(lines).toContain(`${name}=${name}-value`);
    }
  });

  it('omits the CLI version pins when unset', () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-value';

    const env = agentEnvironment();
    expect(env).toBe(`ANTHROPIC_API_KEY=${BROKERED_KEY_PLACEHOLDER}`);
    expect(env).not.toContain('SUPABASE_CLI_VERSION_PINS');
  });

  it('prefers an explicit pin over the same-named process.env value', () => {
    process.env.SUPABASE_CLI_VERSION_PINS = '{"latest":"1.0.0"}';

    const env = agentEnvironment({
      SUPABASE_CLI_VERSION_PINS: '{"latest":"2.117.0"}',
    });

    expect(env).toContain('SUPABASE_CLI_VERSION_PINS={"latest":"2.117.0"}');
    expect(env).not.toContain('1.0.0');
  });

  it('shares one pin value across multiple .env writes, simulating a two-job fan-out', () => {
    const pins = cliVersionPinsEnv({
      latest: '2.117.0',
      beta: '2.118.0-beta.5',
      next: '3.0.0-next.2',
    });

    const jobOneEnv = agentEnvironment(pins);
    const jobTwoEnv = agentEnvironment(pins);

    expect(jobOneEnv).toBe(jobTwoEnv);
    expect(jobOneEnv).toBe(
      'SUPABASE_CLI_VERSION_PINS={"latest":"2.117.0","beta":"2.118.0-beta.5","next":"3.0.0-next.2"}'
    );
  });
});

describe('cliVersionPinsEnv', () => {
  it('forwards a single JSON env var for the resolved pins', () => {
    expect(cliVersionPinsEnv({ canary: '1.4.0-canary.7' })).toEqual({
      SUPABASE_CLI_VERSION_PINS: '{"canary":"1.4.0-canary.7"}',
    });
  });

  it('forwards nothing when no spec was resolved', () => {
    expect(cliVersionPinsEnv({})).toEqual({});
  });
});

describe('FORWARDED_ENV_NAMES', () => {
  // Extra guard against forwarding a raw provider key. Not a complete check.
  it('forwards no API keys', () => {
    expect(
      FORWARDED_ENV_NAMES.filter((name) => name.endsWith('_API_KEY'))
    ).toEqual([]);
  });
});

describe('brokeredNetworkPolicy', () => {
  const originalValues = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of BROKERED_NAMES) {
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

  it('injects configured keys, pins Host, and allows other traffic', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    process.env.OPENAI_API_KEY = 'sk-openai';

    expect(brokeredNetworkPolicy()).toEqual({
      allow: {
        '*': [],
        'api.anthropic.com': [
          {
            transform: [
              { headers: { host: 'api.anthropic.com', 'x-api-key': 'sk-ant' } },
            ],
          },
        ],
        'api.openai.com': [
          {
            transform: [
              {
                headers: {
                  host: 'api.openai.com',
                  authorization: 'Bearer sk-openai',
                },
              },
            ],
          },
        ],
      },
    });
  });
});

describe('resolveCliVersionPins', () => {
  beforeEach(() => {
    vi.mocked(resolveCliVersionSpec).mockReset();
  });

  it('resolves only the requested specs into one pin map every job can share', async () => {
    vi.mocked(resolveCliVersionSpec).mockImplementation(async (spec) =>
      spec === 'latest' ? '2.117.0' : '2.118.0-beta.5'
    );

    const { pins, errors } = await resolveCliVersionPins(
      new Set(['latest', 'beta'])
    );

    expect(pins).toEqual({ latest: '2.117.0', beta: '2.118.0-beta.5' });
    expect(errors.size).toBe(0);
    expect(resolveCliVersionSpec).toHaveBeenCalledTimes(2);
    expect(resolveCliVersionSpec).toHaveBeenCalledWith('latest');
    expect(resolveCliVersionSpec).toHaveBeenCalledWith('beta');

    // Two fanned-out jobs writing their own .env from the same pins must get
    // the identical value the resolver was called once for.
    const forwarded = cliVersionPinsEnv(pins);
    expect(agentEnvironment(forwarded)).toBe(agentEnvironment(forwarded));
    expect(agentEnvironment(forwarded)).toContain(
      'SUPABASE_CLI_VERSION_PINS={"latest":"2.117.0","beta":"2.118.0-beta.5"}'
    );
  });

  it('resolves a range spec', async () => {
    vi.mocked(resolveCliVersionSpec).mockResolvedValue('2.121.0');

    const { pins } = await resolveCliVersionPins(new Set(['^2.120.0']));

    expect(pins).toEqual({ '^2.120.0': '2.121.0' });
    expect(resolveCliVersionSpec).toHaveBeenCalledWith('^2.120.0');
  });

  it('does no network work for an empty spec set', async () => {
    const { pins, errors } = await resolveCliVersionPins(new Set());

    expect(pins).toEqual({});
    expect(errors.size).toBe(0);
    expect(resolveCliVersionSpec).not.toHaveBeenCalled();
  });

  it('reports a failing spec without dropping the ones that resolved', async () => {
    const failure = new Error('npm unreachable');
    vi.mocked(resolveCliVersionSpec).mockImplementation(async (spec) => {
      if (spec === 'beta') throw failure;
      return '2.117.0';
    });

    const { pins, errors } = await resolveCliVersionPins(
      new Set(['latest', 'beta'])
    );

    expect(pins).toEqual({ latest: '2.117.0' });
    expect([...errors]).toEqual([['beta', failure]]);
  });
});

describe('requiredCliVersionSpecs', () => {
  const pair = (overrides: Partial<EvalPair> = {}): EvalPair => ({
    eval_id: 'eval-1',
    experiment: 'experiment-1',
    experiment_suite: 'benchmark',
    eval_suite: 'benchmark',
    ...overrides,
  });

  it('resolves only the spec a latest-tagged experiment declares', async () => {
    const loadExperimentConfig = vi.fn(async () => ({
      localStack: { cliVersionSpec: 'latest' },
    }));
    const target = pair();

    const specs = await requiredCliVersionSpecs([target], {
      loadEvalMetadata: () => ({ cliVersion: undefined }),
      loadExperimentConfig,
    });

    expect([...specs]).toEqual([[target, 'latest']]);
  });

  it('resolves nothing when no experiment in the pair set declares a spec', async () => {
    const loadExperimentConfig = vi.fn(async () => ({}));

    const specs = await requiredCliVersionSpecs(
      [pair(), pair({ eval_id: 'eval-2', experiment: 'experiment-2' })],
      {
        loadEvalMetadata: () => ({ cliVersion: undefined }),
        loadExperimentConfig,
      }
    );

    expect(specs.size).toBe(0);
  });

  it("an eval's pinned cliVersion contributes no spec, even when its experiment declares one", async () => {
    const loadExperimentConfig = vi.fn(async () => ({
      localStack: { cliVersionSpec: 'beta' },
    }));

    const specs = await requiredCliVersionSpecs([pair()], {
      loadEvalMetadata: () => ({ cliVersion: '2.109.1' }),
      loadExperimentConfig,
    });

    expect(specs.size).toBe(0);
    expect(loadExperimentConfig).not.toHaveBeenCalled();
  });

  it('maps pairs sharing an experiment to one spec without loading its config twice', async () => {
    const loadExperimentConfig = vi.fn(async () => ({
      localStack: { cliVersionSpec: '^2.120.0' },
    }));

    const specs = await requiredCliVersionSpecs(
      [pair(), pair({ eval_id: 'eval-2' })],
      {
        loadEvalMetadata: () => ({ cliVersion: undefined }),
        loadExperimentConfig,
      }
    );

    expect([...new Set(specs.values())]).toEqual(['^2.120.0']);
    expect(specs.size).toBe(2);
    expect(loadExperimentConfig).toHaveBeenCalledTimes(1);
  });

  it('throws naming an experiment that cannot be resolved to a config', async () => {
    await expect(
      requiredCliVersionSpecs([pair({ experiment: 'ghost' })], {
        loadEvalMetadata: () => ({ cliVersion: undefined }),
        loadExperimentConfig: async () => {
          throw new Error('no experiment config found for "ghost"');
        },
      })
    ).rejects.toThrow('no experiment config found for "ghost"');
  });
});

describe('runPairs', () => {
  const pair = (experiment: string, evalId = 'eval-1'): EvalPair => ({
    eval_id: evalId,
    experiment,
    experiment_suite: 'cli',
    eval_suite: 'cli',
  });
  const options = (pairs: EvalPair[]) => ({
    pairs,
    revision: 'main',
    repoUrl: 'https://example.com/repo.git',
    outputDir: '/tmp/unused',
    runs: 2,
    timeoutSec: 60,
    concurrency: 4,
    vcpus: 2,
  });
  const specsByExperiment: Record<string, string> = {
    'on-latest': 'latest',
    'on-broken': 'broken-tag',
  };

  beforeEach(() => {
    vi.mocked(resolveCliVersionSpec).mockReset();
    vi.stubEnv('VERCEL_TOKEN', 'token');
    vi.stubEnv('VERCEL_TEAM_ID', 'team');
    vi.stubEnv('VERCEL_PROJECT_ID', 'project');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function deps(
    cliVersions: Record<string, string | undefined> = {}
  ): Parameters<typeof runPairs>[1] & {
    runPairOnce: ReturnType<typeof vi.fn>;
  } {
    return {
      runPairOnce: vi.fn(async () => {}),
      loadEvalMetadata: (target) => ({
        cliVersion: cliVersions[target.eval_id],
      }),
      loadExperimentConfig: async (experiment) => ({
        localStack: { cliVersionSpec: specsByExperiment[experiment] },
      }),
    };
  }

  it('fails only the jobs whose spec could not resolve, and forwards only resolved pins', async () => {
    vi.mocked(resolveCliVersionSpec).mockImplementation(async (spec) => {
      if (spec === 'broken-tag') throw new Error('asset is missing');
      return '2.117.0';
    });
    const runDeps = deps();

    const outcome = runPairs(
      options([pair('on-latest'), pair('on-broken')]),
      runDeps
    );

    await expect(outcome).rejects.toThrow('2 Sandbox eval run(s) failed');
    await outcome.catch((error: AggregateError) => {
      expect(error.errors.map((cause) => cause.message)).toEqual([
        '[on-broken x eval-1 run 1]: could not resolve Supabase CLI version "broken-tag": asset is missing',
        '[on-broken x eval-1 run 2]: could not resolve Supabase CLI version "broken-tag": asset is missing',
      ]);
    });

    const started = runDeps.runPairOnce.mock.calls.map(
      ([jobOptions]) => `${jobOptions.pair.experiment}#${jobOptions.run}`
    );
    expect(started.sort()).toEqual(['on-latest#1', 'on-latest#2']);
    for (const [jobOptions] of runDeps.runPairOnce.mock.calls) {
      expect(jobOptions.pins).toEqual({
        SUPABASE_CLI_VERSION_PINS: '{"latest":"2.117.0"}',
      });
    }
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('SANDBOX FAILED [on-broken x eval-1 run 1]')
    );
  });

  it("runs a job whose eval pins cliVersion even when its experiment's spec failed", async () => {
    vi.mocked(resolveCliVersionSpec).mockRejectedValue(new Error('npm down'));
    const runDeps = deps({ 'pinned-eval': '2.109.1' });

    await runPairs(options([pair('on-broken', 'pinned-eval')]), runDeps);

    expect(runDeps.runPairOnce).toHaveBeenCalledTimes(2);
    expect(resolveCliVersionSpec).not.toHaveBeenCalled();
  });

  it('runs every job when all specs resolve', async () => {
    vi.mocked(resolveCliVersionSpec).mockResolvedValue('2.117.0');
    const runDeps = deps();

    await runPairs(options([pair('on-latest'), pair('on-broken')]), runDeps);

    expect(runDeps.runPairOnce).toHaveBeenCalledTimes(4);
    expect(resolveCliVersionSpec).toHaveBeenCalledTimes(2);
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
        'session-archive.tar.gz',
        'workspace.tgz',
      ]);
      expect(
        JSON.parse(readFileSync(pendingResult.partialPath, 'utf8'))
      ).toMatchObject({ experiment: pair.experiment, eval: pair.eval_id });

      const sandboxUsage = { memory: 8_192 };
      finalizeResult(pendingResult, sandboxUsage);
      expect(readdirSync(runDirectory).sort()).toEqual([
        'result.json',
        'session-archive.tar.gz',
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
    const usage = {
      activeCpuDurationMs: 12_345,
      duration: 23_456,
      memory: 8_192,
      networkTransfer: { ingress: 100, egress: 200 },
    };

    await expect(
      cleanupSandbox(
        {
          name: 'sandbox-1',
          stop: async () => ({ status: 'stopped', ...usage }),
          delete: async () => undefined,
        },
        '[experiment-1 x eval-1 run 1]'
      )
    ).resolves.toEqual(usage);
  });

  it('polls stop until the session is stopped', async () => {
    const stop = vi
      .fn()
      .mockResolvedValueOnce({ status: 'stopping', memory: 8_192 })
      .mockResolvedValueOnce({ status: 'stopped', memory: 8_192, duration: 1 });

    await expect(
      cleanupSandbox(
        { name: 'sandbox-1', stop, delete: async () => undefined },
        '[experiment-1 x eval-1 run 1]'
      )
    ).resolves.toMatchObject({ duration: 1 });
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('does not poll a failed session', async () => {
    const stop = vi.fn().mockResolvedValue({ status: 'failed', memory: 8_192 });

    await cleanupSandbox(
      { name: 'sandbox-1', stop, delete: async () => undefined },
      '[experiment-1 x eval-1 run 1]'
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('accepts stopped usage without optional SDK metrics', async () => {
    await expect(
      cleanupSandbox(
        {
          name: 'sandbox-1',
          stop: async () => ({ status: 'stopped', memory: 8_192 }),
          delete: async () => undefined,
        },
        '[experiment-1 x eval-1 run 1]'
      )
    ).resolves.toEqual({ memory: 8_192 });
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
