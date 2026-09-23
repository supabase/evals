// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-database-003-parallel-projects
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  checkDistinctPorts,
  checkMarkerIsolation,
  checkMetrics,
  checkReportedPorts,
  commandSegments,
  countRawDockerSocketProbes,
  findDetours,
  findProjectDirs,
  leadingWord,
  maskUrlCredentials,
  parseJsonObject,
  readClientsMarkers,
  readDbUrl,
  readRuntimeKind,
  urlPort,
  type StackProbe,
} from './scoring.js';

// Exact `.source` text of the DETOUR_PATTERNS entries in scoring.ts, so a
// reorder of that array doesn't silently weaken these assertions. Order
// WITHIN each `expectedLabels` array below still matters, though — findDetours
// pushes a segment's context-pattern matches before its leading-word label,
// in segment order — these are not sorted before comparing.
const APT_INSTALL_DOCKER =
  '\\b(apt|apt-get)\\s+(install|update)\\b[^\\n]*\\bdocker';
const DNF_YUM_INSTALL_DOCKER = '\\b(dnf|yum)\\s+install\\b[^\\n]*docker';
const APK_ADD_DOCKER = '\\bapk\\s+add\\b[^\\n]*docker';
const BREW_INSTALL_DOCKER_COLIMA =
  '\\bbrew\\s+install\\b[^\\n]*(docker|colima)';
const GET_DOCKER_COM = 'get\\.docker\\.com';
const SYSTEMCTL_DOCKER = '\\bsystemctl\\s+(start|restart|enable)\\s+\\S*docker';
const SERVICE_DOCKER = '\\bservice\\s+docker\\s+(start|restart)\\b';
const USERMOD_DOCKER = '\\busermod\\b[^\\n]*docker';
const GROUPADD_DOCKER = '\\bgroupadd\\b[^\\n]*docker';
const CHMOD_DOCKER_SOCK = '\\bchmod\\s+\\d+\\s+\\S*docker\\.sock';
const CHOWN_DOCKER_SOCK = '\\bchown\\b[^\\n]*docker\\.sock';
const PIP_INSTALL_PODMAN = '\\bpip3?\\s+install\\b[^\\n]*podman';
const BREW_SERVICES_START =
  '\\bbrew\\s+services\\s+start\\s+\\S*(colima|docker)';
const OPEN_DOCKER_APP = '\\bopen\\s+-a\\s+Docker\\b';

