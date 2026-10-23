// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-002-rls-policy-tests
import type { CommandResult } from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import { SEEDED_NOTES_POLICIES } from './fixtures.js';
import {
  buildMutationSql,
  buildOpenReadsTwinSql,
  buildOwnerOnlyTwinSql,
  catchVerdict,
  checkTestsCatchSeededPolicies,
  checkTestsPass,
  DROP_PROBE_FUNCTION_SQL,
  listTestFiles,
  OPEN_READS_TWIN_MARKER,
  OWNER_ONLY_TWIN_MARKER,
  parseTap,
  runSuite,
  tapPassed,
  TESTS_CATCH_CHECK_NAME,
  TESTS_PASS_CHECK_NAME,
  TWIN_NOTES_POLICIES,
  withMarkerRemoved,
  withPgtap,
  type CatchRun,
  type SuiteProbe,
  type TapResult,
  type TestFileRun,
} from './pgtap.js';
import {
  buildRestoreSql,
  buildSnapshotSql,
  DROP_NOTES_POLICIES_SQL,
  type NotesAccessSnapshot,
} from './snapshot.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: DB_URL,
  runtime: 'native',
};

const MARKER = 'eval-mutation-applied';
const A = 'supabase/tests/a_test.sql';
const B = 'supabase/tests/b_test.sql';

const D1 = 'owner sees their own notes';
const D2 = "other user sees none of the owner's notes";
const D3 = 'anon sees no notes';

const PASSING = `1..3
ok 1 - a sees one note
ok 2 - b sees one note
ok 3 - anon sees nothing
`;

const FAILING_WITHOUT_ERROR = `1..3
not ok 1 - a sees one note
# Failed test 1: "a sees one note"
#         have: 2
#         want: 1
not ok 2 - b sees one note
# Failed test 2: "b sees one note"
#         have: 2
#         want: 1
ok 3 - anon sees nothing
# Looks like you failed 2 tests of 3
`;

const FAILING_WITH_ERROR = `1..3
not ok 1 - a sees one note
# Failed test 1: "a sees one note"
#         have: 2
#         want: 1
`;

function result(
  stdout: string,
  ok = true,
  stderr = '',
  exitCode = ok ? 0 : 1
): CommandResult {
  return { ok, exitCode, stdout, stderr };
}

const scriptOf = (command: string) => {
  const payload = /printf %s '([A-Za-z0-9+/]+={0,2})'/.exec(command)?.[1];
  return payload === undefined
    ? command
    : Buffer.from(payload, 'base64').toString('utf8');
};

const entry = (
  ok: boolean,
  number: number | null,
  description: string,
  todo = false
) => ({ ok, number, description, todo });

describe('check names', () => {
  it('are the documented ones', () => {
    expect(TESTS_PASS_CHECK_NAME).toBe(
      "the project's pgTAP tests pass against the local database"
    );
    expect(TESTS_CATCH_CHECK_NAME).toBe(
      'the tests fail when the seeded notes policies are put back'
    );
  });
});

describe('parseTap', () => {
  it('reads a passing file', () => {
    expect(parseTap(PASSING)).toEqual({
      planned: 3,
      plans: 1,
      results: [
        entry(true, 1, 'a sees one note'),
        entry(true, 2, 'b sees one note'),
        entry(true, 3, 'anon sees nothing'),
      ],
    });
  });

  it('reads a file whose tests fail without an error', () => {
    expect(parseTap(FAILING_WITHOUT_ERROR)).toEqual({
      planned: 3,
      plans: 1,
      results: [
        entry(false, 1, 'a sees one note'),
        entry(false, 2, 'b sees one note'),
        entry(true, 3, 'anon sees nothing'),
      ],
    });
  });

  it('reads a file that stopped after its first failure', () => {
    expect(parseTap(FAILING_WITH_ERROR)).toEqual({
      planned: 3,
      plans: 1,
      results: [entry(false, 1, 'a sees one note')],
    });
  });

  it('reads the plan from the end of a no_plan() file', () => {
    const tap = parseTap('ok 1 - first\nok 2 - second\n1..2\n');
    expect(tap).toEqual({
      planned: 2,
      plans: 1,
      results: [entry(true, 1, 'first'), entry(true, 2, 'second')],
    });
  });

  it('reads a skipped file as a plan of zero with no results', () => {
    expect(parseTap('1..0 # SKIP nothing to test\n')).toEqual({
      planned: 0,
      plans: 1,
      results: [],
    });
  });

  it('marks a failing test with a TODO directive as todo and strips the directive from its description', () => {
    expect(
      parseTap('1..3\nok 1 - a\nok 2 - b\nnot ok 3 - x # TODO later\n')
    ).toEqual({
      planned: 3,
      plans: 1,
      results: [
        entry(true, 1, 'a'),
        entry(true, 2, 'b'),
        entry(false, 3, 'x', true),
      ],
    });
  });

  it('ignores diagnostics, blank lines and psql noise between results', () => {
    const tap = parseTap(`
1..2

# Subtest: setup
ok 1 - first

# not ok 9 - this is a comment
#         have: ok 5 - also a comment
psql:/tmp/x.sql:4: NOTICE:  something
not ok 2 - second
# Failed test 2: "second"
`);
    expect(tap).toEqual({
      planned: 2,
      plans: 1,
      results: [entry(true, 1, 'first'), entry(false, 2, 'second')],
    });
  });

  it('reads a result with no test number as number null', () => {
    expect(parseTap('1..1\nok - unnumbered\n').results).toEqual([
      entry(true, null, 'unnumbered'),
    ]);
  });

  it('counts every plan line', () => {
    expect(parseTap('1..2\nok 1 - a\n1..2\nok 2 - b\n')).toMatchObject({
      plans: 2,
    });
  });

  it('reads output with no plan and no results as nothing', () => {
    expect(parseTap('')).toEqual({ planned: null, plans: 0, results: [] });
    expect(parseTap('psql: error: connection refused\n')).toEqual({
      planned: null,
      plans: 0,
      results: [],
    });
  });
});

describe('tapPassed', () => {
  const tap = (
    results: TapResult['results'],
    planned: number | null = results.length,
    plans = planned === null ? 0 : 1
  ): TapResult => ({ planned, plans, results });
  const oks = (n: number): TapResult['results'] =>
    Array.from({ length: n }, (_, i) => entry(true, i + 1, `t${i + 1}`));

  it('passes a complete file with exit 0, one plan and no failure', () => {
    expect(tapPassed(0, parseTap(PASSING))).toBe(true);
  });

  it('passes a no_plan() file whose plan comes last', () => {
    expect(tapPassed(0, parseTap('ok 1 - a\nok 2 - b\n1..2\n'))).toBe(true);
  });

  it('passes a skipped file', () => {
    expect(tapPassed(0, parseTap('1..0 # SKIP\n'))).toBe(true);
  });

  it('passes a file whose only failure is a TODO test', () => {
    expect(
      tapPassed(0, parseTap('1..2\nok 1 - a\nnot ok 2 - b # TODO later\n'))
    ).toBe(true);
  });

  it('fails a file with a failing test even though psql exited 0', () => {
    expect(tapPassed(0, parseTap(FAILING_WITHOUT_ERROR))).toBe(false);
  });

  it('fails exit 3, the status psql returns when ON_ERROR_STOP hit an error', () => {
    expect(tapPassed(3, parseTap(FAILING_WITH_ERROR))).toBe(false);
  });

  it('fails a non-zero exit even when every planned test passed', () => {
    expect(tapPassed(3, parseTap(PASSING))).toBe(false);
  });

  it('fails when psql was killed and has no exit code', () => {
    expect(tapPassed(null, parseTap(PASSING))).toBe(false);
  });

  it('fails a file with results but no plan', () => {
    expect(tapPassed(0, tap(oks(2), null))).toBe(false);
  });

  it('fails a file with no output at all', () => {
    expect(tapPassed(0, parseTap(''))).toBe(false);
  });

  it('fails a file with two plans', () => {
    expect(tapPassed(0, tap(oks(2), 2, 2))).toBe(false);
  });

  it('fails when fewer results ran than were planned', () => {
    expect(tapPassed(0, tap(oks(2), 3))).toBe(false);
  });

  it('fails when more results ran than were planned', () => {
    expect(tapPassed(0, tap(oks(3), 2))).toBe(false);
  });
});

describe('listTestFiles', () => {
  function listing(
    options: { files?: string[] | null; failure?: string; throws?: string } = {}
  ) {
    const exec = vi.fn(async (_command: string): Promise<CommandResult> => {
      if (options.throws !== undefined) throw new Error(options.throws);
      if (options.failure !== undefined) {
        return result('', false, options.failure, 1);
      }
      if (options.files === null) {
        return result(
          '',
          false,
          "find: 'supabase/tests': No such file or directory",
          1
        );
      }
      return result(
        (options.files ?? []).map((file) => `supabase/tests/${file}`).join('\n')
      );
    });
    return { exec };
  }

  it('lists *.sql and *.pg files recursively, sorted, and nothing else', async () => {
    const ctx = listing({
      files: [
        'z_test.pg',
        'README.md',
        'nested/deep/c.pg',
        'a_test.sql',
        'notes.sql.bak',
        'helper.sh',
        '.gitkeep',
        'nested/b_test.sql',
        'sql',
      ],
    });
    expect(await listTestFiles(ctx)).toEqual({
      ok: true,
      files: [
        'supabase/tests/a_test.sql',
        'supabase/tests/nested/b_test.sql',
        'supabase/tests/nested/deep/c.pg',
        'supabase/tests/z_test.pg',
      ],
    });
  });

  it('ignores blank lines in the listing', async () => {
    const exec = vi.fn(async () =>
      result('\nsupabase/tests/a_test.sql\n\n  \n')
    );
    expect(await listTestFiles({ exec })).toEqual({
      ok: true,
      files: ['supabase/tests/a_test.sql'],
    });
  });

  it('finds no files in an empty directory', async () => {
    expect(await listTestFiles(listing({ files: [] }))).toEqual({
      ok: true,
      files: [],
    });
  });

  it('finds no files, without failing the probe, when the directory does not exist', async () => {
    expect(await listTestFiles(listing({ files: null }))).toEqual({
      ok: true,
      files: [],
    });
  });

  it('fails the probe when the listing fails for another reason', async () => {
    const probe = await listTestFiles(
      listing({ failure: "find: 'supabase/tests': Permission denied" })
    );
    expect(probe).toEqual({
      ok: false,
      notes: expect.stringContaining('Permission denied'),
    });
  });

  it('reports a thrown exec instead of rejecting', async () => {
    expect(await listTestFiles(listing({ throws: 'sandbox gone' }))).toEqual({
      ok: false,
      notes: expect.stringContaining('sandbox gone'),
    });
  });
});

describe('buildMutationSql', () => {
  const sql = buildMutationSql();
  const trimmed = sql.trim();

  it('starts a transaction and never ends it', () => {
    expect(trimmed).toMatch(/^begin\b/i);
    expect(sql).not.toMatch(/\b(commit|rollback)\b/i);
  });

  it('drops every policy on public.notes by looping over pg_policies', () => {
    expect(sql).toMatch(/pg_policies/i);
    expect(sql).toMatch(/\bnotes\b/);
    expect(sql).toMatch(/\bdrop policy\b/i);
    expect(sql).toMatch(/\bloop\b/i);
  });

  it('enables row level security on public.notes', () => {
    expect(sql).toMatch(
      /alter table\s+(only\s+)?public\.notes\s+enable row level security/i
    );
  });

  it('recreates every seeded policy verbatim, each as its own statement', () => {
    for (const statement of SEEDED_NOTES_POLICIES) {
      expect(sql).toContain(`${statement};`);
    }
  });

  it('drops the existing policies before it recreates the seeded ones', () => {
    const drop = sql.search(/\bdrop policy\b/i);
    const first = sql.indexOf(SEEDED_NOTES_POLICIES[0]);
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(drop).toBeLessThan(first);
  });

  it('ends by selecting the marker that proves it applied', () => {
    expect(trimmed).toMatch(/select 'eval-mutation-applied';?$/i);
    const last = sql.lastIndexOf(SEEDED_NOTES_POLICIES.at(-1) ?? '');
    expect(sql.indexOf(MARKER)).toBeGreaterThan(last);
  });

  it('drops the policies with the same loop the restore uses', () => {
    expect(sql).toContain(DROP_NOTES_POLICIES_SQL);
  });
});

