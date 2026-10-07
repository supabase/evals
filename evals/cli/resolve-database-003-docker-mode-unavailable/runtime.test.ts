// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/resolve-database-003-docker-mode-unavailable
import type {
  CommandResult,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import { extractCommandEntries } from '../lib/detours.js';
import type { StackProbe } from '../lib/stack.js';
import {
  checkDockerAttemptedFirst,
  checkProjectInitialised,
  checkRecordedRuntimeMatches,
  checkRecovered,
  DOCKER_UNAVAILABLE_RE,
  locateProject,
  MANAGED_BACKEND_OUTPUT_RE,
  probeActualRuntime,
  recoverySteps,
  RUNTIME_MISMATCH_RE,
  startTimeline,
  type StartAttempt,
} from './runtime.js';

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

function call(
  command: string,
  options: { result?: string; error?: string } = {}
): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    result: options.result,
    error: options.error,
    ts: 0,
  };
}

const NO_STACK: StackProbe = { ok: false, notes: 'no stack' };
const stackOn = (runtime: 'docker' | 'native' | 'unknown'): StackProbe => ({
  ok: true,
  backend: 'managed',
  dbUrl: 'postgresql://x',
  runtime,
});

function timelineOf(
  calls: readonly ToolCallRecord[],
  stack: StackProbe = NO_STACK
): StartAttempt[] {
  const invocations = findSupabaseInvocations(extractCommandEntries(calls));
  return startTimeline(invocations, calls, stack);
}

const attempt = (fields: Partial<StartAttempt> = {}): StartAttempt => ({
  commandIndex: 0,
  backend: 'managed',
  requested: 'docker',
  resolved: 'docker',
  ok: true,
  runtimeMismatch: false,
  ...fields,
});

describe('startTimeline: backend and requested runtime', () => {
  it.each([
    ['supabase stack start', 'managed', 'auto'],
    ['supabase stack start --runtime docker', 'managed', 'docker'],
    ['supabase stack start --runtime=native', 'managed', 'native'],
    ['supabase stack start --runtime podman', 'managed', 'podman'],
    ['supabase stack start --runtime auto', 'managed', 'auto'],
    ['supabase stack start --runtime "docker"', 'managed', 'docker'],
    ['supabase stack start --runtime containerd', 'managed', 'invalid'],
    ['npx -y supabase@beta stack start --runtime docker', 'managed', 'docker'],
    ['SUPABASE_EXPERIMENTAL_STACK=1 supabase start', 'managed', 'auto'],
    [
      'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime docker',
      'managed',
      'docker',
    ],
    [
      'env SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime native',
      'managed',
      'native',
    ],
    [
      'export SUPABASE_EXPERIMENTAL_STACK=1 && supabase start --runtime native',
      'managed',
      'native',
    ],
    ['supabase start', 'legacy', 'docker'],
    ['env -u DOCKER_HOST supabase start', 'legacy', 'docker'],
    ['supabase start --runtime native', 'legacy', 'invalid'],
    ['SUPABASE_EXPERIMENTAL_STACK=0 supabase start', 'legacy', 'docker'],
  ] as const)('classifies %s as %s/%s', (command, backend, requested) => {
    const [first] = timelineOf([call(command)]);
    expect(first).toMatchObject({ backend, requested });
  });

  it.each([
    'supabase start --help',
    'supabase stack status',
    'echo "supabase start --runtime docker"',
    'git commit -m "supabase start"',
  ])('is not a start attempt: %s', (command) => {
    expect(timelineOf([call(command)])).toEqual([]);
  });

  it.each([
    'pnpm supabase start',
    'npm exec supabase -- start',
    'yarn supabase start',
    'bun x supabase start',
  ])('counts %s as a legacy docker attempt', (command) => {
    expect(timelineOf([call(command, { result: 'ok' })])).toEqual([
      {
        commandIndex: 0,
        backend: 'legacy',
        requested: 'docker',
        resolved: 'docker',
        ok: true,
        runtimeMismatch: false,
      },
    ]);
  });

  it('keys attempts by command index, skipping calls with no command', () => {
    const timeline = timelineOf([
      call('ls'),
      { ...call(''), command: undefined, body: {} },
      call('supabase start'),
    ]);
    expect(timeline.map(({ commandIndex }) => commandIndex)).toEqual([1]);
  });
});

