// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-006-fix-failing-pgtap-suite
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  REPLAY_DATABASE,
  SEEDED_MIGRATIONS,
  SEEDED_TESTS,
} from './fixtures.js';
import {
  checkReplay,
  REPLAY_CHECK,
  replayMigrations,
  type ReplayResult,
} from './replay.js';
import { psqlCommand } from './sql.js';
import type { SuiteFileRun, SuiteRun } from './suite.js';

const LIVE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const REPLAY_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/eval_replay';

const INVOICE_TOTALS = 'invoice_totals.test.sql';
const LINE_DISCOUNTS = 'line_discounts.test.sql';
const FIX_FILE = '20260302000000_fix_discounts.sql';

const DROP_DATABASE = '-c "drop database if exists eval_replay with (force)"';
const RECREATE_DATABASE = `${DROP_DATABASE} -c "create database eval_replay"`;
const CREATE_EXTENSIONS_SCHEMA = '-c "create schema if not exists extensions"';

const MIGRATION_ERROR =
  'psql:supabase/migrations/20260401000000_dup.sql:1: ERROR:  relation "invoices" already exists\n';

const result = (
  stdout: string,
  exitCode: number | null = 0,
  stderr = ''
): CommandResult => ({ ok: exitCode === 0, exitCode, stdout, stderr });

const FIXED: Record<string, CommandResult> = {
  [INVOICE_TOTALS]: result(`1..4
ok 1 - Function public.invoice_total_cents(bigint) should exist
ok 2 - an invoice total is the sum of quantity times unit price
ok 3 - an invoice with no lines totals zero
ok 4 - a line needs a positive quantity
`),
  [LINE_DISCOUNTS]: result(`1..5
ok 1 - invoice lines have a discount column
ok 2 - a 10% discount takes 10% off the line
ok 3 - discounted and full-price lines add up
ok 4 - a 100% discount makes the line free
ok 5 - a discount cannot be more than 100%
`),
};

const BUGGY: Record<string, CommandResult> = {
  [INVOICE_TOTALS]: result(
    '1..4\nok 1 - Function public.invoice_total_cents(bigint) should exist\n',
    3,
    'psql:<stdin>:12: ERROR:  null value in column "discount_percent" of relation "invoice_lines" violates not-null constraint\n'
  ),
  [LINE_DISCOUNTS]: result(`1..5
ok 1 - invoice lines have a discount column
not ok 2 - a 10% discount takes 10% off the line
# Failed test 2: "a 10% discount takes 10% off the line"
#         have: 300
#         want: 2700
ok 3 - discounted and full-price lines add up
ok 4 - a 100% discount makes the line free
ok 5 - a discount cannot be more than 100%
`),
};

type Call = { label: string; command: string; timeoutMs?: number };

const FILE_COMMAND_RE =
  /^printf '%s' '([A-Za-z0-9+/]+={0,2})' \| base64 -d \| /;

function labelOf(command: string): string {
  const payload = FILE_COMMAND_RE.exec(command)?.[1];
  if (payload !== undefined) {
    const sql = Buffer.from(payload, 'base64').toString('utf8');
    return `file:${SEEDED_TESTS.find((test) => test.sql === sql)?.file ?? 'unknown'}`;
  }
  if (command.includes('create database')) return 'recreate';
  if (command.includes('drop database')) return 'drop-db';
  if (command.includes('pg_extension')) return 'exists';
  if (command.includes('create extension')) return 'create';
  if (command.includes('drop extension')) return 'drop';
  if (command.includes('create schema if not exists extensions')) {
    return 'schema';
  }
  if (command.includes("-f 'supabase/migrations/")) return 'migrations';
  return `unexpected: ${command}`;
}

function fakeCtx(
  options: {
    files?: Record<string, CommandResult>;
    responses?: Record<string, CommandResult | Error>;
  } = {}
) {
  const { files = FIXED, responses = {} } = options;
  const calls: Call[] = [];
  const ctx: Pick<LocalStackEvalContext, 'exec'> = {
    exec: async (command, execOptions) => {
      const label = labelOf(command);
      calls.push({ label, command, timeoutMs: execOptions?.timeoutMs });
      const response = responses[label];
      if (response instanceof Error) throw response;
      if (response !== undefined) return response;
      if (label === 'exists') return result('t\n');
      if (label.startsWith('file:')) {
        return files[label.slice('file:'.length)] ?? result('', 1, 'unknown');
      }
      if (label.startsWith('unexpected')) return result('', 1, 'unexpected');
      return result('');
    },
  };
  return { ctx, calls };
}

