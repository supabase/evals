// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/resolve-database-002-stale-stack-cleanup
import type {
  CommandResult,
  LocalStackEvalContext,
  ToolCallRecord,
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
  findFleetInvocations,
  findLegacyLifecycle,
  findSetup,
  lifecycleEvents,
  probeLegacyContainers,
  probeLegacyDbPort,
  readConfigDbPort,
  readHomeStackLists,
  readPostmasterStarts,
  type ContainerProbe,
  type FleetInvocation,
  type HomeStackList,
  type PortProbe,
} from './fleet.js';
import type { Service } from './services.js';

const UNREACHABLE: StackProbe = { ok: false, notes: 'no stack' };
const REACHABLE: StackProbe = {
  ok: true,
  backend: 'managed-named',
  dbUrl: 'postgresql://postgres:postgres@127.0.0.1:54522/postgres',
  runtime: 'native',
};
const EMPTY_LIST: StackListProbe = { ok: true, stacks: [] };
const QUIET_PORT: PortProbe = { answered: false, notes: 'not probed' };
const NO_CONTAINERS: ContainerProbe = {
  running: false,
  notes: 'no containers',
};
const PAYMENTS_ROWS: RowStringsProbe = { ok: true, values: ['payments-api'] };
const NO_POSTMASTER = { 'checkout-service': null, 'payments-api': null };

const LOOP_START =
  'for s in checkout-service payments-api legacy-import; do (cd "$s" && supabase start); done';

const START_ALL = [
  'cd checkout-service && supabase start',
  'cd payments-api && supabase start',
  'cd legacy-import && supabase start',
];

type Outcome = Partial<
  Pick<ToolCallRecord, 'result' | 'error' | 'resultTs' | 'cwd'>
>;
type Call = string | [command: string, outcome: Outcome];

function toolCall([command, outcome]: [string, Outcome?]): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'Bash' },
    body: {},
    command,
    ts: 0,
    ...outcome,
  };
}

const invocationsOf = (calls: readonly Call[]): FleetInvocation[] =>
  findFleetInvocations(
    calls.map((call) => toolCall(typeof call === 'string' ? [call] : call))
  );

const ok = (result: unknown = ''): Outcome => ({ result });
const failed = (error: string): Outcome => ({ error });

function gone(
  commands: readonly Call[],
  overrides: {
    stackList?: StackListProbe;
    stack?: StackProbe;
    portProbe?: PortProbe;
    containerProbe?: ContainerProbe;
    homeStackLists?: HomeStackList[];
  } = {}
) {
  return checkLegacyImportGone({
    homeStackLists: overrides.homeStackLists,
    stackList: overrides.stackList ?? EMPTY_LIST,
    stack: overrides.stack ?? UNREACHABLE,
    invocations: invocationsOf(commands),
    portProbe: overrides.portProbe ?? QUIET_PORT,
    containerProbe: overrides.containerProbe ?? NO_CONTAINERS,
  });
}

const restarted = (
  commands: readonly Call[],
  postmasterStartMs: number | null = null
) => checkCheckoutRestarted(invocationsOf(commands), postmasterStartMs);

const untouched = (
  commands: readonly Call[],
  stack: StackProbe = REACHABLE,
  rows: RowStringsProbe = PAYMENTS_ROWS,
  postmasterStartMs: number | null = null
) =>
  checkPaymentsUntouched(
    invocationsOf(commands),
    postmasterStartMs,
    stack,
    rows
  );

const SETUP = 'after setup (cmd #3 "supabase start" in legacy-import)';