describe('findDetours', () => {
  const NOT_DETOURS = [
    'docker info',
    'docker --version',
    'which docker',
    'command -v docker',
    'ls -l /var/run/docker.sock',
    'cat /etc/group',
    'pgrep dockerd',
    'ps aux | grep containerd',
    'command -v podman',
    'echo "install Docker Desktop or Podman and ensure it is on PATH"',
    `bash -lc 'supabase start 2>&1 | tail -5'`,
    'env | grep -i docker',
    'grep sudo /etc/passwd',
    'curl -s --unix-socket /var/run/docker.sock http://localhost/_ping',
    'curl --unix-socket /run/docker.sock -sS http://localhost/version | head -c 1000 || true',
    'env -u DOCKER_HOST docker -H unix:///var/run/docker.sock info',
    `/bin/bash -lc 'command -v docker || true; command -v podman || true; command -v psql || true; docker --version 2>&1 || true; podman --version 2>&1 || true; psql --version 2>&1 || true'`,
    'podman --version',
    'nerdctl ps',
    'dockerd --help',
    'containerd -v',
    `bash -lc 'podman info || true'`,
    'timeout 30 podman info',
    // Detour phrases only inside descriptive/quoted text — not executed —
    // must not trip context patterns just because they name a blocker.
    'echo "Blocked: Docker daemon unreachable. To fix: sudo systemctl start docker" >> NOTES.md',
    'git commit -m "docs: note that apt-get install docker.io is required"',
    `bash -lc 'printf "%s\\n" "Remediation: brew install colima && colima start" > REPORT.md'`,
    `bash -lc "cat <<'EOF' > report.md
- tried: sudo systemctl start docker
EOF"`,
    'sudo -n true',
    'sudo -v',
    'sudo --version',
    `bash -lc "sudo -n true"`,
    'tee notes.md <<< "run dockerd"',
    // raw-docker-api-write only fires when curl (et al.) is the executed
    // command — never when the socket/method text merely sits inside an
    // echoed/report string.
    'echo "curl -X POST --unix-socket /var/run/docker.sock http://localhost/containers/create" > notes.md',
  ];

  it.each(NOT_DETOURS)('is not flagged as a detour: %s', (command) => {
    expect(findDetours(command)).toEqual([]);
  });

  const DETOURS: Array<[command: string, expectedLabels: string[]]> = [
    ['sudo systemctl start docker', [SYSTEMCTL_DOCKER, 'leading:sudo']],
    [
      `bash -lc 'cd app && sudo apt-get install -y docker.io'`,
      [APT_INSTALL_DOCKER, 'leading:sudo'],
    ],
    ['apt-get update && apt-get install -y docker.io', [APT_INSTALL_DOCKER]],
    ['dnf install -y docker', [DNF_YUM_INSTALL_DOCKER]],
    ['apk add docker', [APK_ADD_DOCKER]],
    ['brew install colima', [BREW_INSTALL_DOCKER_COLIMA]],
    ['curl -fsSL https://get.docker.com | sh', [GET_DOCKER_COM]],
    ['systemctl enable docker', [SYSTEMCTL_DOCKER]],
    ['service docker start', [SERVICE_DOCKER]],
    ['dockerd &', ['leading:dockerd']],
    ['nohup dockerd >/tmp/d.log 2>&1 &', ['leading:dockerd']],
    ['DOCKER_HOST= sudo dockerd', ['leading:sudo']],
    ['podman machine start', ['leading:podman']],
    ['nerdctl run -d nginx', ['leading:nerdctl']],
    ['usermod -aG docker node', [USERMOD_DOCKER]],
    ['groupadd docker', [GROUPADD_DOCKER]],
    ['chmod 666 /var/run/docker.sock', [CHMOD_DOCKER_SOCK]],
    ['chown node /var/run/docker.sock', [CHOWN_DOCKER_SOCK]],
    [
      'curl -X POST --unix-socket /var/run/docker.sock http://localhost/containers/create',
      ['raw-docker-api-write'],
    ],
    [
      `curl --unix-socket /var/run/docker.sock -d '{}' http://localhost/v1.43/containers/create`,
      ['raw-docker-api-write'],
    ],
    [
      'curl --unix-socket /var/run/docker.sock --data-binary @spec.json http://localhost/containers/create',
      ['raw-docker-api-write'],
    ],
    // Quoting the socket path is ordinary and must not evade detection —
    // raw-docker-api-write runs against the segment's real (unmasked) argv,
    // not the masked one `commandSegments` produces for pattern matching.
    [
      'curl -X POST --unix-socket "/var/run/docker.sock" http://localhost/containers/create',
      ['raw-docker-api-write'],
    ],
    [
      `curl -X POST --unix-socket '/var/run/docker.sock' http://localhost/containers/create`,
      ['raw-docker-api-write'],
    ],
    [
      `curl --unix-socket "/var/run/docker.sock" -d '{"Image":"x"}' http://localhost/containers/create`,
      ['raw-docker-api-write'],
    ],
    // ...and still detected with a quoted socket path inside a shell wrapper.
    [
      `bash -lc 'curl -X POST --unix-socket "/var/run/docker.sock" http://localhost/x'`,
      ['raw-docker-api-write'],
    ],
    // env's own flags are skipped so the real leading binary is still found.
    ['env -i sudo dockerd', ['leading:sudo']],
    ['env -u DOCKER_HOST sudo dockerd', ['leading:sudo']],
    // Nested shell wrappers are unwrapped up to MAX_UNWRAP_DEPTH times.
    [`sh -c 'sh -c "sudo dockerd"'`, ['leading:sudo']],
    // The wrapper's binary may be an absolute path, and its flag cluster may
    // spell the `c` flag in combination with others — both previously missed
    // by the wrapper regex (the reported gap).
    [`/bin/bash -lc 'sudo dockerd'`, ['leading:sudo']],
    [`/usr/bin/sh -c 'sudo dockerd'`, ['leading:sudo']],
    [`bash -lic 'sudo dockerd'`, ['leading:sudo']],
    [`bash -ic 'sudo dockerd'`, ['leading:sudo']],
    // A lone `&` (not part of `&&`/`>&`/`2>&1`) is a segment delimiter.
    ['x & dockerd', ['leading:dockerd']],
    // `sudo` with a non-probe argument is still a detour.
    ['sudo -n systemctl start docker', [SYSTEMCTL_DOCKER, 'leading:sudo']],
    ['pip install podman-compose', [PIP_INSTALL_PODMAN]],
    ['brew services start colima', [BREW_SERVICES_START]],
    ['open -a Docker', [OPEN_DOCKER_APP]],
  ];

  it.each(DETOURS)('flags a detour: %s', (command, expectedLabels) => {
    expect(findDetours(command)).toEqual(expectedLabels);
  });
});

