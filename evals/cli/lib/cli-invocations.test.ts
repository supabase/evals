// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/lib
import { describe, expect, it } from 'vitest';
import {
  findSupabaseInvocations,
  invocationTargetUnresolved,
  invocationTargets,
  invocationVerb,
  type SupabaseInvocation,
} from './cli-invocations.js';

const inv = (argv: string[], cwd?: string): SupabaseInvocation => ({
  commandIndex: 0,
  argv,
  ...(cwd === undefined ? {} : { cwd }),
});

describe('findSupabaseInvocations', () => {
  it('finds a plain invocation with its command index', () => {
    expect(
      findSupabaseInvocations([
        'ls',
        'supabase stack list --output-format json',
      ])
    ).toEqual([
      {
        commandIndex: 1,
        argv: ['supabase', 'stack', 'list', '--output-format', 'json'],
      },
    ]);
  });

  it('unwraps a bash -lc wrapper and splits on &&', () => {
    expect(
      findSupabaseInvocations([
        "bash -lc 'supabase init && supabase start --workdir ./a'",
      ]).map(({ argv }) => argv)
    ).toEqual([
      ['supabase', 'init'],
      ['supabase', 'start', '--workdir', './a'],
    ]);
  });

  it('ignores an echoed command line', () => {
    expect(
      findSupabaseInvocations([
        'echo "supabase stack restart --stack checkout-service"',
      ])
    ).toEqual([]);
  });

  it('ignores a quoted command inside another argument', () => {
    expect(
      findSupabaseInvocations([
        `psql "$DB" -c "select 'supabase stop'"`,
        `git commit -m "supabase stop; supabase start"`,
      ])
    ).toEqual([]);
  });

  it('ignores a heredoc body', () => {
    expect(
      findSupabaseInvocations(['cat > notes.md <<EOF\nsupabase stop\nEOF'])
    ).toEqual([]);
  });

  it('strips env assignments, env, timeout, npx flags and version specs', () => {
    expect(
      findSupabaseInvocations([
        'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack list',
        'env SUPABASE_EXPERIMENTAL_STACK=1 timeout 300 supabase start',
        'npx -y supabase@beta stack destroy --stack legacy-import',
        'bunx supabase stop',
        'pnpm dlx supabase status',
        './node_modules/.bin/supabase stop',
      ]).map(({ argv }) => argv.slice(0, 2))
    ).toEqual([
      ['supabase', 'stack'],
      ['supabase', 'start'],
      ['supabase', 'stack'],
      ['supabase', 'stop'],
      ['supabase', 'status'],
      ['supabase', 'stop'],
    ]);
  });

  it('strips pnpm exec, yarn and yarn dlx', () => {
    expect(
      findSupabaseInvocations([
        'pnpm exec supabase start',
        'yarn supabase stop',
        'yarn dlx supabase status',
      ]).map(({ argv }) => argv)
    ).toEqual([
      ['supabase', 'start'],
      ['supabase', 'stop'],
      ['supabase', 'status'],
    ]);
  });

  it('skips leading shell keywords and negation', () => {
    const found = findSupabaseInvocations([
      'if supabase start --workdir client-a; then echo ok; fi',
      'if ! supabase status; then supabase start; elif true; then :; else supabase stop; fi',
      'while ! supabase status; do sleep 1; done',
      'until supabase status; do supabase start; done',
    ]);
    expect(found.map(({ commandIndex, argv }) => [commandIndex, argv])).toEqual(
      [
        [0, ['supabase', 'start', '--workdir', 'client-a']],
        [1, ['supabase', 'status']],
        [1, ['supabase', 'start']],
        [1, ['supabase', 'stop']],
        [2, ['supabase', 'status']],
        [3, ['supabase', 'status']],
        [3, ['supabase', 'start']],
      ]
    );
    expect(invocationTargets(found[0], 'client-a')).toBe(true);
  });

  it('still ignores an echoed shell keyword line', () => {
    expect(
      findSupabaseInvocations([
        'echo "if supabase start"',
        'if echo supabase start; then :; fi',
      ])
    ).toEqual([]);
  });

  it('tracks pushd like cd', () => {
    expect(
      findSupabaseInvocations(['pushd services/legacy-import && supabase stop'])
    ).toEqual([
      {
        commandIndex: 0,
        argv: ['supabase', 'stop'],
        cwd: 'services/legacy-import',
      },
    ]);
  });

  it('targets the SUPABASE_WORKDIR assignment, relative to the cd directory', () => {
    const [plain, viaEnv, nested] = findSupabaseInvocations([
      'SUPABASE_WORKDIR=client-a supabase start',
      'env SUPABASE_EXPERIMENTAL_STACK=1 SUPABASE_WORKDIR=./client-b supabase stop',
      { command: 'SUPABASE_WORKDIR=../client-c supabase status', cwd: 'x/y' },
    ]);
    expect(plain).toEqual({
      commandIndex: 0,
      argv: ['supabase', 'start'],
      workdir: 'client-a',
    });
    expect(invocationTargets(plain, 'client-a')).toBe(true);
    expect(invocationTargets(viaEnv, 'client-b')).toBe(true);
    expect(invocationTargets(nested, 'client-c')).toBe(true);
    expect(invocationTargets(nested, 'y')).toBe(false);
  });

  it('lets --workdir override SUPABASE_WORKDIR', () => {
    const [found] = findSupabaseInvocations([
      'SUPABASE_WORKDIR=client-a supabase start --workdir client-b',
    ]);
    expect(invocationTargets(found, 'client-b')).toBe(true);
    expect(invocationTargets(found, 'client-a')).toBe(false);
  });

  it('flags a SUPABASE_WORKDIR from a variable as unresolved', () => {
    const [found] = findSupabaseInvocations([
      'SUPABASE_WORKDIR="$s" supabase start',
    ]);
    expect(invocationTargetUnresolved(found)).toBe(true);
  });

  it('recognises npx supabase stack destroy --stack legacy-import as targeting it', () => {
    const [found] = findSupabaseInvocations([
      'npx supabase stack destroy --stack legacy-import',
    ]);
    expect(invocationVerb(found)).toBe('stack destroy');
    expect(invocationTargets(found, 'legacy-import')).toBe(true);
  });

  it('tracks cd within one command, re-evaluated at every cd', () => {
    expect(
      findSupabaseInvocations([
        'cd legacy-import && supabase start && cd ../payments-api && supabase stop',
      ])
    ).toEqual([
      { commandIndex: 0, argv: ['supabase', 'start'], cwd: 'legacy-import' },
      { commandIndex: 0, argv: ['supabase', 'stop'], cwd: 'payments-api' },
    ]);
  });

  it('does not carry cd across commands', () => {
    expect(
      findSupabaseInvocations(['cd legacy-import', 'supabase stop'])
    ).toEqual([{ commandIndex: 1, argv: ['supabase', 'stop'] }]);
  });

  it('forgets the directory on cd - or cd ~', () => {
    expect(
      findSupabaseInvocations(['cd a && cd - && supabase stop'])[0].cwd
    ).toBeUndefined();
  });

  it('stops argv at a redirection or subshell close', () => {
    expect(
      findSupabaseInvocations(['(cd a && supabase stop > /tmp/log 2>&1)'])
    ).toEqual([{ commandIndex: 0, argv: ['supabase', 'stop'], cwd: 'a' }]);
  });

  it('targets a bare command by its entry cwd', () => {
    const [found] = findSupabaseInvocations([
      {
        command: 'supabase stop --no-backup',
        cwd: '/tmp/sandbox-x/legacy-import',
      },
    ]);
    expect(found.cwd).toBe('/tmp/sandbox-x/legacy-import');
    expect(invocationTargets(found, 'legacy-import')).toBe(true);
  });

  it('resolves an in-command cd relative to the entry cwd', () => {
    const [found] = findSupabaseInvocations([
      {
        command: 'cd ../checkout-service && supabase restart',
        cwd: '/tmp/sandbox-x/payments-api',
      },
    ]);
    expect(found.cwd).toBe('/tmp/sandbox-x/checkout-service');
    expect(invocationTargets(found, 'checkout-service')).toBe(true);
    expect(invocationTargets(found, 'payments-api')).toBe(false);
  });

  it('targets no service from the sandbox root cwd', () => {
    const [found] = findSupabaseInvocations([
      { command: 'supabase start', cwd: '/tmp/sandbox-x' },
    ]);
    for (const name of ['legacy-import', 'payments-api', 'checkout-service']) {
      expect(invocationTargets(found, name)).toBe(false);
    }
  });

  it('treats an entry without cwd like a plain string', () => {
    expect(findSupabaseInvocations([{ command: 'supabase stop' }])).toEqual([
      { commandIndex: 0, argv: ['supabase', 'stop'] },
    ]);
  });

  it('skips --help and -h invocations', () => {
    expect(
      findSupabaseInvocations([
        'supabase start --help',
        'supabase stop -h',
        'cd a && supabase stack restart --help',
      ])
    ).toEqual([]);
  });

  it('never throws on unbalanced quotes', () => {
    expect(() => findSupabaseInvocations(['supabase stop "'])).not.toThrow();
  });
});

