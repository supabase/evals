// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-001-rls-policy-tests
import { readFileSync } from 'node:fs';
import type { CommandResult } from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import {
  LEAKY_POLICY_NAME,
  SEEDED_MIGRATION_FILE,
  SEEDED_MIGRATION_VERSION,
} from './fixtures.js';
import {
  accessRuleStatements,
  checkFixInAppliedMigration,
  findPolicyMigrations,
  MIGRATION_CHECK_NAME,
  readRecordedPolicyMigrations,
  type PolicyMigration,
  type PolicyMigrationsProbe,
  type RecordedPolicyMigrationsProbe,
} from './migrations.js';

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
    ['a DO block', 'do $$ begin drop policy "p" on public.notes; end $$;'],
    [
      'a tagged DO block',
      'do $do$ begin\n  alter table public.notes enable row level security;\nend $do$;',
    ],
  ])('ignores %s', (_label, sql) => {
    expect(accessRuleStatements(sql)).toEqual([]);
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
      'a drop policy inside a dollar-quoted body',
      `do $$ begin ${DROP_LEAK} end $$;`,
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

describe('checkFixInAppliedMigration', () => {
  const found = (
    migrations: PolicyMigration[],
    misordered: string[] = []
  ): PolicyMigrationsProbe => ({ ok: true, migrations, misordered });
  const recorded = (
    parts: Partial<Extract<RecordedPolicyMigrationsProbe, { ok: true }>> = {}
  ): RecordedPolicyMigrationsProbe => ({
    ok: true,
    recorded: [],
    missing: [],
    mismatched: [],
    ...parts,
  });

  it('passes a new migration that is recorded with its statements', () => {
    const check = checkFixInAppliedMigration(
      found([FIX]),
      recorded({ recorded: [FIX] })
    );
    expect(check).toMatchObject({ name: MIGRATION_CHECK_NAME, passed: true });
    expect(check.notes).toContain(FIX_VERSION);
  });

  it('passes the edited seeded migration recorded with the edited statements, as after a reset', () => {
    expect(
      checkFixInAppliedMigration(
        found([SEEDED]),
        recorded({ recorded: [SEEDED] })
      ).passed
    ).toBe(true);
  });

  it('passes when every contributing migration is recorded', () => {
    expect(
      checkFixInAppliedMigration(
        found([SEEDED, FIX]),
        recorded({ recorded: [SEEDED, FIX] })
      ).passed
    ).toBe(true);
  });

  it('fails the edited seeded migration that the history still holds in its original form', () => {
    const check = checkFixInAppliedMigration(
      found([SEEDED]),
      recorded({ mismatched: [SEEDED] })
    );
    expect(check.name).toBe(MIGRATION_CHECK_NAME);
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(SEEDED_MIGRATION_VERSION);
  });

  it('fails a migration that is not in the history, naming it', () => {
    const check = checkFixInAppliedMigration(
      found([FIX]),
      recorded({ missing: [FIX] })
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(FIX_VERSION);
  });

  it('fails a migration recorded with different statements than the file, naming it', () => {
    const check = checkFixInAppliedMigration(
      found([FIX]),
      recorded({ mismatched: [FIX] })
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(FIX_VERSION);
  });

  it('fails when only some contributing migrations are recorded', () => {
    expect(
      checkFixInAppliedMigration(
        found([SEEDED, FIX]),
        recorded({ recorded: [SEEDED], missing: [FIX] })
      ).passed
    ).toBe(false);
  });

  it('fails a misordered file even next to a good, recorded one', () => {
    const check = checkFixInAppliedMigration(
      found([FIX], [MISORDERED_FILE]),
      recorded({ recorded: [FIX] })
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(MISORDERED_FILE);
  });

  it('fails with a note that the fix is not in any migration when none touches the policies', () => {
    const check = checkFixInAppliedMigration(found([]), recorded());
    expect(check.name).toBe(MIGRATION_CHECK_NAME);
    expect(check.passed).toBe(false);
    expect(check.notes).toMatch(/(not|n't) in any migration/i);
  });

  it('fails with the scan notes when the migrations could not be read', () => {
    const check = checkFixInAppliedMigration(
      { ok: false, notes: 'supabase/migrations does not exist' },
      recorded({ recorded: [FIX] })
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toContain('supabase/migrations does not exist');
  });

  it('fails with the history notes when the history could not be read', () => {
    const check = checkFixInAppliedMigration(found([FIX]), {
      ok: false,
      notes: 'managed: exit 1: no stack running',
    });
    expect(check.name).toBe(MIGRATION_CHECK_NAME);
    expect(check.passed).toBe(false);
    expect(check.notes).toContain('no stack running');
  });
});
