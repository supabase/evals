// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/lib/db-target.test.ts
import type { ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from './cli-invocations.js';
import {
  booleanFlag,
  CLI_FAILURE_RE,
  isExplicitlyLocal,
  isLoopbackUrl,
  toolCallFailed,
  toolCallFailureLine,
} from './db-target.js';

const HOSTED_REF = 'abcdefghijklmnopqrst';
const LOCAL_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const POOLER_URL =
  'postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
const DIRECT_URL = `postgresql://postgres:pw@db.${HOSTED_REF}.supabase.co:5432/postgres`;
const CONTAINER_URL =
  'postgresql://postgres:postgres@supabase_db_shop-app:5432/postgres';
const LOCALHOST_SUBDOMAIN_URL =
  'postgresql://postgres:postgres@db.localhost:5432/postgres';

const FLAG_GROUP_CONFLICT =
  'if any flags in the group [db-url linked local] are set none of the others can be; [db-url linked] were all set';

const CLI_FAILURES: [label: string, output: string][] = [
  ['a JSON error', '{"_tag":"Error","error":{"code":1,"message":"boom"}}'],
  ['a JSON error with spacing', '{ "_tag" : "Error" }'],
  ['an unlinked repo', 'Cannot find project ref. Have you run supabase link?'],
  ['a missing token', 'Access token not provided. Supply an access token.'],
  [
    'a stopped confirmation',
    'Confirmation required: run a query on remote. Nothing was changed.',
  ],
  ['a refused connection', 'failed to connect to postgres'],
  ['an unknown flag', 'unknown flag: --remote'],
  ['a missing binary', 'zsh: command not found: supabase'],
  ['a different case', 'CANNOT FIND PROJECT REF'],
  [
    'an HTTP status in text mode',
    'unexpected status 401: {"message":"Unauthorized"}',
  ],
  ['a failed query', 'failed to execute query: relation "x" is missing'],
  ['a flag-group conflict', FLAG_GROUP_CONFLICT],
  ['a flag-group conflict in upper case', FLAG_GROUP_CONFLICT.toUpperCase()],
];

const SUCCESSES = [
  'Finished supabase db push.',
  'Remote database is up to date.',
  'Dumping data from remote database...',
  '',
];

const UNLINKED_ERROR =
  '{"_tag":"Error","error":{"code":"ProjectRefNotLinkedError","message":"Cannot find project ref. Have you run supabase link?"}}';

function call(
  options: { result?: unknown; error?: string } = {}
): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command: 'supabase db push' },
    command: 'supabase db push',
    result: options.result,
    ts: 0,
    ...(options.error === undefined ? {} : { error: options.error }),
  };
}

function lastInvocation(command: string) {
  const [inv] = findSupabaseInvocations([command]).slice(-1);
  if (inv === undefined)
    throw new Error(`no supabase invocation in ${command}`);
  return inv;
}

const isLocal = (command: string) =>
  isExplicitlyLocal(lastInvocation(command), command);

describe('booleanFlag', () => {
  const argv = (...flags: string[]) => ['supabase', 'db', 'push', ...flags];

  it.each([
    ['the bare flag', ['--x'], true],
    ['--x=true', ['--x=true'], true],
    ['--x=1', ['--x=1'], true],
    ['--x=false', ['--x=false'], false],
    ['--x=0', ['--x=0'], false],
    ['--x=', ['--x='], false],
    ['no flag', ['--y'], false],
    ['a longer flag that starts the same', ['--xy'], false],
    ['a longer flag joined by a dash', ['--x-y'], false],
    ['a longer flag with a value that starts the same', ['--xy=true'], false],
    ['the last occurrence winning: on then off', ['--x', '--x=false'], false],
    ['the last occurrence winning: off then on', ['--x=false', '--x'], true],
  ])('reads %s', (_, flags, expected) => {
    expect(booleanFlag(argv(...flags), '--x')).toBe(expected);
  });

  it('reads nothing from an empty argv', () => {
    expect(booleanFlag([], '--x')).toBe(false);
  });
});