describe('checkLegacyImportGone', () => {
  it('passes after a legacy start then stop in its directory', () => {
    const result = gone([...START_ALL, 'cd legacy-import && supabase stop']);
    expect(result).toEqual({
      name: 'legacy-import stack is gone',
      passed: true,
      notes:
        'listing: stack list does not list it; resolution: does not resolve (no stack); db port: not probed; containers: no containers; commands: started by cmd #3 "supabase start" in legacy-import; teardown cmd #4 "supabase stop" in legacy-import (succeeded)',
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
    expect(findLegacyLifecycle(invocationsOf(commands)).outcome).toBe('none');
    expect(gone(commands, { stack: REACHABLE }).passed).toBe(false);
  });

  it('fails after rm -rf legacy-import while the stack is still reachable', () => {
    const commands = [...START_ALL, 'rm -rf legacy-import'];
    expect(findLegacyLifecycle(invocationsOf(commands)).outcome).toBe('none');
    const result = gone(commands, { stack: REACHABLE });
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('still resolves (managed-named');
    expect(result.notes).not.toContain('postgres:postgres');
  });

  it('fails a stop of a stack that was never started', () => {
    const result = gone(['cd legacy-import && supabase stop']);
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      'commands: no supabase start targeting legacy-import ran without failing'
    );
  });

  it('does not count a teardown that ran before the start', () => {
    const result = gone([
      'supabase stack stop --stack legacy-import',
      'supabase stack start --stack legacy-import',
    ]);
    expect(result.passed).toBe(true);
    expect(result.notes).toContain('no teardown command found');
  });

  it('does not count a teardown after cd moved to another service', () => {
    const commands = [
      ...START_ALL,
      'cd legacy-import && cd ../payments-api && supabase stop',
    ];
    expect(findLegacyLifecycle(invocationsOf(commands)).outcome).toBe('none');
  });

  it('does not count an echoed teardown', () => {
    const commands = [
      ...START_ALL,
      'echo "next: supabase stack destroy --stack legacy-import"',
    ];
    expect(findLegacyLifecycle(invocationsOf(commands)).outcome).toBe('none');
  });

  it('passes by end state when no teardown command ran, saying so', () => {
    const result = gone([
      ...START_ALL,
      'docker rm -f supabase_db_legacy-import',
    ]);
    expect(result.passed).toBe(true);
    expect(result.notes).toContain(
      'commands: started by cmd #3 "supabase start" in legacy-import; no teardown command found'
    );
  });

  it('fails a stack that was never started even when the state is clear', () => {
    expect(gone(['cd legacy-import && supabase stop']).passed).toBe(false);
    expect(gone([]).passed).toBe(false);
  });

  it('fails a started stack that is still listed, however the teardown went', () => {
    const stackList: StackListProbe = {
      ok: true,
      stacks: [{ name: 'legacy-import' }],
    };
    expect(
      gone([...START_ALL, 'cd legacy-import && supabase stop'], { stackList })
        .passed
    ).toBe(false);
    expect(gone(START_ALL, { stackList }).passed).toBe(false);
  });

  describe('when the teardown command failed but the state is clear', () => {
    const stop = (error: string): Call[] => [
      ...START_ALL,
      ['cd legacy-import && supabase stop --no-backup', failed(error)],
    ];

    it('passes, naming the StopVolumePruneError as a product gap', () => {
      const result = gone(stop('exit 1: StopVolumePruneError: docker too old'));
      expect(result.passed).toBe(true);
      expect(result.notes).toContain(
        'teardown cmd #4 "supabase stop --no-backup" in legacy-import (failed: StopVolumePruneError, see CLI-2637) (product gap CLI-2637)'
      );
    });

    it('reads the LegacyStopVolumePruneError name from structured output', () => {
      const result = gone([
        ...START_ALL,
        [
          'cd legacy-import && supabase stop --no-backup',
          ok('{"_tag":"Error","code":"LegacyStopVolumePruneError"}'),
        ],
      ]);
      expect(result.passed).toBe(true);
      expect(result.notes).toContain(
        '(failed: LegacyStopVolumePruneError, see CLI-2637) (product gap CLI-2637)'
      );
    });

    it('reports another failure without the product-gap note', () => {
      const result = gone(stop('exit 1: permission denied'));
      expect(result.passed).toBe(true);
      expect(result.notes).toContain(
        'stop --no-backup" in legacy-import (failed)'
      );
      expect(result.notes).not.toContain('CLI-2637');
    });

    it('fails when the state still shows it', () => {
      expect(
        gone(stop('exit 1: StopVolumePruneError'), { stack: REACHABLE }).passed
      ).toBe(false);
      expect(
        gone(stop('exit 1: StopVolumePruneError'), {
          containerProbe: { running: true, notes: 'docker still runs x' },
        }).passed
      ).toBe(false);
    });

    it('prefers a later teardown that succeeded for the report', () => {
      const result = gone([
        ...stop('exit 1: StopVolumePruneError'),
        'cd legacy-import && supabase stop',
      ]);
      expect(result.notes).toContain('(succeeded)');
      expect(result.notes).not.toContain('product gap');
    });
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

  it('skips the listing half, saying so, when stack list is unsupported', () => {
    const result = gone([...START_ALL, 'cd legacy-import && supabase stop'], {
      stackList: {
        ok: false,
        unsupported: true,
        notes: 'unknown command "stack"',
      },
    });
    expect(result.passed).toBe(true);
    expect(result.notes).toContain(
      'stack list unsupported, listing not checked (unknown command "stack")'
    );
  });

  it('fails closed when the stack list output is unreadable', () => {
    const result = gone([...START_ALL, 'cd legacy-import && supabase stop'], {
      stackList: {
        ok: false,
        unsupported: false,
        notes: 'unreadable stack list output (exit 0: legacy-import stopped)',
      },
    });
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('stack list unreadable, failing closed');
  });

  it('fails when the configured db port still answers', () => {
    expect(
      gone([...START_ALL, 'cd legacy-import && supabase stop'], {
        portProbe: { answered: true, notes: '[db] port 54522 still answers' },
      }).passed
    ).toBe(false);
  });
});

describe('legacy-import under a relocated CLI home', () => {
  const HOME = '/sandbox/.supabase-home';
  const RELOCATED = [
    'cd checkout-service && SUPABASE_HOME=/sandbox/.supabase-home supabase start',
    'cd payments-api && SUPABASE_HOME=/sandbox/.supabase-home supabase start',
    'cd legacy-import && SUPABASE_HOME=/sandbox/.supabase-home supabase start',
    'cd legacy-import && SUPABASE_HOME=/sandbox/.supabase-home supabase stop',
  ];
  const listed = (): HomeStackList => ({
    home: HOME,
    list: { ok: true, stacks: [{ name: 'legacy-import' }] },
  });
  const empty = (): HomeStackList => ({ home: HOME, list: EMPTY_LIST });

  it('fails when the relocated listing still shows it', () => {
    const result = gone(RELOCATED, { homeStackLists: [listed()] });
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      `listing under relocated home ${HOME}: stack list still lists it`
    );
  });

  it('fails when the stack still resolves under the relocated home', () => {
    const result = gone(RELOCATED, {
      homeStackLists: [empty()],
      stack: { ...REACHABLE, relocatedHome: HOME },
    });
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(`relocated home: ${HOME}`);
  });

  it('passes once the stack is destroyed under that home too', () => {
    const result = gone(RELOCATED, { homeStackLists: [empty()] });
    expect(result.passed).toBe(true);
    expect(result.notes).toContain(
      `listing under relocated home ${HOME}: stack list does not list it`
    );
  });

  it('fails closed on an unreadable relocated listing', () => {
    const result = gone(RELOCATED, {
      homeStackLists: [
        {
          home: HOME,
          list: { ok: false, unsupported: false, notes: 'garbled' },
        },
      ],
    });
    expect(result.passed).toBe(false);
  });

  it('lists under each relocated home the agent started it with', async () => {
    const commands: string[] = [];
    const ctx = {
      exec: async (command: string) => {
        commands.push(command);
        return commandResult('{"stacks":[]}');
      },
    } as unknown as Pick<LocalStackEvalContext, 'exec'>;
    const lists = await readHomeStackLists(ctx, [
      { SUPABASE_HOME: HOME },
      { HOME: '/sandbox/h' },
    ]);
    expect(lists.map(({ home }) => home)).toEqual([
      HOME,
      '/sandbox/h/.supabase',
    ]);
    expect(commands[0]).toBe(
      `SUPABASE_HOME='${HOME}' SUPABASE_EXPERIMENTAL_STACK=1 supabase stack list --output-format json`
    );
  });

  it('tells the judge where legacy-import is still alive', () => {
    const text = describeFleetGroundTruth({
      stacks: {
        'checkout-service': REACHABLE,
        'payments-api': REACHABLE,
        'legacy-import': { ...REACHABLE, relocatedHome: HOME },
      },
      rows: {
        'checkout-service': { ok: true, values: ['checkout-service'] },
        'payments-api': PAYMENTS_ROWS,
      },
      stackList: EMPTY_LIST,
      homeStackLists: [listed()],
      invocations: invocationsOf(RELOCATED),
      postmasterStarts: NO_POSTMASTER,
      portProbe: QUIET_PORT,
      containerProbe: NO_CONTAINERS,
    }).join('\n');
    expect(text).toContain(
      `fleet listing no longer shows it (still listed under the agent's relocated CLI home ${HOME})`
    );
    expect(text).toContain(
      `stack resolves: yes (under the agent's relocated CLI home ${HOME})`
    );
  });
});

describe('ground truth for legacy-import', () => {
  const facts = (calls: readonly Call[], gone = true) => ({
    stacks: {
      'checkout-service': REACHABLE,
      'payments-api': REACHABLE,
      'legacy-import': gone ? UNREACHABLE : REACHABLE,
    },
    rows: {
      'checkout-service': { ok: true, values: ['checkout-service'] },
      'payments-api': PAYMENTS_ROWS,
    } as const,
    stackList: EMPTY_LIST,
    invocations: invocationsOf(calls),
    postmasterStarts: NO_POSTMASTER,
    portProbe: QUIET_PORT,
    containerProbe: NO_CONTAINERS,
  });

  it('states gone by end state and the failed teardown as a fact', () => {
    const text = describeFleetGroundTruth(
      facts([
        ...START_ALL,
        [
          'cd legacy-import && supabase stop --no-backup',
          failed('exit 1: StopVolumePruneError'),
        ],
      ])
    ).join('\n');
    expect(text).toContain('gone by end state');
    expect(text).toMatch(/gone by end state[^\n]*: yes/);
    expect(text).toContain(
      'teardown command: teardown cmd #4 "supabase stop --no-backup" in legacy-import (failed: StopVolumePruneError, see CLI-2637); a VolumePruneError on stop is a CLI product gap (CLI-2637)'
    );
  });

  it('states a missing teardown command and a stack still present', () => {
    const text = describeFleetGroundTruth(facts(START_ALL, false)).join('\n');
    expect(text).toMatch(/gone by end state[^\n]*: no/);
    expect(text).toContain('teardown command: no teardown command found');
  });
});

describe('ground truth for a swapped CLI version', () => {
  const RUNNER = 'npx --yes supabase@2.120.0';
  const facts = (commands: readonly string[], cliOverride: string[]) => ({
    stacks: {
      'checkout-service': REACHABLE,
      'payments-api': UNREACHABLE,
      'legacy-import': UNREACHABLE,
    },
    rows: {
      'checkout-service': { ok: true, values: ['checkout-service'] },
      'payments-api': { ok: false, notes: 'no stack' },
    } as const,
    stackList: EMPTY_LIST,
    invocations: invocationsOf(commands),
    postmasterStarts: NO_POSTMASTER,
    portProbe: QUIET_PORT,
    containerProbe: NO_CONTAINERS,
    cliOverride,
  });

  it('flags a service started only through the override', () => {
    const text = describeFleetGroundTruth(
      facts(
        [
          'cd checkout-service && supabase start',
          `cd payments-api && ${RUNNER} start`,
        ],
        [RUNNER]
      )
    ).join('\n');
    expect(text).toContain(
      `payments-api: started with ${RUNNER}, not the installed CLI; scorer uses the installed CLI`
    );
    expect(text).not.toContain('checkout-service: started with');
  });

  it('says nothing without an override', () => {
    const text = describeFleetGroundTruth(
      facts(['cd payments-api && supabase start'], [])
    ).join('\n');
    expect(text).not.toContain('not the installed CLI');
  });
});

describe('checkCheckoutRestarted', () => {
  it('passes on supabase stack restart after all three started', () => {
    expect(
      restarted([
        ...START_ALL,
        'supabase stack restart --stack checkout-service',
      ])
    ).toEqual({
      name: 'checkout-service was restarted',
      passed: true,
      notes: `commands: cmd #4 "supabase stack restart --stack checkout-service" ran without failing ${SETUP}; no timing recorded`,
    });
  });

  it('counts cd checkout-service && supabase stop && supabase start as a restart', () => {
    const result = restarted([
      ...START_ALL,
      'cd checkout-service && supabase stop && supabase start',
    ]);
    expect(result.passed).toBe(true);
    expect(result.notes).toBe(
      `commands: cmd #4 "supabase stop" in checkout-service then cmd #4 "supabase start" in checkout-service ran without failing ${SETUP}; no timing recorded`
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
      notes: `commands: no stop/restart/reset/destroy targeted it ${SETUP}; no timing recorded; resolves; marker rows ["payments-api"]`,
    });
  });

  it('fails on supabase stack restart --stack payments-api', () => {
    const result = untouched([
      ...START_ALL,
      'supabase stack restart --stack payments-api',
    ]);
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      'commands: touched by cmd #4 "supabase stack restart --stack payments-api"'
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

  it('matches its marker as a whole value only', () => {
    expect(
      untouched(START_ALL, REACHABLE, {
        ok: true,
        values: ['payments-api-archive'],
      }).passed
    ).toBe(false);
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
    expect(result.notes).toContain('started by cmd #1 "supabase start" in $s');
  });

  it('never count a loop stop as a legacy-import teardown or a payments-api touch', () => {
    const commands = [
      LOOP_START,
      'for s in checkout-service payments-api legacy-import; do (cd "$s" && supabase stop); done',
    ];
    expect(findLegacyLifecycle(invocationsOf(commands)).outcome).toBe('none');
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
        containerProbe: NO_CONTAINERS,
      }).passed
    ).toBe(true);
    expect(checkCheckoutRestarted(invocations, null).passed).toBe(true);
    expect(
      checkPaymentsUntouched(invocations, null, REACHABLE, PAYMENTS_ROWS).passed
    ).toBe(true);
  });
});