describe('invocationVerb', () => {
  it.each([
    [['supabase', 'stop'], 'stop'],
    [['supabase', '--workdir', 'a', 'stop', '--no-backup'], 'stop'],
    [['supabase', 'stack', 'restart', '--stack', 'x'], 'stack restart'],
    [['supabase', 'stack', '--stack', 'x', 'destroy'], 'stack destroy'],
    [['supabase', '--debug', 'start'], 'start'],
    [['supabase', 'stack'], 'stack'],
    [['supabase'], undefined],
  ])('%j -> %s', (argv, verb) => {
    expect(invocationVerb(inv(argv))).toBe(verb);
  });
});

describe('invocationTargets', () => {
  it('matches --stack <name> and --stack=<name> exactly', () => {
    expect(
      invocationTargets(
        inv(['supabase', 'stack', 'stop', '--stack', 'legacy-import']),
        'legacy-import'
      )
    ).toBe(true);
    expect(
      invocationTargets(
        inv(['supabase', 'stack', 'stop', '--stack=legacy-import']),
        'legacy-import'
      )
    ).toBe(true);
    expect(
      invocationTargets(
        inv(['supabase', 'stack', 'stop', '--stack', 'legacy-import-old']),
        'legacy-import'
      )
    ).toBe(false);
  });

  it('lets --stack override the cd directory', () => {
    expect(
      invocationTargets(
        inv(
          ['supabase', 'stack', 'destroy', '--stack', 'payments-api'],
          'legacy-import'
        ),
        'legacy-import'
      )
    ).toBe(false);
  });

  it('matches --workdir by basename, relative to the cd directory', () => {
    expect(
      invocationTargets(
        inv(['supabase', 'stop', '--workdir', './legacy-import/']),
        'legacy-import'
      )
    ).toBe(true);
    expect(
      invocationTargets(
        inv(['supabase', 'stop', '--workdir=../legacy-import'], 'services/a'),
        'legacy-import'
      )
    ).toBe(true);
  });

  it('matches the cd directory by basename', () => {
    expect(
      invocationTargets(
        inv(['supabase', 'stop'], 'services/legacy-import'),
        'legacy-import'
      )
    ).toBe(true);
    expect(
      invocationTargets(inv(['supabase', 'stop'], '.'), 'legacy-import')
    ).toBe(false);
  });

  it('never matches an untargeted invocation or a --stack-id', () => {
    expect(invocationTargets(inv(['supabase', 'stop']), 'legacy-import')).toBe(
      false
    );
    expect(
      invocationTargets(
        inv(
          ['supabase', 'stack', 'destroy', '--stack-id', 'abc'],
          'legacy-import'
        ),
        'legacy-import'
      )
    ).toBe(false);
  });

  it('matches stop --project-id <name>, which overrides the cd directory', () => {
    expect(
      invocationTargets(
        inv(['supabase', 'stop', '--project-id', 'legacy-import']),
        'legacy-import'
      )
    ).toBe(true);
    expect(
      invocationTargets(
        inv(['supabase', 'stop', '--project-id=payments-api'], 'legacy-import'),
        'legacy-import'
      )
    ).toBe(false);
  });

  it('treats stop --all as targeting every stack', () => {
    expect(
      invocationTargets(inv(['supabase', 'stop', '--all']), 'payments-api')
    ).toBe(true);
  });
});

