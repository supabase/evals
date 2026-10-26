// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/build-database-006-regenerate-types
import type {
  CommandResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  findSupabaseInvocations,
  type StackLifecycle,
} from '../lib/cli-invocations.js';
import { extractCommandEntries } from '../lib/detours.js';
import type { StackProbe } from '../lib/stack.js';
import {
  analysisFixture,
  CHAINED_TYPECHECK_GEN_TYPES_CALL,
  COMPOUND_GEN_TYPES_CALL,
  CONNECT_LOCAL_DB,
  dockerRunToolCalls,
  failedCall,
  GEN_TYPES_OUTPUT,
  GENERATED_TYPES,
  MASKED_PIPE_GEN_TYPES_CALL,
  SILENT_FAILED_GEN_TYPES_CALL,
  SILENT_FAILED_TYPECHECK_CALL,
  SUCCEEDED_GEN_TYPES_CALL,
  TLS_FAILED_GEN_TYPES_CALL,
} from './fixtures.js';
import {
  checkMetrics,
  checkTypesRegenerated,
  countGenTypesRuns,
  listSilentFailures,
  readCliFacts,
  type GenTypesRuns,
} from './metrics.js';

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

const NO_LIFECYCLE: StackLifecycle = {
  lastCommand: null,
  stoppedByAgent: false,
};

const NO_GEN_TYPES: GenTypesRuns = {
  runs: 0,
  sources: [],
  failed: [],
  succeeded: [],
};

const shellCall = (command: string): ToolCallRecord => ({
  tool: { kind: 'other', toolName: 'shell' },
  body: { command },
  command,
  result: '',
  ts: 0,
});

const countCalls = (toolCalls: ToolCallRecord[]) =>
  countGenTypesRuns(
    findSupabaseInvocations(extractCommandEntries(toolCalls)),
    toolCalls
  );

const metricsOf = (check: { notes?: string }) =>
  JSON.parse(check.notes ?? '{}');

const throwing = <T extends object>(target: T): T =>
  new Proxy(target, {
    get() {
      throw new Error('boom');
    },
  });

