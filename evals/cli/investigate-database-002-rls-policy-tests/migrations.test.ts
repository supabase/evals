// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-002-rls-policy-tests
import { readFileSync } from 'node:fs';
import type { CommandResult } from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import { buildAccessProbeBody, type AccessProbe } from './access.js';
import {
  LEAKY_POLICY_NAME,
  SEEDED_MIGRATION_FILE,
  SEEDED_MIGRATION_VERSION,
  SEEDED_NOTES_POLICIES,
} from './fixtures.js';
import {
  accessRules,
  accessRuleStatements,
  buildReplayProbeSql,
  checkFixInAppliedMigration,
  findPolicyMigrations,
  MIGRATION_CHECK_NAME,
  readRecordedPolicyMigrations,
  readReplayedNotesAccess,
  splitStatements,
  type PolicyMigration,
  type PolicyMigrationsProbe,
  type RecordedPolicyMigrationsProbe,
} from './migrations.js';
import { DROP_NOTES_POLICIES_SQL } from './snapshot.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: DB_URL,
  runtime: 'native',
};

const SEEDED_SQL = readFileSync(
  new URL(
    `./local/supabase/migrations/${SEEDED_MIGRATION_FILE}`,
    import.meta.url
  ),
  'utf8'
);
const LEAKY_BLOCK = SEEDED_SQL.slice(
  SEEDED_SQL.indexOf(`create policy "${LEAKY_POLICY_NAME}"`)
);
const SEEDED_WITHOUT_LEAK = SEEDED_SQL.replace(LEAKY_BLOCK, '');

const DROP_LEAK = `drop policy "${LEAKY_POLICY_NAME}" on public.notes;\n`;
const FIX_FILE = '20260102000000_fix_notes_policy.sql';
const FIX_VERSION = '20260102000000';
const SECOND_FILE = '20260103000000_tighten_notes.sql';
const SECOND_VERSION = '20260103000000';
const SECOND_SQL =
  'alter policy "Users can view their own notes" on public.notes using (true);\n';
const MISORDERED_FILE = '20251231000000_x.sql';

const SEEDED: PolicyMigration = {
  version: SEEDED_MIGRATION_VERSION,
  file: SEEDED_MIGRATION_FILE,
  seeded: true,
};
const FIX: PolicyMigration = {
  version: FIX_VERSION,
  file: FIX_FILE,
  seeded: false,
};
const SECOND: PolicyMigration = {
  version: SECOND_VERSION,
  file: SECOND_FILE,
  seeded: false,
};

function result(stdout: string, ok = true, stderr = ''): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr };
}

const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex');

type OkAccess = Extract<AccessProbe, { ok: true }>;

const FIXED_ACCESS: OkAccess = {
  ok: true,
  reads: {
    owner: { titles: ['eval-probe-owner-1', 'eval-probe-owner-2'] },
    other: { titles: ['eval-probe-other-1'] },
    anon: { titles: [] },
  },
  writes: {
    otherUpdate: { rows: 0 },
    otherDelete: { rows: 0 },
    otherInsertAsOwner: { denied: '42501' },
    ownerUpdate: { rows: 1 },
    ownerInsert: { rows: 1 },
  },
};
const LEAKY_ACCESS: OkAccess = {
  ...FIXED_ACCESS,
  reads: {
    ...FIXED_ACCESS.reads,
    other: {
      titles: [
        'eval-probe-other-1',
        'eval-probe-owner-1',
        'eval-probe-owner-2',
      ],
    },
  },
};
const OPEN_WRITES_ACCESS: OkAccess = {
  ...FIXED_ACCESS,
  writes: { ...FIXED_ACCESS.writes, otherUpdate: { rows: 1 } },
};

const policyNames = [
  'users can view their own notes',
  'users can create their own notes',
  'users can update their own notes',
  'users can delete their own notes',
  'enable read access for authenticated users',
];

describe('check name', () => {
  it('is the documented one', () => {
    expect(MIGRATION_CHECK_NAME).toBe(
      'the notes policy fix is in an applied migration'
    );
  });
});

describe('splitStatements', () => {
  it('returns each top-level statement as written, without its terminator', () => {
    expect(
      splitStatements('DROP POLICY "P" ON public.notes;\nselect  1 ;\n')
    ).toEqual(['DROP POLICY "P" ON public.notes', 'select  1']);
  });

  it('keeps a final statement that has no terminator', () => {
    expect(splitStatements('select 1; select 2')).toEqual([
      'select 1',
      'select 2',
    ]);
  });

  it('skips empty statements', () => {
    expect(splitStatements(';; select 1;;\n;')).toEqual(['select 1']);
    expect(splitStatements('')).toEqual([]);
    expect(splitStatements('-- only a comment\n')).toEqual([]);
  });

  it.each([
    ['a single-quoted literal', "select 'a;b';"],
    ['an escaped quote in a literal', "select 'it''s; fine';"],
    ['an E-string with a backslash-escaped quote', "select E'it\\'s; fine';"],
    ['a double-quoted identifier', 'select 1 as "a;b";'],
    ['a dollar-quoted body', 'do $$ begin perform 1; end $$;'],
    ['a tagged dollar-quoted body', 'do $do$ begin perform 1; end $do$;'],
    ['a dollar-quoted body holding another tag', 'do $a$ x $b$ ; $b$ y $a$;'],
    ['a line comment inside the statement', 'select 1 -- a; b\n, 2;'],
    ['a block comment inside the statement', 'select 1 /* a; b */, 2;'],
    ['a nested block comment', 'select 1 /* a /* b; */ c; */, 2;'],
  ])('does not split inside %s', (_label, statement) => {
    expect(splitStatements(`${statement}\nselect 3;`)).toEqual([
      statement.slice(0, -1),
      'select 3',
    ]);
  });

  it('does not read a parameter such as $1 as a dollar quote', () => {
    expect(splitStatements('select $1; select $2;')).toEqual([
      'select $1',
      'select $2',
    ]);
  });

  it('drops comments before and after a statement but keeps those inside it', () => {
    expect(
      splitStatements(
        '-- close the leak\n/* really */ drop policy /* x */ "p" on public.notes -- bye\n;'
      )
    ).toEqual(['drop policy /* x */ "p" on public.notes']);
  });

  it('splits the seeded migration into its statements, the policies verbatim', () => {
    expect(
      splitStatements(SEEDED_SQL).filter((statement) =>
        statement.startsWith('create policy')
      )
    ).toEqual(SEEDED_NOTES_POLICIES);
  });
});

describe('accessRules', () => {
  it('pairs each access rule statement with its original text', () => {
    expect(
      accessRules(
        '-- c\nCREATE TABLE x (id int);\nDROP POLICY "P" ON PUBLIC.NOTES;\nselect 1;'
      )
    ).toEqual([
      {
        text: 'DROP POLICY "P" ON PUBLIC.NOTES',
        key: 'drop policy "p" on public.notes',
      },
    ]);
  });

  it('keys agree with accessRuleStatements', () => {
    expect(accessRules(SEEDED_SQL).map(({ key }) => key)).toEqual(
      accessRuleStatements(SEEDED_SQL)
    );
  });

  it('keeps the literals of a DO block in its text and its key', () => {
    const sql =
      "DO $$ BEGIN EXECUTE format('drop policy %I on public.notes', 'X'); END $$;";
    expect(accessRules(sql)).toEqual([
      {
        text: sql.slice(0, -1),
        key: "do $$ begin execute format('drop policy %i on public.notes', 'x'); end $$",
      },
    ]);
  });
});