describe('countRawDockerSocketProbes', () => {
  it.each<[commands: string[], expected: number]>([
    [[], 0],
    [
      [
        'curl -s --unix-socket /var/run/docker.sock http://localhost/_ping',
        'curl --unix-socket /run/docker.sock -sS http://localhost/version | head -c 1000 || true',
        'env -u DOCKER_HOST docker -H unix:///var/run/docker.sock info',
      ],
      3,
    ],
    [['docker info', 'ls -l /var/run/docker.sock'], 0],
    [['DOCKER_HOST=unix:///var/run/docker.sock supabase start'], 1],
  ])('counts raw socket probes in %j as %i', (commands, expected) => {
    expect(countRawDockerSocketProbes(commands)).toBe(expected);
  });
});

describe('commandSegments', () => {
  it('unwraps a single-quoted bash -lc wrapper before splitting', () => {
    expect(
      commandSegments(`bash -lc 'cd app && sudo apt-get install -y docker.io'`)
    ).toEqual(['cd app', 'sudo apt-get install -y docker.io']);
  });

  it('unwraps a double-quoted sh -c wrapper before splitting', () => {
    expect(commandSegments(`sh -c "echo hi; echo bye"`)).toEqual([
      'echo hi',
      'echo bye',
    ]);
  });

  it('leaves an unwrapped command alone', () => {
    expect(commandSegments('echo just one')).toEqual(['echo just one']);
  });

  it('splits on newlines, ;, &&, ||, |, and (', () => {
    expect(commandSegments('a; b && c || d | e ( f')).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
    ]);
  });

  it('drops empty segments produced by adjacent delimiters', () => {
    expect(commandSegments('a;;b')).toEqual(['a', 'b']);
  });

  it('splits on a lone &, but not on && or 2>&1', () => {
    expect(commandSegments('a & b')).toEqual(['a', 'b']);
    expect(commandSegments('a && b')).toEqual(['a', 'b']);
    expect(commandSegments('a 2>&1 & b')).toEqual(['a 2>&1', 'b']);
  });

  it('masks quoted literals so their contents cannot leak into segments', () => {
    expect(
      commandSegments('echo "sudo systemctl start docker; rm -rf /"')
    ).toEqual(['echo ""']);
  });
});

