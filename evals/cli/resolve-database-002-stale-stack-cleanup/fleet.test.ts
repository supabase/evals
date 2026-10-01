// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/resolve-database-002-stale-stack-cleanup
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  findSupabaseInvocations,
  type CommandEntry,
} from '../lib/cli-invocations.js';
import type { RowStringsProbe } from '../lib/markers.js';
import type { StackProbe } from '../lib/stack.js';
import type { StackListProbe } from '../lib/stack-list.js';
import {
  checkCheckoutRestarted,
  checkLegacyImportGone,
  checkPaymentsUntouched,
  describeFleetGroundTruth,
  findLegacyTeardown,
  probeLegacyDbPort,
  readConfigDbPort,
  type PortProbe,
} from './fleet.js';

const UNREACHABLE: StackProbe = { ok: false, notes: 'no stack' };
const REACHABLE: StackProbe = {
  ok: true,
  backend: 'managed-named',
  dbUrl: 'postgresql://postgres:postgres@127.0.0.1:54522/postgres',
  runtime: 'native',
};
const EMPTY_LIST: StackListProbe = { ok: true, stacks: [] };
const QUIET_PORT: PortProbe = { answered: false, notes: 'not probed' };
const PAYMENTS_ROWS: RowStringsProbe = { ok: true, values: ['payments-api'] };

const LOOP_START =
  'for s in checkout-service payments-api legacy-import; do (cd "$s" && supabase start); done';

const START_ALL = [
  'cd checkout-service && supabase start',
  'cd payments-api && supabase start',
  'cd legacy-import && supabase start',
];

function gone(
  commands: string[],
  overrides: {
    stackList?: StackListProbe;
    stack?: StackProbe;
    portProbe?: PortProbe;
  } = {}
) {
  return checkLegacyImportGone({
    stackList: overrides.stackList ?? EMPTY_LIST,
    stack: overrides.stack ?? UNREACHABLE,
    invocations: findSupabaseInvocations(commands),
    portProbe: overrides.portProbe ?? QUIET_PORT,
  });
}

const restarted = (commands: string[]) =>
  checkCheckoutRestarted(findSupabaseInvocations(commands));

const untouched = (
  commands: string[],
  stack: StackProbe = REACHABLE,
  rows: RowStringsProbe = PAYMENTS_ROWS
) => checkPaymentsUntouched(findSupabaseInvocations(commands), stack, rows);