describe('the twin SQL', () => {
  const ownerOnly = buildOwnerOnlyTwinSql();
  const openReads = buildOpenReadsTwinSql();
  const FUNCTION_BODY = /as \$\$.*?\$\$/;
  const normalised = (sql: string, marker: string) =>
    sql.replace(FUNCTION_BODY, 'as <body>').replace(marker, '<marker>');

  it('is identical in both twins once the function body and the marker are normalised', () => {
    expect(normalised(ownerOnly, OWNER_ONLY_TWIN_MARKER)).toBe(
      normalised(openReads, OPEN_READS_TWIN_MARKER)
    );
    expect(ownerOnly).not.toBe(openReads);
  });

  it('differs only in the function body and the marker', () => {
    expect(ownerOnly).toContain(
      'as $$select (select auth.uid()) = note_owner$$;'
    );
    expect(openReads).toContain('as $$select true$$;');
    expect(ownerOnly).toContain(`select '${OWNER_ONLY_TWIN_MARKER}';`);
    expect(openReads).toContain(`select '${OPEN_READS_TWIN_MARKER}';`);
    expect(ownerOnly).not.toContain(OPEN_READS_TWIN_MARKER);
    expect(openReads).not.toContain(OWNER_ONLY_TWIN_MARKER);
  });

  it('names the markers as documented, apart from the leak marker', () => {
    expect(OWNER_ONLY_TWIN_MARKER).toBe('eval-twin-owner-only-applied');
    expect(OPEN_READS_TWIN_MARKER).toBe('eval-twin-open-reads-applied');
    expect(
      new Set([MARKER, OWNER_ONLY_TWIN_MARKER, OPEN_READS_TWIN_MARKER]).size
    ).toBe(3);
  });

  for (const [name, sql] of [
    ['owner-only', ownerOnly],
    ['open-reads', openReads],
  ] as const) {
    describe(`the ${name} twin`, () => {
      const trimmed = sql.trim();

      it('starts a transaction and never ends it', () => {
        expect(trimmed).toMatch(/^begin;/i);
        expect(sql).not.toMatch(/\b(commit|rollback)\b/i);
      });

      it('drops every policy with the leak mutation loop, then enables row level security', () => {
        expect(sql).toContain(DROP_NOTES_POLICIES_SQL);
        expect(sql).toMatch(
          /alter table\s+public\.notes\s+enable row level security;/i
        );
        expect(sql.indexOf('alter table')).toBeGreaterThan(
          sql.indexOf(DROP_NOTES_POLICIES_SQL)
        );
      });

      it('shares its prefix with the leak mutation, up to the first statement after row level security', () => {
        const prefix = (text: string) =>
          text.slice(0, text.indexOf('enable row level security;'));
        expect(prefix(sql)).toBe(prefix(buildMutationSql()));
      });

      it('creates the probe function, grants it, and only then creates the four policies', () => {
        const create = sql.indexOf(
          'create or replace function public.eval_probe_can_read_note(note_owner uuid) returns boolean language sql stable as $$'
        );
        const grant = sql.indexOf(
          'grant execute on function public.eval_probe_can_read_note(uuid) to anon, authenticated;'
        );
        expect(create).toBeGreaterThan(sql.indexOf('alter table'));
        expect(grant).toBeGreaterThan(create);
        expect(sql.indexOf('create policy')).toBeGreaterThan(grant);
        expect(sql.match(/create policy/gi)).toHaveLength(4);
        expect(sql.match(/create or replace function/gi)).toHaveLength(1);
      });

      it('creates the four twin policies verbatim, each as its own statement', () => {
        expect(TWIN_NOTES_POLICIES).toEqual([
          'create policy "eval-probe read" on public.notes for select to authenticated using (public.eval_probe_can_read_note(owner_id))',
          'create policy "eval-probe insert" on public.notes for insert to authenticated with check ((select auth.uid()) = owner_id)',
          'create policy "eval-probe update" on public.notes for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id)',
          'create policy "eval-probe delete" on public.notes for delete to authenticated using ((select auth.uid()) = owner_id)',
        ]);
        for (const statement of TWIN_NOTES_POLICIES) {
          expect(sql).toContain(`${statement};`);
        }
      });

      it('names no seeded policy', () => {
        for (const statement of SEEDED_NOTES_POLICIES) {
          const name = /create policy\s+("[^"]+")/.exec(statement)?.[1] ?? '';
          expect(sql).not.toContain(name);
        }
      });

      it('ends by selecting its own marker, after the policies', () => {
        expect(trimmed).toMatch(/select 'eval-twin-[a-z-]+-applied';$/i);
        expect(sql).not.toContain(`'${MARKER}'`);
        expect(sql.lastIndexOf('create policy')).toBeLessThan(
          sql.lastIndexOf("select '")
        );
      });
    });
  }

  it('drops the probe function with if exists and its signature', () => {
    expect(DROP_PROBE_FUNCTION_SQL).toBe(
      'drop function if exists public.eval_probe_can_read_note(uuid)'
    );
  });
});

describe('withMarkerRemoved', () => {
  it('drops the marker line and keeps every other line', () => {
    expect(
      withMarkerRemoved(
        `${OWNER_ONLY_TWIN_MARKER}\n${PASSING}`,
        OWNER_ONLY_TWIN_MARKER
      )
    ).toBe(PASSING);
    expect(
      withMarkerRemoved(
        `ok 1 - a\n  ${OWNER_ONLY_TWIN_MARKER}  \nok 2 - b\n`,
        OWNER_ONLY_TWIN_MARKER
      )
    ).toBe('ok 1 - a\nok 2 - b\n');
  });

  it('keeps a test description that merely mentions the marker', () => {
    const line = `ok 1 - ${OWNER_ONLY_TWIN_MARKER}`;
    expect(withMarkerRemoved(`${line}\n`, OWNER_ONLY_TWIN_MARKER)).toBe(
      `${line}\n`
    );
  });
});

type Run = { stdout: string; exitCode?: number; stderr?: string };
type Behaviour = {
  clean: Run;
  mutated?: Run;
  ownerOnly?: Run;
  openReads?: Run;
  leaks?: boolean;
  ownerOnlyLeaks?: boolean;
  openReadsLeaks?: boolean;
};
type Db = {
  files?: string[] | null;
  listFailure?: string;
  pgtap?: boolean;
  behaviour?: Record<string, Behaviour>;
  createFails?: boolean;
  probeFails?: boolean;
  throws?: string;
  snapshotFailsBefore?: boolean;
  snapshotFailsAfter?: boolean;
  restoreTakes?: boolean;
  restoreFails?: boolean;
  dropFunctionFails?: boolean;
};

const OWNER_POLICY = `create policy "Users can view their own notes" on public.notes as PERMISSIVE for SELECT to authenticated using ((( SELECT auth.uid() AS uid) = owner_id))`;
const LEAKY_POLICY = `create policy "Enable read access for authenticated users" on public.notes as PERMISSIVE for SELECT to authenticated using (true)`;
const BASELINE: NotesAccessSnapshot = {
  policies: [LEAKY_POLICY, OWNER_POLICY],
  rowSecurity: true,
  forceRowSecurity: false,
};
const COMMITTED_MUTATION: NotesAccessSnapshot = {
  policies: [...SEEDED_NOTES_POLICIES],
  rowSecurity: true,
  forceRowSecurity: false,
};
const COMMITTED_TWIN: NotesAccessSnapshot = {
  policies: [...TWIN_NOTES_POLICIES],
  rowSecurity: true,
  forceRowSecurity: false,
};
const snapshotOutput = ({
  policies,
  rowSecurity,
  forceRowSecurity,
}: NotesAccessSnapshot) =>
  [
    ...policies.map(
      (policy) => `policy|${Buffer.from(policy, 'utf8').toString('hex')}`
    ),
    `rls|${rowSecurity}|${forceRowSecurity}`,
    '',
  ].join('\n');

const tapText = (
  descriptions: readonly string[],
  failing: readonly number[] = []
) =>
  [
    `1..${descriptions.length}`,
    ...descriptions.flatMap((description, i) =>
      failing.includes(i + 1)
        ? [
            `not ok ${i + 1} - ${description}`,
            `# Failed test ${i + 1}: "${description}"`,
            '#         have: 2',
            '#         want: 0',
          ]
        : [`ok ${i + 1} - ${description}`]
    ),
    ...(failing.length > 0
      ? [
          `# Looks like you failed ${failing.length} tests of ${descriptions.length}`,
        ]
      : []),
    '',
  ].join('\n');

const DESCRIPTIONS = [D1, D2, D3];
const cleanPass: Run = { stdout: tapText(DESCRIPTIONS) };
const mutatedFail: Run = {
  stdout: `${MARKER}\n${tapText(DESCRIPTIONS, [2])}`,
};
const ownerOnlyPass: Run = {
  stdout: `${OWNER_ONLY_TWIN_MARKER}\n${tapText(DESCRIPTIONS)}`,
};
const ownerOnlyFailsEverything: Run = {
  stdout: `${OWNER_ONLY_TWIN_MARKER}\n${tapText(DESCRIPTIONS, [1, 2, 3])}`,
};
const openReadsFail: Run = {
  stdout: `${OPEN_READS_TWIN_MARKER}\n${tapText(DESCRIPTIONS, [2])}`,
};
const CATCHING: Behaviour = {
  clean: cleanPass,
  mutated: mutatedFail,
  ownerOnly: ownerOnlyPass,
  openReads: openReadsFail,
};