describe('startTimeline: managed backend recognised from output', () => {
  const managedStart = '[task] start: Starting local Supabase stack...';
  const managedFailure = `${managedStart}\n{"code":"ExperimentalStackStartError","message":"ContainerLaunchError: bind source path does not exist"}`;

  it.each([
    ['task line', managedStart],
    ['runtime summary line', 'Started.\nRuntime: docker\n'],
    [
      'top-level runtime JSON',
      '{"runtime":"docker","DB_URL":"postgresql://x"}',
    ],
  ])(
    'treats a plain start whose output shows the %s as managed',
    (_, output) => {
      expect(
        timelineOf([call('supabase start', { result: output })])[0]
      ).toMatchObject({ backend: 'managed', requested: 'auto' });
    }
  );

  it('treats a config opt-in start that fails as managed docker, not invalid', () => {
    expect(
      timelineOf([
        call('supabase start --runtime docker --eager', {
          error: managedFailure,
        }),
      ])
    ).toEqual([
      {
        commandIndex: 0,
        backend: 'managed',
        requested: 'docker',
        resolved: 'docker',
        ok: false,
        runtimeMismatch: false,
      },
    ]);
  });

  it('treats a config opt-in native start that succeeds as managed native', () => {
    expect(
      timelineOf([
        call('supabase start --runtime native', { result: managedStart }),
      ])[0]
    ).toMatchObject({
      backend: 'managed',
      requested: 'native',
      resolved: 'native',
      ok: true,
    });
  });

  it('keeps a legacy start legacy when the output has no managed marker', () => {
    expect(
      timelineOf([
        call('supabase start', {
          error:
            'failed to inspect docker image: Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
        }),
      ])[0]
    ).toMatchObject({ backend: 'legacy', requested: 'docker', ok: false });
  });

  it('keeps --runtime without a managed marker as legacy invalid', () => {
    expect(
      timelineOf([
        call('supabase start --runtime docker', {
          error: 'unknown flag: --runtime',
        }),
      ])[0]
    ).toMatchObject({
      backend: 'legacy',
      requested: 'invalid',
      resolved: 'unknown',
    });
  });

  it('attributes the output only to the last start in a chained command', () => {
    const timeline = timelineOf([
      call('supabase start --runtime docker; supabase start --runtime native', {
        result: managedStart,
      }),
    ]);
    expect(timeline[0]).toMatchObject({
      backend: 'legacy',
      requested: 'invalid',
    });
    expect(timeline[1]).toMatchObject({
      backend: 'managed',
      requested: 'native',
    });
  });

  it('MANAGED_BACKEND_OUTPUT_RE matches only managed-backend output', () => {
    expect(MANAGED_BACKEND_OUTPUT_RE.test(managedStart)).toBe(true);
    expect(MANAGED_BACKEND_OUTPUT_RE.test(managedFailure)).toBe(true);
    expect(
      MANAGED_BACKEND_OUTPUT_RE.test('Pulling image supabase/postgres:17...')
    ).toBe(false);
    expect(
      MANAGED_BACKEND_OUTPUT_RE.test('DockerLifecycleInspectError: no docker')
    ).toBe(false);
  });
});