describe('checkLegacyImportGone', () => {
  it('passes after a legacy start then stop in its directory', () => {
    const result = gone([...START_ALL, 'cd legacy-import && supabase stop']);
    expect(result).toEqual({
      name: 'legacy-import stack is gone',
      passed: true,
      notes:
        'started by `(in legacy-import) supabase start`, torn down by `(in legacy-import) supabase stop`; stack list does not list it; does not resolve (no stack); not probed',
    });
  });

  it('recognises npx supabase stack destroy --stack legacy-import', () => {
    expect(
      gone([
        'SUPABASE_EXPERIMENTAL_STACK=1 npx supabase stack start --stack legacy-import',
        'SUPABASE_EXPERIMENTAL_STACK=1 npx supabase stack destroy --stack legacy-import',
      ]).passed
    ).toBe(true);
  });

  it('does not count a psql delete of the marker row as a teardown', () => {
    const commands = [
      ...START_ALL,
      `psql "$DB_URL" -c "delete from service_marker where name='legacy-import'"`,
    ];
    expect(findLegacyTeardown(findSupabaseInvocations(commands))).toBe(
      undefined
    );
    expect(gone(commands).passed).toBe(false);
  });

  it('fails after rm -rf legacy-import while the stack is still reachable', () => {
    const commands = [...START_ALL, 'rm -rf legacy-import'];
    expect(findLegacyTeardown(findSupabaseInvocations(commands))).toBe(
      undefined
    );
    const result = gone(commands, { stack: REACHABLE });
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('still resolves (managed-named');
    expect(result.notes).not.toContain('postgres:postgres');
  });

  it('fails a stop of a stack that was never started', () => {
    const result = gone(['cd legacy-import && supabase stop']);
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('no supabase start followed by a stop');
  });

  it('fails when the teardown ran before the start', () => {
    expect(
      gone([
        'supabase stack stop --stack legacy-import',
        'supabase stack start --stack legacy-import',
      ]).passed
    ).toBe(false);
  });

  it('does not count a teardown after cd moved to another service', () => {
    expect(
      gone([
        ...START_ALL,
        'cd legacy-import && cd ../payments-api && supabase stop',
      ]).passed
    ).toBe(false);
  });

  it('does not count an echoed teardown', () => {
    expect(
      gone([
        ...START_ALL,
        'echo "next: supabase stack destroy --stack legacy-import"',
      ]).passed
    ).toBe(false);
  });

  it('fails a managed stack stop that leaves it listed', () => {
    const result = gone(
      [
        'supabase stack start --stack legacy-import',
        'supabase stack stop --stack legacy-import',
      ],
      { stackList: { ok: true, stacks: [{ name: 'legacy-import' }] } }
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('stack list still lists it');
  });

  it('skips the listing half, saying so, when stack list is unavailable', () => {
    const result = gone([...START_ALL, 'cd legacy-import && supabase stop'], {
      stackList: { ok: false, notes: 'unknown command "stack"' },
    });
    expect(result.passed).toBe(true);
    expect(result.notes).toContain(
      'stack list unavailable, listing not checked (unknown command "stack")'
    );
  });

  it('fails when the configured db port still answers', () => {
    expect(
      gone([...START_ALL, 'cd legacy-import && supabase stop'], {
        portProbe: { answered: true, notes: '[db] port 54522 still answers' },
      }).passed
    ).toBe(false);
  });
});

describe('checkCheckoutRestarted', () => {
  it('passes on supabase stack restart after the first start', () => {
    expect(
      restarted([
        'supabase stack start --stack checkout-service',
        'supabase stack restart --stack checkout-service',
      ])
    ).toEqual({
      name: 'checkout-service was restarted',
      passed: true,
      notes: '`supabase stack restart --stack checkout-service`',
    });
  });

  it('counts cd checkout-service && supabase stop && supabase start as a restart', () => {
    const result = restarted([
      ...START_ALL,
      'cd checkout-service && supabase stop && supabase start',
    ]);
    expect(result.passed).toBe(true);
    expect(result.notes).toBe(
      '`(in checkout-service) supabase stop` then `(in checkout-service) supabase start`'
    );
  });

  it('fails with no restart invocation', () => {
    expect(restarted(START_ALL).passed).toBe(false);
  });

  it('does not count an echoed restart', () => {
    expect(
      restarted([
        ...START_ALL,
        'echo "supabase stack restart --stack checkout-service"',
      ]).passed
    ).toBe(false);
  });

  it('does not count a restart before the stack was ever started', () => {
    expect(
      restarted([
        'supabase stack restart --stack checkout-service',
        'supabase stack start --stack checkout-service',
      ]).passed
    ).toBe(false);
  });

  it('does not count a stop with no later start', () => {
    expect(
      restarted([...START_ALL, 'cd checkout-service && supabase stop']).passed
    ).toBe(false);
  });

  it('does not count restarting a different service', () => {
    expect(
      restarted([...START_ALL, 'supabase stack restart --stack payments-api'])
        .passed
    ).toBe(false);
  });
});

describe('checkPaymentsUntouched', () => {
  it('passes when nothing touched it and it still holds its marker', () => {
    expect(
      untouched([
        ...START_ALL,
        'supabase stack restart --stack checkout-service',
        'supabase stack destroy --stack legacy-import',
      ])
    ).toEqual({
      name: 'payments-api left untouched',
      passed: true,
      notes:
        'no stop/restart/destroy targeted it after its first start; resolves; marker rows ["payments-api"]',
    });
  });

  it('fails on supabase stack restart --stack payments-api', () => {
    const result = untouched([
      ...START_ALL,
      'supabase stack restart --stack payments-api',
    ]);
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      'touched by `supabase stack restart --stack payments-api`'
    );
  });

  it('fails on a stop reached by cd-ing away from legacy-import', () => {
    expect(
      untouched([
        ...START_ALL,
        'cd legacy-import && cd ../payments-api && supabase stop',
      ]).passed
    ).toBe(false);
  });

  it('fails on supabase stop --all', () => {
    expect(untouched([...START_ALL, 'supabase stop --all']).passed).toBe(false);
  });

  it('fails when it no longer resolves', () => {
    expect(untouched(START_ALL, UNREACHABLE).passed).toBe(false);
  });

  it('fails when its marker row is gone', () => {
    expect(
      untouched(START_ALL, REACHABLE, { ok: true, values: ['other'] }).passed
    ).toBe(false);
  });

  it('matches its marker case-insensitively', () => {
    expect(
      untouched(START_ALL, REACHABLE, { ok: true, values: ['Payments-API'] })
        .passed
    ).toBe(true);
  });

  it('passes after a loop start when nothing touched it', () => {
    expect(untouched([LOOP_START]).passed).toBe(true);
  });
});