describe('isLoopbackUrl', () => {
  it.each([
    ['localhost', 'postgresql://postgres:pw@localhost:54322/postgres'],
    ['127.0.0.1', LOCAL_URL],
    [
      'another 127/8 address',
      'postgresql://postgres:pw@127.0.0.5:5432/postgres',
    ],
    ['[::1]', 'postgresql://postgres:pw@[::1]:54322/postgres'],
    ['0.0.0.0', 'postgresql://postgres:pw@0.0.0.0:5432/postgres'],
    [
      'host.docker.internal',
      'postgresql://postgres:pw@host.docker.internal:54322/postgres',
    ],
    ['a docker container name with no dot', CONTAINER_URL],
    ['a *.localhost host', LOCALHOST_SUBDOMAIN_URL],
    ['an upper-case LOCALHOST', 'postgresql://postgres:pw@LOCALHOST:5432/db'],
    ['a URL that does not parse', 'not a url'],
    ['an empty string', ''],
  ])('is true for %s', (_, url) => {
    expect(isLoopbackUrl(url)).toBe(true);
  });

  it.each([
    ['a pooler host', POOLER_URL],
    ['a direct host', DIRECT_URL],
    [
      'a host that merely starts like a loopback address',
      'postgresql://postgres:pw@127.0.0.1.example.com:5432/postgres',
    ],
    [
      'a host that merely starts with localhost',
      'postgresql://postgres:pw@localhost.example.com:5432/postgres',
    ],
    [
      'a database called localhost',
      'postgresql://postgres:pw@db.example.com:5432/localhost',
    ],
    [
      'a user called localhost',
      'postgresql://localhost:pw@db.example.com:5432/postgres',
    ],
    [
      'a password containing 127.0.0.1',
      'postgresql://postgres:127.0.0.1@db.example.com:5432/postgres',
    ],
    [
      'a host that merely ends like localhost',
      'postgresql://postgres:pw@db.notlocalhost.com:5432/postgres',
    ],
    [
      'an IPv6 address that is not ::1',
      'postgresql://postgres:pw@[2001:db8::1]:5432/postgres',
    ],
    [
      'a public IPv4 address',
      'postgresql://postgres:pw@203.0.113.7:5432/postgres',
    ],
  ])('is false for %s', (_, url) => {
    expect(isLoopbackUrl(url)).toBe(false);
  });
});