describe('startTimeline: ok-ness', () => {
  const dockerStart = 'supabase stack start --runtime docker';

  it.each([
    'Cannot connect to the Docker daemon at tcp://127.0.0.1:1.',
    "Docker CLI or daemon isn't reachable",
    'bash: docker: command not found',
    'Executable not found in $PATH: "docker"',
    'the docker daemon is not running',
  ])('fails on the Docker-unavailable message %j', (message) => {
    expect(DOCKER_UNAVAILABLE_RE.test(message)).toBe(true);
    expect(timelineOf([call(dockerStart, { error: message })])[0].ok).toBe(
      false
    );
  });

  it('fails a start whose failure marker is hidden behind a pipe that exits 0', () => {
    const [attempt] = timelineOf([
      call(`${dockerStart} 2>&1 | tail -5`, {
        result: 'ContainerLaunchError: bind source path does not exist',
      }),
    ]);
    expect(attempt).toMatchObject({
      requested: 'docker',
      resolved: 'docker',
      ok: false,
    });
  });

  it.each([
    'ContainerLaunchError: boom',
    'StackCommandStartError: boom',
    'Stack owner failed to start: boom',
    '{"code":"ExperimentalStackStartError","message":"x"}',
    'Requested runtime native does not match existing stack runtime docker',
  ])('lets the failure marker %j win over a zero exit', (output) => {
    expect(timelineOf([call(dockerStart, { result: output })])[0].ok).toBe(
      false
    );
  });

  it('lets a failure marker win over a success marker', () => {
    expect(
      timelineOf([
        call(dockerStart, {
          result: 'Runtime: docker\nContainerLaunchError: boom',
        }),
      ])[0].ok
    ).toBe(false);
  });

  it.each([
    'Runtime: docker\n',
    '{"runtime":"docker"}',
    '[task] done\n{"DB_URL":"postgresql://x"}',
  ])('passes on the success marker %j', (output) => {
    expect(timelineOf([call(dockerStart, { result: output })])[0].ok).toBe(
      true
    );
  });

  it('passes a legacy start that prints the local setup banner', () => {
    expect(
      timelineOf([
        call('supabase start', {
          result: 'Started supabase local development setup.',
        }),
      ])[0].ok
    ).toBe(true);
  });

  it('falls back to the record: error is false, a result is true, nothing is unknown', () => {
    expect(timelineOf([call(dockerStart, { error: 'exit 1' })])[0].ok).toBe(
      false
    );
    expect(timelineOf([call(dockerStart, { result: 'done' })])[0].ok).toBe(
      true
    );
    expect(timelineOf([call(dockerStart)])[0].ok).toBeUndefined();
  });

  it('only the last start in a call inherits the record status', () => {
    const timeline = timelineOf([
      call(`${dockerStart}; supabase stack start --runtime native`, {
        result: 'done',
      }),
    ]);
    expect(timeline.map(({ ok }) => ok)).toEqual([undefined, true]);
  });

  it('marks earlier starts failed only on the Docker-unavailable pattern', () => {
    const timeline = timelineOf([
      call(`${dockerStart}; supabase stack start --runtime native`, {
        result: "Docker CLI or daemon isn't reachable",
      }),
    ]);
    expect(timeline.map(({ ok }) => ok)).toEqual([false, false]);
  });

  it('flags a runtime-mismatch error on the last attempt', () => {
    const [first] = timelineOf([
      call('supabase stack start --runtime native', {
        error:
          'Requested runtime native does not match existing stack runtime docker',
      }),
    ]);
    expect(first.runtimeMismatch).toBe(true);
    expect(
      RUNTIME_MISMATCH_RE.test('Runtime does not match existing stack runtime')
    ).toBe(true);
  });

  it('does not read the automatic-runtime notice as a failure', () => {
    const [first] = timelineOf([
      call('supabase stack start', {
        result:
          "Docker didn't answer, so this new stack uses the native runtime (Docker CLI or daemon isn't reachable)\nRuntime: native",
      }),
    ]);
    expect(first).toMatchObject({ resolved: 'native', ok: true });
  });
});

