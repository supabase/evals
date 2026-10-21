// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/build-database-006-regenerate-types
import type { ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import { extractCommandEntries } from '../lib/detours.js';
import {
  analysisFixture,
  CHAINED_TYPECHECK_GEN_TYPES_CALL,
  SILENT_FAILED_GEN_TYPES_CALL,
  SILENT_FAILED_TYPECHECK_CALL,
} from './fixtures.js';
import {
  countGenTypesRuns,
  listSilentFailures,
  type CliFacts,
  type GenTypesRuns,
  type StackLifecycle,
} from './metrics.js';
import { describeGroundTruth } from './report.js';
import type { SchemaProbe } from './schema.js';

const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: 'postgresql://postgres:hunter2@127.0.0.1:54322/postgres',
  runtime: 'native',
};

const MIGRATED: SchemaProbe = {
  ok: true,
  applied: true,
  columns: {
    id: 'int8',
    title: 'text',
    inserted_at: 'timestamptz',
    status: 'task_status',
    due_on: 'date',
  },
};

const NO_RUNS: GenTypesRuns = {
  runs: 0,
  sources: [],
  failed: [],
  succeeded: [],
};
const CLI: CliFacts = { versions: { cliVersion: '2.117.0' }, cliOverride: [] };
const NO_LIFECYCLE: StackLifecycle = {
  lastCommand: null,
  stoppedByAgent: false,
};

const SUCCEEDED_WORDING =
  "no CLI error in its tool call's output; the call exited zero, or printed the generated types after gen types connected and a later command failed";

type Facts = Parameters<typeof describeGroundTruth>[0];

const FACTS: Facts = {
  stack: STACK,
  lifecycle: NO_LIFECYCLE,
  schema: MIGRATED,
  analysis: analysisFixture(),
  genTypes: NO_RUNS,
  silentFailures: [],
  cli: CLI,
};

const describe_ = (overrides: Partial<Facts> = {}) =>
  describeGroundTruth({ ...FACTS, ...overrides });

const lineFor = (lines: string[], pattern: RegExp) => {
  const start = lines.findIndex((line) => pattern.test(line));
  if (start === -1) return '';
  const block = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) break;
    block.push(line);
  }
  return block.join('\n');
};

