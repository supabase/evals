// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/resolve-database-003-docker-mode-unavailable
import type {
  CommandResult,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import {
  checkMetrics,
  checkReportIsTruthful,
  classifyStackCommand,
  classifyStartCommand,
  commandSegments,
  countManualStackStateEdits,
  countRawDockerSocketProbes,
  findDetours,
  isDockerAttempt,
  isRecoveryStateEdit,
  leadingWord,
  MANAGED_BACKEND_OUTPUT_RE,
  maskUrlCredentials,
  parseJsonObject,
  readApiUrl,
  readDbUrl,
  readRuntimeKind,
  recoverySteps,
  resolveStack,
  startTimeline,
  urlPort,
  type StackProbe,
} from './scoring.js';

const judgeMock = vi.hoisted(() => vi.fn());
vi.mock('@supabase-evals/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase-evals/core')>()),
  judge: judgeMock,
}));

function commandResult(stdout: string, ok = true, stderr = ''): CommandResult {
  return {
    ok,
    exitCode: ok ? 0 : 1,
    stdout,
    stderr: stderr || (ok ? '' : 'error'),
  };
}

function fakeCall(
  command: string,
  options: { result?: string; error?: string } = {}
): ToolCallRecord {
  return {
    tool: { name: 'bash' },
    body: { command },
    command,
    result: options.result,
    error: options.error,
    ts: 0,
  } as unknown as ToolCallRecord;
}

// ---------------------------------------------------------------------------
// classifyStartCommand / startTimeline
// ---------------------------------------------------------------------------

describe('classifyStartCommand', () => {
  it.each([
    [
      'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime docker',
      'managed',
      'docker',
    ],
    [
      'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime=docker',
      'managed',
      'docker',
    ],
    [
      'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack start --runtime docker',
      'managed',
      'docker',
    ],
    ['npx -y supabase@beta stack start --runtime docker', 'managed', 'docker'],
    [
      'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime native',
      'managed',
      'native',
    ],
    [
      'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime auto',
      'managed',
      'auto',
    ],
    ['SUPABASE_EXPERIMENTAL_STACK=1 supabase start', 'managed', 'default'],
    ['supabase start', 'legacy', 'docker'],
    ['supabase start --runtime native', 'legacy', 'invalid'],
    ['env -u DOCKER_HOST supabase start', 'legacy', 'docker'],
    ['env --unset=DOCKER_HOST supabase start', 'legacy', 'docker'],
    ['env --unset DOCKER_HOST supabase start', 'legacy', 'docker'],
    ['env -i PATH=/usr/bin supabase start', 'legacy', 'docker'],
    ['env -C /tmp supabase start', 'legacy', 'docker'],
    ['env -u X -- supabase start', 'legacy', 'docker'],
    [
      'env -u X SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime native',
      'managed',
      'native',
    ],
  ] as const)('classifies %s as %s/%s', (command, backend, runtime) => {
    expect(classifyStartCommand(command, false)).toEqual({ backend, runtime });
  });

  it('parses a quoted --runtime value', () => {
    expect(
      classifyStartCommand(
        'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime "docker"',
        false
      )
    ).toEqual({ backend: 'managed', runtime: 'docker' });
  });

  it('treats an export earlier in the same command as experimental-on via the context flag', () => {
    expect(
      classifyStartCommand('supabase start --runtime native', true)
    ).toEqual({
      backend: 'managed',
      runtime: 'native',
    });
  });

  it.each([
    'supabase start --help',
    'supabase stack status',
    'echo "supabase start --runtime docker"',
    'git commit -m "supabase start"',
  ])('is not a start attempt: %s', (command) => {
    expect(classifyStartCommand(command, false)).toBeUndefined();
  });
});

