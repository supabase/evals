// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/build-database-006-regenerate-types
import type {
  CommandResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import type { StackProbe } from '../lib/stack.js';
import { analysisFixture } from './fixtures.js';
import { checkMetrics, countGenTypesRuns, readCliFacts } from './metrics.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.117.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

const ctx: Pick<LocalStackEvalContext, 'exec'> = {
  exec: async (command) =>
    command.endsWith('supabase --version')
      ? commandResult('2.117.0\n')
      : commandResult('', false),
};

const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: DB_URL,
  runtime: 'native',
};

const metricsOf = (check: { notes?: string }) =>
  JSON.parse(check.notes ?? '{}');

const throwing = <T extends object>(target: T): T =>
  new Proxy(target, {
    get() {
      throw new Error('boom');
    },
  });

describe('countGenTypesRuns', () => {
  const count = (commands: string[]) =>
    countGenTypesRuns(findSupabaseInvocations(commands));

  it('counts nothing when no supabase command ran', () => {
    expect(count([])).toEqual({ runs: 0, sources: [] });
  });

  it('counts gen types typescript --local with its output redirected', () => {
    expect(
      count(['supabase gen types typescript --local > src/database.types.ts'])
    ).toEqual({ runs: 1, sources: ['local'] });
  });

  it('counts gen types --lang typescript --local', () => {
    expect(count(['supabase gen types --lang typescript --local'])).toEqual({
      runs: 1,
      sources: ['local'],
    });
  });

  it('counts a run through npx with --db-url as db-url', () => {
    expect(
      count(['npx supabase gen types --lang typescript --db-url "$DB_URL"'])
    ).toEqual({ runs: 1, sources: ['db-url'] });
  });

  it('counts --db-url=<url> as db-url', () => {
    expect(count([`supabase gen types typescript --db-url=${DB_URL}`])).toEqual(
      { runs: 1, sources: ['db-url'] }
    );
  });

  it('counts a gen types run that follows other supabase commands in one line', () => {
    expect(
      count([
        'DB_URL=$(supabase status -o env | grep DB_URL | cut -d= -f2-) && supabase gen types typescript --db-url "$DB_URL" > src/database.types.ts',
      ])
    ).toEqual({ runs: 1, sources: ['db-url'] });
  });

  it('counts a run under SUPABASE_EXPERIMENTAL_STACK=1 as local', () => {
    expect(
      count([
        'SUPABASE_EXPERIMENTAL_STACK=1 supabase gen types typescript --local',
      ])
    ).toEqual({ runs: 1, sources: ['local'] });
  });

  it('counts --linked and --project-id runs under their own sources', () => {
    const result = count([
      'supabase gen types typescript --linked',
      'supabase gen types typescript --project-id abcdefghijklmnopqrst',
    ]);

    expect(result.runs).toBe(2);
    expect([...result.sources].sort()).toEqual(['linked', 'project-id']);
  });

  it('counts a run that puts a value flag before gen', () => {
    expect(
      count(['supabase --workdir app gen types typescript --local'])
    ).toEqual({ runs: 1, sources: ['local'] });
  });

  it('reports the source none for a run that names no database', () => {
    expect(count(['supabase gen types typescript'])).toEqual({
      runs: 1,
      sources: ['none'],
    });
  });

  it('counts every run but lists each source once', () => {
    const result = count([
      'supabase gen types typescript --local',
      'supabase gen types typescript --local > src/database.types.ts',
      'supabase gen types typescript --db-url "$DB_URL"',
    ]);

    expect(result.runs).toBe(3);
    expect([...result.sources].sort()).toEqual(['db-url', 'local']);
  });

  it('does not count other gen subcommands or other supabase commands', () => {
    expect(
      count([
        'supabase gen signing-key',
        'supabase start',
        'supabase db reset',
        'supabase migration up',
      ])
    ).toEqual({ runs: 0, sources: [] });
  });

  it('does not count another gen subcommand that has types as a later argument', () => {
    expect(
      count(['supabase gen signing-key --algorithm types --local'])
    ).toEqual({ runs: 0, sources: [] });
  });

  it('does not count a gen types command that was only echoed', () => {
    expect(count(['echo "supabase gen types --local"'])).toEqual({
      runs: 0,
      sources: [],
    });
  });
});