describe('describeGroundTruth', () => {
  it('writes every fact as a dash-led line, with continuations indented', () => {
    const lines = describe_({
      analysis: analysisFixture({
        diagnostics: ['src/tasks.ts:10 a', 'src/tasks.ts:11 b'],
        suppressions: ['src/tasks.ts:12 @ts-ignore'],
        missingExports: ['label'],
      }),
      genTypes: { runs: 1, sources: ['local'], failed: [], succeeded: [] },
    });

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.startsWith('- ') || line.startsWith('  ')).toBe(true);
    }
  });

  describe('installed CLI', () => {
    it('states the installed version', () => {
      expect(lineFor(describe_(), /installed CLI/)).toContain('2.117.0');
    });

    it('states unknown when no version was read', () => {
      expect(
        lineFor(
          describe_({ cli: { versions: null, cliOverride: null } }),
          /installed CLI/
        )
      ).toContain('unknown');
    });

    it('states the version the PATH reported after the run', () => {
      const line = lineFor(
        describe_({
          cli: {
            versions: { cliVersion: '2.117.0', cliVersionAfterRun: '2.122.0' },
            cliOverride: [],
          },
        }),
        /installed CLI/
      );

      expect(line).toContain('2.117.0');
      expect(line).toContain('2.122.0');
    });

    it('lists the CLI override runners the agent used', () => {
      const text = describe_({
        cli: {
          versions: { cliVersion: '2.117.0' },
          cliOverride: ['npx --yes supabase@2.120.0'],
        },
      }).join('\n');

      expect(text).toContain('npx --yes supabase@2.120.0');
    });
  });

  describe('stack', () => {
    it('describes a resolved stack with its backend and runtime', () => {
      expect(describe_().join('\n')).toContain('resolved: managed/native');
    });

    it('names the relocated CLI home of a stack found under one', () => {
      expect(
        describe_({
          stack: { ...STACK, relocatedHome: '/home/agent/.supabase' },
        }).join('\n')
      ).toContain('/home/agent/.supabase');
    });

    it('carries the notes of an unresolved stack', () => {
      expect(
        describe_({
          stack: { ok: false, notes: 'The local stack is not running.' },
        }).join('\n')
      ).toContain('none (The local stack is not running.)');
    });

    it('says the agent stopped the stack and names the last stack command', () => {
      const text = describe_({
        stack: { ok: false, notes: 'The local stack is not running.' },
        lifecycle: { lastCommand: 'supabase stop', stoppedByAgent: true },
      }).join('\n');

      expect(text).toContain('the agent stopped the stack');
      expect(text).toContain('`supabase stop`');
      expect(text).toContain('could not probe the database');
    });

    it('keeps the flags of the stopping command in the line', () => {
      const text = describe_({
        stack: { ok: false, notes: 'The local stack is not running.' },
        lifecycle: {
          lastCommand: 'supabase stop --no-backup',
          stoppedByAgent: true,
        },
      }).join('\n');

      expect(text).toContain('`supabase stop --no-backup`');
    });

    it('says the agent stopped the stack when the stack resolved but the schema probe failed', () => {
      const text = describe_({
        schema: { ok: false, notes: 'psql: connection refused' },
        lifecycle: { lastCommand: 'supabase stop', stoppedByAgent: true },
      }).join('\n');

      expect(text).toContain('the agent stopped the stack');
    });

    it('does not claim the harness could not probe when the stack and schema probes succeeded', () => {
      const text = describe_({
        lifecycle: {
          lastCommand: 'supabase stop --project-id scratch',
          stoppedByAgent: true,
        },
      }).join('\n');

      expect(text).not.toContain('stopped the stack');
      expect(text).not.toContain('could not probe');
      expect(text).toContain('resolved: managed/native');
      expect(text).toMatch(/applied: yes/);
    });

    it('does not mention a stop when the last stack command was a start', () => {
      expect(
        describe_({
          lifecycle: { lastCommand: 'supabase start', stoppedByAgent: false },
        }).join('\n')
      ).not.toContain('stopped the stack');
    });

    it('does not mention a stop when the agent ran no stack command', () => {
      expect(describe_().join('\n')).not.toContain('stopped the stack');
    });

    it('never carries the stack credentials', () => {
      expect(describe_().join('\n')).not.toContain('hunter2');
    });
  });

  describe('migration', () => {
    it('says the migration is applied and lists the columns with their types', () => {
      const lines = describe_();
      const text = lines.join('\n');

      expect(text).toMatch(/applied: yes/);
      expect(text).toContain('status');
      expect(text).toContain('task_status');
      expect(text).toContain('due_on');
    });

    it('says the migration is not applied and shows the leftover is_complete column', () => {
      const text = describe_({
        schema: {
          ok: true,
          applied: false,
          columns: { id: 'int8', title: 'text', is_complete: 'bool' },
        },
      }).join('\n');

      expect(text).toMatch(/applied: no/);
      expect(text).toContain('is_complete');
    });

    it('carries the notes when the schema could not be read', () => {
      expect(
        describe_({
          schema: { ok: false, notes: 'psql: connection refused' },
        }).join('\n')
      ).toContain('psql: connection refused');
    });

    it('says the migration applied per the tool output when the schema could not be read but the evidence shows it applied', () => {
      const text = describe_({
        schema: { ok: false, notes: 'The local stack is not running.' },
        evidence: { command: 'supabase start', via: 'apply-output' },
      }).join('\n');

      expect(text).toContain(
        '- migration 20260315000000 applied: yes, per the output of `supabase start`; the stack was not running when the harness probed'
      );
      expect(text).not.toContain('migration state unavailable');
    });

    describe('credited to a gen types --db-url run', () => {
      const command = 'supabase gen types typescript --db-url "$DB_URL"';
      const text = describe_({
        schema: { ok: false, notes: 'The local stack is not running.' },
        evidence: { command, via: 'gen-types-db-url' },
      }).join('\n');

      it('credits the run and says the harness cannot see that database', () => {
        expect(text).toContain(
          `credited to the successful \`${command}\`, which read a local database the harness cannot see`
        );
      });

      it('says the local stack was not running when the harness probed', () => {
        expect(text).toContain(
          "the project's local stack was not running when the harness probed"
        );
      });

      it('does not claim the migration applied to the local stack', () => {
        expect(text).not.toContain('applied: yes');
        expect(text).not.toContain('per the output');
        expect(text).not.toContain('migration state unavailable');
      });
    });

    it('prefers the probed schema over the evidence when the schema could be read', () => {
      const text = describe_({
        schema: {
          ok: true,
          applied: false,
          columns: { id: 'int8', is_complete: 'bool' },
        },
        evidence: { command: 'supabase start', via: 'apply-output' },
      }).join('\n');

      expect(text).toMatch(/applied: no/);
      expect(text).not.toContain('per the output');
    });
  });

  describe('types modules', () => {
    it('lists a module that describes the new schema without any problems', () => {
      const line = lineFor(describe_(), /types modules/i);

      expect(line).toContain('src/types/supabase.ts');
      expect(line).not.toContain('none');
    });

    it('lists each module with its problems', () => {
      const text = describe_({
        analysis: analysisFixture({
          typesModules: [
            {
              path: 'src/database.types.ts',
              problems: ['tasks Row', 'task_status enum'],
            },
          ],
        }),
      }).join('\n');

      expect(text).toContain('src/database.types.ts');
      expect(text).toContain('tasks Row');
      expect(text).toContain('task_status enum');
    });

    it('says none when no module is in use', () => {
      expect(
        lineFor(
          describe_({ analysis: analysisFixture({ typesModules: [] }) }),
          /types modules/i
        )
      ).toContain('none');
    });
  });

  describe('type-check diagnostics', () => {
    const diagnostics = [
      'src/a.ts:1 alpha problem',
      'src/b.ts:2 bravo problem',
      'src/c.ts:3 charlie problem',
      'src/d.ts:4 delta problem',
      'src/e.ts:5 echo problem',
      'src/f.ts:6 foxtrot problem',
      'src/g.ts:7 golf problem',
    ];

    it('gives the count and only the first five diagnostics', () => {
      const lines = describe_({ analysis: analysisFixture({ diagnostics }) });
      const text = lines.join('\n');

      expect(lineFor(lines, /diagnostics/i)).toMatch(/(?<!\d)7(?!\d)/);
      for (const diagnostic of diagnostics.slice(0, 5)) {
        expect(text).toContain(diagnostic);
      }
      expect(text).not.toContain('foxtrot');
      expect(text).not.toContain('golf');
    });

    it('reports zero diagnostics', () => {
      expect(lineFor(describe_(), /diagnostics/i)).toMatch(/(?<!\d)0(?!\d)/);
    });
  });

  describe('suppressions and missing exports', () => {
    it('lists each suppression', () => {
      const text = describe_({
        analysis: analysisFixture({
          suppressions: ['src/tasks.ts:12 @ts-ignore', 'src/tasks.ts:20 any'],
        }),
      }).join('\n');

      expect(text).toContain('src/tasks.ts:12 @ts-ignore');
      expect(text).toContain('src/tasks.ts:20 any');
    });

    it('says none when nothing was suppressed', () => {
      expect(lineFor(describe_(), /suppressions/i)).toContain('none');
    });

    it('lists each missing export', () => {
      const text = describe_({
        analysis: analysisFixture({
          missingExports: ['label', 'completeTask'],
        }),
      }).join('\n');

      expect(lineFor(text.split('\n'), /missing exports/i)).toContain('label');
      expect(text).toContain('completeTask');
    });

    it('says none when no export is missing', () => {
      expect(lineFor(describe_(), /missing exports/i)).toContain('none');
    });
  });

  describe('gen types runs', () => {
    it('gives the run count and the distinct sources', () => {
      const line = lineFor(
        describe_({
          genTypes: {
            runs: 3,
            sources: ['local', 'db-url'],
            failed: [],
            succeeded: [],
          },
        }),
        /gen types/i
      );

      expect(line).toMatch(/(?<!\d)3(?!\d)/);
      expect(line).toContain('local');
      expect(line).toContain('db-url');
    });

    it('reports zero runs', () => {
      expect(lineFor(describe_(), /gen types/i)).toMatch(/(?<!\d)0(?!\d)/);
    });

    it('states what is counted: direct invocations, no package scripts', () => {
      const line = lineFor(
        describe_({
          genTypes: { runs: 1, sources: ['local'], failed: [], succeeded: [] },
        }),
        /gen types/i
      );

      expect(line).toContain('direct');
      expect(line).toContain('package scripts are not counted');
      expect(line).not.toContain('exit status is not tracked');
    });

    it('says none of the runs failed when none did', () => {
      const line = lineFor(
        describe_({
          genTypes: { runs: 2, sources: ['local'], failed: [], succeeded: [] },
        }),
        /gen types/i
      );

      expect(line).toContain('  failed: none');
      expect(line).not.toContain('failed (tool call');
    });

    it('says nothing about failures when there were no runs', () => {
      const line = lineFor(
        describe_({
          genTypes: { runs: 0, sources: [], failed: [], succeeded: [] },
        }),
        /gen types/i
      );

      expect(line).not.toContain('failed: none');
    });

    it('names a silent failure with its command and says no output was captured', () => {
      const { command = '' } = SILENT_FAILED_GEN_TYPES_CALL;
      const line = lineFor(
        describe_({
          genTypes: {
            runs: 1,
            sources: ['local'],
            failed: [{ command, silent: true }],
            succeeded: [],
          },
        }),
        /gen types/i
      );

      expect(line).toContain(
        `  failed (tool call exited non-zero): \`${command}\` (no output captured; a redirect may have sent the error into the file)`
      );
      expect(line).not.toContain('failed: none');
    });

    it('names a failure that had output by its command alone', () => {
      const line = lineFor(
        describe_({
          genTypes: {
            runs: 1,
            sources: ['local'],
            failed: [{ command: 'supabase gen types --local', silent: false }],
            succeeded: [],
          },
        }),
        /gen types/i
      );

      expect(line).toContain(
        '  failed (tool call exited non-zero): `supabase gen types --local`'
      );
      expect(line).not.toContain('no output captured');
    });

    it('lists every failed run on its own indented line', () => {
      const lines = describe_({
        genTypes: {
          runs: 2,
          sources: ['local'],
          failed: [
            { command: 'first', silent: true },
            { command: 'second', silent: false },
          ],
          succeeded: [],
        },
      });

      expect(lines.filter((line) => line.includes('failed ('))).toEqual([
        '  failed (tool call exited non-zero): `first` (no output captured; a redirect may have sent the error into the file)',
        '  failed (tool call exited non-zero): `second`',
      ]);
    });

    it('names each run that succeeded on its own indented line', () => {
      const lines = describe_({
        genTypes: {
          runs: 3,
          sources: ['local'],
          failed: [{ command: 'first', silent: true }],
          succeeded: [
            { command: 'second', laterCommandFailed: false },
            { command: 'third', laterCommandFailed: true },
          ],
        },
      });

      expect(lines.filter((line) => line.includes('succeeded ('))).toEqual([
        `  succeeded (${SUCCEEDED_WORDING}): \`second\``,
        `  succeeded (${SUCCEEDED_WORDING}): \`third\``,
      ]);
    });

    it('lists a run whose later command failed under succeeded and says no run failed', () => {
      const toolCalls = [CHAINED_TYPECHECK_GEN_TYPES_CALL];
      const lines = describe_({
        genTypes: countGenTypesRuns(
          findSupabaseInvocations(extractCommandEntries(toolCalls)),
          toolCalls
        ),
      });
      const { command = '' } = CHAINED_TYPECHECK_GEN_TYPES_CALL;

      expect(lines).toContain(
        `  succeeded (${SUCCEEDED_WORDING}): \`${command}\``
      );
      expect(lines).toContain('  failed: none');
      expect(lines.join('\n')).not.toContain('failed (tool call');
    });

    it('says none succeeded when every run failed or printed a CLI error', () => {
      const line = lineFor(
        describe_({
          genTypes: {
            runs: 2,
            sources: ['local'],
            failed: [{ command: 'first', silent: true }],
            succeeded: [],
          },
        }),
        /gen types/i
      );

      expect(line).toContain('  succeeded: none');
      expect(line).not.toContain('succeeded (');
    });
  });

  describe('tool calls that failed with no output captured', () => {
    const OTHER_CALLS = /other tool calls that exited non-zero/;
    const factsFor = (toolCalls: ToolCallRecord[]) => {
      const invocations = findSupabaseInvocations(
        extractCommandEntries(toolCalls)
      );
      return {
        genTypes: countGenTypesRuns(invocations, toolCalls),
        silentFailures: listSilentFailures(invocations, toolCalls),
      };
    };

    it('lists a silent failure that is not a gen types run', () => {
      const { command = '' } = SILENT_FAILED_TYPECHECK_CALL;

      expect(
        lineFor(
          describe_(factsFor([SILENT_FAILED_TYPECHECK_CALL])),
          OTHER_CALLS
        )
      ).toBe(
        `- other tool calls that exited non-zero with no output captured:\n  \`${command}\``
      );
    });

    it('leaves the line out when no call failed silently', () => {
      expect(
        describe_(factsFor([CHAINED_TYPECHECK_GEN_TYPES_CALL])).some((line) =>
          OTHER_CALLS.test(line)
        )
      ).toBe(false);
    });

    it('does not repeat a silent gen types failure on it', () => {
      const lines = describe_(
        factsFor([SILENT_FAILED_GEN_TYPES_CALL, SILENT_FAILED_TYPECHECK_CALL])
      );
      const { command: genTypes = '' } = SILENT_FAILED_GEN_TYPES_CALL;
      const { command: typecheck = '' } = SILENT_FAILED_TYPECHECK_CALL;

      expect(lineFor(lines, OTHER_CALLS)).toBe(
        `- other tool calls that exited non-zero with no output captured:\n  \`${typecheck}\``
      );
      expect(lines.filter((line) => line.includes(genTypes))).toHaveLength(1);
    });

    it('lists each silent failure on its own indented line', () => {
      expect(
        lineFor(describe_({ silentFailures: ['first', 'second'] }), OTHER_CALLS)
      ).toBe(
        '- other tool calls that exited non-zero with no output captured:\n  `first`\n  `second`'
      );
    });
  });

  it('carries the analysis notes instead of the findings when the workspace could not be analysed', () => {
    const text = describe_({
      analysis: { ok: false, notes: 'src directory is missing' },
    }).join('\n');

    expect(text).toContain('src directory is missing');
    expect(text).toContain('resolved: managed/native');
  });
});
