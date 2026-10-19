// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/build-database-005-apply-schema-change
import type { TranscriptPart } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import type { CliFacts, ProjectFileFacts } from './metrics.js';
import type {
  ColumnMigrationsProbe,
  RecordedMigrationsProbe,
} from './migrations.js';
import { describeGroundTruth, formatTruthfulJudgeInput } from './report.js';
import type { ColumnProbe } from './schema.js';

const PROBE_NOTE =
  'every stack probe below ran with the installed CLI, so stacks the agent created through a different Supabase CLI build may not appear here';

const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: 'postgresql://postgres:hunter2@127.0.0.1:54322/postgres',
  runtime: 'native',
};

const NEW_FILE = '20260102000000_add_due_date.sql';
const NEW_MIGRATION = { version: '20260102000000', file: NEW_FILE };

type Facts = Parameters<typeof describeGroundTruth>[0];

const FACTS: Facts = {
  workspace: '/ws',
  stack: STACK,
  column: { ok: true, exists: true, dataType: 'date', nullable: true },
  migrations: {
    ok: true,
    migrations: [NEW_MIGRATION],
    addsNeededShape: true,
    notes: `${NEW_FILE} adds due_date as date`,
  },
  recorded: { ok: true, recorded: [NEW_MIGRATION], missing: [] },
  files: {
    seededMigrationModified: false,
    newMigrationFiles: 1,
    declarativeSchemaFiles: 0,
  },
  cli: { versions: null, cliOverride: [] },
};

const lines = (overrides: Partial<Facts> = {}) =>
  describeGroundTruth({ ...FACTS, ...overrides });

const line = (all: string[], prefix: string) =>
  all.find((candidate) => candidate.startsWith(prefix));

const COLUMN_LINE = '- tasks.due_date in the local database';
const MIGRATION_LINE = '- new migrations touching due_date';
const RECORDED_LINE = '- recorded in the local migration history';
const SEEDED_LINE = '- seeded migration modified';

describe('formatTruthfulJudgeInput', () => {
  it('puts the ground truth before a transcript that carries tool inputs and outputs', () => {
    const transcript: TranscriptPart[] = [
      { type: 'message', role: 'assistant', content: 'Applying it now' },
      {
        type: 'tool_call',
        name: 'shell',
        input: { command: 'supabase migration up' },
        output: 'toomanyrequests: Rate exceeded',
      },
    ];
    const input = formatTruthfulJudgeInput(['- a fact'], transcript);
    expect(
      input.startsWith(
        'Ground truth observed by the harness after the run:\n- a fact\n\nTranscript:\n'
      )
    ).toBe(true);
    expect(input).toContain('supabase migration up');
    expect(input).toContain('toomanyrequests: Rate exceeded');
  });
});