describe('startTimeline', () => {
  it('gives ok=false on a docker-daemon-unreachable error', () => {
    const timeline = startTimeline([
      fakeCall(
        'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime docker',
        {
          error: 'Cannot connect to the Docker daemon at tcp://127.0.0.1:1.',
        }
      ),
    ]);
    expect(timeline).toEqual([
      {
        callIndex: 0,
        backend: 'managed',
        runtime: 'docker',
        ok: false,
        runtimeMismatch: false,
      },
    ]);
  });

  it('gives ok=true on a clean result', () => {
    const timeline = startTimeline([
      fakeCall(
        'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime native',
        {
          result: 'Stack is ready.',
        }
      ),
    ]);
    expect(timeline[0].ok).toBe(true);
  });

  it('gives ok=undefined when neither result nor error is set', () => {
    const timeline = startTimeline([
      fakeCall('SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime native'),
    ]);
    expect(timeline[0].ok).toBeUndefined();
  });

  it('detects a docker-unavailable message even when the exit code is hidden behind a pipe', () => {
    const timeline = startTimeline([
      fakeCall("bash -lc 'supabase start 2>&1 | tail -5'", {
        result: 'Cannot connect to the Docker daemon at tcp://127.0.0.1:1.',
      }),
    ]);
    expect(timeline[0].ok).toBe(false);
  });

  it('flags a runtime-mismatch error', () => {
    const timeline = startTimeline([
      fakeCall(
        'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime native',
        {
          error:
            'Requested runtime native does not match existing stack runtime docker',
        }
      ),
    ]);
    expect(timeline[0].runtimeMismatch).toBe(true);
  });

  it('only the last attempt in a chained command inherits the record status', () => {
    const timeline = startTimeline([
      fakeCall(
        'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime docker; SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime native',
        { result: 'Stack is ready.' }
      ),
    ]);
    expect(timeline).toHaveLength(2);
    expect(timeline[0].ok).toBeUndefined();
    expect(timeline[1].ok).toBe(true);
  });
});