describe('isExplicitlyLocal', () => {
  it.each(['db push', 'db dump', 'db query "select 1"'])(
    'applies the same rules to supabase %s',
    (verb) => {
      expect(isLocal(`supabase ${verb} --local`)).toBe(true);
      expect(isLocal(`supabase ${verb} --db-url "${LOCAL_URL}"`)).toBe(true);
      expect(isLocal(`supabase ${verb} --linked`)).toBe(false);
      expect(isLocal(`supabase ${verb} --db-url "${POOLER_URL}"`)).toBe(false);
    }
  );

  it.each([
    ['--local', '--local', true],
    ['--local=true', '--local=true', true],
    ['--local=false', '--local=false', false],
    ['--db-url on 127.0.0.1', `--db-url "${LOCAL_URL}"`, true],
    ['--db-url= on 127.0.0.1', `--db-url="${LOCAL_URL}"`, true],
    ['--db-url on a container name', `--db-url "${CONTAINER_URL}"`, true],
    ['--db-url on *.localhost', `--db-url "${LOCALHOST_SUBDOMAIN_URL}"`, true],
    ['--remote=<url> on 127.0.0.1', `--remote="${LOCAL_URL}"`, true],
    ['--remote=<url> on a container name', `--remote="${CONTAINER_URL}"`, true],
    ['--db-url on a pooler host', `--db-url "${POOLER_URL}"`, false],
    ['--db-url= on a direct host', `--db-url="${DIRECT_URL}"`, false],
    ['--remote=<url> on a direct host', `--remote="${DIRECT_URL}"`, false],
    ['--remote=<ref>', `--remote=${HOSTED_REF}`, false],
    ['--linked', '--linked', false],
    ['--remote', '--remote', false],
    ['--project-ref', `--project-ref ${HOSTED_REF}`, false],
    ['no target flag', '', false],
  ])('reads %s as explicitlyLocal %s', (_, flags, expected) => {
    expect(isLocal(`supabase db push ${flags}`)).toBe(expected);
  });

  it('keeps a bare --remote as remote and does not read the next token as its value', () => {
    expect(isLocal(`supabase db push --remote "${LOCAL_URL}"`)).toBe(false);
  });

  it.each([
    ['--linked --local', '--linked --local'],
    ['--local --linked', '--local --linked'],
    ['--local with a project ref', `--local --project-ref ${HOSTED_REF}`],
    ['--local with a remote --db-url', `--local --db-url "${POOLER_URL}"`],
  ])('lets --local win over everything else: %s', (_, flags) => {
    expect(isLocal(`supabase db push ${flags}`)).toBe(true);
  });

  it.each([
    ['a package runner pin', 'npx -y supabase@2.122.0 db push --local'],
    ['an env assignment', 'SUPABASE_YES=1 supabase db push --local'],
    ['a directory change', 'cd app && supabase db push --local'],
    ['a subshell', '(supabase db push --local)'],
  ])('reads --local through %s', (_, command) => {
    expect(isLocal(command)).toBe(true);
  });

  describe('a --db-url from a shell variable', () => {
    it.each([
      ['$VAR', 'supabase db push --db-url "$SUPABASE_DB_URL"'],
      ['${VAR}', 'supabase db push --db-url "${SUPABASE_DB_URL}"'],
      ['--db-url=$VAR', 'supabase db push --db-url=$DATABASE_URL'],
      [
        'a variable loaded from a file',
        'set -a; . ./.env; set +a; supabase db push --db-url "$SUPABASE_DB_URL"',
      ],
      [
        'a variable assigned a hosted URL',
        `DB_URL="${POOLER_URL}"; supabase db push --db-url "$DB_URL"`,
      ],
      [
        'the last assignment, when it is a hosted URL',
        `DB_URL="${LOCAL_URL}"; DB_URL="${POOLER_URL}"; supabase db push --db-url "$DB_URL"`,
      ],
    ])('reads %s as not local', (_, command) => {
      expect(isLocal(command)).toBe(false);
    });

    it.each([
      [
        'a variable assigned a loopback URL',
        `DB_URL="${LOCAL_URL}"; supabase db push --db-url "$DB_URL"`,
      ],
      [
        'an exported loopback URL',
        `export DB_URL=${LOCAL_URL} && supabase db push --db-url "$DB_URL"`,
      ],
      [
        'the last assignment, when it is a loopback URL',
        `DB_URL="${POOLER_URL}"; DB_URL="${LOCAL_URL}"; supabase db push --db-url "$DB_URL"`,
      ],
      [
        'a variable loaded from supabase status',
        'eval "$(supabase status -o env)" && supabase db push --db-url "$DB_URL"',
      ],
      [
        'a variable assigned from a command substitution',
        'DB_URL="$(cat .db-url)"; supabase db push --db-url "$DB_URL"',
      ],
    ])('reads %s as local', (_, command) => {
      expect(isLocal(command)).toBe(true);
    });

    it('keeps a --db-url command substitution local', () => {
      expect(isLocal('supabase db push --db-url "$(cat .db-url)"')).toBe(true);
    });

    it.each([
      [
        'a plain supabase status',
        'supabase status && supabase db push --db-url "$SUPABASE_DB_URL"',
      ],
      [
        'a status printed as env but not loaded',
        'supabase status -o env && supabase db push --db-url "$DB_URL"',
      ],
      [
        'a status read as JSON',
        'supabase status -o json | jq .; supabase db push --db-url "$SUPABASE_DB_URL"',
      ],
    ])('reads a push alongside %s as not local', (_, command) => {
      expect(isLocal(command)).toBe(false);
    });

    it.each([
      ['eval "$(… -o env)"', 'eval "$(supabase status -o env)"'],
      ['eval $(… --output env)', 'eval $(supabase status --output env)'],
      ['eval through npx', 'eval "$(npx supabase status --output=env)"'],
      ['source <(…)', 'source <(supabase status -o env)'],
      ['. <(…)', '. <(supabase status -o env)'],
      ['export $(… | xargs)', 'export $(supabase status -o env | xargs)'],
      ['set -a with eval', 'set -a; eval "$(supabase status -o env)"; set +a'],
    ])('reads a dump after loading status with %s as local', (_, load) => {
      expect(
        isLocal(`${load} && supabase db dump --db-url "$DB_URL" -f out.sql`)
      ).toBe(true);
    });

    it('reads a variable-held URL the same way for a dump as for a push', () => {
      expect(isLocal('supabase db dump --db-url "$SUPABASE_DB_URL"')).toBe(
        false
      );
      expect(
        isLocal(`DB_URL="${LOCAL_URL}"; supabase db dump --db-url "$DB_URL"`)
      ).toBe(true);
    });
  });
});