describe('checkMetrics', () => {
  it('reports every documented field and always passes', async () => {
    const commands = [
      'supabase gen types typescript --local > src/database.types.ts',
      'supabase gen types --lang typescript --db-url "$DB_URL"',
      'sudo apt-get install docker.io',
    ];
    const invocations = findSupabaseInvocations(commands);

    const check = await checkMetrics(MARKER, {
      commands,
      genTypes: countGenTypesRuns(invocations),
      stack: { ...STACK, relocatedHome: '/home/agent/.supabase' },
      analysis: analysisFixture({
        diagnostics: ['src/tasks.ts:10 a', 'src/tasks.ts:11 b'],
        suppressions: ['src/tasks.ts:12 @ts-ignore'],
      }),
      cli: await readCliFacts(ctx, MARKER, invocations),
    });

    expect(check).toMatchObject({ name: 'metrics', passed: true });
    const { genTypesSources, ...rest } = metricsOf(check);
    expect([...genTypesSources].sort()).toEqual(['db-url', 'local']);
    expect(rest).toEqual({
      cliVersion: '2.117.0',
      cliOverride: [],
      channel: 'beta',
      stack: {
        backend: 'managed',
        runtime: 'native',
        relocatedHome: '/home/agent/.supabase',
      },
      genTypesRuns: 2,
      typesModules: ['src/types/supabase.ts'],
      diagnostics: 2,
      suppressions: 1,
      cliDetours: 1,
    });
  });

  it('reports the pinned channel and a null relocated home when the run had no marker and the CLI home was the default', async () => {
    const check = await checkMetrics(undefined, {
      commands: [],
      genTypes: { runs: 0, sources: [] },
      stack: STACK,
      analysis: analysisFixture(),
      cli: await readCliFacts(ctx, undefined, []),
    });

    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({
      channel: 'pinned',
      stack: { backend: 'managed', runtime: 'native', relocatedHome: null },
      genTypesRuns: 0,
      genTypesSources: [],
      diagnostics: 0,
      suppressions: 0,
      cliDetours: 0,
    });
  });

  it('reports nulls instead of failing when nothing resolved', async () => {
    const failing: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async () => {
        throw new Error('sandbox gone');
      },
    };

    const check = await checkMetrics(undefined, {
      commands: [],
      genTypes: { runs: 0, sources: [] },
      stack: { ok: false, notes: 'none' },
      analysis: { ok: false, notes: 'src directory is missing' },
      cli: await readCliFacts(failing, undefined, []),
    });

    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({
      cliVersion: null,
      channel: 'pinned',
      stack: { backend: 'none', runtime: 'none', relocatedHome: null },
      genTypesRuns: 0,
      typesModules: null,
      diagnostics: null,
      suppressions: null,
      cliDetours: 0,
    });
  });

  it('reports a version-swapping runner and a PATH version that moved', async () => {
    const commands = ['npx --yes supabase@2.1.0 gen types typescript --local'];
    const moved: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async (command) =>
        command.startsWith('/usr/bin/supabase')
          ? commandResult('2.117.0\n')
          : commandResult('2.122.0\n'),
    };
    const invocations = findSupabaseInvocations(commands);

    const check = await checkMetrics(MARKER, {
      commands,
      genTypes: countGenTypesRuns(invocations),
      stack: STACK,
      analysis: analysisFixture(),
      cli: await readCliFacts(moved, MARKER, invocations),
    });

    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.117.0',
      cliVersionAfterRun: '2.122.0',
      cliOverride: ['npx --yes supabase@2.1.0'],
      genTypesRuns: 1,
    });
  });

  it('turns a field whose input throws into null without failing the others', async () => {
    const commands = ['supabase gen types typescript --local'];
    const invocations = findSupabaseInvocations(commands);
    const cli = await readCliFacts(ctx, MARKER, invocations);
    const genTypes = countGenTypesRuns(invocations);

    const hostileCommands = await checkMetrics(MARKER, {
      commands: throwing([] as string[]),
      genTypes,
      stack: STACK,
      analysis: analysisFixture(),
      cli,
    });
    expect(hostileCommands.passed).toBe(true);
    expect(metricsOf(hostileCommands)).toMatchObject({
      cliDetours: null,
      genTypesRuns: 1,
      genTypesSources: ['local'],
      diagnostics: 0,
    });

    const hostileGenTypes = await checkMetrics(MARKER, {
      commands,
      genTypes: throwing({ runs: 1, sources: ['local'] }),
      stack: STACK,
      analysis: analysisFixture(),
      cli,
    });
    expect(hostileGenTypes.passed).toBe(true);
    expect(metricsOf(hostileGenTypes)).toMatchObject({
      genTypesRuns: null,
      genTypesSources: null,
      cliDetours: 0,
      diagnostics: 0,
    });

    const hostileAnalysis = await checkMetrics(MARKER, {
      commands,
      genTypes,
      stack: STACK,
      analysis: {
        ok: true,
        get typesModules(): never {
          throw new Error('boom');
        },
        diagnostics: ['src/tasks.ts:10 a'],
        suppressions: [],
        missingExports: [],
        appFiles: [],
      },
      cli,
    });
    expect(hostileAnalysis.passed).toBe(true);
    expect(metricsOf(hostileAnalysis)).toMatchObject({
      typesModules: null,
      diagnostics: 1,
      suppressions: 0,
      genTypesRuns: 1,
    });
  });
});