describe('leadingWord', () => {
  it('strips chained VAR=val assignments before sudo', () => {
    expect(leadingWord('FOO=bar BAZ=1 sudo x')).toBe('sudo');
  });

  it('strips env, nohup, and timeout <arg> prefixes down to the real binary', () => {
    expect(leadingWord('env FOO=1 nohup timeout 5 dockerd')).toBe('dockerd');
  });

  it('strips env flags (-i, -u NAME, --unset=NAME, -C DIR) down to the real binary', () => {
    expect(leadingWord('env -i sudo')).toBe('sudo');
    expect(leadingWord('env -u DOCKER_HOST sudo')).toBe('sudo');
    expect(leadingWord('env --unset=DOCKER_HOST sudo')).toBe('sudo');
    expect(leadingWord('env -C /tmp sudo')).toBe('sudo');
  });

  it('takes the basename of an absolute path', () => {
    expect(leadingWord('/usr/bin/sudo ls')).toBe('sudo');
  });

  it('strips a single exec prefix', () => {
    expect(leadingWord('exec podman run')).toBe('podman');
  });

  it('returns undefined for an empty segment', () => {
    expect(leadingWord('')).toBeUndefined();
  });
});

describe('parseJsonObject', () => {
  it('parses plain JSON', () => {
    expect(parseJsonObject('{"DB_URL":"postgresql://x"}')).toEqual({
      DB_URL: 'postgresql://x',
    });
  });

  it('extracts JSON wrapped in `[task] …` progress lines', () => {
    const stdout = [
      '[task] resolving stack status',
      '{"DB_URL":"postgresql://x"}',
      '[task] done',
    ].join('\n');
    expect(parseJsonObject(stdout)).toEqual({ DB_URL: 'postgresql://x' });
  });

  it('returns undefined when stdout has no JSON object', () => {
    expect(parseJsonObject('[task] no stack running')).toBeUndefined();
  });

  it('extracts JSON preceded by a `[task]` line with a brace-looking word', () => {
    expect(parseJsonObject('[task] starting {stack}\n{"DB_URL":"x"}')).toEqual({
      DB_URL: 'x',
    });
  });

  it('extracts JSON followed by a `[task]` line with a brace-looking word', () => {
    expect(parseJsonObject('{"DB_URL":"x"}\n[task] done {ok}')).toEqual({
      DB_URL: 'x',
    });
  });

  it('returns the first object when stdout has more than one', () => {
    expect(parseJsonObject('{"a":1}\n{"DB_URL":"x"}')).toEqual({ a: 1 });
  });

  it('parses a stderr-style error payload', () => {
    expect(parseJsonObject('{"_tag":"Errors","errors":[]}')).toEqual({
      _tag: 'Errors',
      errors: [],
    });
  });
});

describe('readDbUrl', () => {
  it.each<[stdout: string, expected: string | undefined]>([
    ['{"_tag":"Help","doc":{}}', undefined],
    ['[task] resolving\n{"DB_URL":"postgresql://x"}', 'postgresql://x'],
    ['', undefined],
  ])('reads DB_URL from %j as %j', (stdout, expected) => {
    expect(readDbUrl(stdout)).toBe(expected);
  });
});

describe('readRuntimeKind', () => {
  it.each<[stdout: string, expected: 'native' | 'docker' | 'unknown']>([
    ['{"runtime":{"kind":"native"}}', 'native'],
    ['{"DB_URL":"x"}', 'unknown'],
  ])('reads runtime.kind from %j as %j', (stdout, expected) => {
    expect(readRuntimeKind(stdout)).toBe(expected);
  });
});

// --- build-database-003-specific logic --------------------------------

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

// Minimal fake of LocalStackEvalContext — only `exec` is used by
// findProjectDirs/readClientsMarkers.
function fakeExecCtx(
  exec: (command: string) => Promise<CommandResult>
): LocalStackEvalContext {
  return { exec } as unknown as LocalStackEvalContext;
}