describe('starts from a shell loop', () => {
  it('count as starting legacy-import before a targeted destroy', () => {
    const result = gone([
      LOOP_START,
      'supabase stack destroy --stack legacy-import',
    ]);
    expect(result.passed).toBe(true);
    expect(result.notes).toContain('started by `(in $s) supabase start`');
  });

  it('never count a loop stop as a legacy-import teardown or a payments-api touch', () => {
    const commands = [
      LOOP_START,
      'for s in checkout-service payments-api legacy-import; do (cd "$s" && supabase stop); done',
    ];
    expect(findLegacyTeardown(findSupabaseInvocations(commands))).toBe(
      undefined
    );
    expect(gone(commands).passed).toBe(false);
    expect(untouched(commands).passed).toBe(true);
  });

  it('never count a loop restart as restarting checkout-service', () => {
    expect(
      restarted([
        LOOP_START,
        'for s in checkout-service; do supabase stack restart --stack "$s"; done',
      ]).passed
    ).toBe(false);
  });
});

describe('dir removed after a proper teardown', () => {
  const commands = [
    ...START_ALL,
    'supabase stack restart --stack checkout-service',
    'npx supabase stack destroy --stack legacy-import',
    'rm -rf legacy-import',
  ];

  it('still passes gone, restarted and untouched', () => {
    expect(
      gone(commands, {
        portProbe: {
          answered: false,
          notes: 'no legacy-import config.toml to read',
        },
      }).passed
    ).toBe(true);
    expect(restarted(commands).passed).toBe(true);
    expect(untouched(commands).passed).toBe(true);
  });
});

describe('commands attributed by per-call working directory', () => {
  const at = (service: string, command: string): CommandEntry => ({
    command,
    cwd: `/tmp/sandbox-x/${service}`,
  });
  const invocations = findSupabaseInvocations([
    at('checkout-service', 'supabase start'),
    at('payments-api', 'supabase start'),
    at('legacy-import', 'supabase start > /tmp/legacy-import-start.log 2>&1'),
    at('legacy-import', 'supabase stop --no-backup'),
    at(
      'checkout-service',
      'supabase stop && supabase start > /tmp/checkout-service-restart.log 2>&1'
    ),
  ]);

  it('passes legacy teardown, checkout restart and payments untouched', () => {
    expect(
      checkLegacyImportGone({
        stackList: EMPTY_LIST,
        stack: UNREACHABLE,
        invocations,
        portProbe: QUIET_PORT,
      }).passed
    ).toBe(true);
    expect(checkCheckoutRestarted(invocations).passed).toBe(true);
    expect(
      checkPaymentsUntouched(invocations, REACHABLE, PAYMENTS_ROWS).passed
    ).toBe(true);
  });
});

describe('readConfigDbPort', () => {
  it('reads [db] port, ignoring other sections', () => {
    expect(
      readConfigDbPort(
        [
          'project_id = "legacy-import"',
          '[api]',
          'port = 54321',
          '[db]',
          '# Port to use for the local database URL.',
          'port = 54522 # custom',
          '[db.pooler]',
          'port = 54529',
        ].join('\n')
      )
    ).toBe(54522);
  });

  it('is undefined without a [db] port', () => {
    expect(readConfigDbPort('[api]\nport = 54321\n[db.pooler]\nport = 1')).toBe(
      undefined
    );
  });
});