function pgtapAnswer(command: string, present: boolean): string {
  if (/count\s*\(/i.test(command)) return present ? '1\n' : '0\n';
  if (/\bexists\s*\(/i.test(command)) return present ? 't\n' : 'f\n';
  if (/select\s+extname/i.test(command)) return present ? 'pgtap\n' : '';
  return present ? '1\n' : '';
}

function fakeDb(db: Db = {}) {
  const log: string[] = [];
  const psqlTestCommands: string[] = [];
  const restoreScripts: string[] = [];
  const state = { pgtap: db.pgtap ?? false };
  const policies = { current: { ...BASELINE } };
  let afterMutation = false;
  let lastMutated = '';

  const exec = vi.fn(async (command: string): Promise<CommandResult> => {
    if (db.throws !== undefined) throw new Error(db.throws);
    if (!/\bpsql\b/.test(command)) {
      if (!command.includes('supabase/tests')) {
        return result('', false, `unexpected command: ${command}`);
      }
      log.push('list');
      if (db.listFailure !== undefined) {
        return result('', false, db.listFailure, 1);
      }
      if (db.files === null) {
        return result(
          '',
          false,
          "find: 'supabase/tests': No such file or directory",
          1
        );
      }
      return result(
        [...(db.files ?? ['a_test.sql'])]
          .reverse()
          .map((file) => `supabase/tests/${file}`)
          .join('\n')
      );
    }
    if (!command.includes(DB_URL)) {
      return result(
        '',
        false,
        'psql: error: connection to server failed: Connection refused',
        2
      );
    }
    if (command.includes('pg_extension')) {
      log.push('probe-extension');
      if (db.probeFails)
        return result('', false, 'psql: error: no pg_extension', 2);
      return result(pgtapAnswer(command, state.pgtap));
    }
    if (/create\s+extension/i.test(command)) {
      log.push('create-extension');
      if (db.createFails) {
        return result(
          '',
          false,
          'ERROR:  could not open extension control file "/usr/share/postgresql/17/extension/pgtap.control"',
          3
        );
      }
      state.pgtap = true;
      return result('');
    }
    if (/drop\s+extension/i.test(command)) {
      log.push('drop-extension');
      state.pgtap = false;
      return result('');
    }
    if (command.includes(DROP_PROBE_FUNCTION_SQL)) {
      log.push('drop-function');
      return db.dropFunctionFails
        ? result(
            '',
            false,
            'ERROR:  cannot drop function: policy depends on it',
            3
          )
        : result('');
    }

    const fileArgs = [
      ...command.matchAll(/(?:^|\s)-f\s+('[^']*'|"[^"]*"|\S+)/g),
    ].map(([, arg]) => arg.replace(/^['"]|['"]$/g, ''));
    const target = fileArgs.find((arg) => arg !== '-');
    const script = fileArgs.includes('-') ? scriptOf(command) : '';

    if (target === undefined) {
      if (script.trim() === buildSnapshotSql().trim()) {
        log.push('snapshot');
        const failing = afterMutation
          ? db.snapshotFailsAfter
          : db.snapshotFailsBefore;
        return failing
          ? result('', false, 'psql: error: connection refused', 2)
          : result(snapshotOutput(policies.current));
      }
      if (script.trim() === buildRestoreSql(BASELINE).trim()) {
        log.push(`restore ${lastMutated}`);
        restoreScripts.push(script);
        if (db.restoreFails) return result('', false, 'ERROR:  deadlock', 3);
        if (db.restoreTakes ?? true) policies.current = { ...BASELINE };
        return result('');
      }
      return result('', false, `unexpected command: ${command}`);
    }

    const key = target.replace(/^.*supabase\/tests\//, '');
    const behaviour = db.behaviour?.[key];
    if (behaviour === undefined) {
      return result('', false, `unexpected command: ${command}`);
    }
    psqlTestCommands.push(command);
    const run = (output: Run) =>
      result(
        output.stdout,
        (output.exitCode ?? 0) === 0,
        output.stderr ?? '',
        output.exitCode ?? 0
      );
    if (script.includes(MARKER)) {
      log.push(`mutate ${key}`);
      lastMutated = key;
      afterMutation = true;
      if (behaviour.leaks) policies.current = { ...COMMITTED_MUTATION };
      return run(behaviour.mutated ?? behaviour.clean);
    }
    if (script.includes(OPEN_READS_TWIN_MARKER)) {
      log.push(`open-reads ${key}`);
      lastMutated = key;
      if (behaviour.openReadsLeaks) policies.current = { ...COMMITTED_TWIN };
      return run(behaviour.openReads ?? behaviour.clean);
    }
    if (script.includes(OWNER_ONLY_TWIN_MARKER)) {
      log.push(`owner-only ${key}`);
      lastMutated = key;
      if (behaviour.ownerOnlyLeaks) policies.current = { ...COMMITTED_TWIN };
      return run(behaviour.ownerOnly ?? behaviour.clean);
    }
    log.push(`clean ${key}`);
    return run(behaviour.clean);
  });

  return { exec, log, psqlTestCommands, restoreScripts, state, policies };
}

const forFile = (log: string[], name: string) =>
  log.filter((line) => line.endsWith(` ${name}`));

describe('withPgtap', () => {
  it('creates pgtap before the callback and drops it after when it was not installed', async () => {
    const db = fakeDb({ pgtap: false });
    const value = await withPgtap(db, DB_URL, async () => {
      db.log.push('callback');
      return 42;
    });
    expect(value).toBe(42);
    expect(db.log).toEqual([
      'probe-extension',
      'create-extension',
      'callback',
      'drop-extension',
    ]);
    expect(db.state.pgtap).toBe(false);
  });

  it('creates pgtap in the extensions schema and drops it with if exists', async () => {
    const db = fakeDb({ pgtap: false });
    await withPgtap(db, DB_URL, async () => undefined);
    const commands = db.exec.mock.calls.map(([command]) => command);
    expect(
      commands.some((c) =>
        /create extension if not exists pgtap with schema extensions/i.test(c)
      )
    ).toBe(true);
    expect(
      commands.some((c) => /drop extension if exists pgtap/i.test(c))
    ).toBe(true);
  });

  it('neither creates nor drops pgtap when it was already installed', async () => {
    const db = fakeDb({ pgtap: true });
    await withPgtap(db, DB_URL, async () => {
      db.log.push('callback');
    });
    expect(db.log).toEqual(['probe-extension', 'callback']);
    expect(db.state.pgtap).toBe(true);
  });

  it('drops pgtap again when the callback throws', async () => {
    const db = fakeDb({ pgtap: false });
    await withPgtap(db, DB_URL, async () => {
      throw new Error('boom');
    }).catch(() => undefined);
    expect(db.log.at(-1)).toBe('drop-extension');
    expect(db.state.pgtap).toBe(false);
  });

  it('fails without running the callback when pgtap cannot be created', async () => {
    const db = fakeDb({ pgtap: false, createFails: true });
    const callback = vi.fn(async () => 'ran');
    expect(await withPgtap(db, DB_URL, callback)).toEqual({
      ok: false,
      notes: expect.stringContaining('pgtap.control'),
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it('fails without running the callback when the extension probe fails', async () => {
    const db = fakeDb({ probeFails: true });
    const callback = vi.fn(async () => 'ran');
    expect(await withPgtap(db, DB_URL, callback)).toMatchObject({ ok: false });
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('runSuite', () => {
  const suiteOf = async (db: Db) => {
    const ctx = fakeDb(db);
    return { ctx, suite: await runSuite(ctx, STACK) };
  };

  it('runs every file clean, then under the leak and both twins, only the files that passed', async () => {
    const { ctx, suite } = await suiteOf({
      files: ['a_test.sql', 'b_test.sql'],
      behaviour: {
        'a_test.sql': CATCHING,
        'b_test.sql': {
          clean: { stdout: tapText(DESCRIPTIONS, [1]) },
        },
      },
    });
    expect(suite).toMatchObject({
      ok: true,
      files: [A, B],
      clean: [
        { file: A, passed: true },
        { file: B, passed: false },
      ],
      catches: [
        {
          file: A,
          mutated: { passed: false, mutationApplied: true },
          ownerOnly: { passed: true, mutationApplied: true },
          openReads: { passed: false, mutationApplied: true },
        },
      ],
    });
    expect(forFile(ctx.log, 'a_test.sql')).toEqual([
      'clean a_test.sql',
      'mutate a_test.sql',
      'owner-only a_test.sql',
      'open-reads a_test.sql',
    ]);
    expect(forFile(ctx.log, 'b_test.sql')).toEqual(['clean b_test.sql']);
  });

  it('parses each clean run into its tap and keeps the psql exit code', async () => {
    const { suite } = await suiteOf({
      files: ['a_test.sql'],
      behaviour: {
        'a_test.sql': {
          clean: {
            stdout: FAILING_WITH_ERROR,
            exitCode: 3,
            stderr: 'psql:a_test.sql:12: ERROR:  more than one row',
          },
        },
      },
    });
    expect(suite).toMatchObject({
      ok: true,
      clean: [
        {
          file: A,
          passed: false,
          exitCode: 3,
          tap: {
            planned: 3,
            results: [{ ok: false, description: 'a sees one note' }],
          },
        },
      ],
      catches: [],
    });
  });

  it('reports a file whose tests pass under the mutation as not caught', async () => {
    const { suite } = await suiteOf({
      behaviour: {
        'a_test.sql': {
          clean: cleanPass,
          mutated: { stdout: `${MARKER}\n${tapText([D3])}` },
          ownerOnly: ownerOnlyPass,
        },
      },
    });
    expect(suite).toMatchObject({
      ok: true,
      catches: [{ file: A, mutated: { passed: true, mutationApplied: true } }],
    });
  });

  it('reports mutationApplied false when the marker never printed', async () => {
    const { suite } = await suiteOf({
      behaviour: {
        'a_test.sql': {
          clean: cleanPass,
          mutated: {
            stdout: '',
            exitCode: 2,
            stderr: 'psql: error: connection refused',
          },
          ownerOnly: ownerOnlyPass,
        },
      },
    });
    expect(suite).toMatchObject({
      ok: true,
      catches: [
        { file: A, mutated: { passed: false, mutationApplied: false } },
      ],
    });
  });

  it('reports mutationApplied false on the owner-only twin when its marker never printed', async () => {
    const { suite } = await suiteOf({
      behaviour: {
        'a_test.sql': {
          clean: cleanPass,
          mutated: mutatedFail,
          ownerOnly: {
            stdout: tapText(DESCRIPTIONS),
            exitCode: 2,
            stderr: 'psql: error: connection refused',
          },
        },
      },
    });
    expect(suite).toMatchObject({
      ok: true,
      catches: [
        {
          file: A,
          mutated: { mutationApplied: true },
          ownerOnly: { passed: false, mutationApplied: false },
        },
      ],
    });
  });

  it('reports mutationApplied false on the open-reads twin when its marker never printed', async () => {
    const { suite } = await suiteOf({
      behaviour: {
        'a_test.sql': {
          ...CATCHING,
          openReads: {
            stdout: tapText(DESCRIPTIONS),
            exitCode: 2,
            stderr: 'psql: error: connection refused',
          },
        },
      },
    });
    expect(suite).toMatchObject({
      ok: true,
      catches: [
        {
          file: A,
          ownerOnly: { passed: true, mutationApplied: true },
          openReads: { passed: false, mutationApplied: false },
        },
      ],
    });
  });

  it('reports a twin run that fails the tests as failed, with its marker removed from the tap', async () => {
    const { suite } = await suiteOf({
      behaviour: {
        'a_test.sql': {
          clean: cleanPass,
          mutated: mutatedFail,
          ownerOnly: ownerOnlyFailsEverything,
        },
      },
    });
    expect(suite).toMatchObject({
      ok: true,
      catches: [
        {
          file: A,
          mutated: { passed: false, mutationApplied: true },
          ownerOnly: {
            passed: false,
            mutationApplied: true,
            tap: { planned: 3, plans: 1 },
          },
        },
      ],
    });
  });

  const stdinOrder = (command: string, relative: string) => ({
    stdin: command.search(/-f -(\s|$)/),
    file: command.indexOf(`-f '${relative}'`),
    rollback: command.search(/-c\s+['"]?rollback['"]?/),
  });
  const commandWith = (commands: string[], marker: string) =>
    commands.find((command) => scriptOf(command).includes(marker)) ?? '';

  it('sends the mutation, the test file and a rollback to one psql session, in that order', async () => {
    const { ctx } = await suiteOf({ behaviour: { 'a_test.sql': CATCHING } });
    const command = commandWith(ctx.psqlTestCommands, MARKER);
    expect(command).not.toBe('');
    expect(command).toContain(`'${DB_URL}'`);
    expect(command).toContain('-v ON_ERROR_STOP=1');
    const { stdin, file, rollback } = stdinOrder(command, 'a_test.sql');
    expect(stdin).toBeGreaterThanOrEqual(0);
    expect(file).toBeGreaterThan(stdin);
    expect(rollback).toBeGreaterThan(file);
    expect(scriptOf(command)).toContain(buildMutationSql().trim());
  });

  it.each([
    ['owner-only twin', OWNER_ONLY_TWIN_MARKER, buildOwnerOnlyTwinSql],
    ['open-reads twin', OPEN_READS_TWIN_MARKER, buildOpenReadsTwinSql],
  ])(
    'runs the file under the %s in the same session shape as the leak mutation, with only the script differing',
    async (_name, marker, build) => {
      const { ctx } = await suiteOf({ behaviour: { 'a_test.sql': CATCHING } });
      const mutation = commandWith(ctx.psqlTestCommands, MARKER);
      const twin = commandWith(ctx.psqlTestCommands, marker);
      expect(twin).not.toBe('');
      expect(twin).not.toBe(mutation);
      expect(twin).toContain('-v ON_ERROR_STOP=1');
      const { stdin, file, rollback } = stdinOrder(twin, 'a_test.sql');
      expect(stdin).toBeGreaterThanOrEqual(0);
      expect(file).toBeGreaterThan(stdin);
      expect(rollback).toBeGreaterThan(file);
      expect(scriptOf(twin)).toContain(build().trim());
      expect(twin.replace(/printf %s '[^']*'/, '')).toBe(
        mutation.replace(/printf %s '[^']*'/, '')
      );
    }
  );

  it('keeps the plain clean run, the one pg_prove would do, free of stdin and rollback', async () => {
    const { ctx } = await suiteOf({ behaviour: { 'a_test.sql': CATCHING } });
    const plain = ctx.psqlTestCommands.filter(
      (command) => !/-f -(\s|$)/.test(command)
    );
    expect(plain).toHaveLength(1);
    expect(plain[0]).not.toContain('rollback');
    expect(plain[0]).not.toContain('printf');
  });

  it('runs every test file from supabase/tests with a path relative to it, like supabase test db', async () => {
    const { ctx } = await suiteOf({
      files: ['a_test.sql', 'sub/dir/b_test.sql'],
      behaviour: {
        'a_test.sql': CATCHING,
        'sub/dir/b_test.sql': CATCHING,
      },
    });
    expect(ctx.psqlTestCommands).toHaveLength(8);
    for (const command of ctx.psqlTestCommands) {
      expect(command.startsWith("cd 'supabase/tests' && ")).toBe(true);
      expect(command).not.toContain("-f 'supabase/tests/");
    }
    const files = ctx.psqlTestCommands.map(
      (command) => /-f '([^']+)'/.exec(command)?.[1]
    );
    expect(files).toEqual([
      'a_test.sql',
      'sub/dir/b_test.sql',
      'a_test.sql',
      'a_test.sql',
      'a_test.sql',
      'sub/dir/b_test.sql',
      'sub/dir/b_test.sql',
      'sub/dir/b_test.sql',
    ]);
  });

  it('reports files with their supabase/tests paths even though psql gets relative ones', async () => {
    const { suite } = await suiteOf({
      files: ['sub/b_test.sql'],
      behaviour: { 'sub/b_test.sql': CATCHING },
    });
    expect(suite).toMatchObject({
      ok: true,
      files: ['supabase/tests/sub/b_test.sql'],
      clean: [{ file: 'supabase/tests/sub/b_test.sql' }],
      catches: [{ file: 'supabase/tests/sub/b_test.sql' }],
    });
  });

  it('runs every clean and mutated file with ON_ERROR_STOP so an error surfaces as a non-zero exit', async () => {
    const { ctx } = await suiteOf({ behaviour: { 'a_test.sql': CATCHING } });
    expect(ctx.psqlTestCommands).toHaveLength(4);
    for (const command of ctx.psqlTestCommands) {
      expect(command).toContain('-v ON_ERROR_STOP=1');
      expect(command).toContain("-f 'a_test.sql'");
    }
  });

  it('does not touch the policies when the file leaves them as they were', async () => {
    const { ctx } = await suiteOf({ behaviour: { 'a_test.sql': CATCHING } });
    expect(ctx.log).toContain('snapshot');
    expect(ctx.log.some((line) => line.startsWith('restore'))).toBe(false);
    expect(ctx.restoreScripts).toEqual([]);
  });

  it('snapshots the notes policies once before the first mutated run and once after each of the three runs per file, then drops the probe function once', async () => {
    const { ctx } = await suiteOf({
      files: ['a_test.sql', 'b_test.sql'],
      behaviour: { 'a_test.sql': CATCHING, 'b_test.sql': CATCHING },
    });
    expect(ctx.log.filter((line) => line !== 'list')).toEqual([
      'probe-extension',
      'create-extension',
      'clean a_test.sql',
      'clean b_test.sql',
      'snapshot',
      'mutate a_test.sql',
      'snapshot',
      'owner-only a_test.sql',
      'snapshot',
      'open-reads a_test.sql',
      'snapshot',
      'mutate b_test.sql',
      'snapshot',
      'owner-only b_test.sql',
      'snapshot',
      'open-reads b_test.sql',
      'snapshot',
      'drop-function',
      'drop-extension',
    ]);
  });

  describe('a test file whose own commit keeps the mutation', () => {
    const leaking: Behaviour = { ...CATCHING, leaks: true };

    const ownerOnlyLeaking: Behaviour = { ...CATCHING, ownerOnlyLeaks: true };
    const openReadsLeaking: Behaviour = { ...CATCHING, openReadsLeaks: true };

    it('restores the policies before the twin runs and still counts the file as a catch', async () => {
      const { ctx, suite } = await suiteOf({
        behaviour: { 'a_test.sql': leaking },
      });
      expect(suite).toMatchObject({
        ok: true,
        catches: [
          {
            file: A,
            leaked: true,
            mutated: { passed: false, mutationApplied: true },
            ownerOnly: { passed: true, mutationApplied: true },
            openReads: { passed: false, mutationApplied: true },
          },
        ],
      });
      expect(forFile(ctx.log, 'a_test.sql')).toEqual([
        'clean a_test.sql',
        'mutate a_test.sql',
        'restore a_test.sql',
        'owner-only a_test.sql',
        'open-reads a_test.sql',
      ]);
      expect(ctx.policies.current).toEqual(BASELINE);
      expect(checkTestsCatchSeededPolicies(suite)).toMatchObject({
        passed: true,
      });
    });

    it('restores after the owner-only twin too when the file commits under it, and still counts the file', async () => {
      const { ctx, suite } = await suiteOf({
        behaviour: { 'a_test.sql': ownerOnlyLeaking },
      });
      expect(suite).toMatchObject({
        ok: true,
        catches: [{ file: A, leaked: true, ownerOnly: { passed: true } }],
      });
      expect(forFile(ctx.log, 'a_test.sql')).toEqual([
        'clean a_test.sql',
        'mutate a_test.sql',
        'owner-only a_test.sql',
        'restore a_test.sql',
        'open-reads a_test.sql',
      ]);
      expect(ctx.policies.current).toEqual(BASELINE);
      expect(checkTestsCatchSeededPolicies(suite).passed).toBe(true);
    });

    it('restores after the open-reads twin too when the file commits under it, and still counts the file', async () => {
      const { ctx, suite } = await suiteOf({
        behaviour: { 'a_test.sql': openReadsLeaking },
      });
      expect(suite).toMatchObject({
        ok: true,
        catches: [{ file: A, leaked: true, openReads: { passed: false } }],
      });
      expect(forFile(ctx.log, 'a_test.sql')).toEqual([
        'clean a_test.sql',
        'mutate a_test.sql',
        'owner-only a_test.sql',
        'open-reads a_test.sql',
        'restore a_test.sql',
      ]);
      expect(ctx.policies.current).toEqual(BASELINE);
      expect(checkTestsCatchSeededPolicies(suite).passed).toBe(true);
    });

    it('restores after all three runs when the file commits under each', async () => {
      const { ctx } = await suiteOf({
        behaviour: {
          'a_test.sql': {
            ...leaking,
            ownerOnlyLeaks: true,
            openReadsLeaks: true,
          },
        },
      });
      expect(forFile(ctx.log, 'a_test.sql')).toEqual([
        'clean a_test.sql',
        'mutate a_test.sql',
        'restore a_test.sql',
        'owner-only a_test.sql',
        'restore a_test.sql',
        'open-reads a_test.sql',
        'restore a_test.sql',
      ]);
      expect(ctx.restoreScripts).toHaveLength(3);
      expect(ctx.policies.current).toEqual(BASELINE);
    });

    it('restores with a committed session that drops every policy, sets the flags and recreates the snapshot', async () => {
      const { ctx } = await suiteOf({
        behaviour: { 'a_test.sql': leaking },
      });
      expect(ctx.restoreScripts).toHaveLength(1);
      const script = ctx.restoreScripts[0];
      expect(script.trim()).toMatch(/^begin;/i);
      expect(script.trim()).toMatch(/commit;$/i);
      expect(script).toContain(DROP_NOTES_POLICIES_SQL);
      expect(script).toContain(
        'alter table public.notes enable row level security;'
      );
      expect(script).toContain(
        'alter table public.notes no force row level security;'
      );
      for (const policy of BASELINE.policies) {
        expect(script).toContain(`${policy};`);
      }
      expect(script.indexOf('create policy')).toBeGreaterThan(
        script.indexOf('drop policy')
      );
    });

    it('restores before the next file is mutated, so later files start from the same policies', async () => {
      const { ctx } = await suiteOf({
        files: ['a_test.sql', 'b_test.sql'],
        behaviour: { 'a_test.sql': leaking, 'b_test.sql': CATCHING },
      });
      expect(
        ctx.log.filter((line) =>
          /^(mutate|restore|owner-only|open-reads)/.test(line)
        )
      ).toEqual([
        'mutate a_test.sql',
        'restore a_test.sql',
        'owner-only a_test.sql',
        'open-reads a_test.sql',
        'mutate b_test.sql',
        'owner-only b_test.sql',
        'open-reads b_test.sql',
      ]);
    });

    it('says in the check notes that the file committed the mutation and the scorer restored the policies', async () => {
      const { suite } = await suiteOf({
        behaviour: { 'a_test.sql': leaking },
      });
      const check = checkTestsCatchSeededPolicies(suite);
      expect(check.passed).toBe(true);
      expect(check.notes).toMatch(/committed the mutation/);
      expect(check.notes).toMatch(
        /restored the notes policies between the runs/
      );
    });

    it('does not count the file when the owner-only twin still fails every test after the restore', async () => {
      const { suite } = await suiteOf({
        behaviour: {
          'a_test.sql': { ...leaking, ownerOnly: ownerOnlyFailsEverything },
        },
      });
      expect(checkTestsCatchSeededPolicies(suite).passed).toBe(false);
    });

    it('does not count the file, runs no twin and mutates nothing further when the restore does not take', async () => {
      const { ctx, suite } = await suiteOf({
        files: ['a_test.sql', 'b_test.sql'],
        restoreTakes: false,
        behaviour: { 'a_test.sql': leaking, 'b_test.sql': CATCHING },
      });
      expect(suite).toMatchObject({
        ok: true,
        catches: [
          {
            file: A,
            leaked: true,
            ownerOnly: null,
            openReads: null,
            restoreFailure: expect.stringContaining('restore'),
          },
        ],
        unmutated: [B],
      });
      expect((suite as Extract<SuiteProbe, { ok: true }>).catches).toHaveLength(
        1
      );
      expect(ctx.log).not.toContain('mutate b_test.sql');
      expect(ctx.log).not.toContain('owner-only a_test.sql');
      expect(ctx.log).not.toContain('open-reads a_test.sql');
      const check = checkTestsCatchSeededPolicies(suite);
      expect(check.passed).toBe(false);
      expect(check.notes).toContain(A);
      expect(check.notes).toMatch(/could not restore/);
      expect(check.notes).toContain(B);
      expect(check.notes).toMatch(/not run under the seeded policies/);
    });

    it('stops the same way when the restore session itself fails', async () => {
      const { ctx, suite } = await suiteOf({
        files: ['a_test.sql', 'b_test.sql'],
        restoreFails: true,
        behaviour: { 'a_test.sql': leaking, 'b_test.sql': CATCHING },
      });
      expect(suite).toMatchObject({
        ok: true,
        catches: [{ file: A, leaked: true, ownerOnly: null, openReads: null }],
        unmutated: [B],
      });
      expect(checkTestsCatchSeededPolicies(suite).notes).toContain('deadlock');
      expect(ctx.log).not.toContain('mutate b_test.sql');
    });

    it('stops after the owner-only twin, keeping the runs so far, when its restore does not take', async () => {
      const { ctx, suite } = await suiteOf({
        files: ['a_test.sql', 'b_test.sql'],
        restoreTakes: false,
        behaviour: { 'a_test.sql': ownerOnlyLeaking, 'b_test.sql': CATCHING },
      });
      expect(suite).toMatchObject({
        ok: true,
        catches: [
          {
            file: A,
            leaked: true,
            mutated: { mutationApplied: true },
            ownerOnly: { passed: true, mutationApplied: true },
            openReads: null,
            restoreFailure: expect.stringContaining('restore'),
          },
        ],
        unmutated: [B],
      });
      expect(ctx.log).not.toContain('mutate b_test.sql');
      expect(ctx.log).not.toContain('open-reads a_test.sql');
      const check = checkTestsCatchSeededPolicies(suite);
      expect(check.passed).toBe(false);
      expect(check.notes).toMatch(/could not restore/);
    });

    it('stops after the open-reads twin, keeping all three runs, when its restore does not take', async () => {
      const { ctx, suite } = await suiteOf({
        files: ['a_test.sql', 'b_test.sql'],
        restoreTakes: false,
        behaviour: { 'a_test.sql': openReadsLeaking, 'b_test.sql': CATCHING },
      });
      expect(suite).toMatchObject({
        ok: true,
        catches: [
          {
            file: A,
            leaked: true,
            mutated: { mutationApplied: true },
            ownerOnly: { mutationApplied: true },
            openReads: { passed: false, mutationApplied: true },
            restoreFailure: expect.stringContaining('restore'),
          },
        ],
        unmutated: [B],
      });
      expect(ctx.log).not.toContain('mutate b_test.sql');
      expect(checkTestsCatchSeededPolicies(suite).passed).toBe(false);
    });

    it('keeps an earlier catch when a later file stops the run, and still reports the skipped files', async () => {
      const { suite } = await suiteOf({
        files: ['a_test.sql', 'b_test.sql', 'c_test.sql'],
        restoreTakes: false,
        behaviour: {
          'a_test.sql': CATCHING,
          'b_test.sql': leaking,
          'c_test.sql': CATCHING,
        },
      });
      const check = checkTestsCatchSeededPolicies(suite);
      expect(check.passed).toBe(true);
      expect(check.notes).toContain('supabase/tests/c_test.sql');
      expect(check.notes).toMatch(/not run under the seeded policies/);
    });
  });

  describe('the probe function cleanup', () => {
    const dropCommands = (ctx: ReturnType<typeof fakeDb>) =>
      ctx.exec.mock.calls
        .map(([command]) => command)
        .filter((command) => command.includes(DROP_PROBE_FUNCTION_SQL));

    it('runs once after every file has been mutated, through psql against the stack database', async () => {
      const { ctx } = await suiteOf({
        files: ['a_test.sql', 'b_test.sql'],
        behaviour: { 'a_test.sql': CATCHING, 'b_test.sql': CATCHING },
      });
      const drops = dropCommands(ctx);
      expect(drops).toHaveLength(1);
      expect(drops[0]).toContain(`'${DB_URL}'`);
      expect(drops[0]).toContain(
        '-c "drop function if exists public.eval_probe_can_read_note(uuid)"'
      );
      expect(ctx.log.filter((line) => line === 'drop-function')).toHaveLength(
        1
      );
      const lastRun = Math.max(
        ctx.log.lastIndexOf('open-reads a_test.sql'),
        ctx.log.lastIndexOf('open-reads b_test.sql')
      );
      expect(ctx.log.indexOf('drop-function')).toBeGreaterThan(lastRun);
    });

    it('runs once when a restore failure stops the run early', async () => {
      const { ctx } = await suiteOf({
        files: ['a_test.sql', 'b_test.sql'],
        restoreTakes: false,
        behaviour: {
          'a_test.sql': { ...CATCHING, leaks: true },
          'b_test.sql': CATCHING,
        },
      });
      expect(ctx.log).not.toContain('mutate b_test.sql');
      expect(dropCommands(ctx)).toHaveLength(1);
      expect(ctx.log.indexOf('drop-function')).toBeGreaterThan(
        ctx.log.indexOf('restore a_test.sql')
      );
    });

    it('runs when the policies cannot be re-read after a mutated run', async () => {
      const { ctx } = await suiteOf({
        snapshotFailsAfter: true,
        behaviour: { 'a_test.sql': CATCHING },
      });
      expect(dropCommands(ctx)).toHaveLength(1);
    });

    it('does not run when no file passed clean, since nothing was mutated', async () => {
      const { ctx } = await suiteOf({
        behaviour: {
          'a_test.sql': { clean: { stdout: tapText(DESCRIPTIONS, [1]) } },
        },
      });
      expect(dropCommands(ctx)).toEqual([]);
    });

    it('does not run when the policies cannot be read before the first mutated run', async () => {
      const { ctx } = await suiteOf({
        snapshotFailsBefore: true,
        behaviour: { 'a_test.sql': CATCHING },
      });
      expect(dropCommands(ctx)).toEqual([]);
    });

    it('ignores its own failure, keeping the catches and dropping pgtap afterwards', async () => {
      const { ctx, suite } = await suiteOf({
        pgtap: false,
        dropFunctionFails: true,
        behaviour: { 'a_test.sql': CATCHING },
      });
      expect(suite).toMatchObject({
        ok: true,
        catches: [{ file: A, ownerOnly: { passed: true } }],
      });
      expect(checkTestsCatchSeededPolicies(suite).passed).toBe(true);
      expect(ctx.log.at(-1)).toBe('drop-extension');
    });
  });

  it('stops mutating when the policies cannot be re-read after a mutated run', async () => {
    const { ctx, suite } = await suiteOf({
      files: ['a_test.sql', 'b_test.sql'],
      snapshotFailsAfter: true,
      behaviour: { 'a_test.sql': CATCHING, 'b_test.sql': CATCHING },
    });
    expect(suite).toMatchObject({
      ok: true,
      catches: [
        {
          file: A,
          ownerOnly: null,
          openReads: null,
          restoreFailure: expect.stringContaining('connection refused'),
        },
      ],
      unmutated: [B],
    });
    expect(ctx.log).not.toContain('mutate b_test.sql');
    expect(checkTestsCatchSeededPolicies(suite).passed).toBe(false);
  });

  it('runs no mutated run and fails the catch check with the reason when the policies cannot be read first', async () => {
    const { ctx, suite } = await suiteOf({
      snapshotFailsBefore: true,
      behaviour: { 'a_test.sql': CATCHING },
    });
    expect(suite).toMatchObject({
      ok: true,
      clean: [{ file: A, passed: true }],
      catches: [],
      mutationBlocked: expect.stringContaining('connection refused'),
    });
    expect(ctx.log.some((line) => line.startsWith('mutate'))).toBe(false);
    const probe = suite;
    expect(checkTestsCatchSeededPolicies(probe)).toMatchObject({
      name: TESTS_CATCH_CHECK_NAME,
      passed: false,
      notes: expect.stringContaining('connection refused'),
    });
    expect(checkTestsPass(probe).passed).toBe(true);
  });

  describe('what counts as a catch', () => {
    const A_OWN = "a sees a's notes";
    const B_BLOCKED = "b cannot see a's notes";
    const ANON_NONE = 'anon sees no notes';
    const CROSS_USER = [A_OWN, B_BLOCKED, ANON_NONE];
    const SAME_UNDER_TWINS = `${A}: failed with the seeded policies put back, but its results did not change when every signed-in user could read notes under identical policies, so it checks how the policies are written, not who can see which notes`;

    const behaviourOf = (
      descriptions: readonly string[],
      leak: readonly number[],
      ownerOnly: readonly number[],
      openReads: readonly number[]
    ): Behaviour => ({
      clean: { stdout: tapText(descriptions) },
      mutated: { stdout: `${MARKER}\n${tapText(descriptions, leak)}` },
      ownerOnly: {
        stdout: `${OWNER_ONLY_TWIN_MARKER}\n${tapText(descriptions, ownerOnly)}`,
      },
      openReads: {
        stdout: `${OPEN_READS_TWIN_MARKER}\n${tapText(descriptions, openReads)}`,
      },
    });

    const tapOf = (marker: string, tap: string, exitCode = 0): Run => ({
      stdout: `${marker}\n${tap}`,
      exitCode,
    });

    const noPlan = (lines: readonly string[]) =>
      [...lines, `1..${lines.length}`, ''].join('\n');

    const verdictOf = async (behaviour: Behaviour) => {
      const { suite } = await suiteOf({
        behaviour: { 'a_test.sql': behaviour },
      });
      return checkTestsCatchSeededPolicies(suite);
    };

    const sameInEveryTwin = (
      cleanTap: string,
      leakTap: string,
      twinTap: string
    ): Behaviour => ({
      clean: { stdout: cleanTap },
      mutated: tapOf(MARKER, leakTap),
      ownerOnly: tapOf(OWNER_ONLY_TWIN_MARKER, twinTap),
      openReads: tapOf(OPEN_READS_TWIN_MARKER, twinTap),
    });

    describe('a file that only reads the catalog', () => {
      it('does not count a file that only checks a for all policy using auth.uid() exists', async () => {
        const check = await verdictOf(
          sameInEveryTwin(
            '1..1\nok 1 - a for all policy on public.notes uses auth.uid()\n',
            '1..1\nnot ok 1 - a for all policy on public.notes uses auth.uid()\n',
            '1..1\nnot ok 1 - a for all policy on public.notes uses auth.uid()\n'
          )
        );
        expect(check.passed).toBe(false);
        expect(check.notes).toBe(SAME_UNDER_TWINS);
      });

      it('does not count a policies_are, policy_cmd_is and policy_roles_are file', async () => {
        const tap = (ok: string) =>
          [
            '1..3',
            `${ok} 1 - Policies on public.notes should be exactly the expected ones`,
            `${ok} 2 - Policy "Users can view their own notes" should be for select`,
            `${ok} 3 - Policy "Users can view their own notes" should be for authenticated`,
            '',
          ].join('\n');
        const check = await verdictOf(
          sameInEveryTwin(tap('ok'), tap('not ok'), tap('not ok'))
        );
        expect(check.passed).toBe(false);
        expect(check.notes).toBe(SAME_UNDER_TWINS);
      });

      it('does not count a per-policy file whose extra not ok under the leak comes from the policy list', async () => {
        const policyTests = (failing: number | null, count: number) =>
          noPlan(
            Array.from(
              { length: count },
              (_, i) =>
                `${failing === i + 1 ? 'not ok' : 'ok'} ${i + 1} - policy ${i + 1} is not open`
            )
          );
        const check = await verdictOf(
          sameInEveryTwin(
            policyTests(null, 4),
            policyTests(4, 4),
            policyTests(null, 4)
          )
        );
        expect(check.passed).toBe(false);
        expect(check.notes).toBe(SAME_UNDER_TWINS);
      });

      it('does not count a catalog test that passes in both twins and fails under the seeded policies', async () => {
        const check = await verdictOf(
          sameInEveryTwin(
            '1..1\nok 1 - no policy on public.notes has qual true\n',
            '1..1\nnot ok 1 - no policy on public.notes has qual true\n',
            '1..1\nok 1 - no policy on public.notes has qual true\n'
          )
        );
        expect(check.passed).toBe(false);
        expect(check.notes).toBe(SAME_UNDER_TWINS);
      });

      it('does not count a file whose leak run errors for a reason the twins do not share', async () => {
        const check = await verdictOf({
          clean: { stdout: tapText(CROSS_USER) },
          mutated: {
            stdout: `${MARKER}\n1..3\nok 1 - ${A_OWN}\n`,
            exitCode: 3,
            stderr: 'psql:b_test.sql:14: ERROR:  relation "helper" is missing',
          },
          ownerOnly: tapOf(OWNER_ONLY_TWIN_MARKER, tapText(CROSS_USER)),
          openReads: tapOf(OPEN_READS_TWIN_MARKER, tapText(CROSS_USER)),
        });
        expect(check.passed).toBe(false);
        expect(check.notes).toBe(SAME_UNDER_TWINS);
      });

      it('does not count a file that fails the same behavioural test under both twins', async () => {
        const check = await verdictOf(behaviourOf(CROSS_USER, [2], [2], [2]));
        expect(check.passed).toBe(false);
        expect(check.notes).toBe(SAME_UNDER_TWINS);
        expect(check.notes).not.toMatch(/drift|re-?run/i);
      });
    });

    describe('a file that reads notes as a user', () => {
      it('counts a cross-user read and names the test that flipped', async () => {
        const check = await verdictOf(behaviourOf(CROSS_USER, [2], [], [2]));
        expect(check.passed).toBe(true);
        expect(check.notes).toContain(
          `test 2 "${B_BLOCKED}" passed when only owners could read notes and failed once every signed-in user could, under identical policies`
        );
      });

      it('counts a file whose open-reads run errors after the first test while the owner-only run passes everything', async () => {
        const { suite } = await suiteOf({
          behaviour: {
            'a_test.sql': {
              clean: { stdout: tapText(CROSS_USER) },
              mutated: tapOf(MARKER, tapText(CROSS_USER, [2])),
              ownerOnly: tapOf(OWNER_ONLY_TWIN_MARKER, tapText(CROSS_USER)),
              openReads: {
                ...tapOf(OPEN_READS_TWIN_MARKER, `1..3\nok 1 - ${A_OWN}\n`, 3),
                stderr:
                  'psql:b_test.sql:14: ERROR:  more than one row returned by a subquery used as an expression',
              },
            },
          },
        });
        const [attempt] = (suite as Extract<SuiteProbe, { ok: true }>).catches;
        expect(catchVerdict(attempt)).toEqual({
          caught: true,
          test: {
            number: 2,
            description: B_BLOCKED,
            ranUnderOpenReads: false,
          },
        });
        expect(checkTestsCatchSeededPolicies(suite).notes).toContain(
          `test 2 "${B_BLOCKED}" passed when only owners could read notes and did not run once every signed-in user could, under identical policies`
        );
      });

      it('counts a mixed file through its behavioural test, not its structural one', async () => {
        const POLICIES_ARE = 'policies_are: the four seeded names';
        const tap = (structural: string, behavioural: string) =>
          `1..2\n${structural} 1 - ${POLICIES_ARE}\n${behavioural} 2 - ${B_BLOCKED}\n`;
        const check = await verdictOf({
          clean: { stdout: tap('ok', 'ok') },
          mutated: tapOf(MARKER, tap('not ok', 'not ok')),
          ownerOnly: tapOf(OWNER_ONLY_TWIN_MARKER, tap('not ok', 'ok')),
          openReads: tapOf(OPEN_READS_TWIN_MARKER, tap('not ok', 'not ok')),
        });
        expect(check.passed).toBe(true);
        expect(check.notes).toContain(`test 2 "${B_BLOCKED}"`);
        expect(check.notes).not.toContain(`"${POLICIES_ARE}"`);
      });

      describe('that emits one test per visible row', () => {
        const PER_ROW_OPEN = [
          '1..3',
          'ok 1 - a can see note: a-note-1',
          'ok 2 - a can see note: a-note-2',
          "not ok 3 - a can see note: b-note-1 (owner_id is b's)",
          '# Looks like you failed 1 test of 3',
          '',
        ].join('\n');
        const PER_ROW_OWNERS = [
          '1..2',
          'ok 1 - a can see note: a-note-1',
          'ok 2 - a can see note: a-note-2',
          '',
        ].join('\n');
        const planLast = (tap: string) => {
          const [plan, ...rest] = tap.trimEnd().split('\n');
          return `${[...rest, plan].join('\n')}\n`;
        };

        it('counts a file by the extra not ok that exists only once every signed-in user can read notes', async () => {
          const check = await verdictOf({
            clean: { stdout: PER_ROW_OWNERS },
            mutated: tapOf(MARKER, PER_ROW_OPEN),
            ownerOnly: tapOf(OWNER_ONLY_TWIN_MARKER, PER_ROW_OWNERS),
            openReads: tapOf(OPEN_READS_TWIN_MARKER, PER_ROW_OPEN),
          });
          expect(check.passed).toBe(true);
          expect(check.notes).toContain(
            'test 3 "a can see note: b-note-1 (owner_id is b\'s)" failed only once every signed-in user could read notes (it did not run when only owners could), under identical policies'
          );
        });

        it('counts a no_plan file the same way', async () => {
          const check = await verdictOf({
            clean: { stdout: planLast(PER_ROW_OWNERS) },
            mutated: tapOf(MARKER, planLast(PER_ROW_OPEN)),
            ownerOnly: tapOf(OWNER_ONLY_TWIN_MARKER, planLast(PER_ROW_OWNERS)),
            openReads: tapOf(OPEN_READS_TWIN_MARKER, planLast(PER_ROW_OPEN)),
          });
          expect(check.passed).toBe(true);
          expect(check.notes).toContain(
            'test 3 "a can see note: b-note-1 (owner_id is b\'s)" failed only once every signed-in user could read notes'
          );
        });

        it('counts a plan(1) file that fails under open reads only through the plan mismatch', async () => {
          const planOne = (rows: number) =>
            [
              '1..1',
              ...Array.from(
                { length: rows },
                (_, i) => `ok ${i + 1} - a can see note: note-${i + 1}`
              ),
              ...(rows > 1
                ? [`# Looks like you planned 1 test but ran ${rows}`]
                : []),
              '',
            ].join('\n');
          const check = await verdictOf({
            clean: { stdout: planOne(1) },
            mutated: tapOf(MARKER, planOne(2)),
            ownerOnly: tapOf(OWNER_ONLY_TWIN_MARKER, planOne(1)),
            openReads: tapOf(OPEN_READS_TWIN_MARKER, planOne(2)),
          });
          expect(check.passed).toBe(true);
          expect(check.notes).toContain(
            'it passed outright when only owners could read notes and failed once every signed-in user could, under identical policies'
          );
        });

        it('does not count a file that fails the same way under both twins', async () => {
          const failing = [
            '1..3',
            'ok 1 - a can see note: a-note-1',
            'not ok 2 - a can see note: a-note-2',
            'ok 3 - a can see note: b-note-1',
            '',
          ].join('\n');
          const check = await verdictOf({
            clean: { stdout: PER_ROW_OWNERS },
            mutated: tapOf(MARKER, PER_ROW_OPEN),
            ownerOnly: tapOf(OWNER_ONLY_TWIN_MARKER, failing),
            openReads: tapOf(OPEN_READS_TWIN_MARKER, failing),
          });
          expect(check.passed).toBe(false);
          expect(check.notes).toBe(SAME_UNDER_TWINS);
        });
      });

      describe('with a structural test next to per-row tests', () => {
        const POLICIES_ARE = 'policies_are: the four seeded names';
        const A_NOTE = 'a can see note: a note';
        const B_NOTE = 'a can see note: b note';
        const UNDER_OWNERS = noPlan([
          `not ok 1 - ${POLICIES_ARE}`,
          `ok 2 - ${A_NOTE}`,
        ]);
        const cleanTap = noPlan([`ok 1 - ${POLICIES_ARE}`, `ok 2 - ${A_NOTE}`]);

        it('counts a mixed no_plan file by the per-row not ok that exists only under open reads', async () => {
          const underOpen = noPlan([
            `not ok 1 - ${POLICIES_ARE}`,
            `ok 2 - ${A_NOTE}`,
            `not ok 3 - ${B_NOTE}`,
          ]);
          const check = await verdictOf({
            clean: { stdout: cleanTap },
            mutated: tapOf(MARKER, underOpen),
            ownerOnly: tapOf(OWNER_ONLY_TWIN_MARKER, UNDER_OWNERS),
            openReads: tapOf(OPEN_READS_TWIN_MARKER, underOpen),
          });
          expect(check.passed).toBe(true);
          expect(check.notes).toContain(
            `test 3 "${B_NOTE}" failed only once every signed-in user could read notes`
          );
        });

        it('does not count an open-reads-only failure that is a TODO', async () => {
          const underOpen = noPlan([
            `not ok 1 - ${POLICIES_ARE}`,
            `ok 2 - ${A_NOTE}`,
            `not ok 3 - ${B_NOTE} # TODO later`,
          ]);
          const check = await verdictOf({
            clean: { stdout: cleanTap },
            mutated: tapOf(MARKER, underOpen),
            ownerOnly: tapOf(OWNER_ONLY_TWIN_MARKER, UNDER_OWNERS),
            openReads: tapOf(OPEN_READS_TWIN_MARKER, underOpen),
          });
          expect(check.passed).toBe(false);
          expect(check.notes).toBe(SAME_UNDER_TWINS);
        });
      });
    });

    describe('when a run did not apply', () => {
      it('does not count a file whose leak run never printed its marker', async () => {
        const check = await verdictOf({
          ...behaviourOf(CROSS_USER, [2], [], [2]),
          mutated: { stdout: tapText(CROSS_USER, [2]) },
        });
        expect(check.passed).toBe(false);
        expect(check.notes).toMatch(/mutation did not apply/);
      });

      it('does not count a file whose owner-only twin never printed its marker', async () => {
        const check = await verdictOf({
          ...behaviourOf(CROSS_USER, [2], [], [2]),
          ownerOnly: {
            stdout: tapText(CROSS_USER),
            exitCode: 2,
            stderr: 'psql: error: connection refused',
          },
        });
        expect(check.passed).toBe(false);
        expect(check.notes).toMatch(
          /the identical-policy runs \(owner-only twin\) did not apply \(psql exit 2: psql: error: connection refused\), so the run proves nothing/
        );
        expect(check.notes).not.toContain('open-reads twin');
      });

      it('does not count a file whose open-reads twin never printed its marker', async () => {
        const check = await verdictOf({
          ...behaviourOf(CROSS_USER, [2], [], [2]),
          openReads: {
            stdout: tapText(CROSS_USER, [2]),
            exitCode: 2,
            stderr: 'psql: error: deadlock detected',
          },
        });
        expect(check.passed).toBe(false);
        expect(check.notes).toMatch(
          /the identical-policy runs \(open-reads twin\) did not apply \(psql exit 2: psql: error: deadlock detected\)/
        );
        expect(check.notes).not.toContain('owner-only twin');
      });
    });
  });

  it('does not read the policies when no file passed clean', async () => {
    const { ctx } = await suiteOf({
      behaviour: {
        'a_test.sql': { clean: { stdout: tapText(DESCRIPTIONS, [1]) } },
      },
    });
    expect(ctx.log).not.toContain('snapshot');
  });

  it('creates pgtap before the first test file and drops it as the very last command when it was not installed', async () => {
    const { ctx, suite } = await suiteOf({
      pgtap: false,
      files: ['a_test.sql'],
      behaviour: { 'a_test.sql': CATCHING },
    });
    expect(suite).toMatchObject({ ok: true });
    expect(ctx.log.filter((line) => line.endsWith('extension'))).toEqual([
      'probe-extension',
      'create-extension',
      'drop-extension',
    ]);
    expect(ctx.log.indexOf('create-extension')).toBeLessThan(
      ctx.log.indexOf('clean a_test.sql')
    );
    expect(ctx.log.at(-1)).toBe('drop-extension');
    expect(ctx.state.pgtap).toBe(false);
  });

  it('drops pgtap even when no file passes clean', async () => {
    const { ctx } = await suiteOf({
      pgtap: false,
      behaviour: {
        'a_test.sql': { clean: { stdout: tapText(DESCRIPTIONS, [1]) } },
      },
    });
    expect(ctx.log.at(-1)).toBe('drop-extension');
  });

  it('leaves pgtap alone when it was already installed', async () => {
    const { ctx } = await suiteOf({
      pgtap: true,
      behaviour: { 'a_test.sql': CATCHING },
    });
    expect(ctx.log).not.toContain('create-extension');
    expect(ctx.log).not.toContain('drop-extension');
    expect(ctx.state.pgtap).toBe(true);
  });

  it('finds no files, runs nothing and stays ok when the tests directory is empty', async () => {
    const { ctx, suite } = await suiteOf({ files: [] });
    expect(suite).toEqual({ ok: true, files: [], clean: [], catches: [] });
    expect(ctx.psqlTestCommands).toEqual([]);
  });

  it('finds no files and stays ok when the tests directory does not exist', async () => {
    const { suite } = await suiteOf({ files: null });
    expect(suite).toEqual({ ok: true, files: [], clean: [], catches: [] });
  });

  it('fails with the stack notes, without running anything, when the stack did not resolve', async () => {
    const ctx = fakeDb({ behaviour: { 'a_test.sql': CATCHING } });
    const suite = await runSuite(ctx, {
      ok: false,
      notes: 'managed: exit 1: no stack running',
    });
    expect(suite).toEqual({
      ok: false,
      notes: expect.stringContaining('no stack running'),
    });
    expect(ctx.exec).not.toHaveBeenCalled();
  });

  it('fails when the listing fails for a reason other than a missing directory', async () => {
    const { suite } = await suiteOf({
      listFailure: "find: 'supabase/tests': Permission denied",
    });
    expect(suite).toEqual({
      ok: false,
      notes: expect.stringContaining('Permission denied'),
    });
  });

  it('fails without running any test file when pgtap cannot be created', async () => {
    const { ctx, suite } = await suiteOf({
      pgtap: false,
      createFails: true,
      behaviour: { 'a_test.sql': CATCHING },
    });
    expect(suite).toEqual({
      ok: false,
      notes: expect.stringContaining('pgtap.control'),
    });
    expect(ctx.psqlTestCommands).toEqual([]);
  });

  it('reports a thrown exec instead of rejecting', async () => {
    const { suite } = await suiteOf({ throws: 'sandbox gone' });
    expect(suite).toEqual({
      ok: false,
      notes: expect.stringContaining('sandbox gone'),
    });
  });
});

describe('check helpers', () => {
  const tapOfRun = (
    descriptions: readonly string[],
    failing: readonly number[],
    planned: number | null = descriptions.length
  ): TapResult => ({
    planned,
    plans: planned === null ? 0 : 1,
    results: descriptions.map((description, i) =>
      entry(!failing.includes(i + 1), i + 1, description)
    ),
  });

  const run = (
    file: string,
    options: {
      descriptions?: readonly string[];
      failing?: readonly number[];
      planned?: number | null;
      exitCode?: number | null;
      detail?: string;
    } = {}
  ): TestFileRun => {
    const descriptions = options.descriptions ?? DESCRIPTIONS;
    const failing = options.failing ?? [];
    const tap = tapOfRun(descriptions, failing, options.planned);
    const exitCode = options.exitCode === undefined ? 0 : options.exitCode;
    return {
      file,
      passed:
        exitCode === 0 &&
        failing.length === 0 &&
        tap.planned === tap.results.length,
      exitCode,
      tap,
      detail: options.detail ?? 'psql exit 0',
    };
  };

  const mutated = (
    file: string,
    options: Parameters<typeof run>[1] & { applied?: boolean } = {}
  ) => ({ ...run(file, options), mutationApplied: options.applied ?? true });

  const catching = (file: string) => ({
    file,
    mutated: mutated(file, { failing: [2] }),
    ownerOnly: mutated(file),
    openReads: mutated(file, { failing: [2] }),
  });

  const runOfTap = (file: string, text: string, exitCode = 0): TestFileRun => {
    const tap = parseTap(text);
    return {
      file,
      passed: tapPassed(exitCode, tap),
      exitCode,
      tap,
      detail: `psql exit ${exitCode}`,
    };
  };

  const suite = (parts: {
    files: string[];
    clean: TestFileRun[];
    catches?: CatchRun[];
    mutationBlocked?: string;
    unmutated?: string[];
  }): SuiteProbe => ({ ok: true, catches: [], ...parts });

  const failedSuite: SuiteProbe = {
    ok: false,
    notes: 'managed: exit 1: no stack running',
  };

  describe('checkTestsPass', () => {
    it('passes when every file passes and there are tests', () => {
      expect(
        checkTestsPass(suite({ files: [A], clean: [run(A)] }))
      ).toMatchObject({ name: TESTS_PASS_CHECK_NAME, passed: true });
    });

    it('passes several files that all pass', () => {
      expect(
        checkTestsPass(suite({ files: [A, B], clean: [run(A), run(B)] })).passed
      ).toBe(true);
    });

    it('passes a skipped file next to a file with tests', () => {
      const skipped = run(B, { descriptions: [], planned: 0 });
      expect(
        checkTestsPass(suite({ files: [A, B], clean: [run(A), skipped] }))
          .passed
      ).toBe(true);
    });

    it('fails with a note naming supabase/tests when there are no test files', () => {
      const check = checkTestsPass(suite({ files: [], clean: [] }));
      expect(check.name).toBe(TESTS_PASS_CHECK_NAME);
      expect(check.passed).toBe(false);
      expect(check.notes).toContain('supabase/tests');
    });

    it('fails when only one of two files fails, naming it and its first failing test', () => {
      const failing = run(B, { failing: [2, 3] });
      const check = checkTestsPass(
        suite({ files: [A, B], clean: [run(A), failing] })
      );
      expect(check.passed).toBe(false);
      expect(check.notes).toContain(B);
      expect(check.notes).toContain(D2);
    });

    it('fails a file that died before finishing, naming it and its detail', () => {
      const died = run(A, {
        descriptions: [D1],
        failing: [],
        planned: 3,
        exitCode: 3,
        detail: 'psql exit 3: ERROR:  more than one row returned by a subquery',
      });
      const check = checkTestsPass(suite({ files: [A], clean: [died] }));
      expect(check.passed).toBe(false);
      expect(check.notes).toContain(A);
      expect(check.notes).toContain('more than one row returned by a subquery');
    });

    it('fails a file that planned more tests than it ran', () => {
      const short = run(A, {
        descriptions: [D1],
        planned: 3,
        detail: 'planned 3 tests but ran 1',
      });
      const check = checkTestsPass(suite({ files: [A], clean: [short] }));
      expect(check.passed).toBe(false);
      expect(check.notes).toContain('planned 3 tests but ran 1');
    });

    it('fails when the files hold no tests at all', () => {
      const empty = run(A, { descriptions: [], planned: 0 });
      const check = checkTestsPass(suite({ files: [A], clean: [empty] }));
      expect(check.passed).toBe(false);
      expect(check.notes).toMatch(/no tests|zero tests|0 tests/i);
    });

    it('fails with the suite notes when the suite could not run', () => {
      const check = checkTestsPass(failedSuite);
      expect(check.name).toBe(TESTS_PASS_CHECK_NAME);
      expect(check.passed).toBe(false);
      expect(check.notes).toContain('no stack running');
    });
  });

  describe('checkTestsCatchSeededPolicies', () => {
    const SAME_UNDER_TWINS = (file: string) =>
      `${file}: failed with the seeded policies put back, but its results did not change when every signed-in user could read notes under identical policies, so it checks how the policies are written, not who can see which notes`;
    const tapRun = (file: string, text: string, applied = true) => ({
      ...runOfTap(file, text),
      mutationApplied: applied,
    });

    it('passes when a file passed clean, failed under the leak with its marker, and a test changed between the twins', () => {
      const check = checkTestsCatchSeededPolicies(
        suite({ files: [A], clean: [run(A)], catches: [catching(A)] })
      );
      expect(check).toMatchObject({
        name: TESTS_CATCH_CHECK_NAME,
        passed: true,
      });
      expect(check.notes).toContain(A);
      expect(check.notes).toContain(
        `test 2 "${D2}" passed when only owners could read notes and failed once every signed-in user could, under identical policies`
      );
    });

    it('passes when one of two files catches the policies', () => {
      const notCaught = {
        file: B,
        mutated: mutated(B),
        ownerOnly: mutated(B),
        openReads: mutated(B),
      };
      expect(
        checkTestsCatchSeededPolicies(
          suite({
            files: [A, B],
            clean: [run(A), run(B)],
            catches: [notCaught, catching(A)],
          })
        ).passed
      ).toBe(true);
    });

    it('passes when a catching file sits next to a file that failed clean', () => {
      expect(
        checkTestsCatchSeededPolicies(
          suite({
            files: [A, B],
            clean: [run(A), run(B, { failing: [1] })],
            catches: [catching(A)],
          })
        ).passed
      ).toBe(true);
    });

    it('fails when the mutation failed the tests but its marker never printed', () => {
      const check = checkTestsCatchSeededPolicies(
        suite({
          files: [A],
          clean: [run(A)],
          catches: [
            {
              ...catching(A),
              mutated: mutated(A, {
                descriptions: [],
                planned: null,
                exitCode: 2,
                applied: false,
              }),
            },
          ],
        })
      );
      expect(check.passed).toBe(false);
      expect(check.notes).toMatch(
        /mutation (did not|didn't) apply|mutation was not applied|not applied/i
      );
    });

    it('fails when a failing mutated run has no marker even though the tap shows failures', () => {
      const check = checkTestsCatchSeededPolicies(
        suite({
          files: [A],
          clean: [run(A)],
          catches: [
            {
              ...catching(A),
              mutated: mutated(A, { failing: [2], applied: false }),
            },
          ],
        })
      );
      expect(check.passed).toBe(false);
    });

    it('fails when the tests still pass under the mutation', () => {
      const check = checkTestsCatchSeededPolicies(
        suite({
          files: [A],
          clean: [run(A)],
          catches: [
            {
              file: A,
              mutated: mutated(A),
              ownerOnly: mutated(A),
              openReads: mutated(A),
            },
          ],
        })
      );
      expect(check.name).toBe(TESTS_CATCH_CHECK_NAME);
      expect(check.passed).toBe(false);
      expect(check.notes).toContain(A);
      expect(check.notes).toMatch(/pass/i);
    });

    it('fails a file that failed under the leak and the same test under both twins, saying it checks how the policies are written', () => {
      const attempt = {
        file: A,
        mutated: mutated(A, { failing: [2] }),
        ownerOnly: mutated(A, { failing: [2] }),
        openReads: mutated(A, { failing: [2] }),
      };
      const check = checkTestsCatchSeededPolicies(
        suite({ files: [A], clean: [run(A)], catches: [attempt] })
      );
      expect(check.passed).toBe(false);
      expect(check.notes).toBe(SAME_UNDER_TWINS(A));
      expect(check.notes).not.toMatch(/drift|re-?run/i);
      expect(catchVerdict(attempt)).toEqual({
        caught: false,
        reason: 'same-under-twins',
      });
    });

    it('fails a file whose twins pass everything while only the leak run fails', () => {
      const attempt = {
        file: A,
        mutated: mutated(A, { failing: [1] }),
        ownerOnly: mutated(A),
        openReads: mutated(A),
      };
      const check = checkTestsCatchSeededPolicies(
        suite({ files: [A], clean: [run(A)], catches: [attempt] })
      );
      expect(check.passed).toBe(false);
      expect(check.notes).toBe(SAME_UNDER_TWINS(A));
    });

    it('catches a file that passes outright only when owners could read notes, with no test number that flips, saying so', () => {
      const attempt = {
        file: A,
        mutated: tapRun(
          A,
          '1..1\nok 1 - a can see note: n1\nok 2 - a can see note: n2\n'
        ),
        ownerOnly: tapRun(A, '1..1\nok 1 - a can see note: n1\n'),
        openReads: tapRun(
          A,
          '1..1\nok 1 - a can see note: n1\nok 2 - a can see note: n2\n'
        ),
      };
      const check = checkTestsCatchSeededPolicies(
        suite({ files: [A], clean: [run(A)], catches: [attempt] })
      );
      expect(check.passed).toBe(true);
      expect(check.notes).toContain(A);
      expect(check.notes).toContain(
        'it passed outright when only owners could read notes and failed once every signed-in user could, under identical policies'
      );
      expect(catchVerdict(attempt)).toEqual({
        caught: true,
        passedOutright: true,
      });
    });

    it('does not catch a file that passes outright under open reads and fails under owner-only reads', () => {
      const check = checkTestsCatchSeededPolicies(
        suite({
          files: [A],
          clean: [run(A)],
          catches: [
            {
              file: A,
              mutated: mutated(A, { failing: [2] }),
              ownerOnly: mutated(A, { failing: [1, 2, 3] }),
              openReads: mutated(A),
            },
          ],
        })
      );
      expect(check.passed).toBe(false);
      expect(check.notes).toBe(SAME_UNDER_TWINS(A));
    });

    it('fails when the owner-only twin never applied, naming it and why', () => {
      const attempt = {
        file: A,
        mutated: mutated(A, { failing: [2] }),
        ownerOnly: mutated(A, {
          applied: false,
          exitCode: 2,
          detail: 'psql exit 2: connection refused',
        }),
        openReads: mutated(A, { failing: [2] }),
      };
      const check = checkTestsCatchSeededPolicies(
        suite({ files: [A], clean: [run(A)], catches: [attempt] })
      );
      expect(check.passed).toBe(false);
      expect(check.notes).toBe(
        `${A}: the identical-policy runs (owner-only twin) did not apply (psql exit 2: connection refused), so the run proves nothing`
      );
      expect(catchVerdict(attempt)).toEqual({
        caught: false,
        reason: 'twins-not-applied',
        twins: ['owner-only'],
      });
    });

    it('fails when the open-reads twin never applied, naming it and why', () => {
      const check = checkTestsCatchSeededPolicies(
        suite({
          files: [A],
          clean: [run(A)],
          catches: [
            {
              file: A,
              mutated: mutated(A, { failing: [2] }),
              ownerOnly: mutated(A),
              openReads: mutated(A, {
                applied: false,
                exitCode: 2,
                detail: 'psql exit 2: deadlock detected',
              }),
            },
          ],
        })
      );
      expect(check.passed).toBe(false);
      expect(check.notes).toBe(
        `${A}: the identical-policy runs (open-reads twin) did not apply (psql exit 2: deadlock detected), so the run proves nothing`
      );
    });

    it('names both twins when neither applied, with the detail of each', () => {
      const attempt = {
        file: A,
        mutated: mutated(A, { failing: [2] }),
        ownerOnly: mutated(A, {
          applied: false,
          detail: 'psql exit 2: connection refused',
        }),
        openReads: mutated(A, {
          applied: false,
          detail: 'psql exit 2: deadlock detected',
        }),
      };
      const check = checkTestsCatchSeededPolicies(
        suite({ files: [A], clean: [run(A)], catches: [attempt] })
      );
      expect(check.notes).toContain(
        '(owner-only twin and open-reads twin) did not apply (psql exit 2: connection refused; psql exit 2: deadlock detected)'
      );
    });

    it('passes through the test that changed, even when a structural test fails under both twins', () => {
      const descriptions = ['policy set', D2];
      const check = checkTestsCatchSeededPolicies(
        suite({
          files: [A],
          clean: [run(A)],
          catches: [
            {
              file: A,
              mutated: mutated(A, { descriptions, failing: [1, 2] }),
              ownerOnly: mutated(A, { descriptions, failing: [1] }),
              openReads: mutated(A, { descriptions, failing: [1, 2] }),
            },
          ],
        })
      );
      expect(check.passed).toBe(true);
      expect(check.notes).toContain(`test 2 "${D2}"`);
      expect(check.notes).not.toContain('"policy set"');
    });

    it('names a test the open-reads run never reached as one that did not run', () => {
      const attempt = {
        file: A,
        mutated: mutated(A, { failing: [2] }),
        ownerOnly: mutated(A),
        openReads: mutated(A, {
          descriptions: [D1],
          planned: 3,
          exitCode: 3,
        }),
      };
      const check = checkTestsCatchSeededPolicies(
        suite({ files: [A], clean: [run(A)], catches: [attempt] })
      );
      expect(check.passed).toBe(true);
      expect(check.notes).toContain(
        `test 2 "${D2}" passed when only owners could read notes and did not run once every signed-in user could, under identical policies`
      );
      expect(catchVerdict(attempt)).toMatchObject({
        caught: true,
        test: { number: 2, ranUnderOpenReads: false },
      });
    });

    it('marks a failure that exists only under open reads', () => {
      const attempt = {
        file: A,
        mutated: tapRun(A, '1..2\nok 1 - set\nnot ok 2 - extra row\n'),
        ownerOnly: tapRun(A, '1..1\nok 1 - set\n'),
        openReads: tapRun(A, '1..2\nok 1 - set\nnot ok 2 - extra row\n'),
      };
      expect(catchVerdict(attempt)).toEqual({
        caught: true,
        test: {
          number: 2,
          description: 'extra row',
          ranUnderOpenReads: true,
          openReadsOnly: true,
        },
      });
      expect(
        checkTestsCatchSeededPolicies(
          suite({ files: [A], clean: [run(A)], catches: [attempt] })
        ).notes
      ).toContain(
        'test 2 "extra row" failed only once every signed-in user could read notes (it did not run when only owners could), under identical policies'
      );
    });

    it('prefers a test that flipped over an open-reads-only failure', () => {
      const attempt = {
        file: A,
        mutated: tapRun(A, '1..3\nok 1 - a\nnot ok 2 - b\nnot ok 3 - c\n'),
        ownerOnly: tapRun(A, '1..2\nok 1 - a\nok 2 - b\n'),
        openReads: tapRun(A, '1..3\nok 1 - a\nnot ok 2 - b\nnot ok 3 - c\n'),
      };
      expect(catchVerdict(attempt)).toMatchObject({
        caught: true,
        test: { number: 2, description: 'b', ranUnderOpenReads: true },
      });
    });

    it('does not flip on a TODO test', () => {
      const check = checkTestsCatchSeededPolicies(
        suite({
          files: [A],
          clean: [run(A)],
          catches: [
            {
              file: A,
              mutated: tapRun(
                A,
                '1..2\nnot ok 1 - set\nnot ok 2 - later # TODO later\n'
              ),
              ownerOnly: tapRun(
                A,
                '1..2\nnot ok 1 - set\nok 2 - later # TODO later\n'
              ),
              openReads: tapRun(
                A,
                '1..2\nnot ok 1 - set\nnot ok 2 - later # TODO later\n'
              ),
            },
          ],
        })
      );
      expect(check.passed).toBe(false);
    });

    it('does not flip on a nested subtest result', () => {
      const check = checkTestsCatchSeededPolicies(
        suite({
          files: [A],
          clean: [run(A)],
          catches: [
            {
              file: A,
              mutated: tapRun(A, '1..1\nnot ok 1 - set\n'),
              ownerOnly: tapRun(A, '1..1\nnot ok 1 - set\n    ok 1 - nested\n'),
              openReads: tapRun(
                A,
                '1..1\nnot ok 1 - set\n    not ok 1 - nested\n'
              ),
            },
          ],
        })
      );
      expect(check.passed).toBe(false);
    });

    it('flips on a result number rather than its description', () => {
      const check = checkTestsCatchSeededPolicies(
        suite({
          files: [A],
          clean: [run(A)],
          catches: [
            {
              file: A,
              mutated: tapRun(
                A,
                '1..2\nok 1 - set\nnot ok 2 - reads under open reads\n'
              ),
              ownerOnly: tapRun(
                A,
                '1..2\nok 1 - set\nok 2 - reads under owner-only\n'
              ),
              openReads: tapRun(
                A,
                '1..2\nok 1 - set\nnot ok 2 - reads under open reads\n'
              ),
            },
          ],
        })
      );
      expect(check.passed).toBe(true);
      expect(check.notes).toContain('test 2 "reads under owner-only"');
    });

    it('passes a file that committed the mutation and was restored, and says so', () => {
      const check = checkTestsCatchSeededPolicies(
        suite({
          files: [A],
          clean: [run(A)],
          catches: [{ ...catching(A), leaked: true }],
        })
      );
      expect(check.passed).toBe(true);
      expect(check.notes).toContain(A);
      expect(check.notes).toMatch(/committed the mutation/);
      expect(check.notes).toMatch(
        /scorer restored the notes policies between the runs/
      );
    });

    it('does not mention a restore for a file that left the policies alone', () => {
      const check = checkTestsCatchSeededPolicies(
        suite({ files: [A], clean: [run(A)], catches: [catching(A)] })
      );
      expect(check.notes).not.toMatch(/restore/i);
    });

    it('does not count a file whose policies could not be restored, and names the files left unmutated', () => {
      const check = checkTestsCatchSeededPolicies(
        suite({
          files: [A, B],
          clean: [run(A), run(B)],
          catches: [
            {
              file: A,
              mutated: mutated(A, { failing: [2] }),
              ownerOnly: null,
              openReads: null,
              leaked: true,
              restoreFailure:
                'the file committed the mutation and the scorer could not restore the notes policies (the restore session failed)',
            },
          ],
          unmutated: [B],
        })
      );
      expect(check.passed).toBe(false);
      expect(check.notes).toContain(A);
      expect(check.notes).toContain('could not restore the notes policies');
      expect(check.notes).toMatch(/not counted/);
      expect(check.notes).toContain(B);
      expect(check.notes).toMatch(/not run under the seeded policies/);
    });

    it('fails with the reason when the policies could not be read before any mutated run', () => {
      const check = checkTestsCatchSeededPolicies(
        suite({
          files: [A],
          clean: [run(A)],
          mutationBlocked:
            'could not read the notes policies: exit 2: connection refused, so no test file was run under the seeded policies',
        })
      );
      expect(check.name).toBe(TESTS_CATCH_CHECK_NAME);
      expect(check.passed).toBe(false);
      expect(check.notes).toContain('connection refused');
      expect(check.notes).toContain('no test file was run');
    });

    it('fails when the clean run fails, since a failing suite cannot prove it catches anything', () => {
      const check = checkTestsCatchSeededPolicies(
        suite({ files: [A], clean: [run(A, { failing: [2] })] })
      );
      expect(check.name).toBe(TESTS_CATCH_CHECK_NAME);
      expect(check.passed).toBe(false);
      expect(check.notes).toMatch(/fail/i);
    });

    it('fails when there are no test files', () => {
      expect(
        checkTestsCatchSeededPolicies(suite({ files: [], clean: [] })).passed
      ).toBe(false);
    });

    it('fails with the suite notes when the suite could not run', () => {
      const check = checkTestsCatchSeededPolicies(failedSuite);
      expect(check.name).toBe(TESTS_CATCH_CHECK_NAME);
      expect(check.passed).toBe(false);
      expect(check.notes).toContain('no stack running');
    });
  });
});