describe('invocationTargetUnresolved', () => {
  it('flags a cd target from a loop variable, kept literal rather than expanded', () => {
    const [found] = findSupabaseInvocations([
      'for s in a b; do (cd "$s" && supabase start); done',
    ]);
    expect(found.cwd).toBe('$s');
    expect(invocationTargetUnresolved(found)).toBe(true);
    expect(invocationTargets(found, 'a')).toBe(false);
  });

  it.each([
    [['supabase', 'stack', 'start', '--stack', '${s}']],
    [['supabase', 'stop', '--project-id=$name']],
    [['supabase', 'start', '--workdir', '`pwd`']],
  ])('flags an expanded flag value in %j', (argv) => {
    expect(invocationTargetUnresolved(inv(argv))).toBe(true);
  });

  it('does not flag an expansion that still ends in a literal name', () => {
    const found = inv(['supabase', 'start'], '$WORKSPACE/legacy-import');
    expect(invocationTargetUnresolved(found)).toBe(false);
    expect(invocationTargets(found, 'legacy-import')).toBe(true);
  });

  it('does not flag literal or untargeted invocations', () => {
    expect(
      invocationTargetUnresolved(inv(['supabase', 'start'], 'legacy-import'))
    ).toBe(false);
    expect(invocationTargetUnresolved(inv(['supabase', 'start']))).toBe(false);
  });
});