const labels = (calls: readonly Call[]) => calls.map((call) => call.label);
const SUITE_LABELS = [
  'exists',
  `file:${INVOICE_TOTALS}`,
  `file:${LINE_DISCOUNTS}`,
];

describe('replayMigrations', () => {
  it('rebuilds a scratch database, replays every migration, runs the suite there and drops the database', async () => {
    const { ctx, calls } = fakeCtx();
    const replay = await replayMigrations(ctx, LIVE_URL, SEEDED_MIGRATIONS);
    expect(labels(calls)).toEqual([
      'recreate',
      'schema',
      'migrations',
      ...SUITE_LABELS,
      'drop-db',
    ]);
    expect(replay).toMatchObject({
      ok: true,
      applied: [...SEEDED_MIGRATIONS],
      suite: { ok: true, files: [{ passed: true }, { passed: true }] },
    });
  });

  it('uses the documented statements against the live and replay urls', async () => {
    const { ctx, calls } = fakeCtx();
    await replayMigrations(ctx, LIVE_URL, SEEDED_MIGRATIONS);
    expect(REPLAY_DATABASE).toBe('eval_replay');
    expect(calls[0].command).toBe(psqlCommand(LIVE_URL, RECREATE_DATABASE));
    expect(calls[1].command).toBe(
      psqlCommand(REPLAY_URL, CREATE_EXTENSIONS_SCHEMA)
    );
    expect(calls[2].command).toBe(
      psqlCommand(
        REPLAY_URL,
        `-f 'supabase/migrations/${SEEDED_MIGRATIONS[0]}' -f 'supabase/migrations/${SEEDED_MIGRATIONS[1]}'`
      )
    );
    expect(calls.at(-1)?.command).toBe(psqlCommand(LIVE_URL, DROP_DATABASE));
  });

  it('gives the migrations three minutes', async () => {
    const { ctx, calls } = fakeCtx();
    await replayMigrations(ctx, LIVE_URL, SEEDED_MIGRATIONS);
    expect(calls.find((call) => call.label === 'migrations')?.timeoutMs).toBe(
      180_000
    );
  });

  it('runs the seeded suite against the replay database and never the live one', async () => {
    const { ctx, calls } = fakeCtx();
    await replayMigrations(ctx, LIVE_URL, SEEDED_MIGRATIONS);
    const suiteCalls = calls.filter(
      (call) => call.label === 'exists' || call.label.startsWith('file:')
    );
    expect(suiteCalls).toHaveLength(SUITE_LABELS.length);
    for (const call of suiteCalls) {
      expect(call.command).toContain(`'${REPLAY_URL}'`);
      expect(call.command).not.toContain(`'${LIVE_URL}'`);
    }
  });

  it('replays the files in the order given, not sorted', async () => {
    const reversed = [...SEEDED_MIGRATIONS].reverse();
    const { ctx, calls } = fakeCtx();
    await replayMigrations(ctx, LIVE_URL, reversed);
    expect(calls.find((call) => call.label === 'migrations')?.command).toBe(
      psqlCommand(
        REPLAY_URL,
        `-f 'supabase/migrations/${reversed[0]}' -f 'supabase/migrations/${reversed[1]}'`
      )
    );
  });

  it('replays a fix migration after the seeded ones with one -f per file', async () => {
    const files = [...SEEDED_MIGRATIONS, FIX_FILE];
    const { ctx, calls } = fakeCtx();
    const replay = await replayMigrations(ctx, LIVE_URL, files);
    expect(calls.find((call) => call.label === 'migrations')?.command).toBe(
      psqlCommand(
        REPLAY_URL,
        files.map((file) => `-f 'supabase/migrations/${file}'`).join(' ')
      )
    );
    expect(replay).toMatchObject({ ok: true, applied: files });
  });

  it('shell-quotes a file name that holds a single quote', async () => {
    const { ctx, calls } = fakeCtx();
    await replayMigrations(ctx, LIVE_URL, ["20260401000000_it's.sql"]);
    expect(calls.find((call) => call.label === 'migrations')?.command).toBe(
      psqlCommand(
        REPLAY_URL,
        `-f 'supabase/migrations/20260401000000_it'\\''s.sql'`
      )
    );
  });

  it('keeps the query string of the live url when it points at the replay database', async () => {
    const { ctx, calls } = fakeCtx();
    await replayMigrations(
      ctx,
      `${LIVE_URL}?sslmode=disable`,
      SEEDED_MIGRATIONS
    );
    expect(calls[1].command).toBe(
      psqlCommand(`${REPLAY_URL}?sslmode=disable`, CREATE_EXTENSIONS_SCHEMA)
    );
  });

  it('returns a suite that failed on the replayed database without treating it as a replay failure', async () => {
    const { ctx } = fakeCtx({ files: BUGGY });
    const replay = await replayMigrations(ctx, LIVE_URL, SEEDED_MIGRATIONS);
    expect(replay).toMatchObject({
      ok: true,
      applied: [...SEEDED_MIGRATIONS],
      suite: {
        ok: true,
        files: [
          { file: INVOICE_TOTALS, passed: false, ran: 1 },
          { file: LINE_DISCOUNTS, passed: false },
        ],
      },
    });
  });

  describe('a migration that fails to apply', () => {
    it('stops with the file, line and message psql reported', async () => {
      const { ctx } = fakeCtx({
        responses: { migrations: result('', 3, MIGRATION_ERROR) },
      });
      expect(await replayMigrations(ctx, LIVE_URL, SEEDED_MIGRATIONS)).toEqual({
        ok: false,
        notes:
          'replaying the migrations stopped: supabase/migrations/20260401000000_dup.sql:1: relation "invoices" already exists',
      });
    });

    it('runs no test and still drops the scratch database', async () => {
      const { ctx, calls } = fakeCtx({
        responses: { migrations: result('', 3, MIGRATION_ERROR) },
      });
      await replayMigrations(ctx, LIVE_URL, SEEDED_MIGRATIONS);
      expect(labels(calls)).toEqual([
        'recreate',
        'schema',
        'migrations',
        'drop-db',
      ]);
      expect(calls.at(-1)?.command).toBe(psqlCommand(LIVE_URL, DROP_DATABASE));
    });

    it('falls back to the exit status when psql printed nothing', async () => {
      const { ctx } = fakeCtx({
        responses: { migrations: result('', 137) },
      });
      expect(await replayMigrations(ctx, LIVE_URL, SEEDED_MIGRATIONS)).toEqual({
        ok: false,
        notes: 'replaying the migrations stopped: exit 137',
      });
    });
  });

  describe('a scratch database that cannot be built', () => {
    it('fails and still attempts the drop when create database fails', async () => {
      const { ctx, calls } = fakeCtx({
        responses: {
          recreate: result(
            '',
            3,
            'psql:<stdin>:1: ERROR:  permission denied to create database\n'
          ),
        },
      });
      const replay = await replayMigrations(ctx, LIVE_URL, SEEDED_MIGRATIONS);
      expect(replay.ok).toBe(false);
      if (!replay.ok) {
        expect(replay.notes).toContain('permission denied to create database');
      }
      expect(labels(calls)).toEqual(['recreate', 'drop-db']);
    });

    it('fails, runs nothing further and drops the database when the extensions schema cannot be created', async () => {
      const { ctx, calls } = fakeCtx({
        responses: { schema: result('', 3, 'psql:<stdin>:1: ERROR:  boom\n') },
      });
      const replay = await replayMigrations(ctx, LIVE_URL, SEEDED_MIGRATIONS);
      expect(replay.ok).toBe(false);
      expect(labels(calls)).toEqual(['recreate', 'schema', 'drop-db']);
    });
  });

  describe('dropping the scratch database', () => {
    it('ignores a failed drop', async () => {
      const { ctx } = fakeCtx({
        responses: {
          'drop-db': result('', 1, 'database "eval_replay" is being accessed'),
        },
      });
      expect(
        await replayMigrations(ctx, LIVE_URL, SEEDED_MIGRATIONS)
      ).toMatchObject({ ok: true, applied: [...SEEDED_MIGRATIONS] });
    });

    it('ignores a drop that throws', async () => {
      const { ctx } = fakeCtx({
        responses: { 'drop-db': new Error('connection reset') },
      });
      expect(
        await replayMigrations(ctx, LIVE_URL, SEEDED_MIGRATIONS)
      ).toMatchObject({ ok: true, applied: [...SEEDED_MIGRATIONS] });
    });

    it('still drops the database when exec throws during the replay', async () => {
      const { ctx, calls } = fakeCtx({
        responses: { migrations: new Error('exec timed out') },
      });
      await replayMigrations(ctx, LIVE_URL, SEEDED_MIGRATIONS).catch(
        () => undefined
      );
      expect(calls.at(-1)?.label).toBe('drop-db');
    });
  });

  it('fails without touching the database when there are no migration files', async () => {
    const { ctx, calls } = fakeCtx();
    expect(await replayMigrations(ctx, LIVE_URL, [])).toEqual({
      ok: false,
      notes: 'no migration files to replay',
    });
    expect(calls).toEqual([]);
  });
});