describe('findProjectDirs', () => {
  it('finds both top-level projects', async () => {
    const ctx = fakeExecCtx(async () =>
      commandResult(
        [
          './client-a/supabase/config.toml',
          './client-b/supabase/config.toml',
        ].join('\n')
      )
    );
    expect(await findProjectDirs(ctx)).toEqual({
      ok: true,
      clientA: './client-a',
      clientB: './client-b',
    });
  });

  it('finds both projects when nested under another directory', async () => {
    const ctx = fakeExecCtx(async () =>
      commandResult(
        [
          './projects/client-a/supabase/config.toml',
          './projects/client-b/supabase/config.toml',
        ].join('\n')
      )
    );
    expect(await findProjectDirs(ctx)).toEqual({
      ok: true,
      clientA: './projects/client-a',
      clientB: './projects/client-b',
    });
  });

  it('fails when only one project exists', async () => {
    const ctx = fakeExecCtx(async () =>
      commandResult('./client-a/supabase/config.toml')
    );
    const result = await findProjectDirs(ctx);
    expect(result.ok).toBe(false);
    expect((result as { notes: string }).notes).toContain('./client-a');
  });

  it('fails when neither project exists', async () => {
    const ctx = fakeExecCtx(async () => commandResult(''));
    const result = await findProjectDirs(ctx);
    expect(result).toEqual({
      ok: false,
      notes: expect.stringContaining('none'),
    });
  });

  it('fails when more than one directory matches client-a', async () => {
    const ctx = fakeExecCtx(async () =>
      commandResult(
        [
          './client-a/supabase/config.toml',
          './client-a-old/supabase/config.toml',
          './client-b/supabase/config.toml',
        ].join('\n')
      )
    );
    const result = await findProjectDirs(ctx);
    expect(result.ok).toBe(false);
  });
});

const STACK_A: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: 'postgresql://postgres:postgres@localhost:54321/postgres',
  apiUrl: 'http://127.0.0.1:54320',
  runtime: 'native',
};
const STACK_B: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: 'postgresql://postgres:postgres@localhost:54322/postgres',
  apiUrl: 'http://127.0.0.1:54323',
  runtime: 'native',
};

describe('checkDistinctPorts', () => {
  it('passes when the two stacks resolve to different ports', () => {
    const result = checkDistinctPorts(STACK_A, STACK_B);
    expect(result.passed).toBe(true);
    expect(result.notes).toContain('54321');
    expect(result.notes).toContain('54322');
  });

  it('fails when both stacks resolve to the same port', () => {
    const result = checkDistinctPorts(STACK_A, { ...STACK_A });
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('54321');
  });

  it('fails with a clear note when a DB URL cannot be parsed, without leaking credentials', () => {
    const withCreds: StackProbe = {
      ok: true,
      backend: 'managed',
      dbUrl: 'postgresql://admin:s3cr3t@localhost:5432/postgres',
      runtime: 'native',
    };
    const unparseable: StackProbe = {
      ok: true,
      backend: 'managed',
      dbUrl: 'not-a-valid-url',
      runtime: 'native',
    };
    const result = checkDistinctPorts(withCreds, unparseable);
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('could not parse a port');
    expect(result.notes).not.toContain('s3cr3t');
    expect(result.notes).not.toContain('admin');
  });

  it('fails when one or both stacks never resolved', () => {
    const result = checkDistinctPorts(STACK_A, {
      ok: false,
      notes: 'managed: no stack; legacy: no stack',
    });
    expect(result.passed).toBe(false);
  });
});

