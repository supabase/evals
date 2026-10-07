// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/lib
import { describe, expect, it } from 'vitest';
import {
  findSupabaseInvocations,
  invocationDirectory,
  invocationTargetUnresolved,
  invocationTargets,
  invocationTargetsDir,
  invocationVerb,
  isStartInvocation,
  listCliOverrides,
  listUnverifiedRunners,
  type CommandEntry,
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

  it("gives every invocation its entry's time and none to string commands", () => {
    expect(
      findSupabaseInvocations([
        { command: 'supabase start && supabase status', at: 1234 },
        'supabase stop',
      ])
    ).toEqual([
      { commandIndex: 0, argv: ['supabase', 'start'], at: 1234 },
      { commandIndex: 0, argv: ['supabase', 'status'], at: 1234 },
      { commandIndex: 1, argv: ['supabase', 'stop'] },
    ]);
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

  it('restores the outer directory when a subshell that ran cd closes', () => {
    expect(
      findSupabaseInvocations([
        '(cd legacy-import && supabase status); supabase stop',
        {
          command: '(cd legacy-import && supabase status); supabase stop',
          cwd: '/w',
        },
      ])
    ).toEqual([
      { commandIndex: 0, argv: ['supabase', 'status'], cwd: 'legacy-import' },
      { commandIndex: 0, argv: ['supabase', 'stop'] },
      {
        commandIndex: 1,
        argv: ['supabase', 'status'],
        cwd: '/w/legacy-import',
      },
      { commandIndex: 1, argv: ['supabase', 'stop'], cwd: '/w' },
    ]);
  });

  it('scopes cd to each level of nested subshells', () => {
    expect(
      findSupabaseInvocations([
        'cd a && (cd b && (cd c && supabase start) && supabase status) && supabase stop',
      ]).map(({ argv, cwd }) => [argv[1], cwd])
    ).toEqual([
      ['start', 'a/b/c'],
      ['status', 'a/b'],
      ['stop', 'a'],
    ]);
  });

  it('keeps a cd that runs outside any subshell after an unrelated one closes', () => {
    expect(
      findSupabaseInvocations(['(supabase status) && cd a && supabase stop'])
    ).toEqual([
      { commandIndex: 0, argv: ['supabase', 'status'] },
      { commandIndex: 0, argv: ['supabase', 'stop'], cwd: 'a' },
    ]);
  });

  it('ignores a backslash-escaped paren when scoping cd', () => {
    expect(
      findSupabaseInvocations([
        {
          command:
            '(cd legacy-import && echo \\) && supabase stop); supabase status',
          cwd: '/w',
        },
      ]).map(({ argv, cwd }) => [argv[1], cwd])
    ).toEqual([
      ['stop', '/w/legacy-import'],
      ['status', '/w'],
    ]);
  });

  it('ignores a quoted paren when scoping cd', () => {
    expect(
      findSupabaseInvocations(['cd a && echo ")" && supabase stop'])
    ).toEqual([{ commandIndex: 0, argv: ['supabase', 'stop'], cwd: 'a' }]);
  });

  it('ignores invocations inside a trailing comment', () => {
    expect(
      findSupabaseInvocations([
        'echo ok # suggested cleanup; supabase stop --all',
      ])
    ).toEqual([]);
  });

  it('keeps an invocation followed by a comment', () => {
    expect(findSupabaseInvocations(['supabase stop # done'])).toEqual([
      { commandIndex: 0, argv: ['supabase', 'stop'] },
    ]);
  });

  it('keeps an invocation after a # inside a parameter expansion', () => {
    expect(
      findSupabaseInvocations([
        'echo ${DOCKER_HOST:- # unset}; supabase stop',
        'echo ${DOCKER_HOST} # unset; supabase stop',
      ])
    ).toEqual([{ commandIndex: 0, argv: ['supabase', 'stop'] }]);
  });

  it('does not treat a quoted or mid-word # as a comment', () => {
    expect(
      findSupabaseInvocations([
        'echo "#"; supabase stop',
        'echo a#b; echo ${#x}; supabase start',
      ]).map(({ argv }) => argv)
    ).toEqual([
      ['supabase', 'stop'],
      ['supabase', 'start'],
    ]);
  });

  it('skips a commented line in a multi-line command', () => {
    expect(
      findSupabaseInvocations([
        'supabase start\n# supabase stop --all\nsupabase status',
      ]).map(({ argv }) => argv)
    ).toEqual([
      ['supabase', 'start'],
      ['supabase', 'status'],
    ]);
  });

  it.each([
    'env -u DOCKER_HOST supabase start --workdir client-a',
    'env --unset=DOCKER_HOST supabase start --workdir client-a',
    'env --unset DOCKER_HOST supabase start --workdir client-a',
    'env -i SUPABASE_EXPERIMENTAL_STACK=1 supabase start --workdir client-a',
  ])('strips env options in %j', (command) => {
    const [found] = findSupabaseInvocations([command]);
    expect(found.argv).toEqual(['supabase', 'start', '--workdir', 'client-a']);
    expect(invocationTargets(found, 'client-a')).toBe(true);
  });

  it('finds env -i supabase stop', () => {
    expect(findSupabaseInvocations(['env -i supabase stop'])).toEqual([
      { commandIndex: 0, argv: ['supabase', 'stop'] },
    ]);
  });

  it('runs an env -C or --chdir invocation in that directory, for that invocation only', () => {
    const found = findSupabaseInvocations([
      {
        command:
          'env -C legacy-import supabase stop && env --chdir=../x supabase start && supabase status',
        cwd: '/w',
      },
    ]);
    expect(found.map(({ argv, cwd }) => [argv[1], cwd])).toEqual([
      ['stop', '/w/legacy-import'],
      ['start', '/x'],
      ['status', '/w'],
    ]);
    expect(invocationTargets(found[0], 'legacy-import')).toBe(true);
  });

  it('combines nested env -C wrappers', () => {
    expect(
      findSupabaseInvocations([
        {
          command: 'env -C services/legacy-import env --chdir=.. supabase stop',
          cwd: '/w',
        },
        { command: 'env -C a env -C /x supabase stop', cwd: '/w' },
        'env -C a env -C b supabase stop',
      ]).map(({ cwd }) => cwd)
    ).toEqual(['/w/services', '/x', 'a/b']);
  });

  it.each([
    'SUPABASE_WORKDIR=legacy-import env -u SUPABASE_WORKDIR supabase stop',
    'SUPABASE_WORKDIR=legacy-import env --unset=SUPABASE_WORKDIR supabase stop',
    'SUPABASE_WORKDIR=legacy-import env --unset SUPABASE_WORKDIR supabase stop',
    'SUPABASE_WORKDIR=legacy-import env -i supabase stop',
  ])('drops a SUPABASE_WORKDIR that env removes in %j', (command) => {
    const [found] = findSupabaseInvocations([{ command, cwd: '/w/client-b' }]);
    expect(found).toEqual({
      commandIndex: 0,
      argv: ['supabase', 'stop'],
      cwd: '/w/client-b',
    });
    expect(invocationTargets(found, 'client-b')).toBe(true);
    expect(invocationTargets(found, 'legacy-import')).toBe(false);
  });

  it.each([
    'SUPABASE_WORKDIR=legacy-import env -u DOCKER_HOST supabase stop',
    'env -i SUPABASE_WORKDIR=legacy-import supabase stop',
    'SUPABASE_WORKDIR=x env -u SUPABASE_WORKDIR SUPABASE_WORKDIR=legacy-import supabase stop',
  ])('keeps a SUPABASE_WORKDIR env still passes in %j', (command) => {
    const [found] = findSupabaseInvocations([{ command, cwd: '/w/client-b' }]);
    expect(found.workdir).toBe('legacy-import');
    expect(invocationTargets(found, 'legacy-import')).toBe(true);
  });

  it('finds an invocation after env --', () => {
    expect(
      findSupabaseInvocations([
        'env -- supabase stop',
        'env -u DOCKER_HOST -- supabase start',
      ]).map(({ argv }) => argv)
    ).toEqual([
      ['supabase', 'stop'],
      ['supabase', 'start'],
    ]);
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

  it('lets the cd directory win over --stack when the directory is a known target', () => {
    const destroy = inv(
      ['supabase', 'stack', 'destroy', '--stack', 'payments-api'],
      'legacy-import'
    );
    const known = ['legacy-import', 'payments-api'];
    expect(invocationTargets(destroy, 'legacy-import', known)).toBe(true);
    expect(invocationTargets(destroy, 'payments-api', known)).toBe(false);
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

  it('matches stop --project-id <name>, unless the cd directory is another known target', () => {
    expect(
      invocationTargets(
        inv(['supabase', 'stop', '--project-id', 'legacy-import']),
        'legacy-import'
      )
    ).toBe(true);
    expect(
      invocationTargets(
        inv(['supabase', 'stop', '--project-id=payments-api'], 'legacy-import'),
        'payments-api',
        ['legacy-import', 'payments-api']
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

describe('invocation env and runner', () => {
  const S = '/sandbox';
  const first = (command: string, cwd?: string) =>
    findSupabaseInvocations([{ command, cwd }])[0];

  it('records an absolute SUPABASE_HOME and TMPDIR with the call cwd', () => {
    const invocation = first(
      `SUPABASE_HOME=${S}/.supabase-runtime-home TMPDIR=${S}/.supabase-tmp supabase start`,
      `${S}/client-a`
    );
    expect(invocation).toMatchObject({
      cwd: `${S}/client-a`,
      env: {
        SUPABASE_HOME: `${S}/.supabase-runtime-home`,
        TMPDIR: `${S}/.supabase-tmp`,
      },
    });
    expect(invocation.runner).toBeUndefined();
  });

  it('records HOME in place of SUPABASE_HOME', () => {
    expect(
      first(
        `HOME=${S}/.supabase-runtime-home TMPDIR=${S}/.supabase-tmp supabase start`,
        `${S}/client-a`
      ).env
    ).toEqual({
      HOME: `${S}/.supabase-runtime-home`,
      TMPDIR: `${S}/.supabase-tmp`,
    });
  });

  it('records env assigned after a cd and resolves the target from it', () => {
    const invocation = first(
      `cd client-a && TMPDIR=${S}/.tmp SUPABASE_HOME=${S}/.supabase-home SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime docker --eager`,
      S
    );
    expect(invocation.env).toEqual({
      SUPABASE_HOME: `${S}/.supabase-home`,
      TMPDIR: `${S}/.tmp`,
    });
    expect(invocationTargets(invocation, 'client-a')).toBe(true);
  });

  it('resolves $PWD-relative values and records the npx runner', () => {
    const invocation = first(
      'HOME="$PWD/.local-supabase-home" TMPDIR="$PWD/.local-supabase-home/tmp" NPM_CONFIG_CACHE=/home/node/.npm npx --yes supabase@2.120.0 start --workdir client-b',
      S
    );
    expect(invocation).toMatchObject({
      argv: ['supabase', 'start', '--workdir', 'client-b'],
      env: {
        HOME: `${S}/.local-supabase-home`,
        TMPDIR: `${S}/.local-supabase-home/tmp`,
      },
      runner: 'npx --yes supabase@2.120.0',
    });
    expect(invocationTargets(invocation, 'client-b')).toBe(true);
  });

  it('resolves ${PWD} the same way', () => {
    expect(first('SUPABASE_HOME=${PWD}/.home supabase start', S).env).toEqual({
      SUPABASE_HOME: `${S}/.home`,
    });
  });

  it('resolves a relative value against the cwd', () => {
    expect(
      first('mkdir -p .home && SUPABASE_HOME=.home supabase start', S).env
    ).toEqual({ SUPABASE_HOME: `${S}/.home` });
  });

  it('expands $PWD against the shell cwd, not the env -C directory', () => {
    const w = '/w';
    expect(
      first('SUPABASE_HOME=$PWD/.h env -C client-a supabase start', w)
    ).toMatchObject({ cwd: '/w/client-a', env: { SUPABASE_HOME: '/w/.h' } });
    expect(
      first('env -C client-a SUPABASE_HOME=$PWD/.h supabase start', w).env
    ).toEqual({ SUPABASE_HOME: '/w/.h' });
    expect(
      first('cd client-a && SUPABASE_HOME=$PWD/.h supabase start', w).env
    ).toEqual({ SUPABASE_HOME: '/w/client-a/.h' });
    expect(
      first('export SUPABASE_HOME=$PWD/.h && env -C client-a supabase start', w)
        .env
    ).toEqual({ SUPABASE_HOME: '/w/.h' });
  });

  it('resolves a plain relative value against the env -C directory', () => {
    expect(
      first('SUPABASE_HOME=.h env -C client-a supabase start', '/w').env
    ).toEqual({ SUPABASE_HOME: '/w/client-a/.h' });
  });

  it('drops $PWD under env -C when the shell cwd is unknown', () => {
    expect(
      first('SUPABASE_HOME=$PWD/.h env -C /w/client-a supabase start').env
    ).toBeUndefined();
  });

  it('drops a relative value when the cwd is unknown', () => {
    expect(first('SUPABASE_HOME=.home supabase start').env).toBeUndefined();
  });

  it('drops values with other unresolved expansions', () => {
    expect(
      first('SUPABASE_HOME=$FOO/home TMPDIR=${BAR} HOME=/h supabase start', S)
        .env
    ).toEqual({ HOME: '/h' });
  });

  it('clears env with `env -u` and `env -i`', () => {
    expect(
      first('SUPABASE_HOME=/a env -u SUPABASE_HOME supabase start', S).env
    ).toBeUndefined();
    expect(first('HOME=/a env -i TMPDIR=/t supabase start', S).env).toEqual({
      TMPDIR: '/t',
    });
  });

  it('records env set through `env VAR=…`', () => {
    expect(first('env SUPABASE_HOME=/a supabase start', S).env).toEqual({
      SUPABASE_HOME: '/a',
    });
  });

  it('records pnpm dlx and bunx runners but not unversioned or exec runs', () => {
    expect(first('pnpm dlx supabase@2.0.0 start').runner).toBe(
      'pnpm dlx supabase@2.0.0'
    );
    expect(first('bunx supabase@2.0.0 start').runner).toBe(
      'bunx supabase@2.0.0'
    );
    expect(first('npx supabase start').runner).toBeUndefined();
    expect(first('pnpm exec supabase start').runner).toBeUndefined();
  });
});

describe('listCliOverrides', () => {
  const runner = (spec: string) => ({
    ...inv(['supabase', 'start']),
    runner: spec,
  });

  it('lists distinct runner specs', () => {
    expect(
      listCliOverrides([
        runner('npx supabase@2.0.0'),
        inv(['supabase', 'start']),
        runner('npx supabase@2.0.0'),
      ])
    ).toEqual(['npx supabase@2.0.0']);
  });

  it('skips the installed version', () => {
    expect(
      listCliOverrides([runner('npx supabase@2.0.0')], 'v2.0.0\n')
    ).toEqual([]);
  });
});

describe('directory attribution', () => {
  const S = '/sandbox';
  const KNOWN = ['client-a', 'client-b', 'payments-api'];
  const start = (command: string, cwd?: string) =>
    findSupabaseInvocations([{ command, cwd }])[0];

  it('resolves the directory from cwd, --workdir, SUPABASE_WORKDIR and env -C', () => {
    expect(invocationDirectory(start('supabase start', `${S}/client-a`))).toBe(
      `${S}/client-a`
    );
    expect(
      invocationDirectory(start('supabase --workdir client-b start', S))
    ).toBe(`${S}/client-b`);
    expect(
      invocationDirectory(start('SUPABASE_WORKDIR=client-b supabase start', S))
    ).toBe(`${S}/client-b`);
    expect(
      invocationDirectory(start('env -C client-b supabase start', S))
    ).toBe(`${S}/client-b`);
    expect(invocationDirectory(start('supabase start'))).toBeUndefined();
  });

  it('expands a leading $PWD in --workdir, SUPABASE_WORKDIR and env -C values', () => {
    const codex = start(
      'supabase start --workdir "$PWD"',
      '/tmp/sbx/checkout-service'
    );
    expect(invocationDirectory(codex)).toBe('/tmp/sbx/checkout-service');
    expect(invocationTargets(codex, 'checkout-service')).toBe(true);
    expect(invocationTargetUnresolved(codex)).toBe(false);

    for (const command of [
      'supabase start --workdir "$PWD/legacy-import"',
      'supabase start --workdir="$PWD/legacy-import"',
      'supabase start --workdir ${PWD}/legacy-import',
      'SUPABASE_WORKDIR="$PWD/legacy-import" supabase start',
      'env -C "$PWD/legacy-import" supabase start',
      'env --chdir=${PWD}/legacy-import supabase start',
    ]) {
      const found = start(command, '/tmp/sbx');
      expect(invocationDirectory(found), command).toBe(
        '/tmp/sbx/legacy-import'
      );
      expect(invocationTargetUnresolved(found), command).toBe(false);
    }

    const afterCd = start(
      'cd payments-api && supabase stop --workdir "$PWD"',
      '/tmp/sbx'
    );
    expect(invocationDirectory(afterCd)).toBe('/tmp/sbx/payments-api');
    expect(invocationTargets(afterCd, 'payments-api')).toBe(true);
  });

  it('keeps $PWD and other variables in a workdir unresolved', () => {
    for (const command of [
      'supabase start --workdir "$PWD"',
      'SUPABASE_WORKDIR="$PWD" supabase start',
      'env -C "$PWD" supabase start',
    ]) {
      expect(invocationTargetUnresolved(start(command)), command).toBe(true);
    }
    expect(
      invocationTargetUnresolved(
        start('supabase start --workdir "$OTHER"', '/tmp/sbx')
      )
    ).toBe(true);
  });

  it('matches a directory by normalised path, or by basename when relative', () => {
    const inDir = start('supabase start', `${S}/client-a/`);
    expect(invocationTargetsDir(inDir, `${S}/client-a`)).toBe(true);
    expect(invocationTargetsDir(inDir, `${S}/client-b`)).toBe(false);
    expect(invocationTargetsDir(inDir, './client-a')).toBe(true);
    expect(
      invocationTargetsDir(
        start('supabase --workdir client-a start'),
        `${S}/client-a`
      )
    ).toBe(true);
    expect(invocationTargetsDir(start('supabase start'), `${S}/client-a`)).toBe(
      false
    );
  });

  it('credits a --stack start to the directory it ran in', () => {
    const inA = start('supabase stack start --stack demo', `${S}/client-a`);
    expect(invocationTargets(inA, 'client-a')).toBe(true);
    expect(invocationTargets(inA, 'client-a', KNOWN)).toBe(true);
    expect(invocationTargets(inA, 'client-b', KNOWN)).toBe(false);
  });

  it('credits a --workdir --stack start to the workdir project', () => {
    const inv = start(
      'supabase --workdir client-b stack start --stack native',
      S
    );
    expect(invocationTargets(inv, 'client-b', KNOWN)).toBe(true);
    expect(invocationTargets(inv, 'client-a', KNOWN)).toBe(false);
  });

  it('keeps a --stack name from a directory that is no known target', () => {
    const fromRoot = start('supabase stack start --stack payments-api', S);
    expect(invocationTargets(fromRoot, 'payments-api', KNOWN)).toBe(true);
    expect(invocationTargets(fromRoot, 'client-a', KNOWN)).toBe(false);
    expect(
      invocationTargets(
        start('supabase stack start --stack payments-api'),
        'payments-api'
      )
    ).toBe(true);
  });

  it('does not credit --stack <other known target> run inside a project directory', () => {
    const inB = start('supabase stack start --stack client-a', `${S}/client-b`);
    expect(invocationTargets(inB, 'client-b', KNOWN)).toBe(true);
    expect(invocationTargets(inB, 'client-a', KNOWN)).toBe(false);
  });

  it('ignores the directory for --stack-id', () => {
    const inv = start('supabase stack stop --stack-id abc', `${S}/client-a`);
    expect(invocationTargets(inv, 'client-a', KNOWN)).toBe(false);
    expect(invocationTargetsDir(inv, `${S}/client-a`)).toBe(false);
  });

  it('classifies start verbs once', () => {
    expect(isStartInvocation(start('supabase start'))).toBe(true);
    expect(isStartInvocation(start('supabase stack start --stack x'))).toBe(
      true
    );
    expect(isStartInvocation(start('supabase stack stop --stack x'))).toBe(
      false
    );
  });
});

describe('runner forms', () => {
  const first = (command: string) => findSupabaseInvocations([command])[0];

  it.each([
    ['npx -p supabase@2.1.0 supabase stack start', 'npx -p supabase@2.1.0'],
    [
      'npx --yes --package supabase@2.1.0 supabase stack start',
      'npx --yes --package supabase@2.1.0',
    ],
    [
      'npx --package=supabase@2.1.0 supabase stack start',
      'npx --package=supabase@2.1.0',
    ],
    ['npm exec supabase@2.1.0 -- stack start', 'npm exec supabase@2.1.0'],
    [
      'npm exec --yes -p supabase@2.1.0 -- supabase stack start',
      'npm exec --yes -p supabase@2.1.0',
    ],
    ['pnpm dlx supabase@2.1.0 stack start', 'pnpm dlx supabase@2.1.0'],
    ['yarn dlx supabase@2.1.0 stack start', 'yarn dlx supabase@2.1.0'],
    ['bunx supabase@2.1.0 stack start', 'bunx supabase@2.1.0'],
  ])('parses %s', (command, runner) => {
    expect(first(command)).toMatchObject({
      argv: ['supabase', 'stack', 'start'],
      runner,
    });
  });

  it('records no runner for an unversioned npm exec', () => {
    expect(first('npm exec supabase -- stack start')).toMatchObject({
      argv: ['supabase', 'stack', 'start'],
    });
    expect(first('npm exec supabase -- stack start').runner).toBeUndefined();
  });

  it.each([
    'npm i -g supabase@2.1.0',
    'npm install -g supabase@2.1.0',
    'npm install --global supabase@2.1.0',
    'pnpm add -g supabase@2.1.0',
    'bun add -g supabase@2.1.0',
    'yarn global add supabase@2.1.0',
  ])('treats %s as an override for later invocations', (install) => {
    const [before, same, later] = findSupabaseInvocations([
      'supabase start',
      `${install} && supabase stack start`,
      'supabase stop',
    ]);
    expect(before.runner).toBeUndefined();
    expect(same.runner).toMatch(/supabase@2\.1\.0$/);
    expect(later.runner).toBe(same.runner);
    expect(listCliOverrides([before, same, later], '2.0.0')).toEqual([
      same.runner,
    ]);
    expect(listCliOverrides([same], '2.1.0')).toEqual([]);
  });

  describe('global install lifecycle', () => {
    const runners = (...commands: Array<string | CommandEntry>) =>
      findSupabaseInvocations(commands).map(({ runner }) => runner);

    it('does not apply an install whose call failed', () => {
      const invocations = findSupabaseInvocations([
        { command: 'npm i -g supabase@2.120.0', failed: true },
        'supabase start',
      ]);
      expect(invocations.map(({ runner }) => runner)).toEqual([undefined]);
      expect(listCliOverrides(invocations, '2.119.0')).toEqual([]);
    });

    it('applies an install whose call succeeded', () => {
      const invocations = findSupabaseInvocations([
        { command: 'npm i -g supabase@2.120.0' },
        'supabase start',
      ]);
      expect(listCliOverrides(invocations, '2.119.0')).toEqual([
        'npm i -g supabase@2.120.0',
      ]);
    });

    it('lets a later successful install replace a failed one', () => {
      expect(
        runners(
          { command: 'npm i -g supabase@2.120.0', failed: true },
          'npm i -g supabase@2.121.0',
          'supabase start'
        )
      ).toEqual(['npm i -g supabase@2.121.0']);
    });

    it.each([
      'npm uninstall -g supabase',
      'npm rm -g supabase',
      'pnpm remove -g supabase',
      'bun remove -g supabase',
      'yarn global remove supabase',
    ])('clears the runner after %s', (uninstall) => {
      expect(
        runners('npm i -g supabase@2.120.0', uninstall, 'supabase start')
      ).toEqual([undefined]);
      expect(
        runners(`npm i -g supabase@2.120.0 && ${uninstall} && supabase start`)
      ).toEqual([undefined]);
    });

    it('keeps the runner when the uninstall failed or named another package', () => {
      expect(
        runners(
          'npm i -g supabase@2.120.0',
          { command: 'npm uninstall -g supabase', failed: true },
          'supabase start'
        )
      ).toEqual(['npm i -g supabase@2.120.0']);
      expect(
        runners(
          'npm i -g supabase@2.120.0',
          'npm uninstall -g typescript',
          'supabase start'
        )
      ).toEqual(['npm i -g supabase@2.120.0']);
    });
  });

  it('ignores a global install of another package or without a version', () => {
    const invocations = findSupabaseInvocations([
      'npm i -g typescript@5 && supabase start',
      'npm i -g supabase && supabase start',
      'npm i supabase@2.1.0 && supabase start',
    ]);
    expect(invocations.map(({ runner }) => runner)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('lists dist-tag runners as unverified, not as overrides', () => {
    const invocations = findSupabaseInvocations([
      'npx supabase@latest start',
      'npx -p supabase@beta supabase start',
      'npx supabase@2.1.0 start',
    ]);
    expect(listCliOverrides(invocations, '2.0.0')).toEqual([
      'npx supabase@2.1.0',
    ]);
    expect(listUnverifiedRunners(invocations)).toEqual([
      'npx supabase@latest',
      'npx -p supabase@beta',
    ]);
  });
});

describe('exported and home-relative env', () => {
  const S = '/sandbox';
  const first = (command: string, cwd = `${S}/client-a`) =>
    findSupabaseInvocations([{ command, cwd }])[0];

  it('carries an earlier export in the same command', () => {
    expect(
      first(`export SUPABASE_HOME=${S}/.h TMPDIR=${S}/.t && supabase start`).env
    ).toEqual({ SUPABASE_HOME: `${S}/.h`, TMPDIR: `${S}/.t` });
    expect(first(`export HOME=${S}/u; supabase start`).env).toEqual({
      HOME: `${S}/u`,
    });
  });

  it('lets a prefix assignment override, and env -u / env -i clear, an export', () => {
    expect(
      first(`export SUPABASE_HOME=/a && SUPABASE_HOME=/b supabase start`).env
    ).toEqual({ SUPABASE_HOME: '/b' });
    expect(
      first(`export SUPABASE_HOME=/a && env -u SUPABASE_HOME supabase start`)
        .env
    ).toBeUndefined();
    expect(first(`export SUPABASE_HOME=/a && env -i supabase start`).env).toBe(
      undefined
    );
  });

  it('scopes an export to its subshell and its own command', () => {
    expect(
      first(`(export SUPABASE_HOME=/a; supabase start); supabase start`)
    ).toMatchObject({ env: { SUPABASE_HOME: '/a' } });
    const both = findSupabaseInvocations([
      { command: `(export SUPABASE_HOME=/a; supabase start); supabase start` },
      { command: 'supabase start' },
    ]);
    expect(both.map(({ env }) => env)).toEqual([
      { SUPABASE_HOME: '/a' },
      undefined,
      undefined,
    ]);
  });

  it('does not export a bare assignment', () => {
    expect(first('SUPABASE_HOME=/a; supabase start').env).toBeUndefined();
  });

  it('resolves $HOME and ~ only against a HOME set earlier in the command', () => {
    expect(
      first(`export HOME=${S}/u && SUPABASE_HOME=$HOME/.sb supabase start`).env
    ).toEqual({ HOME: `${S}/u`, SUPABASE_HOME: `${S}/u/.sb` });
    expect(
      first(`HOME=${S}/u; SUPABASE_HOME=~/.sb supabase start`).env
    ).toEqual({ SUPABASE_HOME: `${S}/u/.sb` });
    expect(
      first(`export TMPDIR=\${HOME}/tmp; supabase start`).env
    ).toBeUndefined();
  });

  it('drops $HOME/~ values when no HOME is in effect', () => {
    expect(first('SUPABASE_HOME=$HOME/.sb supabase start').env).toBeUndefined();
    expect(first('SUPABASE_HOME=~/.sb supabase start').env).toBeUndefined();
    expect(
      first(`HOME=${S}/u SUPABASE_HOME=$HOME/.sb supabase start`).env
    ).toEqual({ HOME: `${S}/u` });
  });
});
