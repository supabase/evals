// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/lib/db-target.test.ts
import type {
  CommandResult,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from './cli-invocations.js';
import {
  booleanFlag,
  CLI_FAILURE_RE,
  dryRunCommandIndexes,
  hostedEndpoint,
  isExplicitlyLocal,
  isLoopbackUrl,
  POOLER_URL_PATH,
  readHostedEndpoints,
  type TargetOptions,
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

const PUSH_SUCCESS = /Finished supabase db push\./;

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

const isLocal = (command: string, options?: TargetOptions) =>
  isExplicitlyLocal(lastInvocation(command), command, options);

const HOSTED_PORT = 55432;
const HARNESS_POOLER_URL = `postgresql://postgres:postgres@host.docker.internal:${HOSTED_PORT}/postgres?sslmode=disable`;
const HOSTED: TargetOptions = {
  remoteEndpoints: [`host.docker.internal:${HOSTED_PORT}`],
};
const LOCAL_STACK_ON_DOCKER_HOST =
  'postgresql://postgres:postgres@host.docker.internal:54322/postgres';

const commandResult = (stdout = ''): CommandResult => ({
  ok: true,
  exitCode: 0,
  stdout,
  stderr: '',
});

function fakeExec(respond: CommandResult | (() => CommandResult)) {
  const calls: string[] = [];
  const ctx = {
    exec: async (command: string) => {
      calls.push(command);
      return typeof respond === 'function' ? respond() : respond;
    },
  } as unknown as Pick<LocalStackEvalContext, 'exec'>;
  return { ctx, calls };
}

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

describe('dryRunCommandIndexes', () => {
  const indexes = (subcommand: string, ...commands: string[]) => [
    ...dryRunCommandIndexes(findSupabaseInvocations(commands), subcommand),
  ];

  it('lists the commands that dry-run the subcommand, whatever else they run', () => {
    expect(
      indexes(
        'push',
        'supabase db push --yes',
        'supabase db push --dry-run',
        'supabase db push --dry-run=true && supabase db push --yes'
      )
    ).toEqual([1, 2]);
  });

  it('skips --dry-run=false', () => {
    expect(indexes('push', 'supabase db push --dry-run=false')).toEqual([]);
  });

  it('skips a dry run of another subcommand or verb', () => {
    expect(
      indexes(
        'push',
        'supabase db dump --dry-run -f a.sql',
        'supabase migration up --dry-run'
      )
    ).toEqual([]);
    expect(
      indexes('dump', 'supabase db dump --dry-run -f a.sql && supabase db push')
    ).toEqual([0]);
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

  describe('with known hosted endpoints', () => {
    it.each([
      ['--db-url', `--db-url "${HARNESS_POOLER_URL}"`],
      ['--db-url=', `--db-url="${HARNESS_POOLER_URL}"`],
      ['--remote=<url>', `--remote="${HARNESS_POOLER_URL}"`],
    ])(
      'reads %s at the hosted endpoint as local until it is passed, then as remote',
      (_, flags) => {
        const command = `supabase db push ${flags}`;
        expect(isLocal(command)).toBe(true);
        expect(isLocal(command, HOSTED)).toBe(false);
      }
    );

    it.each(['db push', 'db dump', 'db query "select 1"'])(
      'applies to supabase %s',
      (verb) => {
        const command = `supabase ${verb} --db-url "${HARNESS_POOLER_URL}"`;
        expect(isLocal(command, HOSTED)).toBe(false);
      }
    );

    it('keeps a local stack on the same host at another port local', () => {
      expect(
        isLocal(
          `supabase db push --db-url "${LOCAL_STACK_ON_DOCKER_HOST}"`,
          HOSTED
        )
      ).toBe(true);
      expect(
        isLocal(
          `supabase db push --remote="${LOCAL_STACK_ON_DOCKER_HOST}"`,
          HOSTED
        )
      ).toBe(true);
    });

    it('reads a variable assigned the hosted URL as remote', () => {
      for (const assignment of [
        `DB_URL="${HARNESS_POOLER_URL}"`,
        `export DB_URL=${HARNESS_POOLER_URL}`,
        `DB_URL='${HARNESS_POOLER_URL}'`,
      ]) {
        const command = `${assignment}; supabase db push --db-url "$DB_URL"`;
        expect(isLocal(command)).toBe(true);
        expect(isLocal(command, HOSTED)).toBe(false);
      }
    });

    it('reads a variable by its last assignment', () => {
      expect(
        isLocal(
          `DB_URL="${HARNESS_POOLER_URL}"; DB_URL="${LOCAL_STACK_ON_DOCKER_HOST}"; supabase db push --db-url "$DB_URL"`,
          HOSTED
        )
      ).toBe(true);
    });

    it('reads a variable that holds no URL the command shows as before', () => {
      expect(
        isLocal('supabase db push --db-url "$SUPABASE_DB_URL"', HOSTED)
      ).toBe(false);
      expect(
        isLocal(
          'eval "$(supabase status -o env)" && supabase db push --db-url "$DB_URL"',
          HOSTED
        )
      ).toBe(true);
    });

    it('lets --local win over the hosted endpoint', () => {
      expect(
        isLocal(
          `supabase db push --local --db-url "${HARNESS_POOLER_URL}"`,
          HOSTED
        )
      ).toBe(true);
    });

    it('defaults the URL port to 5432 when matching', () => {
      const options = { remoteEndpoints: ['localhost:5432'] };
      expect(
        isLocal(
          'supabase db push --db-url "postgresql://localhost/db"',
          options
        )
      ).toBe(false);
      expect(
        isLocal(
          'supabase db push --db-url "postgresql://localhost:54322/db"',
          options
        )
      ).toBe(true);
    });

    it('matches the host in any case', () => {
      expect(
        isLocal(
          `supabase db push --db-url "postgresql://p:p@HOST.DOCKER.INTERNAL:${HOSTED_PORT}/postgres"`,
          HOSTED
        )
      ).toBe(false);
    });

    it('matches any endpoint in the list and a loopback address among them', () => {
      const options = {
        remoteEndpoints: ['db.example.com:5432', '127.0.0.1:6543'],
      };
      expect(
        isLocal(
          'supabase db push --db-url "postgresql://p:p@127.0.0.1:6543/postgres"',
          options
        )
      ).toBe(false);
      expect(isLocal(`supabase db push --db-url "${LOCAL_URL}"`, options)).toBe(
        true
      );
    });

    it.each([
      ['no options', undefined],
      ['empty options', {}],
      ['no endpoints', { remoteEndpoints: [] }],
    ])('reads the loopback rules alone with %s', (_, options) => {
      expect(
        isLocal(`supabase db push --db-url "${HARNESS_POOLER_URL}"`, options)
      ).toBe(true);
    });

    it('does not change a URL that was remote already', () => {
      expect(isLocal(`supabase db push --db-url "${POOLER_URL}"`, HOSTED)).toBe(
        false
      );
    });
  });
});

describe('hostedEndpoint', () => {
  it('reads the host and port from the URL the harness writes', () => {
    expect(hostedEndpoint(HARNESS_POOLER_URL)).toBe(
      `host.docker.internal:${HOSTED_PORT}`
    );
  });

  it('defaults the port to 5432', () => {
    expect(
      hostedEndpoint('postgresql://postgres:pw@db.example.com/postgres')
    ).toBe('db.example.com:5432');
  });

  it('ignores the user, password, path and query', () => {
    expect(
      hostedEndpoint(
        `postgresql://u:p%40ss@db.example.com:6543/x?sslmode=disable`
      )
    ).toBe('db.example.com:6543');
  });

  it('lowercases the host', () => {
    expect(hostedEndpoint('postgresql://p:p@DB.Example.COM:6543/x')).toBe(
      'db.example.com:6543'
    );
  });

  it('trims the newline the file may end with', () => {
    expect(hostedEndpoint(`${HARNESS_POOLER_URL}\n`)).toBe(
      `host.docker.internal:${HOSTED_PORT}`
    );
  });

  it('reads an IPv4 host', () => {
    expect(
      hostedEndpoint('postgresql://p:p@192.168.65.254:55432/postgres')
    ).toBe('192.168.65.254:55432');
  });

  it.each([
    ['an empty string', ''],
    ['only whitespace', ' \n'],
    ['text that is not a URL', 'not a url'],
    ['a URL with no host', 'postgresql:///postgres'],
  ])('is undefined for %s', (_, url) => {
    expect(hostedEndpoint(url)).toBeUndefined();
  });
});

describe('readHostedEndpoints', () => {
  it('reads supabase/.temp/pooler-url with cat and returns its host and port', async () => {
    const { ctx, calls } = fakeExec(commandResult(HARNESS_POOLER_URL));

    expect(await readHostedEndpoints(ctx)).toEqual([
      `host.docker.internal:${HOSTED_PORT}`,
    ]);
    expect(calls).toEqual(['cat supabase/.temp/pooler-url']);
  });

  it('names the file the CLI reads the pooler URL from', () => {
    expect(POOLER_URL_PATH).toBe('supabase/.temp/pooler-url');
  });

  it('trims the newline the file may end with', async () => {
    const { ctx } = fakeExec(commandResult(`${HARNESS_POOLER_URL}\n`));

    expect(await readHostedEndpoints(ctx)).toEqual([
      `host.docker.internal:${HOSTED_PORT}`,
    ]);
  });

  it('returns nothing when the file does not exist', async () => {
    const { ctx } = fakeExec({
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: 'cat: supabase/.temp/pooler-url: No such file or directory',
    });

    expect(await readHostedEndpoints(ctx)).toEqual([]);
  });

  it('returns nothing when the file cannot be read', async () => {
    const { ctx } = fakeExec({
      ok: false,
      exitCode: 1,
      stdout: HARNESS_POOLER_URL,
      stderr: 'cat: supabase/.temp/pooler-url: Permission denied',
    });

    expect(await readHostedEndpoints(ctx)).toEqual([]);
  });

  it.each([
    ['garbage', 'not a url at all'],
    ['empty', ''],
    ['binary noise', '\u0000\u0001\ufffd'],
  ])('returns nothing when the file holds %s', async (_, content) => {
    const { ctx } = fakeExec(commandResult(content));

    expect(await readHostedEndpoints(ctx)).toEqual([]);
  });

  it('returns nothing instead of throwing when exec throws', async () => {
    const { ctx } = fakeExec(() => {
      throw new Error('sandbox gone');
    });

    expect(await readHostedEndpoints(ctx)).toEqual([]);
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

  describe('with a success pattern', () => {
    const failed = (options: Parameters<typeof call>[0]) =>
      toolCallFailed(call(options), undefined, PUSH_SUCCESS);

    it.each([
      [
        'a tool error',
        { result: 'Finished supabase db push.', error: 'exit 1' },
      ],
      [
        'a CLI failure line after it',
        { result: `Finished supabase db push.\n${FLAG_GROUP_CONFLICT}` },
      ],
      [
        'both a CLI failure line and a tool error',
        {
          result: `Finished supabase db push.\n${FLAG_GROUP_CONFLICT}`,
          error: 'exit 1',
        },
      ],
      [
        'the output in the error text of a call with no result',
        { error: `exit 1\nFinished supabase db push.\n${FLAG_GROUP_CONFLICT}` },
      ],
    ])(
      'is false when the output shows the success text next to %s',
      (_, options) => {
        expect(failed(options)).toBe(false);
      }
    );

    it('is false when the success text is the only output', () => {
      expect(failed({ result: 'Finished supabase db push.' })).toBe(false);
    });

    it.each([
      ['a tool error and no output', { error: 'exit 1' }],
      ['a CLI failure line', { result: UNLINKED_ERROR }],
      [
        'a failure of another command and no success text',
        { result: FLAG_GROUP_CONFLICT, error: 'exit 1' },
      ],
      [
        'text that only resembles the success text',
        { result: 'Finished supabase db pull.', error: 'exit 1' },
      ],
    ])('is still true for %s', (_, options) => {
      expect(failed(options)).toBe(true);
    });

    it('does not apply the success pattern when none is given', () => {
      expect(
        toolCallFailed(
          call({ result: 'Finished supabase db push.', error: 'exit 1' })
        )
      ).toBe(true);
    });

    it('is false when there is no tool call', () => {
      expect(toolCallFailed(undefined, undefined, PUSH_SUCCESS)).toBe(false);
    });

    it('still reads the extra failure pattern when the success text is absent', () => {
      expect(
        toolCallFailed(
          call({ result: 'pg_dump: error: boom' }),
          /pg_dump: error/i,
          PUSH_SUCCESS
        )
      ).toBe(true);
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

  describe('with a success pattern', () => {
    it('is undefined when the output shows the success text, though the call errored', () => {
      expect(
        toolCallFailureLine(
          call({
            result: `Finished supabase db push.\n${FLAG_GROUP_CONFLICT}`,
            error: 'exit 1',
          }),
          undefined,
          PUSH_SUCCESS
        )
      ).toBeUndefined();
    });

    it('still reports the failure line when the success text is absent', () => {
      expect(
        toolCallFailureLine(
          call({ result: FLAG_GROUP_CONFLICT, error: 'exit 1' }),
          undefined,
          PUSH_SUCCESS
        )
      ).toBe(FLAG_GROUP_CONFLICT);
    });

    it('reports the failure line when no success pattern is given', () => {
      expect(
        toolCallFailureLine(
          call({ result: `Finished supabase db push.\n${FLAG_GROUP_CONFLICT}` })
        )
      ).toBe(FLAG_GROUP_CONFLICT);
    });
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