describe('directory attribution before stack name', () => {
  const kinds = (command: string, service: Service) =>
    lifecycleEvents(invocationsOf([command]), service).map(({ kind }) => kind);

  it('credits a --stack name inside another service directory to the directory', () => {
    const command =
      'cd legacy-import && supabase stack destroy --stack payments-api';
    expect(kinds(command, 'legacy-import')).toEqual(['teardown']);
    expect(kinds(command, 'payments-api')).toEqual([]);
  });

  it('credits a --stack name to its service from the sandbox root', () => {
    const command = 'supabase stack start --stack payments-api';
    expect(kinds(command, 'payments-api')).toEqual(['start']);
    expect(kinds(command, 'legacy-import')).toEqual([]);
  });

  it('credits an unrelated --stack name inside a service directory to that service', () => {
    const command = 'cd checkout-service && supabase stack start --stack demo';
    expect(kinds(command, 'checkout-service')).toEqual(['start']);
    expect(kinds(command, 'payments-api')).toEqual([]);
  });
});

describe('failed tool calls', () => {
  const START_BY_WORKDIR = [
    'supabase start --workdir checkout-service',
    'supabase start --workdir payments-api',
    'supabase start --workdir legacy-import',
  ];
  const RESTART =
    'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack restart --stack checkout-service';

  it('do not count a stack restart that exited non-zero', () => {
    const result = restarted([
      ...START_BY_WORKDIR,
      [RESTART, failed('Unknown subcommand stack')],
    ]);
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('ran without failing');
  });

  it('do not count a stack restart whose output is a CLI error envelope', () => {
    expect(
      restarted([
        ...START_BY_WORKDIR,
        [
          RESTART,
          ok(
            '{"_tag":"Error","code":"StackNotFound","message":"No managed stack exists"}'
          ),
        ],
      ]).passed
    ).toBe(false);
  });

  it('read a CLI error inside structured tool output', () => {
    expect(
      restarted([
        ...START_BY_WORKDIR,
        [
          RESTART,
          ok([{ type: 'text', text: 'Error: UnknownSubcommand: stack' }]),
        ],
      ]).passed
    ).toBe(false);
  });

  it('count a stack restart that succeeded or whose outcome was not recorded', () => {
    expect(
      restarted([...START_BY_WORKDIR, [RESTART, ok('Restarted.')]]).passed
    ).toBe(true);
    expect(restarted([...START_BY_WORKDIR, RESTART]).passed).toBe(true);
  });

  it('never count a top-level supabase restart, which no CLI has', () => {
    expect(
      restarted([
        ...START_BY_WORKDIR,
        'supabase restart --workdir checkout-service',
      ]).passed
    ).toBe(false);
  });

  it('do not count a stop then start when the stop failed', () => {
    expect(
      restarted([
        ...START_BY_WORKDIR,
        ['supabase stop --workdir checkout-service', failed('exit 1')],
        'supabase start --workdir checkout-service',
      ]).passed
    ).toBe(false);
  });

  it('do not count a failed teardown of legacy-import after its directory was removed', () => {
    const commands: Call[] = [
      ...START_BY_WORKDIR,
      'rm -rf legacy-import',
      [
        'supabase stop --workdir legacy-import',
        failed('cannot read config in legacy-import'),
      ],
    ];
    expect(findLegacyLifecycle(invocationsOf(commands)).outcome).toBe('failed');
    expect(gone(commands).notes).toContain('(failed)');
  });

  it('do not count a failed start as legacy-import start evidence', () => {
    expect(
      gone([
        ['supabase start --workdir legacy-import', failed('port in use')],
        'supabase stop --workdir legacy-import',
      ]).passed
    ).toBe(false);
  });

  it('map back to their tool call past calls with no command', () => {
    const invocations = findFleetInvocations([
      toolCall(['supabase start --workdir checkout-service']),
      {
        tool: { kind: 'other', toolName: 'Read' },
        body: {},
        path: 'x',
        ts: 0,
      },
      toolCall(['supabase start --workdir payments-api', failed('exit 1')]),
    ]);
    expect(invocations.map((inv) => inv.failed)).toEqual([undefined, true]);
  });
});

