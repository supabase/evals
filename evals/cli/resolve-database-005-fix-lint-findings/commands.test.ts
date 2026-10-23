// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-005-fix-lint-findings
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import {
  checkRanDatabaseChecks,
  countDatabaseCheckRuns,
  RAN_CHECKS_CHECK,
  targetsLocalDatabase,
} from './commands.js';

const STACK_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const REMOTE_URL =
  'postgresql://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres';
const POOLER_URL =
  'postgresql://postgres:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
const PROJECT_REF = 'abcdefghijklmnopqrst';

const countsOf = (...commands: string[]) =>
  countDatabaseCheckRuns(findSupabaseInvocations(commands));

const countsAgainstStack = (...commands: string[]) =>
  countDatabaseCheckRuns(findSupabaseInvocations(commands), STACK_URL);

const invocationOf = (command: string) => {
  const [invocation] = findSupabaseInvocations([command]);
  return invocation;
};

describe('countDatabaseCheckRuns', () => {
  it.each([
    ['supabase db lint', { lint: 1, advisors: 0, remote: 0 }],
    ['supabase db lint --level error', { lint: 1, advisors: 0, remote: 0 }],
    [
      'supabase db lint --level warning --fail-on error',
      { lint: 1, advisors: 0, remote: 0 },
    ],
    ['npx supabase db lint --local', { lint: 1, advisors: 0, remote: 0 }],
    ['supabase --workdir /ws db lint', { lint: 1, advisors: 0, remote: 0 }],
    ['supabase db advisors', { lint: 0, advisors: 1, remote: 0 }],
    ['npx supabase db advisors --local', { lint: 0, advisors: 1, remote: 0 }],
    [
      'supabase db advisors --type security --level warn',
      { lint: 0, advisors: 1, remote: 0 },
    ],
  ])('counts %j as %j', (command, expected) => {
    expect(countsOf(command)).toEqual(expected);
    expect(countsAgainstStack(command)).toEqual(expected);
  });

  it('counts each run of each command', () => {
    expect(
      countsOf(
        'supabase db lint',
        'npx supabase db advisors --local',
        'supabase db lint --level error',
        'supabase db advisors --type performance'
      )
    ).toEqual({ lint: 2, advisors: 2, remote: 0 });
  });

  it.each([
    'supabase db reset',
    'supabase migration list',
    'supabase migration up',
    'supabase db query "select 1"',
    'supabase db diff -f fix',
    'supabase db push --local',
    'supabase start',
    'psql "$DATABASE_URL" -c "select 1"',
  ])('does not count %j', (command) => {
    expect(countsOf(command)).toEqual({ lint: 0, advisors: 0, remote: 0 });
  });

  it('does not count a command that only echoes the invocation', () => {
    expect(countsOf('echo "supabase db lint"')).toEqual({
      lint: 0,
      advisors: 0,
      remote: 0,
    });
  });

  it('counts only the check runs among other supabase commands', () => {
    expect(
      countsOf(
        'supabase start',
        'supabase db advisors',
        'supabase db reset',
        'supabase migration list',
        'supabase db lint'
      )
    ).toEqual({ lint: 1, advisors: 1, remote: 0 });
  });

  it('is zero when the agent ran nothing', () => {
    expect(countDatabaseCheckRuns([])).toEqual({
      lint: 0,
      advisors: 0,
      remote: 0,
    });
  });

  describe('remote targets', () => {
    it.each([
      ['supabase db lint --linked', { lint: 0, advisors: 0, remote: 1 }],
      ['supabase db lint --linked=true', { lint: 0, advisors: 0, remote: 1 }],
      [
        'supabase db advisors --linked --type all',
        { lint: 0, advisors: 0, remote: 1 },
      ],
      [
        `supabase db advisors --project-ref ${PROJECT_REF}`,
        { lint: 0, advisors: 0, remote: 1 },
      ],
      [
        `supabase db advisors --project-ref=${PROJECT_REF}`,
        { lint: 0, advisors: 0, remote: 1 },
      ],
      [
        `supabase db lint --db-url ${REMOTE_URL}`,
        { lint: 0, advisors: 0, remote: 1 },
      ],
      [
        `supabase db lint --db-url=${POOLER_URL}`,
        { lint: 0, advisors: 0, remote: 1 },
      ],
      ['supabase db lint --remote', { lint: 0, advisors: 0, remote: 1 }],
      [
        `supabase db advisors --remote=${PROJECT_REF}`,
        { lint: 0, advisors: 0, remote: 1 },
      ],
      [
        `supabase db advisors --remote=${REMOTE_URL}`,
        { lint: 0, advisors: 0, remote: 1 },
      ],
    ])('counts %j only as remote, with a stack given', (command, expected) => {
      expect(countsAgainstStack(command)).toEqual(expected);
    });

    it.each([
      'supabase db lint --linked',
      'supabase db lint --linked=true',
      `supabase db advisors --project-ref ${PROJECT_REF}`,
      `supabase db lint --db-url ${REMOTE_URL}`,
      `supabase db lint --db-url=${POOLER_URL}`,
      'supabase db lint --remote',
      `supabase db advisors --remote=${PROJECT_REF}`,
      `supabase db advisors --remote=${REMOTE_URL}`,
    ])('counts %j only as remote without a stack too', (command) => {
      const counts = countsOf(command);
      expect(counts.lint + counts.advisors).toBe(0);
      expect(counts.remote).toBe(1);
    });

    it('counts a remote run on a remote host even when its port matches the stack', () => {
      expect(
        countsAgainstStack(
          'supabase db lint --db-url postgresql://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:54322/postgres'
        )
      ).toEqual({ lint: 0, advisors: 0, remote: 1 });
    });

    it('counts a private-network host as remote', () => {
      expect(
        countsOf(
          'supabase db lint --db-url postgresql://postgres:pw@10.0.0.5:54322/postgres'
        )
      ).toEqual({ lint: 0, advisors: 0, remote: 1 });
    });

    it('counts another local Postgres on a different port as remote when the stack is known', () => {
      expect(
        countsAgainstStack(
          'supabase db lint --db-url postgresql://postgres:postgres@127.0.0.1:5432/postgres'
        )
      ).toEqual({ lint: 0, advisors: 0, remote: 1 });
    });

    it('treats a loopback URL without a port as port 5432', () => {
      const command =
        'supabase db lint --db-url postgresql://postgres:postgres@127.0.0.1/postgres';
      expect(countsAgainstStack(command)).toEqual({
        lint: 0,
        advisors: 0,
        remote: 1,
      });
      expect(
        countDatabaseCheckRuns(
          findSupabaseInvocations([command]),
          'postgresql://postgres:postgres@127.0.0.1:5432/postgres'
        )
      ).toEqual({ lint: 1, advisors: 0, remote: 0 });
    });

    it('counts a loopback URL on any port as local when no stack is known', () => {
      expect(
        countsOf(
          'supabase db lint --db-url postgresql://postgres:postgres@127.0.0.1:5432/postgres'
        )
      ).toEqual({ lint: 1, advisors: 0, remote: 0 });
    });

    it('separates local and remote runs of the same check', () => {
      expect(
        countsAgainstStack(
          'supabase db lint --linked',
          'supabase db lint',
          `supabase db advisors --project-ref ${PROJECT_REF}`,
          'supabase db advisors --local',
          'supabase db lint --linked'
        )
      ).toEqual({ lint: 1, advisors: 1, remote: 3 });
    });
  });

  describe('local targets', () => {
    it.each([
      'supabase db lint --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres',
      'supabase db lint --db-url=postgresql://postgres:postgres@127.0.0.1:54322/postgres',
      'supabase db lint --db-url postgresql://postgres:postgres@localhost:54322/postgres',
      'supabase db lint --db-url postgresql://postgres:postgres@foo.localhost:54322/postgres',
      'supabase db lint --db-url postgresql://postgres:postgres@127.0.0.2:54322/postgres',
      'supabase db lint --db-url postgresql://postgres:postgres@0.0.0.0:54322/postgres',
      'supabase db lint --db-url postgresql://postgres:postgres@host.docker.internal:54322/postgres',
      'supabase db lint --db-url postgresql://postgres:postgres@db:54322/postgres',
      'supabase db lint --db-url "postgresql://postgres:postgres@[::1]:54322/postgres"',
      'supabase db lint --db-url "$DB_URL"',
      'supabase db lint --db-url "postgresql://postgres:postgres@127.0.0.1:$DB_PORT/postgres"',
      'supabase db lint --db-url "postgresql://postgres:postgres@$DB_HOST:54322/postgres"',
      'supabase db lint --db-url "`get-db-url`"',
      'supabase db lint --remote=postgresql://postgres:postgres@127.0.0.1:54322/postgres',
      'supabase db lint --local',
      'supabase db lint',
    ])('counts %j as a local lint run', (command) => {
      expect(countsAgainstStack(command)).toEqual({
        lint: 1,
        advisors: 0,
        remote: 0,
      });
    });

    it('counts a local advisors run through --remote with a loopback URL on the stack port', () => {
      expect(
        countsAgainstStack(
          'supabase db advisors --remote=postgresql://postgres:postgres@127.0.0.1:54322/postgres'
        )
      ).toEqual({ lint: 0, advisors: 1, remote: 0 });
    });
  });

  describe('help runs', () => {
    it.each([
      'supabase db lint help',
      'supabase db advisors help',
      'supabase db lint --help',
      'supabase db advisors -h',
      'supabase help db lint',
      'supabase help db advisors',
    ])('counts %j nowhere', (command) => {
      expect(countsOf(command)).toEqual({ lint: 0, advisors: 0, remote: 0 });
      expect(countsAgainstStack(command)).toEqual({
        lint: 0,
        advisors: 0,
        remote: 0,
      });
    });

    it('counts a help run against a remote flag nowhere, not even as remote', () => {
      expect(countsAgainstStack('supabase db lint help --linked')).toEqual({
        lint: 0,
        advisors: 0,
        remote: 0,
      });
    });

    it('still counts the real run that follows a help run', () => {
      expect(
        countsAgainstStack(
          'supabase db lint help',
          'supabase db lint --help',
          'supabase db lint'
        )
      ).toEqual({ lint: 1, advisors: 0, remote: 0 });
    });
  });
});