describe('accessRuleStatements', () => {
  it.each([
    [
      'a public-qualified create policy',
      'create policy "p" on public.notes for select to authenticated using (true);',
    ],
    [
      'an unqualified table',
      'create policy "p" on notes for select to authenticated using (true);',
    ],
    [
      'a quoted schema and table as db diff writes them',
      'create policy "p" on "public"."notes" for select to authenticated using (true);',
    ],
    [
      'a quoted policy name with spaces on a quoted schema and table',
      `drop policy "${LEAKY_POLICY_NAME}" on "public"."notes";`,
    ],
    [
      'a quoted policy name with spaces and if exists',
      `drop policy if exists "${LEAKY_POLICY_NAME}" on "public"."notes";`,
    ],
    ['whitespace around the dot', 'drop policy "p" on public . notes;'],
    [
      'uppercase keywords and table',
      'CREATE POLICY "P" ON PUBLIC.NOTES FOR SELECT USING (TRUE);',
    ],
    ['alter policy', 'alter policy "p" on public.notes using (false);'],
    ['drop policy', 'drop policy "p" on public.notes;'],
    ['drop policy if exists', 'drop policy if exists "p" on public.notes;'],
    ['an unquoted policy name', 'drop policy enable_read on public.notes;'],
    [
      'a statement spread over several lines',
      'create policy "p"\n  on public.notes\n  for select\n  to authenticated\n  using (true);',
    ],
    [
      'a policy whose using clause holds a semicolon in a literal',
      'create policy "p" on public.notes for select using (title <> \'a;b\');',
    ],
    [
      'a comment between keywords',
      'drop policy /* leak */ "p" on public.notes;',
    ],
    [
      'a preceding line comment',
      '-- close the leak\ndrop policy "p" on public.notes;',
    ],
    [
      'enable row level security',
      'alter table public.notes enable row level security;',
    ],
    [
      'disable row level security',
      'alter table public.notes disable row level security;',
    ],
    [
      'force row level security',
      'alter table public.notes force row level security;',
    ],
    [
      'no force row level security',
      'alter table public.notes no force row level security;',
    ],
    [
      'row level security on an unqualified table',
      'alter table notes enable row level security;',
    ],
    [
      'row level security with if exists and only on quoted names',
      'alter table if exists only "public"."notes" enable row level security;',
    ],
  ])('finds %s', (_label, sql) => {
    const statements = accessRuleStatements(sql);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^(create|alter|drop) (policy|table)\b/);
  });

  it.each([
    [
      'a policy on the look-alike notes_archive',
      'create policy "p" on public.notes_archive for select using (true);',
    ],
    [
      'a policy on the unqualified look-alike notes_archive',
      'drop policy "p" on notes_archive;',
    ],
    [
      'a policy on the quoted look-alike notes_archive',
      'create policy "p" on "public"."notes_archive" for select using (true);',
    ],
    [
      'a policy on notes in another schema',
      'create policy "p" on private.notes for select using (true);',
    ],
    [
      'a policy on quoted notes in another schema',
      'create policy "p" on "private"."notes" for select using (true);',
    ],
    [
      'row level security on notes_archive',
      'alter table public.notes_archive enable row level security;',
    ],
    [
      'row level security on notes in another schema',
      'alter table private.notes enable row level security;',
    ],
    [
      'a column added to notes',
      'alter table public.notes add column pinned boolean default false;',
    ],
    [
      'the create table statement',
      'create table public.notes (id bigint primary key, owner_id uuid);',
    ],
    [
      'an index on notes',
      'create index notes_owner_idx on public.notes (owner_id);',
    ],
    ['a line comment', '-- drop policy "p" on public.notes;'],
    ['a block comment', '/* drop policy "p" on public.notes; */'],
    [
      'a nested block comment',
      '/* outer /* inner */ drop policy "p" on public.notes; */',
    ],
    ['a single-quoted literal', `select 'drop policy "p" on public.notes';`],
    [
      'a comment on the table that quotes a statement',
      `comment on table public.notes is 'create policy "p" on public.notes for select using (true)';`,
    ],
    [
      'an E-string literal holding an escaped quote',
      `select E'it\\'s drop policy "p" on public.notes';`,
    ],
    ['a dollar-quoted body', 'select $$drop policy "p" on public.notes$$;'],
    [
      'a tagged dollar-quoted body',
      'select $body$drop policy "p" on public.notes$body$;',
    ],
    [
      'a quoted policy name that mentions notes, on another table',
      'drop policy "p on public.notes" on public.other;',
    ],
    [
      'a function that mentions a policy on notes',
      'create function policy_notes() returns void language sql as $$ select 1 $$;',
    ],
    [
      'a DO block that only switches row level security, naming no policy',
      'do $$ begin alter table public.notes enable row level security; end $$;',
    ],
    [
      'a DO block that mentions only notes',
      'do $$ begin delete from public.notes; end $$;',
    ],
    [
      'a DO block that mentions only a policy',
      'do $$ begin drop policy "p" on public.other; end $$;',
    ],
    [
      'a DO block that mentions both only in comments',
      'do /* policy on notes */ $$ begin perform 1; end $$ -- policy notes\n;',
    ],
  ])('ignores %s', (_label, sql) => {
    expect(accessRuleStatements(sql)).toEqual([]);
  });

  describe('a DO block', () => {
    it.each([
      [
        'dropping the policy',
        'do $$ begin drop policy "p" on public.notes; end $$;',
      ],
      [
        'with a tag and a language clause',
        'do language plpgsql $do$ begin\n  drop policy if exists "p" on public.notes;\nend $do$;',
      ],
      ['upper-cased', 'DO $$ BEGIN DROP POLICY "P" ON PUBLIC.NOTES; END $$;'],
      [
        'looping over pg_policies with a dynamic drop',
        "do $$ declare p record; begin for p in select policyname from pg_policies where tablename = 'notes' loop execute format('drop policy %I on public.notes', p.policyname); end loop; end $$;",
      ],
      [
        'whose policy and table are named only in a string literal',
        'do $$ begin execute \'drop policy "p" on public.notes\'; end $$;',
      ],
    ])('counts one %s as an access rule', (_label, sql) => {
      const statements = accessRuleStatements(sql);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatch(/^do\b/);
    });

    it('compares by its body, so two DO blocks with different bodies differ', () => {
      const drop = 'do $$ begin drop policy "a" on public.notes; end $$;';
      const other = 'do $$ begin drop policy "b" on public.notes; end $$;';
      expect(accessRuleStatements(drop)).not.toEqual(
        accessRuleStatements(other)
      );
    });

    it('compares equal after formatting and comment changes', () => {
      const a = 'do $$ begin drop policy "a" on public.notes; end $$;';
      const b =
        '-- close it\nDO  $$ begin drop policy "a" on public.notes; end $$ ; /* done */';
      expect(accessRuleStatements(a)).toEqual(accessRuleStatements(b));
    });

    it('keeps its place among the other access rules', () => {
      const sql = [
        'alter table public.notes enable row level security;',
        'do $$ begin drop policy "a" on public.notes; end $$;',
        'create policy "b" on public.notes for select using (true);',
      ].join('\n');
      const statements = accessRuleStatements(sql);
      expect(statements).toHaveLength(3);
      expect(statements[1]).toMatch(/^do\b/);
    });
  });

  it('finds the access rules among other statements and keeps their order', () => {
    const sql = [
      'create table public.notes (id bigint primary key);',
      'alter table public.notes enable row level security;',
      'create policy "a" on public.notes for select using (true);',
      'create index notes_idx on public.notes (id);',
      'drop policy "a" on public.notes;',
    ].join('\n');
    const statements = accessRuleStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/^alter table\b.*row level security/);
    expect(statements[1]).toMatch(/^create policy "a"/);
    expect(statements[2]).toMatch(/^drop policy "a"/);
  });

  it('reads the seeded migration as the row level security statement then its five policies in order', () => {
    const statements = accessRuleStatements(SEEDED_SQL);
    expect(statements).toHaveLength(6);
    expect(statements[0]).toMatch(/^alter table\b.*row level security/);
    policyNames.forEach((name, i) => {
      expect(statements[i + 1]).toMatch(/^create policy\b/);
      expect(statements[i + 1]).toContain(name);
    });
  });

  it.each([
    ['whitespace squashed', SEEDED_SQL.replace(/\s+/g, ' ')],
    [
      'keywords upper-cased',
      SEEDED_SQL.replace(
        /\b(create|policy|on|for|to|using|alter|table|enable|row|level|security)\b/g,
        (word) => word.toUpperCase()
      ),
    ],
    [
      'comments added',
      `-- tightened\n${SEEDED_SQL.replace('create policy', '/* p */ create policy')}`,
    ],
    ['windows line endings', SEEDED_SQL.replace(/\n/g, '\r\n')],
    [
      'an unrelated statement added',
      `${SEEDED_SQL}\nalter table public.notes add column pinned boolean;\n`,
    ],
  ])('compares equal to the seed after %s', (_label, sql) => {
    expect(accessRuleStatements(sql)).toEqual(accessRuleStatements(SEEDED_SQL));
  });

  it.each([
    ['the leaky policy removed', SEEDED_WITHOUT_LEAK],
    [
      'using (true) turned into using (false)',
      SEEDED_SQL.replace('using (true)', 'using (false)'),
    ],
    [
      'row level security disabled',
      SEEDED_SQL.replace(
        'enable row level security',
        'disable row level security'
      ),
    ],
    [
      'a policy renamed',
      SEEDED_SQL.replace(
        'Users can view their own notes',
        'Owners can view their notes'
      ),
    ],
    ['a drop policy appended', `${SEEDED_SQL}\n${DROP_LEAK}`],
  ])('differs from the seed with %s', (_label, sql) => {
    expect(accessRuleStatements(sql)).not.toEqual(
      accessRuleStatements(SEEDED_SQL)
    );
  });

  it('keeps statement order significant', () => {
    const drop = 'drop policy "p" on public.notes;';
    const create = 'create policy "p" on public.notes for select using (true);';
    expect(accessRuleStatements(`${drop}\n${create}`)).not.toEqual(
      accessRuleStatements(`${create}\n${drop}`)
    );
  });
});