describe('starts that reported ready inside a failed call', () => {
  const READY = '[task] done: Stack is ready.';
  const START = (name: string) =>
    `SUPABASE_EXPERIMENTAL_STACK=1 supabase start --stack ${name}`;
  const startFlags = (calls: readonly Call[]) =>
    invocationsOf(calls).map((inv) => inv.failed);

  it('do not fail a start that printed ready before a later command exited 127', () => {
    expect(
      startFlags([
        [
          `${START('checkout-service')} > out && jq . out`,
          failed(`${READY}\nbash: jq: command not found\nexit 127`),
        ],
      ])
    ).toEqual([false]);
  });

  it('read ready markers from the result too', () => {
    expect(
      startFlags([
        [
          START('checkout-service'),
          {
            error: 'exit 1',
            result: 'Started supabase local development setup.',
          },
        ],
      ])
    ).toEqual([false]);
  });

  it('credit only as many starts as printed ready, in order', () => {
    expect(
      startFlags([
        [
          [
            'set -e',
            START('payments-api'),
            'supabase db query --stack payments-api "select 1"',
            START('legacy-import'),
          ].join('\n'),
          failed(`${READY}\ntls: handshake failure\nexit 1`),
        ],
      ])
    ).toEqual([false, true, true]);
  });

  it('keep every invocation failed when the output has a CLI error envelope', () => {
    expect(
      startFlags([
        [
          `${START('checkout-service')}; ${START('payments-api')}`,
          failed(`${READY}\n{"_tag":"Error","code":"StackNotFound"}`),
        ],
      ])
    ).toEqual([true, true]);
  });

  it('keep a failed start failed when nothing reported ready', () => {
    expect(
      startFlags([[START('checkout-service'), failed('port in use')]])
    ).toEqual([true]);
  });

  it('do not credit other verbs', () => {
    expect(
      startFlags([
        [
          'supabase stack restart --stack checkout-service',
          failed(`${READY}\nexit 1`),
        ],
      ])
    ).toEqual([true]);
  });

  describe('replaying a run where the first two starts hit unrelated failures', () => {
    const at = (iso: string): Outcome => ({ resultTs: Date.parse(iso) });
    const filler = (n: number): Call[] =>
      Array.from({ length: n }, (): Call => 'echo working');
    const CALLS: Call[] = [
      ...filler(17),
      [
        `${START('checkout-service')} > out && jq . out`,
        {
          ...failed(`${READY}\njq: command not found\nexit 127`),
          ...at('2026-10-07T12:41:00.000Z'),
        },
      ],
      ...filler(2),
      [
        [
          'set -e',
          START('payments-api'),
          'supabase db query --stack payments-api "insert into t values (1)"',
          START('legacy-import'),
        ].join('\n'),
        {
          ...failed(`${READY}\nTLS handshake failed\nexit 1`),
          ...at('2026-10-07T12:42:08.000Z'),
        },
      ],
      ...filler(6),
      [
        `supabase db query --stack legacy-import "select 1" && ${START('legacy-import')}`,
        { result: READY, ...at('2026-10-07T12:43:28.432Z') },
      ],
      'echo working',
      [
        [
          'supabase stack destroy --stack legacy-import --yes',
          'supabase stack restart --stack checkout-service',
        ].join('\n'),
        { result: 'done', ...at('2026-10-07T12:43:50.000Z') },
      ],
    ];
    const CHECKOUT_POSTMASTER = Date.parse('2026-10-07T12:43:56.389Z');
    const PAYMENTS_POSTMASTER = Date.parse('2026-10-07T12:42:07.900Z');

    it('anchors setup on the later successful start', () => {
      const setup = findSetup(invocationsOf(CALLS));
      expect(setup?.anchor.commandIndex).toBe(27);
      expect(setup?.anchor.at).toBe(Date.parse('2026-10-07T12:43:28.432Z'));
    });

    it('passes checkout restarted and payments untouched on state evidence', () => {
      const checkout = restarted(CALLS, CHECKOUT_POSTMASTER);
      expect(checkout.passed).toBe(true);
      expect(checkout.notes).toMatch(/^state: /);
      const payments = untouched(
        CALLS,
        REACHABLE,
        PAYMENTS_ROWS,
        PAYMENTS_POSTMASTER
      );
      expect(payments.passed).toBe(true);
      expect(payments.notes).toMatch(/^state: /);
    });
  });
});