describe('targetsLocalDatabase', () => {
  it.each([
    'supabase db lint',
    'supabase db lint --local',
    'supabase db reset',
    'supabase db query --local "select 1"',
    'supabase migration up',
    'supabase db lint --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    'supabase db lint --db-url "$DB_URL"',
  ])('is true for %j', (command) => {
    expect(targetsLocalDatabase(invocationOf(command), STACK_URL)).toBe(true);
  });

  it.each([
    'supabase db lint --linked',
    'supabase db lint --linked=true',
    `supabase db advisors --project-ref ${PROJECT_REF}`,
    `supabase db advisors --project-ref=${PROJECT_REF}`,
    'supabase db lint --remote',
    `supabase db lint --remote=${PROJECT_REF}`,
    `supabase db lint --remote=${REMOTE_URL}`,
    'supabase db reset --linked',
    `supabase migration up --db-url ${REMOTE_URL}`,
    'supabase db query --linked "select 1"',
    'supabase db query --remote "select 1"',
    `supabase db lint --db-url ${POOLER_URL}`,
  ])('is false for %j', (command) => {
    expect(targetsLocalDatabase(invocationOf(command), STACK_URL)).toBe(false);
    expect(targetsLocalDatabase(invocationOf(command))).toBe(false);
  });

  it('compares a loopback URL port with the stack port only when a stack URL is given', () => {
    const invocation = invocationOf(
      'supabase db lint --db-url postgresql://postgres:postgres@127.0.0.1:5432/postgres'
    );
    expect(targetsLocalDatabase(invocation)).toBe(true);
    expect(targetsLocalDatabase(invocation, STACK_URL)).toBe(false);
    expect(
      targetsLocalDatabase(
        invocation,
        'postgresql://postgres:postgres@127.0.0.1:5432/postgres'
      )
    ).toBe(true);
  });
});