describe('findPolicyMigrations', () => {
  function fakeProject(
    files: Record<string, string> | null,
    options: { throws?: string; unreadable?: string[] } = {}
  ) {
    const exec = vi.fn(async (command: string): Promise<CommandResult> => {
      if (options.throws !== undefined) throw new Error(options.throws);
      const cat = command.match(
        /^cat\s+'?supabase\/migrations\/([^'\s]+)'?\s*$/
      );
      if (cat) {
        const name = cat[1];
        if (
          files === null ||
          !(name in files) ||
          options.unreadable?.includes(name)
        ) {
          return result('', false, `cat: ${name}: No such file or directory`);
        }
        return result(files[name]);
      }
      if (command.includes('supabase/migrations')) {
        if (files === null) {
          return result(
            '',
            false,
            "ls: cannot access 'supabase/migrations': No such file or directory"
          );
        }
        const names = Object.keys(files).sort();
        return command.includes('find ')
          ? result(
              names.map((name) => `supabase/migrations/${name}`).join('\n')
            )
          : result(names.join('\n'));
      }
      return result('', false, `unexpected command: ${command}`);
    });
    return { exec };
  }

  const scan = (files: Record<string, string> | null, options = {}) =>
    findPolicyMigrations(fakeProject(files, options));

  it('does not count the untouched seeded migration', async () => {
    expect(await scan({ [SEEDED_MIGRATION_FILE]: SEEDED_SQL })).toEqual({
      ok: true,
      migrations: [],
      misordered: [],
    });
  });

  it('marks the seeded migration missing and counts a later file that holds every policy, as after a squash', async () => {
    expect(await scan({ [FIX_FILE]: `${SEEDED_SQL}\n${DROP_LEAK}` })).toEqual({
      ok: true,
      migrations: [FIX],
      misordered: [],
      seededMissing: true,
    });
  });

  it('does not mark the seeded migration missing when its file is there', async () => {
    const probe = await scan({ [SEEDED_MIGRATION_FILE]: SEEDED_SQL });
    expect(probe).not.toHaveProperty('seededMissing');
    expect(probe).not.toHaveProperty('notesNeverCreated');
  });

  it('finds nothing to count, and marks the seeded migration missing and notes never created, when no policy file is left', async () => {
    expect(await scan({})).toEqual({
      ok: true,
      migrations: [],
      misordered: [],
      seededMissing: true,
      notesNeverCreated: true,
    });
  });

  it('marks notes never created when the seeded file is gone and only a policies-only migration is left', async () => {
    expect(await scan({ [FIX_FILE]: DROP_LEAK })).toEqual({
      ok: true,
      migrations: [FIX],
      misordered: [],
      seededMissing: true,
      notesNeverCreated: true,
    });
  });

  it('marks notes never created when the only create table for it sits in a comment or a literal', async () => {
    const probe = await scan({
      [FIX_FILE]: `-- create table public.notes (id uuid);\nselect 'create table public.notes (id uuid)';\n${DROP_LEAK}`,
    });
    expect(probe).toMatchObject({
      seededMissing: true,
      notesNeverCreated: true,
    });
  });

  it('does not mark notes never created when a later file other than the seeded one creates it', async () => {
    const probe = await scan({
      [FIX_FILE]: DROP_LEAK,
      '20260101000500_create_notes_again.sql':
        'create table if not exists public.notes (id uuid primary key);\n',
    });
    expect(probe).toMatchObject({ seededMissing: true });
    expect(probe).not.toHaveProperty('notesNeverCreated');
  });

  it('counts a new migration that drops the leaky policy', async () => {
    expect(
      await scan({ [SEEDED_MIGRATION_FILE]: SEEDED_SQL, [FIX_FILE]: DROP_LEAK })
    ).toEqual({ ok: true, migrations: [FIX], misordered: [] });
  });

  it.each([
    ['drop policy', DROP_LEAK],
    [
      'drop policy if exists',
      `drop policy if exists "${LEAKY_POLICY_NAME}" on public.notes;`,
    ],
    ['quoted names', `drop policy "${LEAKY_POLICY_NAME}" on "public"."notes";`],
    ['uppercase', `DROP POLICY "${LEAKY_POLICY_NAME}" ON PUBLIC.NOTES;`],
    ['alter policy', SECOND_SQL],
    [
      'create policy',
      'create policy "Only owners" on public.notes as restrictive for select using (owner_id = auth.uid());',
    ],
    [
      'row level security',
      'alter table public.notes force row level security;',
    ],
    ['a transaction around the drop', `begin;\n${DROP_LEAK}commit;`],
    ['a DO block that drops the policy', `do $$ begin ${DROP_LEAK} end $$;`],
    [
      'a DO block that drops every notes policy dynamically',
      "do $$ declare p record; begin for p in select policyname from pg_policies where tablename = 'notes' loop execute format('drop policy %I on public.notes', p.policyname); end loop; end $$;",
    ],
  ])('counts a new migration with %s', async (_label, sql) => {
    const probe = await scan({
      [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
      [FIX_FILE]: sql,
    });
    expect(probe).toMatchObject({
      ok: true,
      migrations: [FIX],
      misordered: [],
    });
  });

  it.each([
    [
      'a column added to notes',
      'alter table public.notes add column pinned boolean default false;',
    ],
    ['a policy on notes_archive', 'drop policy "p" on public.notes_archive;'],
    [
      'a policy on notes in another schema',
      'drop policy "p" on private.notes;',
    ],
    ['a commented-out drop policy', `-- ${DROP_LEAK}`],
    ['a drop policy inside a string literal', `select '${DROP_LEAK.trim()}';`],
    [
      'a drop policy inside a dollar-quoted function body',
      `create function f() returns void language plpgsql as $$ begin ${DROP_LEAK} end $$;`,
    ],
    ['no statements', ''],
  ])('does not count a new migration with %s', async (_label, sql) => {
    expect(
      await scan({ [SEEDED_MIGRATION_FILE]: SEEDED_SQL, [FIX_FILE]: sql })
    ).toEqual({ ok: true, migrations: [], misordered: [] });
  });

  it.each([
    ['the leaky policy removed', SEEDED_WITHOUT_LEAK],
    [
      'using (true) turned into using (false)',
      SEEDED_SQL.replace('using (true)', 'using (false)'),
    ],
    [
      'row level security switched off',
      SEEDED_SQL.replace(
        'enable row level security',
        'disable row level security'
      ),
    ],
  ])('counts the seeded migration edited with %s', async (_label, edited) => {
    expect(await scan({ [SEEDED_MIGRATION_FILE]: edited })).toEqual({
      ok: true,
      migrations: [SEEDED],
      misordered: [],
    });
  });

  it.each([
    ['whitespace only', SEEDED_SQL.replace(/\s+/g, ' ')],
    ['a comment only', `-- reviewed\n${SEEDED_SQL}`],
    [
      'the table definition only',
      SEEDED_SQL.replace(
        "body text not null default ''",
        "body text not null default '', pinned boolean not null default false"
      ),
    ],
    [
      'keyword case only',
      SEEDED_SQL.replace(/create policy/g, 'CREATE POLICY'),
    ],
  ])(
    'does not count the seeded migration edited with %s',
    async (_label, edited) => {
      expect(await scan({ [SEEDED_MIGRATION_FILE]: edited })).toEqual({
        ok: true,
        migrations: [],
        misordered: [],
      });
    }
  );

  it('lists the edited seeded migration before the new ones, in version order', async () => {
    const probe = await scan({
      [SEEDED_MIGRATION_FILE]: SEEDED_WITHOUT_LEAK,
      [FIX_FILE]: DROP_LEAK,
      [SECOND_FILE]: SECOND_SQL,
    });
    expect(probe).toEqual({
      ok: true,
      migrations: [SEEDED, FIX, SECOND],
      misordered: [],
    });
  });

  it.each([
    ['a version before the seeded one', MISORDERED_FILE],
    ['a short numeric version', '0001_fix.sql'],
    [
      'the seeded version under another name',
      '20260101000000_fix_notes_policy.sql',
    ],
  ])('puts a touching file with %s in misordered', async (_label, file) => {
    const probe = await scan({
      [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
      [file]: DROP_LEAK,
    });
    expect(probe).toMatchObject({ ok: true, misordered: [file] });
  });

  it('reports a misordered file next to a good one without losing the good one', async () => {
    const probe = await scan({
      [MISORDERED_FILE]: DROP_LEAK,
      [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
      [FIX_FILE]: DROP_LEAK,
    });
    expect(probe).toMatchObject({ ok: true, misordered: [MISORDERED_FILE] });
    expect(probe.ok ? probe.migrations : []).toEqual(
      expect.arrayContaining([FIX])
    );
  });

  it('does not report a version-before-seeded file that touches no notes policy', async () => {
    expect(
      await scan({
        [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
        [MISORDERED_FILE]: 'select 1;',
      })
    ).toEqual({ ok: true, migrations: [], misordered: [] });
  });

  it.each([
    'README.md',
    'notes_fix.sql',
    '20260102000000.sql',
    '20260102000000_fix.sql.bak',
    '.gitkeep',
  ])('ignores %s, which is not <digits>_<name>.sql', async (file) => {
    expect(
      await scan({
        [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
        [file]: DROP_LEAK,
      })
    ).toEqual({ ok: true, migrations: [], misordered: [] });
  });

  it('reports a missing migrations directory instead of an empty result', async () => {
    const probe = await scan(null);
    expect(probe).toEqual({ ok: false, notes: expect.any(String) });
    expect(probe.ok ? '' : probe.notes).toContain('supabase/migrations');
  });

  it('reports a thrown exec instead of rejecting', async () => {
    const probe = await scan(
      { [SEEDED_MIGRATION_FILE]: SEEDED_SQL },
      { throws: 'sandbox gone' }
    );
    expect(probe).toEqual({
      ok: false,
      notes: expect.stringContaining('sandbox gone'),
    });
  });
});

describe('readRecordedPolicyMigrations', () => {
  const found = (
    migrations: PolicyMigration[],
    misordered: string[] = []
  ): PolicyMigrationsProbe => ({ ok: true, migrations, misordered });

  type History = {
    versions?: string[];
    files?: Record<string, string>;
    statements?: Record<string, string>;
    stdout?: string;
    psql?: CommandResult;
    unreadable?: string[];
    throws?: string;
  };

  function fakeHistory(history: History = {}) {
    const files = history.files ?? {
      [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
      [FIX_FILE]: DROP_LEAK,
      [SECOND_FILE]: SECOND_SQL,
    };
    const versions = history.versions ?? [
      SEEDED_MIGRATION_VERSION,
      FIX_VERSION,
      SECOND_VERSION,
    ];
    const exec = vi.fn(async (command: string): Promise<CommandResult> => {
      if (history.throws !== undefined) throw new Error(history.throws);
      const cat = command.match(
        /^cat\s+'?supabase\/migrations\/([^'\s]+)'?\s*$/
      );
      if (cat) {
        return history.unreadable?.includes(cat[1]) || !(cat[1] in files)
          ? result('', false, `cat: ${cat[1]}: No such file or directory`)
          : result(files[cat[1]]);
      }
      if (/\bpsql\b/.test(command) && command.includes('schema_migrations')) {
        if (!command.includes(DB_URL)) {
          return result('', false, 'psql: error: connection refused');
        }
        if (history.psql) return history.psql;
        if (history.stdout !== undefined) return result(history.stdout);
        const asked = [...command.matchAll(/'(\d+)'/g)].map((m) => m[1]);
        const rows = versions
          .filter((version) => asked.includes(version))
          .map((version) => {
            const name = Object.keys(files).find((file) =>
              file.startsWith(`${version}_`)
            );
            const statements =
              history.statements?.[version] ??
              (name === undefined ? '' : files[name]);
            return `${version}|${hex(statements)}`;
          });
        return result(rows.length > 0 ? `${rows.join('\n')}\n` : '');
      }
      return result('', false, `unexpected command: ${command}`);
    });
    return { exec };
  }

  const psqlCalls = (ctx: ReturnType<typeof fakeHistory>) =>
    ctx.exec.mock.calls
      .map(([command]) => command)
      .filter((command) => /\bpsql\b/.test(command));

  it('records a migration whose history statements hold the same access rules as the file', async () => {
    const ctx = fakeHistory();
    expect(
      await readRecordedPolicyMigrations(ctx, STACK, found([FIX]))
    ).toEqual({
      ok: true,
      recorded: [FIX],
      missing: [],
      mismatched: [],
    });
  });

  it('asks the stack database about exactly the contributing versions', async () => {
    const ctx = fakeHistory();
    await readRecordedPolicyMigrations(ctx, STACK, found([FIX, SECOND]));
    const commands = psqlCalls(ctx).join('\n');
    expect(commands).toContain(`'${DB_URL}'`);
    expect(commands).toContain('supabase_migrations.schema_migrations');
    expect(commands).toContain(FIX_VERSION);
    expect(commands).toContain(SECOND_VERSION);
    expect(commands).not.toContain(SEEDED_MIGRATION_VERSION);
  });

  it('records a migration whose history statements differ only in formatting and comments', async () => {
    const ctx = fakeHistory({
      statements: {
        [FIX_VERSION]: `-- close the leak\nDROP POLICY\n  "${LEAKY_POLICY_NAME}"\n  ON public.notes`,
      },
    });
    expect(
      await readRecordedPolicyMigrations(ctx, STACK, found([FIX]))
    ).toMatchObject({
      recorded: [FIX],
      mismatched: [],
    });
  });

  it('compares access rules only, so statements the file adds beyond them do not mismatch', async () => {
    const ctx = fakeHistory({
      files: {
        [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
        [FIX_FILE]: `${DROP_LEAK}alter table public.notes add column pinned boolean;\n`,
      },
      statements: { [FIX_VERSION]: DROP_LEAK.replace(';\n', '') },
    });
    expect(
      await readRecordedPolicyMigrations(ctx, STACK, found([FIX]))
    ).toMatchObject({
      recorded: [FIX],
      mismatched: [],
    });
  });

  it('marks a contributing migration that is not in the history as missing', async () => {
    const ctx = fakeHistory({ versions: [SEEDED_MIGRATION_VERSION] });
    expect(
      await readRecordedPolicyMigrations(ctx, STACK, found([FIX]))
    ).toEqual({
      ok: true,
      recorded: [],
      missing: [FIX],
      mismatched: [],
    });
  });

  it.each([
    ['empty statements, as migration repair records them', ''],
    [
      'a different policy being dropped',
      'drop policy "Something else" on public.notes',
    ],
    [
      'a different table',
      `drop policy "${LEAKY_POLICY_NAME}" on public.notes_archive`,
    ],
  ])(
    'marks a migration recorded with %s as mismatched',
    async (_label, statements) => {
      const ctx = fakeHistory({ statements: { [FIX_VERSION]: statements } });
      expect(
        await readRecordedPolicyMigrations(ctx, STACK, found([FIX]))
      ).toEqual({
        ok: true,
        recorded: [],
        missing: [],
        mismatched: [FIX],
      });
    }
  );

  it('marks a file edited after it was applied as mismatched', async () => {
    const ctx = fakeHistory({
      files: {
        [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
        [FIX_FILE]: `${DROP_LEAK}drop policy "Users can view their own notes" on public.notes;\n`,
      },
      statements: { [FIX_VERSION]: DROP_LEAK },
    });
    expect(
      await readRecordedPolicyMigrations(ctx, STACK, found([FIX]))
    ).toMatchObject({
      recorded: [],
      mismatched: [FIX],
    });
  });

  describe('a DO block migration', () => {
    const doDrop = `do $$ begin drop policy "${LEAKY_POLICY_NAME}" on public.notes; end $$;\n`;
    const doDropOther = doDrop.replace(LEAKY_POLICY_NAME, 'Something else');
    const files = { [SEEDED_MIGRATION_FILE]: SEEDED_SQL, [FIX_FILE]: doDrop };

    it('records when the history holds the same body, whatever the formatting and comments', async () => {
      const ctx = fakeHistory({
        files,
        statements: {
          [FIX_VERSION]: `-- close it\nDO $$ begin drop policy "${LEAKY_POLICY_NAME}" on public.notes; end $$`,
        },
      });
      expect(
        await readRecordedPolicyMigrations(ctx, STACK, found([FIX]))
      ).toMatchObject({ recorded: [FIX], mismatched: [] });
    });

    it('marks a DO block recorded with a different body as mismatched, not equal because both mask to the same text', async () => {
      const ctx = fakeHistory({
        files,
        statements: { [FIX_VERSION]: doDropOther },
      });
      expect(
        await readRecordedPolicyMigrations(ctx, STACK, found([FIX]))
      ).toMatchObject({ recorded: [], mismatched: [FIX] });
    });
  });

  it('records the edited seeded migration when the history holds the edited statements, as after a reset', async () => {
    const ctx = fakeHistory({
      files: { [SEEDED_MIGRATION_FILE]: SEEDED_WITHOUT_LEAK },
    });
    expect(
      await readRecordedPolicyMigrations(ctx, STACK, found([SEEDED]))
    ).toEqual({
      ok: true,
      recorded: [SEEDED],
      missing: [],
      mismatched: [],
    });
  });

  it('marks the edited seeded migration as mismatched when the history still holds the original statements', async () => {
    const ctx = fakeHistory({
      files: { [SEEDED_MIGRATION_FILE]: SEEDED_WITHOUT_LEAK },
      statements: { [SEEDED_MIGRATION_VERSION]: SEEDED_SQL },
    });
    expect(
      await readRecordedPolicyMigrations(ctx, STACK, found([SEEDED]))
    ).toEqual({
      ok: true,
      recorded: [],
      missing: [],
      mismatched: [SEEDED],
    });
  });

  it('splits several contributing migrations into recorded, missing and mismatched', async () => {
    const ctx = fakeHistory({
      files: {
        [SEEDED_MIGRATION_FILE]: SEEDED_WITHOUT_LEAK,
        [FIX_FILE]: DROP_LEAK,
        [SECOND_FILE]: SECOND_SQL,
      },
      versions: [SEEDED_MIGRATION_VERSION, SECOND_VERSION],
      statements: { [SECOND_VERSION]: '' },
    });
    expect(
      await readRecordedPolicyMigrations(
        ctx,
        STACK,
        found([SEEDED, FIX, SECOND])
      )
    ).toEqual({
      ok: true,
      recorded: [SEEDED],
      missing: [FIX],
      mismatched: [SECOND],
    });
  });

  it('compares whole versions, not substrings of longer rows', async () => {
    const ctx = fakeHistory({
      stdout: `1${FIX_VERSION}|${hex(DROP_LEAK)}\n`,
    });
    expect(
      await readRecordedPolicyMigrations(ctx, STACK, found([FIX]))
    ).toMatchObject({
      ok: true,
      recorded: [],
      missing: [FIX],
    });
  });

  it('finds the version among several returned rows and blank lines', async () => {
    const ctx = fakeHistory({
      stdout: `${SECOND_VERSION}|${hex(SECOND_SQL)}\n\n${FIX_VERSION}|${hex(DROP_LEAK)}\n`,
    });
    expect(
      await readRecordedPolicyMigrations(ctx, STACK, found([FIX]))
    ).toMatchObject({
      recorded: [FIX],
    });
  });

  it('reports the stack failure without querying when the stack did not resolve', async () => {
    const ctx = fakeHistory();
    const probe = await readRecordedPolicyMigrations(
      ctx,
      { ok: false, notes: 'managed: exit 1: no stack running' },
      found([FIX])
    );
    expect(probe).toEqual({
      ok: false,
      notes: expect.stringContaining('no stack running'),
    });
    expect(ctx.exec).not.toHaveBeenCalled();
  });

  it('reports the migration scan failure without querying', async () => {
    const ctx = fakeHistory();
    const probe = await readRecordedPolicyMigrations(ctx, STACK, {
      ok: false,
      notes: 'supabase/migrations does not exist',
    });
    expect(probe).toEqual({
      ok: false,
      notes: expect.stringContaining('supabase/migrations does not exist'),
    });
    expect(ctx.exec).not.toHaveBeenCalled();
  });

  it('reports a failing psql, even if it printed a row', async () => {
    const ctx = fakeHistory({
      psql: result(
        `${FIX_VERSION}|${hex(DROP_LEAK)}\n`,
        false,
        'psql: error: connection refused'
      ),
    });
    const probe = await readRecordedPolicyMigrations(ctx, STACK, found([FIX]));
    expect(probe.ok).toBe(false);
    expect(probe.ok ? '' : probe.notes).toContain('connection refused');
  });

  it.each(['not a history row', `${FIX_VERSION}|zz`, `${FIX_VERSION}`])(
    'fails loudly on the unrecognised history row %j',
    async (stdout) => {
      const ctx = fakeHistory({ stdout });
      const probe = await readRecordedPolicyMigrations(
        ctx,
        STACK,
        found([FIX])
      );
      expect(probe.ok).toBe(false);
      expect(probe.ok ? '' : probe.notes).toContain(stdout);
    }
  );

  it('reports a migration file it cannot read', async () => {
    const ctx = fakeHistory({ unreadable: [FIX_FILE] });
    const probe = await readRecordedPolicyMigrations(ctx, STACK, found([FIX]));
    expect(probe.ok).toBe(false);
  });

  it('reports a thrown exec instead of rejecting', async () => {
    const ctx = fakeHistory({ throws: 'sandbox gone' });
    expect(
      await readRecordedPolicyMigrations(ctx, STACK, found([FIX]))
    ).toEqual({
      ok: false,
      notes: expect.stringContaining('sandbox gone'),
    });
  });
});

describe('buildReplayProbeSql', () => {
  const statements = [
    'alter table public.notes enable row level security',
    'DROP POLICY "p" ON public.notes',
  ];
  const sql = buildReplayProbeSql(statements);

  it('runs in one transaction that is rolled back and never committed', () => {
    expect(sql.trim()).toMatch(/^begin;/i);
    expect(sql.trim()).toMatch(/rollback;$/i);
    expect(sql).not.toMatch(/\bcommit\b/i);
  });

  it('clears the notes policies and row level security before replaying anything', () => {
    const drop = sql.indexOf(DROP_NOTES_POLICIES_SQL);
    const disable = sql.indexOf(
      'alter table public.notes disable row level security;'
    );
    const noForce = sql.indexOf(
      'alter table public.notes no force row level security;'
    );
    const first = sql.indexOf(`${statements[0]};`);
    expect(drop).toBeGreaterThan(0);
    expect(disable).toBeGreaterThan(drop);
    expect(noForce).toBeGreaterThan(disable);
    expect(first).toBeGreaterThan(noForce);
  });

  it('replays every statement in order, each terminated with a semicolon', () => {
    expect(sql).toContain(`${statements[0]};\n${statements[1]};\n`);
  });

  it('runs the access probe body after the replayed statements, inside the same transaction', () => {
    const body = buildAccessProbeBody();
    expect(sql).toContain(body);
    expect(sql.indexOf(body)).toBeGreaterThan(sql.indexOf(`${statements[1]};`));
    expect(sql.indexOf(body) + body.length).toBeLessThan(
      sql.lastIndexOf('rollback;')
    );
  });
});

describe('readReplayedNotesAccess', () => {
  const found = (
    migrations: PolicyMigration[],
    misordered: string[] = [],
    seededMissing = false
  ): PolicyMigrationsProbe => ({
    ok: true,
    migrations,
    misordered,
    ...(seededMissing ? { seededMissing: true as const } : {}),
  });
  const recorded = (
    parts: Partial<Extract<RecordedPolicyMigrationsProbe, { ok: true }>> = {}
  ): RecordedPolicyMigrationsProbe => ({
    ok: true,
    recorded: [],
    missing: [],
    mismatched: [],
    ...parts,
  });

  const FIXED_ROWS = `${'\n'.repeat(8)}read.anon|titles:
read.other|titles:eval-probe-other-1
read.owner|titles:eval-probe-owner-1,eval-probe-owner-2
write.otherDelete|rows:0
write.otherInsertAsOwner|denied:42501
write.otherUpdate|rows:0
write.ownerInsert|rows:1
write.ownerUpdate|rows:1
`;

  function fakeReplay(
    options: {
      files?: Record<string, string>;
      unreadable?: string[];
      psql?: CommandResult;
      throws?: string;
    } = {}
  ) {
    const files = options.files ?? {
      [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
      [FIX_FILE]: DROP_LEAK,
    };
    const scripts: string[] = [];
    const exec = vi.fn(async (command: string): Promise<CommandResult> => {
      if (options.throws !== undefined) throw new Error(options.throws);
      const cat = command.match(
        /^cat\s+'?supabase\/migrations\/([^'\s]+)'?\s*$/
      );
      if (cat) {
        return options.unreadable?.includes(cat[1]) || !(cat[1] in files)
          ? result('', false, `cat: ${cat[1]}: No such file or directory`)
          : result(files[cat[1]]);
      }
      if (/\bpsql\b/.test(command)) {
        const payload = /printf %s '([A-Za-z0-9+/]+={0,2})'/.exec(command)?.[1];
        scripts.push(
          payload === undefined
            ? command
            : Buffer.from(payload, 'base64').toString('utf8')
        );
        if (!command.includes(DB_URL)) {
          return result('', false, 'psql: error: connection refused');
        }
        return options.psql ?? result(FIXED_ROWS);
      }
      return result('', false, `unexpected command: ${command}`);
    });
    return { exec, scripts };
  }

  const replay = (
    ctx: ReturnType<typeof fakeReplay>,
    probe = found([FIX]),
    history = recorded({ recorded: [FIX] })
  ) => readReplayedNotesAccess(ctx, STACK, probe, history);

  it('runs the replay in one psql session as the stack database user, stopping on error', async () => {
    const ctx = fakeReplay();
    await replay(ctx);
    const psqlCalls = ctx.exec.mock.calls
      .map(([command]) => command)
      .filter((command) => /\bpsql\b/.test(command));
    expect(psqlCalls).toHaveLength(1);
    expect(psqlCalls[0]).toContain(`'${DB_URL}'`);
    expect(psqlCalls[0]).toContain('-v ON_ERROR_STOP=1');
    expect(psqlCalls[0]).toMatch(/-f -(\s|$)/);
    expect(ctx.scripts[0]).toContain(DROP_NOTES_POLICIES_SQL);
  });

  it('returns the parsed outcomes of the replay', async () => {
    expect(await replay(fakeReplay())).toEqual(FIXED_ACCESS);
  });

  it("replays the seeded file's access rules first, even when the seeded file is unchanged, then the contributors", async () => {
    const ctx = fakeReplay({
      files: {
        [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
        [FIX_FILE]: DROP_LEAK,
        [SECOND_FILE]: SECOND_SQL,
      },
    });
    await replay(
      ctx,
      found([FIX, SECOND]),
      recorded({ recorded: [FIX, SECOND] })
    );
    const [script] = ctx.scripts;
    const at = (text: string) => script.indexOf(`${text};`);
    const seededRules = accessRules(SEEDED_SQL).map(({ text }) => text);
    expect(seededRules).toHaveLength(6);
    const positions = [
      ...seededRules,
      DROP_LEAK.trim().replace(/;$/, ''),
      SECOND_SQL.trim().replace(/;$/, ''),
    ].map(at);
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("replays the edited seeded file's current content, not the original", async () => {
    const ctx = fakeReplay({
      files: { [SEEDED_MIGRATION_FILE]: SEEDED_WITHOUT_LEAK },
    });
    await replay(ctx, found([SEEDED]), recorded({ recorded: [SEEDED] }));
    expect(ctx.scripts[0]).toContain(
      'create policy "Users can view their own notes"'
    );
    expect(ctx.scripts[0]).not.toContain(
      `create policy "${LEAKY_POLICY_NAME}"`
    );
  });

  it('replays only the access rule statements, in their original text', async () => {
    const ctx = fakeReplay({
      files: {
        [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
        [FIX_FILE]: `-- close the leak\nalter table public.notes add column pinned boolean;\nDROP POLICY  "${LEAKY_POLICY_NAME}"\n  ON PUBLIC.NOTES; -- done\nselect 1;\n`,
      },
    });
    await replay(ctx);
    expect(ctx.scripts[0]).toContain(
      `DROP POLICY  "${LEAKY_POLICY_NAME}"\n  ON PUBLIC.NOTES;`
    );
    expect(ctx.scripts[0]).not.toContain('add column pinned');
    expect(ctx.scripts[0]).not.toContain('close the leak');
  });

  it('replays a DO block with its body, as one statement', async () => {
    const doDrop = `do $$ begin drop policy "${LEAKY_POLICY_NAME}" on public.notes; end $$;\n`;
    const ctx = fakeReplay({
      files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL, [FIX_FILE]: doDrop },
    });
    await replay(ctx);
    expect(ctx.scripts[0]).toContain(`${doDrop.trim()}\n`);
  });

  describe('when the seeded migration file is gone', () => {
    const SQUASHED = `${SEEDED_SQL}\n${DROP_LEAK}`;

    it('does not read the seeded file and replays the contributors only', async () => {
      const ctx = fakeReplay({ files: { [FIX_FILE]: SQUASHED } });
      const outcome = await replay(
        ctx,
        found([FIX], [], true),
        recorded({ recorded: [FIX] })
      );
      expect(outcome).toEqual(FIXED_ACCESS);
      const cats = ctx.exec.mock.calls
        .map(([command]) => command)
        .filter((command) => command.startsWith('cat '));
      expect(cats).toHaveLength(1);
      expect(cats[0]).toContain(FIX_FILE);
      const seededRules = accessRules(SEEDED_SQL).map(({ text }) => text);
      const script = ctx.scripts[0];
      expect(script.split(`${seededRules[0]};`)).toHaveLength(2);
      expect(script).toContain(`${DROP_LEAK.trim().replace(/;$/, '')};`);
    });

    it('replays no seeded rules when the contributors hold none of their own', async () => {
      const ctx = fakeReplay({ files: { [FIX_FILE]: DROP_LEAK } });
      await replay(ctx, found([FIX], [], true), recorded({ recorded: [FIX] }));
      expect(ctx.scripts[0]).not.toContain('create policy');
    });

    it('still replays the seeded file first when it is there', async () => {
      const ctx = fakeReplay();
      await replay(ctx);
      expect(ctx.scripts[0]).toContain('create policy');
    });

    it('does not replay when no migration creates notes, since a reset could not rebuild the table', async () => {
      const ctx = fakeReplay({ files: { [FIX_FILE]: SQUASHED } });
      const probe: PolicyMigrationsProbe = {
        ...found([FIX], [], true),
        notesNeverCreated: true,
      };
      expect(await replay(ctx, probe, recorded({ recorded: [FIX] }))).toEqual({
        ok: false,
        notes: expect.stringContaining('not replayed'),
      });
      expect(ctx.exec).not.toHaveBeenCalled();
    });

    it('still needs a recorded contributor, so a seeded file that is gone and nothing else does not replay', async () => {
      const ctx = fakeReplay({ files: {} });
      expect(await replay(ctx, found([], [], true), recorded())).toEqual({
        ok: false,
        notes: expect.stringContaining('not replayed'),
      });
      expect(ctx.exec).not.toHaveBeenCalled();
    });
  });

  it('reads each migration file once through cat', async () => {
    const ctx = fakeReplay();
    await replay(ctx);
    const cats = ctx.exec.mock.calls
      .map(([command]) => command)
      .filter((command) => command.startsWith('cat '));
    expect(cats).toHaveLength(2);
    expect(cats.join('\n')).toContain(SEEDED_MIGRATION_FILE);
    expect(cats.join('\n')).toContain(FIX_FILE);
  });

  it.each([
    [
      'a contributor missing from the history',
      found([FIX]),
      recorded({ missing: [FIX] }),
    ],
    [
      'a contributor recorded with other statements',
      found([FIX]),
      recorded({ mismatched: [FIX] }),
    ],
    [
      'a file that sorts before the seeded one',
      found([FIX], [MISORDERED_FILE]),
      recorded({ recorded: [FIX] }),
    ],
    ['no contributor at all', found([]), recorded()],
    [
      'a history that could not be read',
      found([FIX]),
      { ok: false as const, notes: 'no stack' },
    ],
    [
      'migration files that could not be read',
      { ok: false as const, notes: 'no dir' },
      recorded(),
    ],
  ])('does not replay with %s', async (_label, probe, history) => {
    const ctx = fakeReplay();
    const outcome = await replay(ctx, probe, history);
    expect(outcome).toEqual({
      ok: false,
      notes: expect.stringContaining('not replayed'),
    });
    expect(ctx.exec).not.toHaveBeenCalled();
  });

  it('reports the stack failure without running anything when the stack did not resolve', async () => {
    const ctx = fakeReplay();
    const outcome = await readReplayedNotesAccess(
      ctx,
      { ok: false, notes: 'managed: exit 1: no stack running' },
      found([FIX]),
      recorded({ recorded: [FIX] })
    );
    expect(outcome).toEqual({
      ok: false,
      notes: expect.stringContaining('no stack running'),
    });
    expect(ctx.exec).not.toHaveBeenCalled();
  });

  it('reports the psql error when a replayed statement fails, even if rows were printed', async () => {
    const ctx = fakeReplay({
      psql: result(
        FIXED_ROWS,
        false,
        'psql:<stdin>:31: ERROR:  policy "x" for table "notes" does not exist'
      ),
    });
    const outcome = await replay(ctx);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.notes).toContain(
      'policy "x" for table "notes" does not exist'
    );
  });

  it('reports unreadable probe output instead of reading it as an outcome', async () => {
    const outcome = await replay(
      fakeReplay({ psql: result('something else entirely') })
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.notes).toContain(
      'something else entirely'
    );
  });

  it('reports a migration file it cannot read', async () => {
    const outcome = await replay(fakeReplay({ unreadable: [FIX_FILE] }));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.notes).toContain(FIX_FILE);
  });

  it('reports a thrown exec instead of rejecting', async () => {
    expect(await replay(fakeReplay({ throws: 'sandbox gone' }))).toEqual({
      ok: false,
      notes: expect.stringContaining('sandbox gone'),
    });
  });
});

describe('checkFixInAppliedMigration', () => {
  const found = (
    migrations: PolicyMigration[],
    misordered: string[] = [],
    flags: { seededMissing?: true; notesNeverCreated?: true } = {}
  ): PolicyMigrationsProbe => ({
    ok: true,
    migrations,
    misordered,
    ...flags,
  });
  const recorded = (
    parts: Partial<Extract<RecordedPolicyMigrationsProbe, { ok: true }>> = {}
  ): RecordedPolicyMigrationsProbe => ({
    ok: true,
    recorded: [],
    missing: [],
    mismatched: [],
    ...parts,
  });

  it('passes a new migration that is recorded with its statements and replays to the fixed behaviour', () => {
    const check = checkFixInAppliedMigration(
      found([FIX]),
      recorded({ recorded: [FIX] }),
      FIXED_ACCESS
    );
    expect(check).toMatchObject({ name: MIGRATION_CHECK_NAME, passed: true });
    expect(check.notes).toContain(FIX_VERSION);
    expect(check.notes).toMatch(/replay/i);
  });

  it('passes the edited seeded migration recorded with the edited statements, as after a reset', () => {
    expect(
      checkFixInAppliedMigration(
        found([SEEDED]),
        recorded({ recorded: [SEEDED] }),
        FIXED_ACCESS
      ).passed
    ).toBe(true);
  });

  it('passes when every contributing migration is recorded', () => {
    expect(
      checkFixInAppliedMigration(
        found([SEEDED, FIX]),
        recorded({ recorded: [SEEDED, FIX] }),
        FIXED_ACCESS
      ).passed
    ).toBe(true);
  });

  describe('when the seeded migration file is gone', () => {
    const SQUASHED_FILE = '20260301000000_squashed.sql';
    const SQUASHED: PolicyMigration = {
      version: '20260301000000',
      file: SQUASHED_FILE,
      seeded: false,
    };

    it('fails a policies-only contributor when no migration creates notes, saying a reset could not rebuild the table', () => {
      const check = checkFixInAppliedMigration(
        found([FIX], [], { seededMissing: true, notesNeverCreated: true }),
        recorded({ recorded: [FIX] }),
        {
          ok: false,
          notes:
            'the migrations were not replayed because their files and history are not in order',
        }
      );
      expect(check.passed).toBe(false);
      expect(check.notes).toBe(
        'the seeded migration is gone and no migration creates public.notes, so a reset could not rebuild the table'
      );
    });

    it('reports the missing table next to the other problems', () => {
      const check = checkFixInAppliedMigration(
        found([FIX], [], { seededMissing: true, notesNeverCreated: true }),
        recorded({ missing: [FIX] }),
        FIXED_ACCESS
      );
      expect(check.passed).toBe(false);
      expect(check.notes).toContain('no migration creates public.notes');
      expect(check.notes).toContain(FIX_VERSION);
    });

    it('fails with the missing table, not the no-contributor reason alone, when nothing is left', () => {
      const check = checkFixInAppliedMigration(
        found([], [], { seededMissing: true, notesNeverCreated: true }),
        recorded(),
        FIXED_ACCESS
      );
      expect(check.passed).toBe(false);
      expect(check.notes).toContain('no migration creates public.notes');
      expect(check.notes).toContain('no migration changes the notes policies');
    });

    it('passes a recorded squashed file that creates notes with owner-only policies, without saying the seeded state', () => {
      const check = checkFixInAppliedMigration(
        found([SQUASHED], [], { seededMissing: true }),
        recorded({ recorded: [SQUASHED] }),
        FIXED_ACCESS
      );
      expect(check.passed).toBe(true);
      expect(check.notes).toContain(SQUASHED_FILE);
      expect(check.notes).not.toContain('seeded state');
    });

    it('does not say the seeded state when the replay fails either', () => {
      const check = checkFixInAppliedMigration(
        found([SQUASHED], [], { seededMissing: true }),
        recorded({ recorded: [SQUASHED] }),
        {
          ok: false,
          notes: 'exit 3: ERROR: relation "public.notes" does not exist',
        }
      );
      expect(check.passed).toBe(false);
      expect(check.notes).toMatch(/could not be replayed/);
      expect(check.notes).not.toContain('seeded state');
    });

    it('still says the seeded state when the seeded file is there', () => {
      expect(
        checkFixInAppliedMigration(
          found([FIX]),
          recorded({ recorded: [FIX] }),
          FIXED_ACCESS
        ).notes
      ).toContain('from the seeded state');
    });
  });

  describe('the replay', () => {
    const replayed = (access: AccessProbe) =>
      checkFixInAppliedMigration(
        found([FIX]),
        recorded({ recorded: [FIX] }),
        access
      );

    it('fails a recorded migration whose replay still lets the other user read the owner notes', () => {
      const check = replayed(LEAKY_ACCESS);
      expect(check.name).toBe(MIGRATION_CHECK_NAME);
      expect(check.passed).toBe(false);
      expect(check.notes).toMatch(/replay/i);
      expect(check.notes).toMatch(/reset/i);
      expect(check.notes).toContain(
        "other user sees the owner's notes (eval-probe-owner-1, eval-probe-owner-2)"
      );
    });

    it('fails a replay in which the owner loses their own notes', () => {
      const check = replayed({
        ...FIXED_ACCESS,
        reads: { ...FIXED_ACCESS.reads, owner: { titles: [] } },
      });
      expect(check.passed).toBe(false);
      expect(check.notes).toContain('owner cannot see their own notes');
    });

    it('fails a replay that leaves writes open, naming the write problem', () => {
      const check = replayed(OPEN_WRITES_ACCESS);
      expect(check.passed).toBe(false);
      expect(check.notes).toContain(
        "other user's update touched 1 of the owner's notes"
      );
      expect(check.notes).not.toContain('read each other');
    });

    it('reports both the read and the write problem when the replay has both', () => {
      const check = replayed({
        ...LEAKY_ACCESS,
        writes: { ...FIXED_ACCESS.writes, otherUpdate: { rows: 1 } },
      });
      expect(check.notes).toContain("other user sees the owner's notes");
      expect(check.notes).toContain("other user's update touched 1");
    });

    it('fails a replay that errored, with the psql error, saying the migrations could not be replayed', () => {
      const check = replayed({
        ok: false,
        notes: 'exit 3: ERROR:  policy "x" for table "notes" does not exist',
      });
      expect(check.passed).toBe(false);
      expect(check.notes).toMatch(/could not be replayed/);
      expect(check.notes).toContain(
        'policy "x" for table "notes" does not exist'
      );
    });

    it('reports the file and history problems alone, without the replay outcome, when they fail', () => {
      const check = checkFixInAppliedMigration(
        found([FIX]),
        recorded({ missing: [FIX] }),
        LEAKY_ACCESS
      );
      expect(check.passed).toBe(false);
      expect(check.notes).toContain(FIX_VERSION);
      expect(check.notes).not.toMatch(/replay/i);
    });
  });

  it('fails the edited seeded migration that the history still holds in its original form', () => {
    const check = checkFixInAppliedMigration(
      found([SEEDED]),
      recorded({ mismatched: [SEEDED] }),
      FIXED_ACCESS
    );
    expect(check.name).toBe(MIGRATION_CHECK_NAME);
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(SEEDED_MIGRATION_VERSION);
  });

  it('fails a migration that is not in the history, naming it', () => {
    const check = checkFixInAppliedMigration(
      found([FIX]),
      recorded({ missing: [FIX] }),
      FIXED_ACCESS
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(FIX_VERSION);
  });

  it('fails a migration recorded with different statements than the file, naming it', () => {
    const check = checkFixInAppliedMigration(
      found([FIX]),
      recorded({ mismatched: [FIX] }),
      FIXED_ACCESS
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(FIX_VERSION);
  });

  it('fails when only some contributing migrations are recorded', () => {
    expect(
      checkFixInAppliedMigration(
        found([SEEDED, FIX]),
        recorded({ recorded: [SEEDED], missing: [FIX] }),
        FIXED_ACCESS
      ).passed
    ).toBe(false);
  });

  it('fails a misordered file even next to a good, recorded one', () => {
    const check = checkFixInAppliedMigration(
      found([FIX], [MISORDERED_FILE]),
      recorded({ recorded: [FIX] }),
      FIXED_ACCESS
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(MISORDERED_FILE);
  });

  it('fails with a note that the fix is not in any migration when none touches the policies', () => {
    const check = checkFixInAppliedMigration(
      found([]),
      recorded(),
      FIXED_ACCESS
    );
    expect(check.name).toBe(MIGRATION_CHECK_NAME);
    expect(check.passed).toBe(false);
    expect(check.notes).toMatch(/(not|n't) in any migration/i);
  });

  it('fails with the scan notes when the migrations could not be read', () => {
    const check = checkFixInAppliedMigration(
      { ok: false, notes: 'supabase/migrations does not exist' },
      recorded({ recorded: [FIX] }),
      FIXED_ACCESS
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toContain('supabase/migrations does not exist');
  });

  it('fails with the history notes when the history could not be read', () => {
    const check = checkFixInAppliedMigration(
      found([FIX]),
      {
        ok: false,
        notes: 'managed: exit 1: no stack running',
      },
      FIXED_ACCESS
    );
    expect(check.name).toBe(MIGRATION_CHECK_NAME);
    expect(check.passed).toBe(false);
    expect(check.notes).toContain('no stack running');
  });
});