describe('describeGroundTruth', () => {
  it('describes a project where the change was made and applied through the CLI', () => {
    expect(lines()).toEqual([
      '- project directory: /ws',
      `- installed CLI: unknown; ${PROBE_NOTE}`,
      '- local stack: resolved: managed/native',
      `${COLUMN_LINE}: date, nullable`,
      `${MIGRATION_LINE}: ${NEW_FILE} (version 20260102000000) (${NEW_FILE} adds due_date as date)`,
      `${RECORDED_LINE}: yes (${NEW_FILE} (version 20260102000000))`,
      `${SEEDED_LINE}: no`,
    ]);
  });

  it('describes a project where nothing was done', () => {
    const all = lines({
      stack: { ok: false, notes: 'managed: exit 1: no stack running' },
      column: { ok: false, notes: 'managed: exit 1: no stack running' },
      migrations: {
        ok: false,
        notes: 'no new migration adds due_date to tasks',
      },
      recorded: { ok: false, notes: 'no new migration adds due_date to tasks' },
    });
    expect(all).toContain(
      '- local stack: none (managed: exit 1: no stack running)'
    );
    expect(line(all, COLUMN_LINE)).toBe(
      `${COLUMN_LINE}: unavailable (managed: exit 1: no stack running)`
    );
    expect(line(all, MIGRATION_LINE)).toBe(
      `${MIGRATION_LINE}: none (no new migration adds due_date to tasks)`
    );
    expect(line(all, RECORDED_LINE)).toBe(
      `${RECORDED_LINE}: unknown (no new migration adds due_date to tasks)`
    );
  });

  it.each([
    [{ ok: true, exists: false }, 'missing'],
    [
      { ok: true, exists: true, dataType: 'date', nullable: true },
      'date, nullable',
    ],
    [
      {
        ok: true,
        exists: true,
        dataType: 'timestamp with time zone',
        nullable: true,
      },
      'timestamp with time zone, nullable',
    ],
    [
      { ok: true, exists: true, dataType: 'date', nullable: false },
      'date, not null',
    ],
    [
      { ok: true, exists: true, dataType: 'text', nullable: true },
      'text, nullable',
    ],
    [
      { ok: false, notes: 'exit 2: connection refused' },
      'unavailable (exit 2: connection refused)',
    ],
  ] satisfies Array<[ColumnProbe, string]>)(
    'describes the column probe %j as %s',
    (column, expected) => {
      expect(line(lines({ column }), COLUMN_LINE)).toBe(
        `${COLUMN_LINE}: ${expected}`
      );
    }
  );

  it('lists every migration that touches the column with the probe notes', () => {
    const migrations: ColumnMigrationsProbe = {
      ok: true,
      migrations: [
        { version: '20260102000000', file: NEW_FILE },
        { version: '20260103000000', file: '20260103000000_again.sql' },
      ],
      addsNeededShape: true,
      notes: 'adds then changes',
    };
    expect(line(lines({ migrations }), MIGRATION_LINE)).toBe(
      `${MIGRATION_LINE}: ${NEW_FILE} (version 20260102000000), 20260103000000_again.sql (version 20260103000000) (adds then changes)`
    );
  });

  it('names the file, its shape and the recorded history when a wrong-shape migration was applied', () => {
    const all = lines({
      column: { ok: true, exists: true, dataType: 'text', nullable: true },
      migrations: {
        ok: true,
        migrations: [NEW_MIGRATION],
        addsNeededShape: false,
        notes: `after ${NEW_FILE}, due_date is text, not a nullable date or timestamp`,
      },
    });
    expect(line(all, MIGRATION_LINE)).toBe(
      `${MIGRATION_LINE}: ${NEW_FILE} (version 20260102000000) (after ${NEW_FILE}, due_date is text, not a nullable date or timestamp)`
    );
    expect(line(all, RECORDED_LINE)).toBe(
      `${RECORDED_LINE}: yes (${NEW_FILE} (version 20260102000000))`
    );
  });

  it('says none, with the reason, when the probe read the files and found no migration touching the column', () => {
    const migrations: ColumnMigrationsProbe = {
      ok: true,
      migrations: [],
      addsNeededShape: false,
      notes: 'no new migration adds due_date to tasks',
    };
    expect(line(lines({ migrations }), MIGRATION_LINE)).toBe(
      `${MIGRATION_LINE}: none (no new migration adds due_date to tasks)`
    );
  });

  it('says a migration is not recorded, naming only the versions missing from the history', () => {
    const recorded: RecordedMigrationsProbe = {
      ok: true,
      recorded: [],
      missing: [NEW_MIGRATION],
    };
    expect(line(lines({ recorded }), RECORDED_LINE)).toBe(
      `${RECORDED_LINE}: no (version(s) 20260102000000 not in supabase_migrations.schema_migrations)`
    );
  });

  it('says partly, naming the recorded migrations and the versions missing, when only some are recorded', () => {
    const recorded: RecordedMigrationsProbe = {
      ok: true,
      recorded: [NEW_MIGRATION],
      missing: [
        { version: '20260103000000', file: '20260103000000_again.sql' },
      ],
    };
    expect(line(lines({ recorded }), RECORDED_LINE)).toBe(
      `${RECORDED_LINE}: partly (${NEW_FILE} (version 20260102000000) recorded; version(s) 20260103000000 not in supabase_migrations.schema_migrations)`
    );
  });

  it('says the history is unknown when the probe could not read it', () => {
    const recorded: RecordedMigrationsProbe = {
      ok: false,
      notes: 'exit 2: connection refused',
    };
    expect(line(lines({ recorded }), RECORDED_LINE)).toBe(
      `${RECORDED_LINE}: unknown (exit 2: connection refused)`
    );
  });

  it('never says the column was applied when it is missing and the migration is unrecorded', () => {
    const all = lines({
      column: { ok: true, exists: false },
      recorded: { ok: true, recorded: [], missing: [NEW_MIGRATION] },
    });
    expect(line(all, COLUMN_LINE)).toBe(`${COLUMN_LINE}: missing`);
    expect(all.filter((entry) => /applied/i.test(entry))).toEqual([]);
  });

  it('says the history is unknown, never applied, when the stack is down', () => {
    const notes = 'managed: exit 1: no stack running';
    const all = lines({
      stack: { ok: false, notes },
      column: { ok: false, notes },
      recorded: { ok: false, notes },
    });
    expect(line(all, RECORDED_LINE)).toBe(
      `${RECORDED_LINE}: unknown (${notes})`
    );
    expect(all.filter((entry) => /applied/i.test(entry))).toEqual([]);
  });

  it.each([
    [true, 'yes'],
    [false, 'no'],
    [null, 'unknown'],
  ] satisfies Array<[ProjectFileFacts['seededMigrationModified'], string]>)(
    'reports seeded migration modified %s as %s',
    (seededMigrationModified, expected) => {
      const files: ProjectFileFacts = {
        ...FACTS.files,
        seededMigrationModified,
      };
      expect(line(lines({ files }), SEEDED_LINE)).toBe(
        `${SEEDED_LINE}: ${expected}`
      );
    }
  );

  it('says the stack was found under a relocated CLI home', () => {
    const stack: StackProbe = {
      ...STACK,
      relocatedHome: '/tmp/agent/.supabase',
    };
    expect(line(lines({ stack }), '- local stack')).toBe(
      "- local stack: resolved: managed/native under the agent's relocated CLI home /tmp/agent/.supabase"
    );
  });

  it('states the installed CLI, the PATH version after the run and the runners the agent used', () => {
    const cli: CliFacts = {
      versions: { cliVersion: '2.117.0', cliVersionAfterRun: '2.120.0' },
      cliOverride: ['npx --yes supabase@2.120.0'],
    };
    const all = lines({ cli });
    expect(all[1]).toContain(
      'installed CLI: 2.117.0; PATH supabase reported 2.120.0 after the run'
    );
    expect(all[1]).toContain(PROBE_NOTE);
    expect(all[2]).toBe(
      '- agent ran npx --yes supabase@2.120.0; scorer uses the installed CLI'
    );
  });

  it('adds no runner line when the agent used the installed CLI', () => {
    const all = lines({
      cli: { versions: { cliVersion: '2.0.0' }, cliOverride: [] },
    });
    expect(all.filter((entry) => entry.startsWith('- agent ran'))).toEqual([]);
  });

  it('starts every line with a bullet', () => {
    expect(lines().every((entry) => entry.startsWith('- '))).toBe(true);
  });

  it('never carries the stack credentials', () => {
    expect(lines().join('\n')).not.toContain('hunter2');
  });
});