describe('checkRanDatabaseChecks', () => {
  it('keeps the check name stable for the results dashboard', () => {
    expect(RAN_CHECKS_CHECK).toBe('ran supabase db lint or db advisors');
  });

  it.each([
    [{ lint: 1, advisors: 0, remote: 0 }, 'db lint ×1, db advisors ×0'],
    [{ lint: 0, advisors: 1, remote: 0 }, 'db lint ×0, db advisors ×1'],
    [{ lint: 3, advisors: 2, remote: 0 }, 'db lint ×3, db advisors ×2'],
  ])('passes with %j', (counts, notes) => {
    expect(checkRanDatabaseChecks(counts)).toEqual({
      name: RAN_CHECKS_CHECK,
      passed: true,
      notes,
    });
  });

  it('fails when neither check ran', () => {
    expect(checkRanDatabaseChecks({ lint: 0, advisors: 0, remote: 0 })).toEqual(
      {
        name: RAN_CHECKS_CHECK,
        passed: false,
        notes: 'db lint ×0, db advisors ×0',
      }
    );
  });

  it('fails and says how many runs were skipped when every run targeted a remote database', () => {
    expect(checkRanDatabaseChecks({ lint: 0, advisors: 0, remote: 2 })).toEqual(
      {
        name: RAN_CHECKS_CHECK,
        passed: false,
        notes: 'db lint ×0, db advisors ×0 (2 remote runs not counted)',
      }
    );
  });

  it('says 1 remote run in the singular', () => {
    expect(
      checkRanDatabaseChecks({ lint: 0, advisors: 0, remote: 1 }).notes
    ).toBe('db lint ×0, db advisors ×0 (1 remote run not counted)');
  });

  it('still passes on the local runs and appends the remote runs it did not count', () => {
    expect(checkRanDatabaseChecks({ lint: 1, advisors: 2, remote: 3 })).toEqual(
      {
        name: RAN_CHECKS_CHECK,
        passed: true,
        notes: 'db lint ×1, db advisors ×2 (3 remote runs not counted)',
      }
    );
  });

  it('passes on lint alone and on advisors alone, never requiring both', () => {
    expect(checkRanDatabaseChecks(countsOf('supabase db lint')).passed).toBe(
      true
    );
    expect(
      checkRanDatabaseChecks(countsOf('npx supabase db advisors --local'))
        .passed
    ).toBe(true);
  });

  it('fails when the agent only reset the database and listed migrations', () => {
    expect(
      checkRanDatabaseChecks(
        countsOf('supabase db reset', 'supabase migration list')
      ).passed
    ).toBe(false);
  });

  it('fails when the agent only linted a linked project, naming the skipped run', () => {
    expect(
      checkRanDatabaseChecks(countsAgainstStack('supabase db lint --linked'))
    ).toEqual({
      name: RAN_CHECKS_CHECK,
      passed: false,
      notes: 'db lint ×0, db advisors ×0 (1 remote run not counted)',
    });
  });

  it('fails when the agent only asked the checks for help', () => {
    expect(
      checkRanDatabaseChecks(
        countsAgainstStack('supabase db lint help', 'supabase db advisors help')
      )
    ).toEqual({
      name: RAN_CHECKS_CHECK,
      passed: false,
      notes: 'db lint ×0, db advisors ×0',
    });
  });
});