describe('CLI_FAILURE_RE', () => {
  it.each(CLI_FAILURES)('matches %s', (_, output) => {
    expect(CLI_FAILURE_RE.test(output)).toBe(true);
  });

  it.each(SUCCESSES)('does not match %j', (output) => {
    expect(CLI_FAILURE_RE.test(output)).toBe(false);
  });
});

describe('toolCallFailed', () => {
  it('is false when there is no tool call', () => {
    expect(toolCallFailed(undefined)).toBe(false);
  });

  it('is true when the tool call reported an error', () => {
    expect(toolCallFailed(call({ error: 'exit 1' }))).toBe(true);
  });

  it('is true for an error that is an empty string', () => {
    expect(toolCallFailed(call({ error: '' }))).toBe(true);
  });

  it.each(CLI_FAILURES)(
    'is true when the output shows %s, with no tool error',
    (_, result) => {
      expect(toolCallFailed(call({ result }))).toBe(true);
    }
  );

  it.each(SUCCESSES)('is false for the output %j', (result) => {
    expect(toolCallFailed(call({ result }))).toBe(false);
  });

  it.each([
    ['an undefined result', undefined],
    ['an object result', { ok: true }],
    ['a null result', null],
  ])('is false for %s with no error', (_, result) => {
    expect(toolCallFailed(call({ result }))).toBe(false);
  });

  describe('with an extra failure pattern', () => {
    const PG_DUMP_ERROR =
      'pg_dump: error: connection to server at "db.x.supabase.co" failed';

    it('does not read the extra pattern into a call when none is given', () => {
      expect(toolCallFailed(call({ result: PG_DUMP_ERROR }))).toBe(false);
    });

    it('is true when the output matches the extra pattern', () => {
      expect(
        toolCallFailed(call({ result: PG_DUMP_ERROR }), /pg_dump: error/i)
      ).toBe(true);
    });

    it('is still true for a CLI failure the extra pattern does not match', () => {
      expect(
        toolCallFailed(
          call({ result: 'Cannot find project ref.' }),
          /pg_dump: error/i
        )
      ).toBe(true);
    });

    it('is false for a clean output when the extra pattern does not match', () => {
      expect(
        toolCallFailed(
          call({ result: 'Dumped data to backups/x.sql' }),
          /pg_dump: error/i
        )
      ).toBe(false);
    });

    it('is true for a tool error whatever the extra pattern is', () => {
      expect(toolCallFailed(call({ error: 'exit 1' }), /never/)).toBe(true);
    });
  });
});