describe('urlPort / maskUrlCredentials', () => {
  it('reads the port off a standard URL', () => {
    expect(
      urlPort('postgresql://postgres:postgres@localhost:54321/postgres')
    ).toBe(54321);
    expect(urlPort('http://127.0.0.1:54320')).toBe(54320);
  });

  it('returns undefined when a URL has no port or cannot be parsed', () => {
    expect(urlPort('http://127.0.0.1')).toBeUndefined();
    expect(urlPort('not-a-valid-url')).toBeUndefined();
  });

  it('strips userinfo from a URL', () => {
    expect(
      maskUrlCredentials('postgresql://admin:s3cr3t@localhost:5432/postgres')
    ).toBe('postgresql://localhost:5432/postgres');
  });

  it('returns a placeholder for an unparseable URL rather than the raw text', () => {
    expect(maskUrlCredentials('not-a-valid-url')).toBe('<unparseable-url>');
  });
});

describe('readClientsMarkers', () => {
  it('parses the marker rows out of a jsonb_agg result', async () => {
    const ctx = fakeExecCtx(async (command) => {
      expect(command).toContain('jsonb_agg');
      return commandResult('[{"id":1,"name":"client-a"}]');
    });
    expect(await readClientsMarkers(ctx, STACK_A)).toEqual({
      ok: true,
      markers: ['client-a'],
    });
  });

  it('reports the table as missing when psql errors on public.clients', async () => {
    const ctx = fakeExecCtx(async () => ({
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: 'ERROR: relation "public.clients" does not exist',
    }));
    const result = await readClientsMarkers(ctx, STACK_A);
    expect(result.ok).toBe(false);
    expect((result as { notes: string }).notes).toContain('public.clients');
  });

  it('fails immediately when the stack never resolved', async () => {
    const ctx = fakeExecCtx(async () => commandResult(''));
    expect(
      await readClientsMarkers(ctx, { ok: false, notes: 'no stack' })
    ).toEqual({ ok: false, notes: 'no stack' });
  });
});

describe('checkMarkerIsolation', () => {
  it('passes when each database holds only its own marker', () => {
    const result = checkMarkerIsolation(
      { ok: true, markers: ['client-a'] },
      { ok: true, markers: ['client-b'] }
    );
    expect(result.passed).toBe(true);
  });

  // The most important negative case: both marker rows landed in the SAME
  // database, proving the agent addressed the wrong stack (or only one
  // stack), not by luck.
  it('fails when both marker rows are in the same database', () => {
    const result = checkMarkerIsolation(
      { ok: true, markers: ['client-a', 'client-b'] },
      { ok: true, markers: [] }
    );
    expect(result.passed).toBe(false);
  });

  it('fails when a project is missing its own marker even without cross-contamination', () => {
    const result = checkMarkerIsolation(
      { ok: true, markers: [] },
      { ok: true, markers: ['client-b'] }
    );
    expect(result.passed).toBe(false);
  });

  it('fails when the clients table is missing in either project', () => {
    const result = checkMarkerIsolation(
      { ok: false, notes: 'relation "public.clients" does not exist' },
      { ok: true, markers: ['client-b'] }
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('public.clients');
  });
});

describe('checkReportedPorts', () => {
  it('passes when the report mentions both real API ports', () => {
    const report = 'client-a is on port 54320 and client-b is on port 54323.';
    const result = checkReportedPorts(STACK_A, STACK_B, report);
    expect(result.passed).toBe(true);
  });

  it('fails when the report is missing one of the real ports', () => {
    const report = 'client-a is on port 54320.';
    const result = checkReportedPorts(STACK_A, STACK_B, report);
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('54323');
  });

  it('fails when a real API port is unavailable to compare against', () => {
    const noApiUrl: StackProbe = { ...STACK_B, apiUrl: undefined };
    const result = checkReportedPorts(STACK_A, noApiUrl, 'anything');
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('unavailable');
  });
});

describe('checkMetrics', () => {
  it('reports the pinned channel when no environment marker is present', async () => {
    const ctx = fakeExecCtx(async () => commandResult('', false));
    const result = await checkMetrics(ctx, undefined, [], [], STACK_A, STACK_B);
    expect(result.passed).toBe(true);
    const metrics = JSON.parse(result.notes ?? '{}');
    expect(metrics.channel).toBe('pinned');
  });
});