describe('change phase', () => {
  it('ignores a setup-phase stop and start of checkout-service', () => {
    const result = restarted([
      'supabase start --workdir checkout-service',
      'supabase stop --workdir checkout-service',
      'supabase start --workdir checkout-service',
      'supabase start --workdir payments-api',
      'supabase start --workdir legacy-import',
      'supabase stop --workdir legacy-import',
    ]);
    expect(result.passed).toBe(false);
  });

  it('ignores a setup-phase retry of payments-api', () => {
    expect(
      untouched([
        'supabase start --workdir payments-api',
        'supabase stop --workdir payments-api',
        'supabase start --workdir payments-api',
        'supabase start --workdir checkout-service',
        'supabase start --workdir legacy-import',
        'supabase stack restart --stack checkout-service',
      ]).passed
    ).toBe(true);
  });

  it('never begins when a start failed, failing restart and untouched with a note', () => {
    const commands: Call[] = [
      'supabase start --workdir checkout-service',
      'supabase start --workdir payments-api',
      ['supabase start --workdir legacy-import', failed('port in use')],
      'supabase stack restart --stack checkout-service',
    ];
    const restart = restarted(commands);
    expect(restart.passed).toBe(false);
    expect(restart.notes).toBe(
      'unavailable: not all three services had a start that did not fail, so no change phase to check'
    );
    const payments = untouched(commands);
    expect(payments.passed).toBe(false);
    expect(payments.notes).toContain('no change phase to check');
  });

  it('still begins after a loop start', () => {
    expect(
      restarted([LOOP_START, 'supabase stack restart --stack checkout-service'])
        .passed
    ).toBe(true);
  });
});

describe('payments-api db reset', () => {
  it('counts as a touch after all three started', () => {
    const result = untouched([
      ...START_ALL,
      'supabase db reset --workdir payments-api',
    ]);
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      'commands: touched by cmd #4 "supabase db reset --workdir payments-api"'
    );
  });

  it('does not count during setup', () => {
    expect(
      untouched([
        'supabase start --workdir payments-api',
        'supabase db reset --workdir payments-api',
        'supabase start --workdir checkout-service',
        'supabase start --workdir legacy-import',
      ]).passed
    ).toBe(true);
  });
});

describe('leftover legacy-import containers', () => {
  it('fail gone even after a teardown that succeeded', () => {
    const result = gone(
      [
        ...START_ALL,
        'cd legacy-import && supabase stop',
        'rm -rf legacy-import',
      ],
      {
        containerProbe: {
          running: true,
          notes: 'docker still runs supabase_db_legacy-import',
        },
      }
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      'docker still runs supabase_db_legacy-import'
    );
  });
});