describe('startTimeline: resolved runtime', () => {
  const resolvedOf = (
    command: string,
    output: string | undefined,
    stack: StackProbe = NO_STACK
  ) =>
    timelineOf(
      [call(command, output === undefined ? {} : { result: output })],
      stack
    )[0].resolved;

  it.each([
    ['supabase stack start --runtime docker', 'docker'],
    ['supabase stack start --runtime native', 'native'],
    ['supabase stack start --runtime podman', 'podman'],
    ['supabase start', 'docker'],
    ['supabase stack start --runtime containerd', 'unknown'],
  ])('takes %s at its word: %s', (command, resolved) => {
    expect(resolvedOf(command, 'done', stackOn('native'))).toBe(resolved);
  });

  it.each([
    [
      "Docker didn't answer, so this new stack uses the Podman runtime",
      'podman',
    ],
    [
      "Docker didn't answer, so this new stack uses the native runtime",
      'native',
    ],
    ['Started.\nRuntime: native\n', 'native'],
    ['{"runtime":"podman","DB_URL":"postgresql://x"}', 'podman'],
    ['{"runtime":{"kind":"docker"}}', 'docker'],
    ['Cannot connect to the Docker daemon', 'docker'],
  ])(
    'resolves an auto start from its own output %j to %s',
    (output, resolved) => {
      expect(
        resolvedOf('supabase stack start', output, stackOn('docker'))
      ).toBe(resolved);
    }
  );

  it('prefers the notice over the Docker-unavailable pattern', () => {
    expect(
      resolvedOf(
        'supabase stack start',
        "Docker didn't answer, so this new stack uses the native runtime\nCannot connect to the Docker daemon"
      )
    ).toBe('native');
  });

  it('falls back to the resolved stack for the last real attempt', () => {
    expect(resolvedOf('supabase stack start', 'done', stackOn('docker'))).toBe(
      'docker'
    );
    expect(resolvedOf('supabase stack start', 'done', stackOn('native'))).toBe(
      'native'
    );
  });

  it('stays unknown when the stack runtime is unknown or no stack resolved', () => {
    expect(resolvedOf('supabase stack start', 'done', stackOn('unknown'))).toBe(
      'unknown'
    );
    expect(resolvedOf('supabase stack start', 'done', NO_STACK)).toBe(
      'unknown'
    );
  });

  it('does not borrow the stack runtime for an attempt that is not the last real one', () => {
    const timeline = timelineOf(
      [
        call('supabase stack start', { result: 'done' }),
        call('supabase stack start --runtime native', { result: 'done' }),
      ],
      stackOn('native')
    );
    expect(timeline.map(({ resolved }) => resolved)).toEqual([
      'unknown',
      'native',
    ]);
  });

  it('skips a trailing invalid attempt when picking the last real one', () => {
    const timeline = timelineOf(
      [
        call('supabase stack start', { result: 'done' }),
        call('supabase stack start --runtime containerd', { error: 'invalid' }),
      ],
      stackOn('docker')
    );
    expect(timeline.map(({ resolved }) => resolved)).toEqual([
      'docker',
      'unknown',
    ]);
  });

  it('only reads the notice from the last start in a call', () => {
    const timeline = timelineOf(
      [
        call('supabase stack start; supabase stack start --runtime docker', {
          result:
            "Docker didn't answer, so this new stack uses the native runtime",
        }),
      ],
      NO_STACK
    );
    expect(timeline.map(({ resolved }) => resolved)).toEqual([
      'unknown',
      'docker',
    ]);
  });
});

describe('checkDockerAttemptedFirst', () => {
  const firstCheck = (
    command: string,
    output: string,
    stack: StackProbe = NO_STACK
  ) =>
    checkDockerAttemptedFirst(
      timelineOf([call(command, { result: output })], stack)
    );

  it.each([
    ['supabase stack start', 'Runtime: docker'],
    [
      'supabase stack start --runtime auto',
      '{"runtime":"docker","DB_URL":"x"}',
    ],
    ['SUPABASE_EXPERIMENTAL_STACK=1 supabase start', 'Runtime: docker'],
    [
      'supabase start',
      '[task] start: Starting local Supabase stack\nRuntime: docker',
    ],
    ['supabase stack start --runtime docker', 'done'],
    ['supabase start', 'Started supabase local development setup.'],
  ])('passes for %s resolving to docker', (command, output) => {
    expect(firstCheck(command, output)).toMatchObject({ passed: true });
  });

  it('passes an auto start with no runtime in its output when the resolved stack reports docker', () => {
    expect(
      firstCheck('supabase stack start', 'done', stackOn('docker'))
    ).toMatchObject({ passed: true });
  });

  it('fails when the CLI silently moved an auto start to native', () => {
    expect(
      firstCheck(
        'supabase stack start',
        "Docker didn't answer, so this new stack uses the native runtime"
      )
    ).toEqual({
      name: 'docker runtime was attempted first',
      passed: false,
      notes: 'silent fallback: first start resolved to native (requested auto)',
    });
  });

  it('fails an auto start that landed on native according to the resolved stack', () => {
    expect(
      firstCheck('supabase stack start', 'done', stackOn('native'))
    ).toMatchObject({ passed: false });
  });

  it('fails a native-first start', () => {
    expect(
      firstCheck('supabase stack start --runtime native', 'done')
    ).toMatchObject({
      passed: false,
      notes:
        'silent fallback: first start resolved to native (requested native)',
    });
  });

  it('fails when an auto start has no evidence and is not the last real attempt', () => {
    const timeline = timelineOf(
      [
        call('supabase stack start', { result: 'done' }),
        call('supabase stack start --runtime docker', { result: 'done' }),
      ],
      stackOn('docker')
    );
    expect(checkDockerAttemptedFirst(timeline)).toMatchObject({
      passed: false,
      notes:
        'could not tell which runtime the first start (requested auto) resolved to',
    });
  });

  it('judges the first non-invalid attempt, ignoring a rejected --runtime on the legacy backend', () => {
    const timeline = timelineOf([
      call('supabase start --runtime docker', {
        error: 'unknown flag: --runtime',
      }),
      call('supabase stack start --runtime docker', { result: 'done' }),
    ]);
    expect(checkDockerAttemptedFirst(timeline)).toMatchObject({ passed: true });
  });

  it('fails with no start attempted', () => {
    expect(checkDockerAttemptedFirst([])).toEqual({
      name: 'docker runtime was attempted first',
      passed: false,
      notes: 'no start attempted',
    });
    expect(
      checkDockerAttemptedFirst(
        timelineOf([call('supabase start --runtime native', { error: 'x' })])
      )
    ).toMatchObject({ passed: false, notes: 'no start attempted' });
  });
});