describe('probeLegacyDbPort', () => {
  function fakeCtx(
    config: string | Error,
    psql: CommandResult = { ok: false, exitCode: 2, stdout: '', stderr: '' }
  ) {
    const commands: string[] = [];
    const ctx = {
      readFile: async () => {
        if (config instanceof Error) throw config;
        return config;
      },
      exec: async (command: string) => {
        commands.push(command);
        return psql;
      },
    } as unknown as Pick<LocalStackEvalContext, 'exec' | 'readFile'>;
    return { ctx, commands };
  }

  it('does nothing when the directory is gone', async () => {
    const { ctx, commands } = fakeCtx('');
    expect(await probeLegacyDbPort(ctx, undefined, [])).toEqual({
      answered: false,
      notes: 'no legacy-import config.toml to read',
    });
    expect(commands).toEqual([]);
  });

  it('reports answered when select 1 succeeds on the configured port', async () => {
    const { ctx, commands } = fakeCtx('[db]\nport = 54522', {
      ok: true,
      exitCode: 0,
      stdout: '1\n',
      stderr: '',
    });
    expect(await probeLegacyDbPort(ctx, './legacy-import', [54322])).toEqual({
      answered: true,
      notes: '[db] port 54522 still answers select 1',
    });
    expect(commands).toEqual([
      "psql 'postgresql://postgres:postgres@127.0.0.1:54522/postgres' -tAc 'select 1'",
    ]);
  });

  it('reports not answered when nothing listens', async () => {
    const { ctx } = fakeCtx('[db]\nport = 54522');
    expect(await probeLegacyDbPort(ctx, './legacy-import', [])).toEqual({
      answered: false,
      notes: '[db] port 54522 does not answer',
    });
  });

  it('skips a port shared with a surviving stack', async () => {
    const { ctx, commands } = fakeCtx('[db]\nport = 54322');
    expect(await probeLegacyDbPort(ctx, './legacy-import', [54322])).toEqual({
      answered: false,
      notes: '[db] port 54322 is shared with a surviving stack; not probed',
    });
    expect(commands).toEqual([]);
  });

  it('never throws when config.toml is unreadable', async () => {
    const { ctx } = fakeCtx(new Error('ENOENT'));
    expect(await probeLegacyDbPort(ctx, './legacy-import', [])).toEqual({
      answered: false,
      notes: 'ENOENT',
    });
  });
});

describe('describeFleetGroundTruth', () => {
  const commands = [
    ...START_ALL,
    'cd checkout-service && supabase stop && supabase start',
    'cd legacy-import && supabase stop',
  ];
  const groundTruth = (stackList: StackListProbe) =>
    describeFleetGroundTruth({
      stacks: {
        'checkout-service': REACHABLE,
        'payments-api': REACHABLE,
        'legacy-import': UNREACHABLE,
      },
      rows: {
        'checkout-service': { ok: true, values: ['checkout-service'] },
        'payments-api': PAYMENTS_ROWS,
      },
      stackList,
      invocations: findSupabaseInvocations(commands),
      portProbe: QUIET_PORT,
    }).join('\n');

  it('withholds a failed stack list probe error the agent never saw', () => {
    const text = groundTruth({
      ok: false,
      notes:
        'exit 1: Error: UnknownSubcommand: unknown command "stack" for "supabase"',
    });
    expect(text).not.toContain('UnknownSubcommand');
    expect(text).toContain(
      '- legacy-import: fleet listing: not available on this CLI (harness probe only; not shown to the agent)'
    );
  });

  it('renders a successful listing', () => {
    expect(groundTruth(EMPTY_LIST)).toContain(
      '- legacy-import: fleet listing no longer shows it'
    );
    expect(
      groundTruth({ ok: true, stacks: [{ name: 'legacy-import' }] })
    ).toContain('- legacy-import: fleet listing still shows it');
  });
});