describe('probeLegacyContainers', () => {
  function fakeCtx(result: CommandResult | Error) {
    const commands: string[] = [];
    const ctx = {
      exec: async (command: string) => {
        commands.push(command);
        if (result instanceof Error) throw result;
        return result;
      },
    } as unknown as Pick<LocalStackEvalContext, 'exec'>;
    return { ctx, commands };
  }
  const docker = (stdout: string): CommandResult => ({
    ok: true,
    exitCode: 0,
    stdout,
    stderr: '',
  });

  it('does nothing while the directory exists', async () => {
    const { ctx, commands } = fakeCtx(docker(''));
    expect(await probeLegacyContainers(ctx, './legacy-import')).toEqual({
      running: false,
      notes: 'directory exists; containers not probed',
    });
    expect(commands).toEqual([]);
  });

  it('finds a container by the CLI project label', async () => {
    const { ctx, commands } = fakeCtx(
      docker('sandbox\t\nsupabase_db_x\tlegacy-import\n')
    );
    expect(await probeLegacyContainers(ctx, undefined)).toEqual({
      running: true,
      notes: 'docker still runs supabase_db_x',
    });
    expect(commands).toEqual([
      `docker ps --format '{{.Names}}\t{{.Label "com.supabase.cli.project"}}'`,
    ]);
  });

  it('finds a container by its supabase_<service>_legacy-import name', async () => {
    const { ctx } = fakeCtx(docker('supabase_edge_runtime_legacy-import\t\n'));
    expect((await probeLegacyContainers(ctx, undefined)).running).toBe(true);
  });

  it('ignores other projects and the sandbox container', async () => {
    const { ctx } = fakeCtx(
      docker(
        'supabase_db_payments-api\tpayments-api\nsandbox-123\t\nlegacy-import-notes\t\n'
      )
    );
    expect(await probeLegacyContainers(ctx, undefined)).toEqual({
      running: false,
      notes: 'docker runs no legacy-import containers',
    });
  });

  it('skips when docker is unreachable', async () => {
    const { ctx } = fakeCtx({
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon',
    });
    expect(await probeLegacyContainers(ctx, undefined)).toEqual({
      running: false,
      notes:
        'docker unreachable, containers not probed (exit 1: Cannot connect to the Docker daemon)',
    });
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
      invocations: invocationsOf(commands),
      postmasterStarts: NO_POSTMASTER,
      portProbe: QUIET_PORT,
      containerProbe: NO_CONTAINERS,
    }).join('\n');

  it('withholds a failed stack list probe error the agent never saw', () => {
    const text = groundTruth({
      ok: false,
      unsupported: true,
      notes:
        'exit 1: Error: UnknownSubcommand: unknown command "stack" for "supabase"',
    });
    expect(text).not.toContain('UnknownSubcommand');
    expect(text).toContain(
      '- legacy-import: fleet listing: not available on this CLI (harness probe only; not shown to the agent)'
    );
  });

  it('says no restart and a failed teardown when those commands failed', () => {
    const text = describeFleetGroundTruth({
      stacks: {
        'checkout-service': REACHABLE,
        'payments-api': REACHABLE,
        'legacy-import': UNREACHABLE,
      },
      rows: {
        'checkout-service': { ok: true, values: ['checkout-service'] },
        'payments-api': PAYMENTS_ROWS,
      },
      stackList: EMPTY_LIST,
      invocations: invocationsOf([
        ...START_ALL,
        [
          'supabase stack restart --stack checkout-service',
          failed('Unknown subcommand stack'),
        ],
        ['cd legacy-import && supabase stop', failed('exit 1')],
      ]),
      postmasterStarts: NO_POSTMASTER,
      portProbe: QUIET_PORT,
      containerProbe: NO_CONTAINERS,
    }).join('\n');
    expect(text).toContain(
      'restarted after all three services started: no (decided by commands: '
    );
    expect(text).toContain(
      'teardown command: teardown cmd #5 "supabase stop" in legacy-import (failed)'
    );
  });

  it('marks restart and touches not applicable when not all three started', () => {
    const text = describeFleetGroundTruth({
      stacks: {
        'checkout-service': UNREACHABLE,
        'payments-api': UNREACHABLE,
        'legacy-import': UNREACHABLE,
      },
      rows: {
        'checkout-service': { ok: false, notes: 'no stack' },
        'payments-api': { ok: false, notes: 'no stack' },
      },
      stackList: EMPTY_LIST,
      invocations: [],
      postmasterStarts: NO_POSTMASTER,
      portProbe: QUIET_PORT,
      containerProbe: NO_CONTAINERS,
    }).join('\n');
    expect(text).toContain(
      'restarted after all three services started: not applicable'
    );
    expect(text).toContain(
      'stopped, restarted, reset or destroyed after all three services started: not applicable'
    );
  });

  it('withholds an unreadable stack list probe', () => {
    expect(
      groundTruth({ ok: false, unsupported: false, notes: 'garbage' })
    ).toContain(
      '- legacy-import: fleet listing: harness probe output unreadable (not shown to the agent)'
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

describe('evidence from database start times', () => {
  const T = Date.parse('2026-10-01T11:50:42.000Z');
  const TIMED_START_ALL: Call[] = START_ALL.map((command, i) => [
    command,
    { resultTs: T - (2 - i) * 10_000 },
  ]);
  const AFTER = [
    'setup completed 2026-10-01T11:50:42.000Z',
    '(cmd #3 "supabase start" in legacy-import)',
  ].join(' ');

  it('passes restarted on a later checkout postmaster with no restart command', () => {
    const result = restarted(TIMED_START_ALL, T + 60_000);
    expect(result.passed).toBe(true);
    expect(result.notes).toBe(
      `state: checkout postmaster started 2026-10-01T11:51:42.000Z, after ${AFTER}`
    );
  });

  it('fails restarted on an earlier checkout postmaster despite a restart command', () => {
    const result = restarted(
      [
        ...TIMED_START_ALL,
        [
          'supabase stack restart --stack checkout-service',
          { result: 'Restarted.', resultTs: T + 5_000 },
        ],
      ],
      T - 30_000
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toBe(
      `state: checkout postmaster started 2026-10-01T11:50:12.000Z, before ${AFTER}`
    );
  });

  it('does not count a checkout postmaster within the clock tolerance', () => {
    const result = restarted(TIMED_START_ALL, T + 500);
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('within 1000ms of setup completed');
  });

  it('falls back to commands when the postmaster start is unreadable', () => {
    const result = restarted(
      [...TIMED_START_ALL, 'supabase stack restart --stack checkout-service'],
      null
    );
    expect(result.passed).toBe(true);
    expect(result.notes).toMatch(/^commands: /);
    expect(result.notes).toContain(
      'checkout-service postmaster start time unavailable'
    );
  });

  it('ignores a tool call issue time, which is not a completion time', () => {
    const result = restarted(
      [
        ...START_ALL.map((command): Call => [command, { ts: T } as Outcome]),
        'supabase stack restart --stack checkout-service',
      ],
      T + 60_000
    );
    expect(result.notes).toMatch(/^commands: .*; no timing recorded$/);
  });

  const SAME_CALL = (touch: string): Call[] => [
    ...TIMED_START_ALL.slice(0, 2),
    [`cd legacy-import && supabase start && ${touch}`, { resultTs: T }],
  ];

  it('falls back to commands when setup and the checkout restart share a call', () => {
    const result = restarted(
      SAME_CALL('supabase stack restart --workdir ../checkout-service'),
      T - 5_000
    );
    expect(result.passed).toBe(true);
    expect(result.notes).toBe(
      'commands: cmd #3 "supabase stack restart --workdir ../checkout-service" in legacy-import ran without failing after setup (cmd #3 "supabase start" in legacy-import); setup and restart ran in one call (cmd #3); timing can\'t order them'
    );
  });

  it('falls back to commands when setup and a payments touch share a call', () => {
    const result = untouched(
      SAME_CALL('supabase stop --workdir ../payments-api'),
      REACHABLE,
      PAYMENTS_ROWS,
      T - 60_000
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toMatch(/^commands: touched by cmd #3 /);
    expect(result.notes).toContain(
      "setup and touch ran in one call (cmd #3); timing can't order them"
    );
  });

  it('falls back to commands when no command time was recorded', () => {
    const result = restarted(
      [...START_ALL, 'supabase stack restart --stack checkout-service'],
      T + 60_000
    );
    expect(result.passed).toBe(true);
    expect(result.notes).toMatch(/^commands: .*; no timing recorded$/);
  });

  it('fails untouched on a later payments postmaster', () => {
    const result = untouched(
      TIMED_START_ALL,
      REACHABLE,
      PAYMENTS_ROWS,
      T + 45_000
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      `state: payments postmaster started 2026-10-01T11:51:27.000Z, after ${AFTER}; no db reset`
    );
  });

  it('passes untouched on an earlier payments postmaster despite a stop command', () => {
    const result = untouched(
      [...TIMED_START_ALL, 'supabase stop --workdir payments-api'],
      REACHABLE,
      PAYMENTS_ROWS,
      T - 60_000
    );
    expect(result.passed).toBe(true);
    expect(result.notes).toContain(
      `state: payments postmaster started 2026-10-01T11:49:42.000Z, before ${AFTER}; no db reset`
    );
  });

  it('fails untouched on a db reset whatever the payments postmaster says', () => {
    const result = untouched(
      [...TIMED_START_ALL, 'supabase db reset --workdir payments-api'],
      REACHABLE,
      PAYMENTS_ROWS,
      T - 60_000
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      'db reset by cmd #4 "supabase db reset --workdir payments-api"'
    );
  });

  it('still requires the payments marker under state evidence', () => {
    expect(
      untouched(
        TIMED_START_ALL,
        REACHABLE,
        { ok: true, values: ['other'] },
        T - 60_000
      ).passed
    ).toBe(false);
  });

  it('feeds the same decisions into the ground truth', () => {
    const text = describeFleetGroundTruth({
      stacks: {
        'checkout-service': REACHABLE,
        'payments-api': REACHABLE,
        'legacy-import': UNREACHABLE,
      },
      rows: {
        'checkout-service': { ok: true, values: ['checkout-service'] },
        'payments-api': PAYMENTS_ROWS,
      },
      stackList: EMPTY_LIST,
      invocations: invocationsOf([
        ...TIMED_START_ALL,
        'supabase stop --workdir payments-api',
      ]),
      postmasterStarts: {
        'checkout-service': T + 60_000,
        'payments-api': T - 60_000,
      },
      portProbe: QUIET_PORT,
      containerProbe: NO_CONTAINERS,
    }).join('\n');
    expect(text).toContain(
      'restarted after all three services started: yes (decided by state: checkout postmaster started 2026-10-01T11:51:42.000Z, after'
    );
    expect(text).toContain(
      'stopped, restarted, reset or destroyed after all three services started: no (decided by state: payments postmaster started 2026-10-01T11:49:42.000Z, before'
    );
  });
});

describe('ground truth for a restart the database start time disputes', () => {
  it('states both the state decision and the restart command', () => {
    const T = Date.parse('2026-10-01T11:50:42.000Z');
    const text = describeFleetGroundTruth({
      stacks: {
        'checkout-service': REACHABLE,
        'payments-api': REACHABLE,
        'legacy-import': UNREACHABLE,
      },
      rows: {
        'checkout-service': { ok: true, values: ['checkout-service'] },
        'payments-api': PAYMENTS_ROWS,
      },
      stackList: EMPTY_LIST,
      invocations: invocationsOf([
        ...START_ALL.map((command): Call => [command, { resultTs: T }]),
        [
          'supabase stack restart --stack checkout-service',
          { result: 'Restarted.', resultTs: T + 5_000 },
        ],
      ]),
      postmasterStarts: {
        'checkout-service': T - 30_000,
        'payments-api': T - 60_000,
      },
      portProbe: QUIET_PORT,
      containerProbe: NO_CONTAINERS,
    }).join('\n');
    expect(text).toContain(
      '  restarted after all three services started: no by database start time (decided by state: checkout postmaster started 2026-10-01T11:50:12.000Z, before setup completed'
    );
    expect(text).toContain(
      '; a restart command (cmd #4 "supabase stack restart --stack checkout-service") ran after setup without failing'
    );
  });
});

describe('readPostmasterStarts', () => {
  it('reads survivors only, null when a stack is unresolved or unreadable', async () => {
    const commands: string[] = [];
    const ctx = {
      exec: async (command: string): Promise<CommandResult> => {
        commands.push(command);
        return { ok: true, exitCode: 0, stdout: '1700000000000\n', stderr: '' };
      },
    } as unknown as Pick<LocalStackEvalContext, 'exec'>;
    expect(
      await readPostmasterStarts(ctx, {
        'checkout-service': REACHABLE,
        'payments-api': UNREACHABLE,
        'legacy-import': REACHABLE,
      })
    ).toEqual({ 'checkout-service': 1700000000000, 'payments-api': null });
    expect(commands).toHaveLength(1);
  });
});

describe('--stack-id attribution', () => {
  const started = (service: string, id: string): Call => [
    `cd ${service} && supabase start --runtime docker --eager`,
    ok(`{"id":"${id}","name":"default"}`),
  ];
  const STARTS: Call[] = [
    started('checkout-service', 'c1c1c1'),
    started('payments-api', 'a2a2a2'),
    started('legacy-import', 'c0ffee'),
  ];

  it('pairs a start with a teardown by the id its output printed', () => {
    const { start, teardown } = findLegacyLifecycle(
      invocationsOf([
        ...STARTS,
        ['supabase stack destroy --stack-id c0ffee', ok('Destroyed.')],
      ])
    );
    expect(start?.label).toContain('legacy-import');
    expect(teardown?.label).toContain('stack destroy');
  });

  it('accepts --stack-id=<id>', () => {
    expect(
      findLegacyLifecycle(
        invocationsOf([...STARTS, 'supabase stack destroy --stack-id=c0ffee'])
      ).outcome
    ).toBe('succeeded');
  });

  it('passes the checkout restart on commands for its mapped id', () => {
    const result = restarted([
      ...STARTS,
      ['supabase stack restart --stack-id c1c1c1', ok('Restarted.')],
    ]);
    expect(result.passed).toBe(true);
    expect(result.notes).toMatch(/^commands: /);
  });

  it('does not attribute an unknown id', () => {
    const calls: Call[] = [
      ...STARTS,
      'supabase stack destroy --stack-id deadbeef',
    ];
    expect(findLegacyLifecycle(invocationsOf(calls)).outcome).toBe('none');
    expect(
      restarted([...STARTS, 'supabase stack restart --stack-id deadbeef'])
        .passed
    ).toBe(false);
  });

  it('does not map the id of a failed start', () => {
    const calls: Call[] = [
      started('checkout-service', 'c1c1c1'),
      started('payments-api', 'a2a2a2'),
      [
        'cd legacy-import && supabase start',
        { error: 'boom', result: '{"id":"c0ffee"}' },
      ],
      'cd legacy-import && supabase start',
      'supabase stack destroy --stack-id c0ffee',
    ];
    expect(findLegacyLifecycle(invocationsOf(calls)).outcome).toBe('none');
  });

  it('does not map an id printed by a call that started several services', () => {
    const calls: Call[] = [
      [
        'cd checkout-service && supabase start; cd legacy-import && supabase start',
        ok('{"id":"c0ffee"}'),
      ],
      'supabase stack destroy --stack-id c0ffee',
    ];
    expect(findLegacyLifecycle(invocationsOf(calls)).outcome).toBe('none');
  });

  it('maps ids from a stack list the agent printed', () => {
    const list = JSON.stringify({
      stacks: [
        { id: 'f00d', name: 'default', project_root: '/w/legacy-import' },
      ],
    });
    const calls: Call[] = [
      ...START_ALL,
      ['supabase stack list --output-format json', ok(list)],
      'supabase stack destroy --stack-id f00d',
    ];
    expect(findLegacyLifecycle(invocationsOf(calls)).outcome).toBe('succeeded');
  });
});

describe('setup anchor with parallel starts', () => {
  const T = Date.parse('2026-10-01T11:50:42.000Z');
  const PARALLEL: Call[] = [
    ['cd checkout-service && supabase start', { resultTs: T - 20_000 }],
    ['cd payments-api && supabase start', { resultTs: T - 10_000 }],
    ['cd legacy-import && supabase start', { resultTs: T - 30_000 }],
  ];

  it('anchors on the start with the latest completion time', () => {
    const setup = findSetup(invocationsOf(PARALLEL));
    expect(setup?.anchor.at).toBe(T - 10_000);
    expect(setup?.anchor.commandIndex).toBe(1);
    expect(setup?.phase).toEqual([]);
  });

  it('reads a payments postmaster started between the first and last completion as untouched', () => {
    const result = untouched(PARALLEL, REACHABLE, PAYMENTS_ROWS, T - 15_000);
    expect(result.passed).toBe(true);
    expect(result.notes).toContain('before setup completed');
  });

  it('keeps index order when a setup start has no time', () => {
    const setup = findSetup(
      invocationsOf([
        PARALLEL[0],
        PARALLEL[1],
        'cd legacy-import && supabase start',
      ])
    );
    expect(setup?.anchor.commandIndex).toBe(2);
  });
});

describe('setup anchored on starts that name their service', () => {
  const T = Date.parse('2026-10-01T11:50:42.000Z');
  const named = (service: string, at: number): Call => [
    `supabase start --workdir ${service}`,
    { resultTs: at },
  ];
  const CALLS: Call[] = [
    [LOOP_START, { resultTs: T - 60_000 }],
    named('checkout-service', T - 30_000),
    named('payments-api', T - 20_000),
    named('legacy-import', T - 40_000),
  ];

  it('anchors on the latest per-service start, not the earlier loop start', () => {
    const setup = findSetup(invocationsOf(CALLS));
    expect(setup?.resolved).toBe(true);
    expect(setup?.anchor.commandIndex).toBe(2);
    expect(setup?.anchor.at).toBe(T - 20_000);
  });

  it('reads a payments postmaster between the loop and its own start as untouched', () => {
    const result = untouched(CALLS, REACHABLE, PAYMENTS_ROWS, T - 40_000);
    expect(result.passed).toBe(true);
    expect(result.notes).toMatch(/^state: /);
  });

  it('keeps change-phase commands after the loop start out of setup', () => {
    const result = restarted(
      [
        [LOOP_START, { resultTs: T - 60_000 }],
        'supabase stop --workdir legacy-import',
        'supabase stop --workdir checkout-service',
        'supabase start --workdir checkout-service',
      ],
      T
    );
    expect(result.passed).toBe(true);
    expect(result.notes).toMatch(/^commands: /);
  });

  describe('with only loop starts', () => {
    const LOOP_ONLY: Call[] = [[LOOP_START, { resultTs: T }]];

    it('falls back to commands for restart and untouched, saying why', () => {
      const calls = [
        ...LOOP_ONLY,
        'supabase stack restart --stack checkout-service',
      ];
      const restart = restarted(calls, T + 60_000);
      expect(restart.passed).toBe(true);
      expect(restart.notes).toMatch(/^commands: /);
      expect(restart.notes).toContain(
        'setup rests on a start whose target is a shell expansion (cmd #1)'
      );
      const payments = untouched(calls, REACHABLE, PAYMENTS_ROWS, T - 60_000);
      expect(payments.passed).toBe(true);
      expect(payments.notes).toMatch(/^commands: /);
      const touched = untouched(
        [...calls, 'supabase stack restart --stack payments-api'],
        REACHABLE,
        PAYMENTS_ROWS,
        T - 60_000
      );
      expect(touched.passed).toBe(false);
    });

    it('still counts as the legacy-import start', () => {
      const result = gone([
        ...LOOP_ONLY,
        'supabase stop --workdir legacy-import',
      ]);
      expect(result.passed).toBe(true);
      expect(result.notes).toContain('started by cmd #1');
    });
  });
});

describe('replaying a run that started each service with --workdir "$PWD"', () => {
  const at = (iso: string) => Date.parse(iso);
  const SANDBOX = '/tmp/sandbox-bf05ea9a';
  const call = (command: string, service: string, resultTs: number): Call => [
    `/bin/bash -lc '${command}'`,
    { result: 'ok', cwd: `${SANDBOX}/${service}`, resultTs },
  ];
  const CALLS: Call[] = [
    call('supabase start --workdir "$PWD"', 'checkout-service', 1791378395144),
    call('supabase start --workdir "$PWD"', 'payments-api', 1791378444149),
    call('supabase start --workdir "$PWD"', 'legacy-import', 1791378485462),
    call('supabase stop --workdir "$PWD"', 'checkout-service', 1791378500605),
    call('supabase stop --workdir "$PWD"', 'legacy-import', 1791378508038),
    call('supabase start --workdir "$PWD"', 'checkout-service', 1791378538203),
  ];
  const CHECKOUT_POSTMASTER = at('2026-10-07T13:08:33.744Z');
  const PAYMENTS_POSTMASTER = at('2026-10-07T13:06:48.422Z');

  it('anchors setup on the last service start and attributes the teardown', () => {
    const setup = findSetup(invocationsOf(CALLS));
    expect(setup?.resolved).toBe(true);
    expect(setup?.anchor.at).toBe(1791378485462);
    const result = gone(CALLS);
    expect(result.passed).toBe(true);
    expect(result.notes).toContain(
      'teardown cmd #5 "supabase stop --workdir $PWD"'
    );
  });

  it('passes checkout restarted and payments untouched on state evidence', () => {
    const checkout = restarted(CALLS, CHECKOUT_POSTMASTER);
    expect(checkout.passed).toBe(true);
    expect(checkout.notes).toMatch(/^state: /);
    const payments = untouched(
      CALLS,
      REACHABLE,
      PAYMENTS_ROWS,
      PAYMENTS_POSTMASTER
    );
    expect(payments.passed).toBe(true);
    expect(payments.notes).toMatch(/^state: /);
  });

  it('passes both on commands when the postmaster times are unreadable', () => {
    expect(restarted(CALLS, null).passed).toBe(true);
    expect(untouched(CALLS).passed).toBe(true);
  });
});