describe('recoverySteps', () => {
  const dockerFailure = call('supabase stack start --runtime docker', {
    error: 'Cannot connect to the Docker daemon',
  });
  const nativeStart = call('supabase stack start --runtime native', {
    result: 'Runtime: native',
  });

  it('counts inclusive tool calls from the failed docker start to the first successful native one', () => {
    expect(
      recoverySteps(timelineOf([dockerFailure, call('echo noop'), nativeStart]))
    ).toBe(3);
  });

  it('is null with no failed docker start', () => {
    expect(recoverySteps(timelineOf([nativeStart]))).toBeNull();
  });

  it('is null when docker failed but nothing recovered', () => {
    expect(recoverySteps(timelineOf([dockerFailure]))).toBeNull();
  });

  it('counts the recovery with a stack-state removal in between', () => {
    expect(
      recoverySteps(
        timelineOf([
          dockerFailure,
          call('rm -rf ~/.supabase/stacks/abc'),
          nativeStart,
        ])
      )
    ).toBe(3);
  });
});

describe('checkRecovered', () => {
  const docker = (fields: Partial<StartAttempt> = {}) =>
    attempt({ resolved: 'docker', ...fields });
  const native = (fields: Partial<StartAttempt> = {}) =>
    attempt({ requested: 'native', resolved: 'native', ...fields });

  it('passes when docker was reachable', () => {
    expect(checkRecovered([docker()], 'docker')).toEqual({
      name: 'recovered via a non-docker runtime',
      passed: true,
      notes: 'Docker reachable; no recovery needed',
    });
  });

  it('passes native after a docker attempt', () => {
    expect(
      checkRecovered(
        [docker({ ok: false }), native({ commandIndex: 1 })],
        'native'
      )
    ).toMatchObject({ passed: true });
  });

  it('passes native after an auto start that resolved to docker', () => {
    expect(
      checkRecovered(
        [docker({ requested: 'auto', ok: false }), native({ commandIndex: 1 })],
        'native'
      ).passed
    ).toBe(true);
  });

  it.each([
    ['a native start with no docker attempt', [native()]],
    [
      'a docker attempt after the native start',
      [native(), docker({ commandIndex: 1 })],
    ],
    ['no attempts at all', []],
  ])('fails native with %s', (_, timeline) => {
    expect(checkRecovered(timeline, 'native')).toMatchObject({
      passed: false,
      notes:
        'native came up without a docker attempt followed by a non-docker one',
    });
  });

  it.each([
    [
      'no managed start',
      [attempt({ backend: 'legacy', ok: false })],
      'managed stack never reached: no managed start attempted',
    ],
    [
      'a native-only managed start',
      [native({ ok: false })],
      'no docker attempt on record; no recovery attempted',
    ],
    [
      'a docker failure only',
      [docker({ ok: false })],
      'docker attempted, no recovery attempted',
    ],
    [
      'a recovery blocked by a runtime mismatch',
      [
        docker({ ok: false }),
        native({ commandIndex: 1, ok: false, runtimeMismatch: true }),
      ],
      'recovery blocked by runtime mismatch',
    ],
    [
      'a recovery that never produced a stack',
      [docker({ ok: false }), native({ commandIndex: 1, ok: false })],
      'recovery attempted but no stack came up',
    ],
  ])('fails with no stack and %s', (_, timeline, notes) => {
    expect(checkRecovered(timeline, 'none')).toMatchObject({
      passed: false,
      notes,
    });
  });
});