describe('countGenTypesRuns', () => {
  const count = (commands: string[]) => {
    const { runs, sources } = countGenTypesRuns(
      findSupabaseInvocations(commands),
      commands.map(shellCall)
    );
    return { runs, sources };
  };

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

describe('countGenTypesRuns failed runs', () => {
  it('counts a call recorded with an empty error as failed and silent', () => {
    expect(countCalls([SILENT_FAILED_GEN_TYPES_CALL])).toEqual({
      runs: 1,
      sources: ['local'],
      failed: [{ command: SILENT_FAILED_GEN_TYPES_CALL.command, silent: true }],
      succeeded: [],
    });
  });

  it('does not count a call that returned a result as failed', () => {
    expect(countCalls(dockerRunToolCalls())).toMatchObject({
      runs: 2,
      failed: [],
    });
  });

  it('counts a call with an error message as failed but not silent', () => {
    const call = {
      ...SILENT_FAILED_GEN_TYPES_CALL,
      error: 'ContainerRuntimeNotFoundError: no container runtime found',
    };

    expect(countCalls([call]).failed).toEqual([
      { command: call.command, silent: false },
    ]);
  });

  it('lists only the failed calls among several runs', () => {
    expect(
      countCalls([SILENT_FAILED_GEN_TYPES_CALL, ...dockerRunToolCalls()])
    ).toMatchObject({
      runs: 3,
      failed: [{ command: SILENT_FAILED_GEN_TYPES_CALL.command, silent: true }],
    });
  });

  it('ignores a failed call that ran no gen types', () => {
    const start = { ...shellCall('supabase start'), error: 'boom' };

    expect(countCalls([start])).toEqual({
      runs: 0,
      sources: [],
      failed: [],
      succeeded: [],
    });
  });
});

describe('countGenTypesRuns succeeded runs', () => {
  it('counts a redirected run whose output is the CLI progress as succeeded', () => {
    expect(countCalls([SUCCEEDED_GEN_TYPES_CALL])).toMatchObject({
      runs: 1,
      failed: [],
      succeeded: [
        {
          command: SUCCEEDED_GEN_TYPES_CALL.command,
          laterCommandFailed: false,
        },
      ],
    });
  });

  it('counts a gen types run inside a compound command that exited zero as succeeded', () => {
    expect(countCalls([COMPOUND_GEN_TYPES_CALL])).toMatchObject({
      runs: 1,
      failed: [],
      succeeded: [
        { command: COMPOUND_GEN_TYPES_CALL.command, laterCommandFailed: false },
      ],
    });
  });

  it('counts neither succeeded nor failed a run that exited zero through a pipe while printing the CLI error', () => {
    expect(countCalls([MASKED_PIPE_GEN_TYPES_CALL])).toMatchObject({
      runs: 1,
      failed: [],
      succeeded: [],
    });
  });

  it('does not count a silent failure as succeeded', () => {
    expect(countCalls([SILENT_FAILED_GEN_TYPES_CALL])).toMatchObject({
      runs: 1,
      failed: [{ silent: true }],
      succeeded: [],
    });
  });

  it('does not count a call with an error message as succeeded', () => {
    const call = failedCall(
      'supabase gen types --local',
      '{"_tag":"Error","error":{"code":"GenTypesLocalDbNotRunningError"}}\n'
    );

    expect(countCalls([call])).toMatchObject({ failed: [{}], succeeded: [] });
  });

  it('does not count a call that recorded no output as succeeded', () => {
    const { result: _result, ...call } = SUCCEEDED_GEN_TYPES_CALL;

    expect(countCalls([call])).toMatchObject({ failed: [], succeeded: [] });
  });

  it('lists only the succeeded calls among several runs', () => {
    expect(
      countCalls([
        SILENT_FAILED_GEN_TYPES_CALL,
        MASKED_PIPE_GEN_TYPES_CALL,
        SUCCEEDED_GEN_TYPES_CALL,
      ])
    ).toMatchObject({
      runs: 3,
      succeeded: [
        {
          command: SUCCEEDED_GEN_TYPES_CALL.command,
          laterCommandFailed: false,
        },
      ],
    });
  });
});

describe('countGenTypesRuns runs whose tool call errored after the CLI connected', () => {
  it('counts a run whose later typecheck failed as succeeded and not failed', () => {
    expect(countCalls([CHAINED_TYPECHECK_GEN_TYPES_CALL])).toEqual({
      runs: 1,
      sources: ['local'],
      failed: [],
      succeeded: [
        {
          command: CHAINED_TYPECHECK_GEN_TYPES_CALL.command,
          laterCommandFailed: true,
        },
      ],
    });
  });

  it('counts the unformatted-types notice printed to stderr as the generated types', () => {
    const call = failedCall(
      'supabase gen types typescript --local --schema public > src/database.types.ts && npm run typecheck',
      `${GEN_TYPES_OUTPUT}\n> tsc --noEmit\n\nsh: 1: tsc: not found\n`
    );

    expect(countCalls([call])).toMatchObject({
      failed: [],
      succeeded: [{ command: call.command, laterCommandFailed: true }],
    });
  });

  it('keeps a run that errored after only connecting as failed', () => {
    expect(countCalls([TLS_FAILED_GEN_TYPES_CALL])).toEqual({
      runs: 1,
      sources: ['db-url'],
      failed: [{ command: TLS_FAILED_GEN_TYPES_CALL.command, silent: false }],
      succeeded: [],
    });
  });

  it('does not count generated types printed before the connect line', () => {
    const call = failedCall(
      'cat src/database.types.ts && supabase gen types --local > /tmp/t.ts && npm run typecheck',
      `${GENERATED_TYPES}${CONNECT_LOCAL_DB}`
    );

    expect(countCalls([call])).toMatchObject({
      failed: [{ command: call.command, silent: false }],
      succeeded: [],
    });
  });

  it('does not count generated types in an output with no connect line', () => {
    const call = failedCall(
      'supabase gen types --local > /tmp/t.ts; head -150 src/database.types.ts && npm run typecheck',
      GENERATED_TYPES
    );

    expect(countCalls([call])).toMatchObject({ failed: [{}], succeeded: [] });
  });

  it('does not count generated types after the connect line when the output holds a CLI error', () => {
    const call = failedCall(
      'supabase gen types --local --schema public > src/database.types.ts && head -150 src/database.types.ts && supabase db lint',
      `${CONNECT_LOCAL_DB}${GENERATED_TYPES}{"_tag":"Error","error":{"code":"DbLintFailed"}}\n`
    );

    expect(countCalls([call])).toMatchObject({
      failed: [{ command: call.command, silent: false }],
      succeeded: [],
    });
  });
});

describe('listSilentFailures', () => {
  const silentFailures = (toolCalls: ToolCallRecord[]) =>
    listSilentFailures(
      findSupabaseInvocations(extractCommandEntries(toolCalls)),
      toolCalls
    );

  it('lists the command of a call recorded with an empty error', () => {
    expect(silentFailures([SILENT_FAILED_TYPECHECK_CALL])).toEqual([
      SILENT_FAILED_TYPECHECK_CALL.command,
    ]);
  });

  it('lists each such call once, in order', () => {
    const lint = { ...SILENT_FAILED_TYPECHECK_CALL, command: 'npm run lint' };

    expect(silentFailures([SILENT_FAILED_TYPECHECK_CALL, lint, lint])).toEqual([
      SILENT_FAILED_TYPECHECK_CALL.command,
      'npm run lint',
      'npm run lint',
    ]);
  });

  it('ignores calls that succeeded or errored with output', () => {
    expect(
      silentFailures([
        SUCCEEDED_GEN_TYPES_CALL,
        failedCall('npm run typecheck', 'sh: 1: tsc: not found\n'),
        shellCall('ls'),
      ])
    ).toEqual([]);
  });

  it('does not repeat a silent gen types failure', () => {
    const compound = {
      ...SILENT_FAILED_GEN_TYPES_CALL,
      command: 'supabase gen types --local > /tmp/t.ts && npm run typecheck',
    };

    expect(
      silentFailures([
        SILENT_FAILED_GEN_TYPES_CALL,
        compound,
        SILENT_FAILED_TYPECHECK_CALL,
      ])
    ).toEqual([SILENT_FAILED_TYPECHECK_CALL.command]);
  });

  it('lists a silent failure that follows a gen types run in another call', () => {
    expect(
      silentFailures([SUCCEEDED_GEN_TYPES_CALL, SILENT_FAILED_TYPECHECK_CALL])
    ).toEqual([SILENT_FAILED_TYPECHECK_CALL.command]);
  });
});

describe('checkTypesRegenerated', () => {
  const NAME = 'types were regenerated with supabase gen types';

  it('fails with a note when the agent ran no gen types', () => {
    const check = checkTypesRegenerated(countCalls([]));

    expect(check).toMatchObject({ name: NAME, passed: false });
    expect(check.notes).toContain('no direct `supabase gen types` run');
  });

  it('passes when a run succeeded and names it in the notes', () => {
    const check = checkTypesRegenerated(countCalls([SUCCEEDED_GEN_TYPES_CALL]));

    expect(check).toMatchObject({ name: NAME, passed: true });
    expect(check.notes).toContain(`\`${SUCCEEDED_GEN_TYPES_CALL.command}\``);
  });

  it('passes when a failed run is followed by a later success, naming the last success', () => {
    const check = checkTypesRegenerated(
      countCalls([
        SILENT_FAILED_GEN_TYPES_CALL,
        SUCCEEDED_GEN_TYPES_CALL,
        COMPOUND_GEN_TYPES_CALL,
      ])
    );

    expect(check.passed).toBe(true);
    expect(check.notes).toContain(`\`${COMPOUND_GEN_TYPES_CALL.command}\``);
  });

  it('passes a run whose later command failed, saying it printed the types after connecting', () => {
    const check = checkTypesRegenerated(
      countCalls([CHAINED_TYPECHECK_GEN_TYPES_CALL])
    );

    expect(check).toEqual({
      name: NAME,
      passed: true,
      notes: `\`${CHAINED_TYPECHECK_GEN_TYPES_CALL.command}\` printed the generated types after connecting, with no CLI error in its output; a later command in the same tool call exited non-zero`,
    });
  });

  it('keeps the exited-zero notes for a run whose tool call exited zero', () => {
    expect(
      checkTypesRegenerated(countCalls([SUCCEEDED_GEN_TYPES_CALL])).notes
    ).toBe(
      `\`${SUCCEEDED_GEN_TYPES_CALL.command}\` exited zero with no CLI error in its output`
    );
  });

  it('fails when the only run errored after connecting and printed nothing else', () => {
    const check = checkTypesRegenerated(
      countCalls([TLS_FAILED_GEN_TYPES_CALL])
    );

    expect(check.passed).toBe(false);
    expect(check.notes).toContain(
      `tool call errored: \`${TLS_FAILED_GEN_TYPES_CALL.command}\``
    );
  });

  it('fails when the only run succeeded through a pipe while printing the CLI error', () => {
    const check = checkTypesRegenerated(
      countCalls([MASKED_PIPE_GEN_TYPES_CALL])
    );

    expect(check.passed).toBe(false);
    expect(check.notes).toContain('1 printed a CLI error');
  });

  it('fails listing each errored run and the runs with a CLI error in their output', () => {
    const check = checkTypesRegenerated(
      countCalls([SILENT_FAILED_GEN_TYPES_CALL, MASKED_PIPE_GEN_TYPES_CALL])
    );

    expect(check.passed).toBe(false);
    expect(check.notes).toContain(
      `tool call errored: \`${SILENT_FAILED_GEN_TYPES_CALL.command}\``
    );
    expect(check.notes).toContain('1 printed a CLI error');
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
      genTypes: countGenTypesRuns(invocations, commands.map(shellCall)),
      stack: { ...STACK, relocatedHome: '/home/agent/.supabase' },
      lifecycle: NO_LIFECYCLE,
      analysis: analysisFixture({
        diagnostics: ['src/tasks.ts:10 a', 'src/tasks.ts:11 b'],
        suppressions: ['src/tasks.ts:12 @ts-ignore'],
      }),
      cli: await readCliFacts(ctx, MARKER, invocations),
      migrationEvidence: 'probe',
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
      genTypesFailedRuns: 0,
      genTypesSucceededRuns: 2,
      stackStoppedByAgent: false,
      migrationEvidence: 'probe',
      typesModules: ['src/types/supabase.ts'],
      diagnostics: 2,
      suppressions: 1,
      cliDetours: 1,
    });
  });

  it('reports the pinned channel and a null relocated home when the run had no marker and the CLI home was the default', async () => {
    const check = await checkMetrics(undefined, {
      commands: [],
      genTypes: NO_GEN_TYPES,
      stack: STACK,
      lifecycle: NO_LIFECYCLE,
      analysis: analysisFixture(),
      cli: await readCliFacts(ctx, undefined, []),
      migrationEvidence: 'probe',
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

  it('reports stackStoppedByAgent from the lifecycle', async () => {
    const run = async (lifecycle: StackLifecycle) =>
      metricsOf(
        await checkMetrics(undefined, {
          commands: [],
          genTypes: NO_GEN_TYPES,
          stack: STACK,
          lifecycle,
          analysis: analysisFixture(),
          cli: await readCliFacts(ctx, undefined, []),
          migrationEvidence: 'probe',
        })
      );

    expect(
      await run({ lastCommand: 'supabase stop', stoppedByAgent: true })
    ).toMatchObject({ stackStoppedByAgent: true });
    expect(
      await run({ lastCommand: 'supabase start', stoppedByAgent: false })
    ).toMatchObject({ stackStoppedByAgent: false });
    expect(await run(NO_LIFECYCLE)).toMatchObject({
      stackStoppedByAgent: false,
    });
  });

  it('reports genTypesFailedRuns from the gen types calls that failed', async () => {
    const toolCalls = [SILENT_FAILED_GEN_TYPES_CALL, ...dockerRunToolCalls()];
    const invocations = findSupabaseInvocations(
      extractCommandEntries(toolCalls)
    );

    const check = await checkMetrics(undefined, {
      commands: [],
      genTypes: countGenTypesRuns(invocations, toolCalls),
      stack: STACK,
      lifecycle: NO_LIFECYCLE,
      analysis: analysisFixture(),
      cli: await readCliFacts(ctx, undefined, []),
      migrationEvidence: 'probe',
    });

    expect(metricsOf(check)).toMatchObject({
      genTypesRuns: 3,
      genTypesFailedRuns: 1,
      genTypesSucceededRuns: 2,
    });
  });

  it.each(['probe', 'tool-output', 'gen-types-db-url', 'none'] as const)(
    'reports migrationEvidence %s from the facts',
    async (migrationEvidence) => {
      const check = await checkMetrics(undefined, {
        commands: [],
        genTypes: NO_GEN_TYPES,
        stack: STACK,
        lifecycle: NO_LIFECYCLE,
        analysis: analysisFixture(),
        cli: await readCliFacts(ctx, undefined, []),
        migrationEvidence,
      });

      expect(metricsOf(check)).toMatchObject({ migrationEvidence });
    }
  );

  it('reports nulls instead of failing when nothing resolved', async () => {
    const failing: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async () => {
        throw new Error('sandbox gone');
      },
    };

    const check = await checkMetrics(undefined, {
      commands: [],
      genTypes: NO_GEN_TYPES,
      stack: { ok: false, notes: 'none' },
      lifecycle: NO_LIFECYCLE,
      analysis: { ok: false, notes: 'src directory is missing' },
      cli: await readCliFacts(failing, undefined, []),
      migrationEvidence: 'none',
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
      genTypes: countGenTypesRuns(invocations, commands.map(shellCall)),
      stack: STACK,
      lifecycle: NO_LIFECYCLE,
      analysis: analysisFixture(),
      cli: await readCliFacts(moved, MARKER, invocations),
      migrationEvidence: 'probe',
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
    const genTypes = countGenTypesRuns(invocations, commands.map(shellCall));

    const hostileCommands = await checkMetrics(MARKER, {
      commands: throwing([] as string[]),
      genTypes,
      stack: STACK,
      lifecycle: NO_LIFECYCLE,
      analysis: analysisFixture(),
      cli,
      migrationEvidence: 'probe',
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
      genTypes: throwing({
        runs: 1,
        sources: ['local'],
        failed: [],
        succeeded: [],
      }),
      stack: STACK,
      lifecycle: NO_LIFECYCLE,
      analysis: analysisFixture(),
      cli,
      migrationEvidence: 'probe',
    });
    expect(hostileGenTypes.passed).toBe(true);
    expect(metricsOf(hostileGenTypes)).toMatchObject({
      genTypesRuns: null,
      genTypesFailedRuns: null,
      genTypesSucceededRuns: null,
      genTypesSources: null,
      cliDetours: 0,
      diagnostics: 0,
    });

    const hostileAnalysis = await checkMetrics(MARKER, {
      commands,
      genTypes,
      stack: STACK,
      lifecycle: NO_LIFECYCLE,
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
      migrationEvidence: 'probe',
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