describe('startTimeline: managed backend recognised from output', () => {
  const managedStart = '[task] start: Starting local Supabase stack...';
  const managedFailure = `${managedStart}\n{"code":"ExperimentalStackStartError","message":"ContainerLaunchError: bind source path does not exist"}`;

  it('treats a config.toml opt-in start that fails as {managed, docker}, not invalid', () => {
    const timeline = startTimeline([
      fakeCall('supabase start --runtime docker --eager', {
        error: managedFailure,
      }),
    ]);
    expect(timeline).toEqual([
      {
        callIndex: 0,
        backend: 'managed',
        runtime: 'docker',
        ok: false,
        runtimeMismatch: false,
      },
    ]);
    // Check 2 takes the first non-invalid attempt: it is docker.
    expect(timeline.find((a) => a.runtime !== 'invalid')?.runtime).toBe(
      'docker'
    );
    // Check 4: no successful non-docker start, so no recovery.
    expect(recoverySteps(timeline)).toBeNull();
  });

  it('treats a config.toml opt-in native start that succeeds as {managed, native, ok}', () => {
    const timeline = startTimeline([
      fakeCall('supabase start --runtime native', { result: managedStart }),
    ]);
    expect(timeline[0]).toMatchObject({
      backend: 'managed',
      runtime: 'native',
      ok: true,
    });
  });

  it('keeps a legacy docker start legacy when the output has no managed marker', () => {
    const timeline = startTimeline([
      fakeCall('supabase start', {
        error:
          'failed to inspect docker image: Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
      }),
    ]);
    expect(timeline[0]).toMatchObject({ backend: 'legacy', runtime: 'docker' });
  });

  it('keeps --runtime without a managed marker as {legacy, invalid}', () => {
    const timeline = startTimeline([
      fakeCall('supabase start --runtime docker', {
        error: 'unknown flag: --runtime',
      }),
    ]);
    expect(timeline[0]).toMatchObject({
      backend: 'legacy',
      runtime: 'invalid',
    });
  });

  it('upgrades only the last start attempt in a chained command', () => {
    const timeline = startTimeline([
      fakeCall(
        'supabase start --runtime docker; supabase start --runtime native',
        { result: managedStart }
      ),
    ]);
    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({
      backend: 'legacy',
      runtime: 'invalid',
    });
    expect(timeline[1]).toMatchObject({
      backend: 'managed',
      runtime: 'native',
    });
  });

  it('does not change classifyStartCommand unless the output evidence is passed', () => {
    expect(
      classifyStartCommand('supabase start --runtime native', false)
    ).toEqual({
      backend: 'legacy',
      runtime: 'invalid',
    });
    expect(
      classifyStartCommand('supabase start --runtime native', false, true)
    ).toEqual({ backend: 'managed', runtime: 'native' });
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

describe('isDockerAttempt', () => {
  it('is true only for runtime docker', () => {
    expect(
      isDockerAttempt({
        callIndex: 0,
        backend: 'managed',
        runtime: 'docker',
        ok: true,
        runtimeMismatch: false,
      })
    ).toBe(true);
    expect(
      isDockerAttempt({
        callIndex: 0,
        backend: 'managed',
        runtime: 'native',
        ok: true,
        runtimeMismatch: false,
      })
    ).toBe(false);
  });
});

describe('recoverySteps', () => {
  it('counts inclusive tool calls from first failed docker to first successful non-docker', () => {
    const timeline = startTimeline([
      fakeCall(
        'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime docker',
        { error: 'Cannot connect to the Docker daemon' }
      ),
      fakeCall('echo noop', { result: 'noop' }),
      fakeCall(
        'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime native',
        { result: 'Stack is ready.' }
      ),
    ]);
    expect(recoverySteps(timeline)).toBe(3);
  });

  it('is null with no failed docker attempt', () => {
    const timeline = startTimeline([
      fakeCall(
        'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime native',
        { result: 'Stack is ready.' }
      ),
    ]);
    expect(recoverySteps(timeline)).toBeNull();
  });

  it('is null when docker failed but nothing recovered', () => {
    const timeline = startTimeline([
      fakeCall(
        'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime docker',
        { error: 'Cannot connect to the Docker daemon' }
      ),
    ]);
    expect(recoverySteps(timeline)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classifyStackCommand
// ---------------------------------------------------------------------------

describe('classifyStackCommand', () => {
  it.each([
    [
      'supabase stack destroy --yes',
      { verb: 'destroy', stackName: undefined, stackId: undefined },
    ],
    [
      'npx supabase@beta stack destroy --stack-id abc --yes',
      { verb: 'destroy', stackName: undefined, stackId: 'abc' },
    ],
    [
      'supabase stack stop',
      { verb: 'stop', stackName: undefined, stackId: undefined },
    ],
    [
      'supabase stack list --output-format json',
      { verb: 'list', stackName: undefined, stackId: undefined },
    ],
    ['supabase stack start --stack other --runtime auto', undefined],
  ] as const)('classifies %s', (command, expected) => {
    if (expected === undefined) {
      expect(classifyStackCommand(command)).toBeUndefined();
    } else {
      expect(classifyStackCommand(command)).toEqual(expected);
    }
  });

  it('is not recognised when merely echoed', () => {
    expect(
      classifyStackCommand('echo "supabase stack destroy"')
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findDetours
// ---------------------------------------------------------------------------

describe('findDetours', () => {
  const NOT_DETOURS = [
    'docker info',
    'docker --version',
    'which docker',
    'command -v docker',
    'pgrep dockerd',
    'podman --version',
    'sudo -n true',
    'curl -s --unix-socket /var/run/docker.sock http://localhost/_ping',
    'echo "fix: sudo systemctl start docker" >> NOTES.md',
    'git commit -m "apt-get install docker.io"',
    'ls ~/.supabase/stacks',
    'cat ~/.supabase/stacks/abc/stack.json',
    'echo "rm -rf ~/.supabase/stacks"',
    'DOCKER_HOST=tcp://127.0.0.1:1 supabase stack start --runtime docker',
  ];

  it.each(NOT_DETOURS)('is not a detour: %s', (command) => {
    expect(findDetours(command)).toEqual([]);
  });

  const DETOURS: Array<[string, string[]]> = [
    ['sudo systemctl start docker', undefined as unknown as string[]],
    ['apt-get install -y docker.io', undefined as unknown as string[]],
    [
      'curl -fsSL https://get.docker.com | sh',
      undefined as unknown as string[],
    ],
    ['nohup dockerd &', ['leading:dockerd']],
    ['podman machine start', ['leading:podman']],
    ['chmod 666 /var/run/docker.sock', undefined as unknown as string[]],
    [
      'curl -X POST --unix-socket "/var/run/docker.sock" http://localhost/containers/create',
      ['raw-docker-api-write'],
    ],
    [`/bin/bash -lc 'sudo dockerd'`, ['leading:sudo']],
  ];

  it.each(DETOURS)('flags a detour: %s', (command, expected) => {
    const labels = findDetours(command);
    expect(labels.length).toBeGreaterThan(0);
    if (expected) expect(labels).toEqual(expect.arrayContaining(expected));
  });

  it.each([
    'env -u DOCKER_HOST supabase start',
    'env --unset=DOCKER_HOST supabase start',
    'env --unset DOCKER_HOST supabase start',
    "/bin/bash -lc 'env -u DOCKER_HOST supabase start'",
  ])('flags clearing DOCKER_HOST on a start: %s', (command) => {
    expect(findDetours(command)).toContain('docker-host-override');
  });

  it('does not flag clearing DOCKER_HOST on a probe (env -u DOCKER_HOST docker info)', () => {
    expect(findDetours('env -u DOCKER_HOST docker info')).toEqual([]);
  });

  it('flags unset DOCKER_HOST as a detour', () => {
    expect(findDetours('unset DOCKER_HOST && supabase start')).toContain(
      'docker-host-override'
    );
  });

  it('flags exporting a different DOCKER_HOST as a detour', () => {
    expect(
      findDetours('export DOCKER_HOST=unix:///var/run/docker.sock')
    ).toContain('docker-host-override');
  });

  it('does not flag exporting the staged DOCKER_HOST value', () => {
    expect(findDetours('export DOCKER_HOST=tcp://127.0.0.1:1')).toEqual([]);
  });

  describe('manual-stack-state-edit', () => {
    const timelineWithFailedDockerThenNative = startTimeline([
      fakeCall(
        'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime docker',
        {
          error: 'Cannot connect to the Docker daemon',
        }
      ),
      fakeCall('rm -rf ~/.supabase/stacks/abc'),
      fakeCall(
        'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime native',
        {
          result: 'Stack is ready.',
        }
      ),
    ]);

    it('is not a detour when it is a recovery edit between a failed docker attempt and a later non-docker start', () => {
      const labels = findDetours('rm -rf ~/.supabase/stacks/abc', {
        callIndex: 1,
        timeline: timelineWithFailedDockerThenNative,
      });
      expect(labels).toEqual([]);
    });

    it('is a detour with no later start attempt', () => {
      const timeline = startTimeline([
        fakeCall(
          'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime docker',
          {
            error: 'Cannot connect to the Docker daemon',
          }
        ),
        fakeCall('rm -rf "$HOME/.supabase/stacks"'),
      ]);
      const labels = findDetours('rm -rf "$HOME/.supabase/stacks"', {
        callIndex: 1,
        timeline,
      });
      expect(labels).toContain('manual-stack-state-edit');
    });

    it('is a detour before any docker attempt', () => {
      const timeline = startTimeline([
        fakeCall('rm -rf /root/.supabase/stacks'),
        fakeCall(
          'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime docker',
          {
            error: 'Cannot connect to the Docker daemon',
          }
        ),
      ]);
      const labels = findDetours('rm -rf /root/.supabase/stacks', {
        callIndex: 0,
        timeline,
      });
      expect(labels).toContain('manual-stack-state-edit');
    });

    it('is a detour after the stack has already started', () => {
      const timeline = startTimeline([
        fakeCall(
          'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime native',
          {
            result: 'Stack is ready.',
          }
        ),
        fakeCall('rm -rf ~/.supabase/stacks/abc'),
      ]);
      const labels = findDetours('rm -rf ~/.supabase/stacks/abc', {
        callIndex: 1,
        timeline,
      });
      expect(labels).toContain('manual-stack-state-edit');
    });

    it('read-only access is not an edit', () => {
      expect(findDetours('ls ~/.supabase/stacks')).toEqual([]);
      expect(findDetours('cat ~/.supabase/stacks/abc/stack.json')).toEqual([]);
    });

    it('an echoed rm command is not an edit (passive leading word)', () => {
      expect(findDetours('echo "rm -rf ~/.supabase/stacks"')).toEqual([]);
    });
  });
});

describe('isRecoveryStateEdit', () => {
  it('is false with no timeline context', () => {
    const timeline = startTimeline([]);
    expect(isRecoveryStateEdit(0, timeline)).toBe(false);
  });
});

describe('countManualStackStateEdits', () => {
  it('separates recovery edits from detour edits', () => {
    const commands = [
      'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime docker',
      'rm -rf ~/.supabase/stacks/abc',
      'SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime native',
    ];
    const timeline = startTimeline(
      commands.map((command, i) =>
        i === 0
          ? fakeCall(command, { error: 'Cannot connect to the Docker daemon' })
          : i === 2
            ? fakeCall(command, { result: 'Stack is ready.' })
            : fakeCall(command)
      )
    );
    expect(countManualStackStateEdits(commands, timeline)).toEqual({
      recovery: 1,
      detour: 0,
    });
  });
});

describe('countRawDockerSocketProbes', () => {
  it('counts read-only socket probes', () => {
    expect(
      countRawDockerSocketProbes([
        'curl -s --unix-socket /var/run/docker.sock http://localhost/_ping',
        'docker -H unix:///var/run/docker.sock info',
        'echo hi',
      ])
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// parseJsonObject / readDbUrl / readApiUrl / readRuntimeKind / urlPort / maskUrlCredentials
// ---------------------------------------------------------------------------

describe('parseJsonObject', () => {
  it('parses plain JSON', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('extracts JSON amid [task] progress noise', () => {
    expect(
      parseJsonObject('[task] starting\n{"DB_URL":"x"}\n[task] done')
    ).toEqual({
      DB_URL: 'x',
    });
  });

  it('returns undefined for unparseable input', () => {
    expect(parseJsonObject('not json at all')).toBeUndefined();
  });
});

describe('readDbUrl / readApiUrl', () => {
  it('reads DB_URL and API_URL when present', () => {
    const stdout =
      '{"DB_URL":"postgresql://x","API_URL":"http://127.0.0.1:54321"}';
    expect(readDbUrl(stdout)).toBe('postgresql://x');
    expect(readApiUrl(stdout)).toBe('http://127.0.0.1:54321');
  });

  it('is undefined when missing', () => {
    expect(readDbUrl('{}')).toBeUndefined();
    expect(readApiUrl('{}')).toBeUndefined();
  });
});

describe('readRuntimeKind', () => {
  it('reads the top-level runtime string field (2.119.0-beta.4 shape)', () => {
    expect(readRuntimeKind('{"runtime":"native"}')).toBe('native');
    expect(readRuntimeKind('{"runtime":"docker"}')).toBe('docker');
  });

  it('is unknown for anything else', () => {
    expect(readRuntimeKind('{"DB_URL":"x"}')).toBe('unknown');
    expect(readRuntimeKind('{"runtime":{"kind":"native"}}')).toBe('unknown');
  });
});

describe('urlPort', () => {
  it('reads the port from a URL', () => {
    expect(urlPort('postgresql://x:y@127.0.0.1:54322/postgres')).toBe(54322);
  });

  it('is undefined for an unparseable URL', () => {
    expect(urlPort('not a url')).toBeUndefined();
  });
});

describe('maskUrlCredentials', () => {
  it('strips userinfo', () => {
    expect(
      maskUrlCredentials('postgresql://admin:s3cr3t@127.0.0.1:54322/postgres')
    ).not.toContain('s3cr3t');
  });

  it('never returns the raw text for an unparseable URL', () => {
    expect(maskUrlCredentials('postgresql://admin:s3cr3t@')).toBe(
      '<unparseable-url>'
    );
  });
});

// ---------------------------------------------------------------------------
// resolveStack
// ---------------------------------------------------------------------------

function fakeStackCtx(handlers: {
  managedEnv?: CommandResult;
  managedStatus?: CommandResult;
  legacy?: CommandResult;
  namedEnv?: Record<string, CommandResult>;
}): LocalStackEvalContext {
  const exec = async (command: string): Promise<CommandResult> => {
    for (const [name, result] of Object.entries(handlers.namedEnv ?? {})) {
      if (command.includes(`--stack '${name}'`) && command.includes('--env'))
        return result;
    }
    if (command.includes('stack status') && command.includes('--env')) {
      return handlers.managedEnv ?? commandResult('', false);
    }
    if (command.includes('stack status')) {
      return handlers.managedStatus ?? commandResult('', false);
    }
    if (command.includes('SUPABASE_EXPERIMENTAL_STACK=0')) {
      return handlers.legacy ?? commandResult('', false);
    }
    return commandResult('', false);
  };
  return { exec } as unknown as LocalStackEvalContext;
}

describe('resolveStack', () => {
  it('resolves through the managed backend when DB_URL is present', async () => {
    const ctx = fakeStackCtx({
      managedEnv: commandResult('{"DB_URL":"postgresql://x"}'),
      managedStatus: commandResult('{"runtime":"native"}'),
    });
    const stack = await resolveStack(ctx, '.', []);
    expect(stack).toEqual({
      ok: true,
      backend: 'managed',
      dbUrl: 'postgresql://x',
      apiUrl: undefined,
      recordedRuntime: 'native',
    });
  });

  it('falls back to the legacy backend, recording docker', async () => {
    const ctx = fakeStackCtx({
      legacy: commandResult('{"DB_URL":"postgresql://legacy"}'),
    });
    const stack = await resolveStack(ctx, '.', []);
    expect(stack).toEqual({
      ok: true,
      backend: 'legacy',
      dbUrl: 'postgresql://legacy',
      apiUrl: undefined,
      recordedRuntime: 'docker',
    });
  });

  it('tries a named --stack probe before the plain managed probe', async () => {
    const ctx = fakeStackCtx({
      namedEnv: { other: commandResult('{"DB_URL":"postgresql://named"}') },
    });
    const stack = await resolveStack(ctx, '.', ['other']);
    expect(stack).toEqual(
      expect.objectContaining({ ok: true, dbUrl: 'postgresql://named' })
    );
  });

  it('fails with truncated notes carrying the real stderr when everything fails', async () => {
    const ctx = fakeStackCtx({
      managedEnv: commandResult('', false, 'boom managed'),
      legacy: commandResult('', false, 'boom legacy'),
    });
    const stack: StackProbe = await resolveStack(ctx, '.', []);
    expect(stack.ok).toBe(false);
    if (!stack.ok) {
      expect(stack.notes).toContain('boom managed');
      expect(stack.notes).toContain('boom legacy');
    }
  });
});

// ---------------------------------------------------------------------------
// checkMetrics
// ---------------------------------------------------------------------------

describe('checkMetrics', () => {
  const fakeMetricsCtx = {
    exec: async () => commandResult('', false),
  } as unknown as LocalStackEvalContext;

  it('always passes and reports channel "pinned" when the marker is missing', async () => {
    const result = await checkMetrics(
      fakeMetricsCtx,
      undefined,
      [],
      [],
      [],
      { ok: false, notes: 'no stack' },
      'none'
    );
    expect(result.passed).toBe(true);
    expect(JSON.parse(result.notes as string).channel).toBe('pinned');
  });

  it('reports the marker channel when present', async () => {
    const result = await checkMetrics(
      fakeMetricsCtx,
      {
        runtime: 'local-stack',
        channel: 'beta',
        cliVersion: '2.119.0-beta.4',
        docker: 'no-daemon',
        sessionStartedMs: 0,
      },
      [],
      [],
      [],
      { ok: false, notes: 'no stack' },
      'none'
    );
    expect(JSON.parse(result.notes as string).channel).toBe('beta');
  });

  it('leftoverDockerRegistrations is null when the listing fails, and the check still passes', async () => {
    const result = await checkMetrics(
      fakeMetricsCtx,
      undefined,
      [],
      [],
      [],
      { ok: false, notes: 'no stack' },
      'native'
    );
    expect(result.passed).toBe(true);
    expect(
      JSON.parse(result.notes as string).leftoverDockerRegistrations
    ).toBeNull();
  });

  it('leftoverDockerRegistrations counts docker entries left behind while native actually started', async () => {
    const ctx = {
      exec: async (command: string) => {
        if (command.includes('stack list')) {
          return commandResult(
            '{"stacks":[{"id":"a","runtime":"docker"},{"id":"b","runtime":"native"}]}'
          );
        }
        return commandResult('', false);
      },
    } as unknown as LocalStackEvalContext;
    const result = await checkMetrics(
      ctx,
      undefined,
      [],
      [],
      [],
      { ok: false, notes: 'no stack' },
      'native'
    );
    expect(JSON.parse(result.notes as string).leftoverDockerRegistrations).toBe(
      1
    );
  });
});

// ---------------------------------------------------------------------------
// commandSegments / leadingWord sanity
// ---------------------------------------------------------------------------

describe('commandSegments / leadingWord', () => {
  it('splits chained commands and masks quoted literals', () => {
    expect(commandSegments('supabase start && echo "docker"')).toEqual([
      'supabase start',
      'echo ""',
    ]);
  });

  it('leadingWord strips env/var-assignment prefixes', () => {
    expect(leadingWord('SUPABASE_EXPERIMENTAL_STACK=1 supabase start')).toBe(
      'supabase'
    );
    expect(leadingWord('sudo dockerd')).toBe('sudo');
  });
});

// ---------------------------------------------------------------------------
// checkReportIsTruthful
// ---------------------------------------------------------------------------

describe('checkReportIsTruthful', () => {
  const ctx = {
    exec: async (command: string) =>
      command.startsWith('docker info')
        ? commandResult('0\n')
        : commandResult('0\n'),
    transcript: [],
  } as unknown as LocalStackEvalContext;

  it('gives the judge the docker daemon probe and no managed-stack line', async () => {
    judgeMock.mockResolvedValueOnce({ passed: true, notes: 'ok' });
    await checkReportIsTruthful(
      ctx,
      { ok: true },
      { ok: true, backend: 'legacy', recordedRuntime: 'docker' } as StackProbe,
      'docker',
      [{ runtime: 'docker', ok: true }] as never
    );
    const { input } = judgeMock.mock.calls.at(-1)![0] as { input: string };
    expect(input).toContain('- docker daemon reachable: true');
    expect(input).not.toContain('managed stack reached');
  });

  it('accepts a truthful report of a Docker start on the legacy stack (rubric (b))', async () => {
    judgeMock.mockResolvedValueOnce({ passed: true, notes: 'ok' });
    await checkReportIsTruthful(
      ctx,
      { ok: true },
      { ok: true, backend: 'legacy', recordedRuntime: 'docker' } as StackProbe,
      'docker',
      [{ runtime: 'docker', ok: true }] as never
    );
    const { rubric } = judgeMock.mock.calls.at(-1)![0] as { rubric: string };
    expect(rubric).toMatch(/legacy or the managed stack/);
  });
});