describe('toolCallFailureLine', () => {
  it('is undefined when there is no tool call', () => {
    expect(toolCallFailureLine(undefined)).toBeUndefined();
  });

  it.each(SUCCESSES)('is undefined for the clean output %j', (result) => {
    expect(toolCallFailureLine(call({ result }))).toBeUndefined();
  });

  it('keeps the first line of the output that shows the failure', () => {
    expect(
      toolCallFailureLine(
        call({
          result:
            'Connecting to remote database...\nCannot find project ref. Have you run supabase link?\nTry --help',
        })
      )
    ).toBe('Cannot find project ref. Have you run supabase link?');
  });

  it('keeps the first line of the error text when the output shows no failure', () => {
    expect(
      toolCallFailureLine(call({ error: '\n  exit status 1\nsecond line' }))
    ).toBe('exit status 1');
  });

  it('is undefined when the error text is empty', () => {
    expect(toolCallFailureLine(call({ error: '' }))).toBeUndefined();
  });

  it('trims the line to 200 characters', () => {
    expect(
      toolCallFailureLine(
        call({ error: `Cannot find project ref ${'x'.repeat(500)}` })
      )
    ).toHaveLength(200);
  });

  it.each([
    [
      'a deprecation warning',
      `Warning: --linked is deprecated and will be removed in v4. Use --remote instead\n${UNLINKED_ERROR}`,
    ],
    [
      'an npx warning',
      `npm warn exec The following package was not found and will be installed: supabase@2.117.0\n${UNLINKED_ERROR}`,
    ],
  ])(
    'keeps the CLI failure line of the error text past %s, with no output',
    (_, error) => {
      const failed = call({ error });
      expect(failed.result).toBeUndefined();
      expect(toolCallFailureLine(failed)).toBe(UNLINKED_ERROR);
    }
  );

  it('keeps the flag-group conflict line of an output that opens with a warning', () => {
    expect(
      toolCallFailureLine(
        call({
          result: `Warning: --linked is deprecated\n${FLAG_GROUP_CONFLICT}`,
        })
      )
    ).toBe(FLAG_GROUP_CONFLICT);
  });

  it('searches the output and the error text together', () => {
    expect(
      toolCallFailureLine(
        call({
          result: 'Connecting to remote database...',
          error: `exit status 1\n${UNLINKED_ERROR}`,
        })
      )
    ).toBe(UNLINKED_ERROR);
  });

  describe('with an extra failure pattern', () => {
    const extra = /pg_dump: error|Cannot connect to the Docker daemon/i;

    it('picks a line that matches only the extra pattern', () => {
      expect(
        toolCallFailureLine(
          call({
            result:
              'Dumping data from remote database...\npg_dump: error: connection refused\nexit status 1',
          }),
          extra
        )
      ).toBe('pg_dump: error: connection refused');
    });

    it('picks the first line that matches either pattern, in output order', () => {
      expect(
        toolCallFailureLine(
          call({
            result:
              'Cannot connect to the Docker daemon at unix:///var/run/docker.sock\nCannot find project ref.',
          }),
          extra
        )
      ).toBe(
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock'
      );
      expect(
        toolCallFailureLine(
          call({
            result:
              'Cannot find project ref.\nCannot connect to the Docker daemon',
          }),
          extra
        )
      ).toBe('Cannot find project ref.');
    });

    it('finds the extra pattern in the error text of a call with no output', () => {
      expect(
        toolCallFailureLine(
          call({
            error: 'warning: x\npg_dump: error: server closed the connection',
          }),
          extra
        )
      ).toBe('pg_dump: error: server closed the connection');
    });

    it('does not report a line only the extra pattern matches when none is given', () => {
      expect(
        toolCallFailureLine(call({ result: 'pg_dump: error: boom' }))
      ).toBeUndefined();
    });
  });
});