describe('checkReplay', () => {
  const passedFile = (file: string, planned: number): SuiteFileRun => ({
    file,
    exitCode: 0,
    passed: true,
    planned,
    ran: planned,
    failures: [],
  });
  const PASSING_SUITE: SuiteRun = {
    ok: true,
    files: [passedFile(INVOICE_TOTALS, 4), passedFile(LINE_DISCOUNTS, 5)],
  };

  it('names the check as documented', () => {
    expect(REPLAY_CHECK).toBe(
      'the seeded tests pass on a database rebuilt from the migrations'
    );
  });

  it('passes when the suite passed on the replayed database', () => {
    expect(
      checkReplay({
        ok: true,
        applied: [...SEEDED_MIGRATIONS],
        suite: PASSING_SUITE,
      })
    ).toEqual({
      name: REPLAY_CHECK,
      passed: true,
      notes: `2 migration(s) replayed; ${INVOICE_TOTALS}: 4/4 passed; ${LINE_DISCOUNTS}: 5/5 passed`,
    });
  });

  it('counts a fix migration among those replayed', () => {
    const check = checkReplay({
      ok: true,
      applied: [...SEEDED_MIGRATIONS, FIX_FILE],
      suite: PASSING_SUITE,
    });
    expect(check.passed).toBe(true);
    expect(check.notes).toMatch(/^3 migration\(s\) replayed; /);
  });

  it('fails with the replay notes when a migration did not apply', () => {
    const replay: ReplayResult = {
      ok: false,
      notes:
        'replaying the migrations stopped: supabase/migrations/20260401000000_dup.sql:1: relation "invoices" already exists',
    };
    expect(checkReplay(replay)).toEqual({
      name: REPLAY_CHECK,
      passed: false,
      notes: replay.notes,
    });
  });

  it('fails with the suite notes when the suite did not pass on the replayed database', async () => {
    const { ctx } = fakeCtx({ files: BUGGY });
    const check = checkReplay(
      await replayMigrations(ctx, LIVE_URL, SEEDED_MIGRATIONS)
    );
    expect(check.name).toBe(REPLAY_CHECK);
    expect(check.passed).toBe(false);
    expect(check.notes).toMatch(/^2 migration\(s\) replayed; /);
    expect(check.notes).toContain(
      `${INVOICE_TOTALS}: stopped after 1 of 4 tests: <stdin>:12: null value in column "discount_percent" of relation "invoice_lines" violates not-null constraint`
    );
    expect(check.notes).toContain(
      `${LINE_DISCOUNTS}: not ok 2 - a 10% discount takes 10% off the line (have 300, want 2700)`
    );
  });

  it('fails with the suite notes when the suite could not run on the replayed database', () => {
    expect(
      checkReplay({
        ok: true,
        applied: [...SEEDED_MIGRATIONS],
        suite: {
          ok: false,
          notes: 'could not prepare pgTAP: exit 2: psql: error: no route',
        },
      })
    ).toEqual({
      name: REPLAY_CHECK,
      passed: false,
      notes:
        '2 migration(s) replayed; could not prepare pgTAP: exit 2: psql: error: no route',
    });
  });

  it('passes a replay of the seeded migrations plus a fix migration end to end', async () => {
    const { ctx } = fakeCtx();
    const check = checkReplay(
      await replayMigrations(ctx, LIVE_URL, [...SEEDED_MIGRATIONS, FIX_FILE])
    );
    expect(check.passed).toBe(true);
    expect(check.notes).toMatch(/^3 migration\(s\) replayed; /);
  });
});