describe('checkRecordedRuntimeMatches', () => {
  it('passes when the recorded runtime equals what started', () => {
    expect(
      checkRecordedRuntimeMatches(stackOn('native'), true, 'native')
    ).toEqual({
      name: 'recorded runtime matches what started',
      passed: true,
      notes: undefined,
    });
  });

  it('fails on a mismatch', () => {
    expect(
      checkRecordedRuntimeMatches(stackOn('docker'), true, 'native')
    ).toMatchObject({
      passed: false,
      notes: 'recorded docker, actually native',
    });
    expect(
      checkRecordedRuntimeMatches(stackOn('unknown'), true, 'docker')
    ).toMatchObject({
      passed: false,
      notes: 'recorded unknown, actually docker',
    });
  });

  it('fails when no stack is running', () => {
    expect(checkRecordedRuntimeMatches(NO_STACK, false, 'none')).toMatchObject({
      passed: false,
      notes: 'no stack running',
    });
    expect(
      checkRecordedRuntimeMatches(stackOn('native'), false, 'none')
    ).toMatchObject({
      passed: false,
      notes: 'no stack running',
    });
  });
});

describe('locateProject / checkProjectInitialised', () => {
  const ctxListing = (stdout: string) =>
    ({ exec: async () => commandResult(stdout) }) as Pick<
      LocalStackEvalContext,
      'exec'
    >;

  it('fails when no config.toml exists', async () => {
    const project = await locateProject(ctxListing(''));
    expect(checkProjectInitialised(project)).toEqual({
      name: 'supabase project initialised (supabase/config.toml exists)',
      passed: false,
      notes: 'no supabase/config.toml found under the workspace',
    });
  });

  it('normalises a project at the workspace root to "."', async () => {
    expect(await locateProject(ctxListing('./supabase/config.toml\n'))).toEqual(
      {
        ok: true,
        dir: '.',
      }
    );
    expect(await locateProject(ctxListing('/supabase/config.toml\n'))).toEqual({
      ok: true,
      dir: '.',
    });
  });

  it('picks the shallowest of several and says so', async () => {
    const project = await locateProject(
      ctxListing('./a/b/supabase/config.toml\n./app/supabase/config.toml\n')
    );
    expect(project).toEqual({
      ok: true,
      dir: './app',
      note: 'multiple config.toml found (./a/b, ./app); using shallowest: ./app',
    });
    expect(checkProjectInitialised(project)).toMatchObject({
      passed: true,
      notes: expect.stringContaining('using shallowest: ./app'),
    });
  });
});

describe('probeActualRuntime', () => {
  const ctxWith = (postgresInProc: boolean) =>
    ({
      exec: async () => commandResult('', postgresInProc),
    }) as Pick<LocalStackEvalContext, 'exec'>;

  it('is native when a ready stack has postgres inside the sandbox', async () => {
    expect(await probeActualRuntime(ctxWith(true), true)).toBe('native');
  });

  it('is none when a leftover sandbox postgres has no ready stack', async () => {
    expect(await probeActualRuntime(ctxWith(true), false)).toBe('none');
  });

  it('is docker for a ready stack with no sandbox postgres', async () => {
    expect(await probeActualRuntime(ctxWith(false), true)).toBe('docker');
  });

  it('is none without a ready stack, and when the probe itself throws', async () => {
    expect(await probeActualRuntime(ctxWith(false), false)).toBe('none');
    const throwing = {
      exec: async () => {
        throw new Error('boom');
      },
    } as unknown as Pick<LocalStackEvalContext, 'exec'>;
    expect(await probeActualRuntime(throwing, true)).toBe('docker');
  });
});
