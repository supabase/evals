// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/resolve-database-002-stale-stack-cleanup
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  checkLegacyImportGone,
  checkMetrics,
  hasLegacyTeardownCommand,
  checkMarkerIsolation,
  collectStringValues,
  commandSegments,
  countRawDockerSocketProbes,
  findDetours,
  findServiceDirs,
  leadingWord,
  maskUrlCredentials,
  parseJsonObject,
  readDbUrl,
  readRuntimeKind,
  readServiceMarkers,
  readStackList,
  resolveServiceStack,
  stackEntryMatchesName,
  urlPort,
  type StackListProbe,
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

// --- resolve-database-002-specific logic --------------------------------

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

// Minimal fake of LocalStackEvalContext — only `exec` is used by
// findServiceDirs/resolveServiceStack/readStackList/readServiceMarkers.
function fakeExecCtx(
  exec: (command: string) => Promise<CommandResult>
): LocalStackEvalContext {
  return { exec } as unknown as LocalStackEvalContext;
}

describe('findServiceDirs', () => {
  it('finds all three service projects', async () => {
    const ctx = fakeExecCtx(async () =>
      commandResult(
        [
          './checkout-service/supabase/config.toml',
          './payments-api/supabase/config.toml',
          './legacy-import/supabase/config.toml',
        ].join('\n')
      )
    );
    expect(await findServiceDirs(ctx)).toEqual({
      ok: true,
      dirs: {
        'checkout-service': './checkout-service',
        'payments-api': './payments-api',
        'legacy-import': './legacy-import',
      },
    });
  });

  it('finds all three when nested under another directory', async () => {
    const ctx = fakeExecCtx(async () =>
      commandResult(
        [
          './projects/checkout-service/supabase/config.toml',
          './projects/payments-api/supabase/config.toml',
          './projects/legacy-import/supabase/config.toml',
        ].join('\n')
      )
    );
    expect(await findServiceDirs(ctx)).toEqual({
      ok: true,
      dirs: {
        'checkout-service': './projects/checkout-service',
        'payments-api': './projects/payments-api',
        'legacy-import': './projects/legacy-import',
      },
    });
  });

  it('fails when one service project is missing', async () => {
    const ctx = fakeExecCtx(async () =>
      commandResult(
        [
          './checkout-service/supabase/config.toml',
          './payments-api/supabase/config.toml',
        ].join('\n')
      )
    );
    const result = await findServiceDirs(ctx);
    expect(result.ok).toBe(false);
    expect((result as { notes: string }).notes).toContain(
      'legacy-import (found 0)'
    );
  });

  it('fails when no service projects exist', async () => {
    const ctx = fakeExecCtx(async () => commandResult(''));
    const result = await findServiceDirs(ctx);
    expect(result).toEqual({
      ok: false,
      notes: expect.stringContaining('none'),
    });
  });
});

describe('resolveServiceStack', () => {
  it('resolves via the managed, globally-named stack when available (wins the cascade)', async () => {
    const ctx = fakeExecCtx(async (command) => {
      if (command.includes('--stack') && command.includes('--env')) {
        return commandResult(
          '{"DB_URL":"postgresql://x/1","API_URL":"http://x:1"}'
        );
      }
      if (command.includes('--stack')) {
        return commandResult('{"runtime":{"kind":"native"}}');
      }
      throw new Error(`should not fall through the cascade: ${command}`);
    });
    const result = await resolveServiceStack(
      ctx,
      'checkout-service',
      './checkout-service'
    );
    expect(result).toEqual({
      ok: true,
      backend: 'managed-named',
      dbUrl: 'postgresql://x/1',
      apiUrl: 'http://x:1',
      runtime: 'native',
    });
  });

  it('falls through to the project-scoped managed stack when the named lookup fails', async () => {
    const ctx = fakeExecCtx(async (command) => {
      if (command.includes('--stack')) {
        return commandResult('{"_tag":"Error"}', false);
      }
      if (
        command.includes('SUPABASE_EXPERIMENTAL_STACK=1') &&
        command.includes('--env')
      ) {
        return commandResult(
          '{"DB_URL":"postgresql://x/2","API_URL":"http://x:2"}'
        );
      }
      if (command.includes('SUPABASE_EXPERIMENTAL_STACK=1')) {
        return commandResult('{"runtime":{"kind":"docker"}}');
      }
      throw new Error(`should not fall through to legacy: ${command}`);
    });
    const result = await resolveServiceStack(
      ctx,
      'payments-api',
      './payments-api'
    );
    expect(result).toEqual({
      ok: true,
      backend: 'managed-project',
      dbUrl: 'postgresql://x/2',
      apiUrl: 'http://x:2',
      runtime: 'docker',
    });
  });

  it('falls through to the legacy per-project status when both managed lookups fail', async () => {
    const ctx = fakeExecCtx(async (command) => {
      if (command.includes('SUPABASE_EXPERIMENTAL_STACK=1')) {
        return commandResult('{"_tag":"Error"}', false);
      }
      if (command.includes('SUPABASE_EXPERIMENTAL_STACK=0')) {
        return commandResult(
          '{"DB_URL":"postgresql://x/3","API_URL":"http://x:3"}'
        );
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const result = await resolveServiceStack(
      ctx,
      'checkout-service',
      './checkout-service'
    );
    expect(result).toEqual({
      ok: true,
      backend: 'legacy',
      dbUrl: 'postgresql://x/3',
      apiUrl: 'http://x:3',
      runtime: 'docker',
    });
  });

  it('fails with a clear combined note when all three cascade steps fail', async () => {
    const ctx = fakeExecCtx(async () => commandResult('', false));
    const result = await resolveServiceStack(
      ctx,
      'legacy-import',
      './legacy-import'
    );
    expect(result.ok).toBe(false);
    const notes = (result as { notes: string }).notes;
    expect(notes).toContain('managed(named)');
    expect(notes).toContain('managed(project)');
    expect(notes).toContain('legacy');
  });
});

describe('readStackList', () => {
  it('parses the empty envelope', async () => {
    const ctx = fakeExecCtx(async () =>
      commandResult('{"stacks":[],"message":""}')
    );
    expect(await readStackList(ctx)).toEqual({ ok: true, stacks: [] });
  });

  it('parses an envelope whose entry shape nests the name one level deep', async () => {
    const ctx = fakeExecCtx(async () =>
      commandResult(
        '{"stacks":[{"id":"abc","stack":{"label":"checkout-service"}}],"message":""}'
      )
    );
    expect(await readStackList(ctx)).toEqual({
      ok: true,
      stacks: [{ id: 'abc', stack: { label: 'checkout-service' } }],
    });
  });

  it('parses an envelope whose entry names the stack via a nested array', async () => {
    const ctx = fakeExecCtx(async () =>
      commandResult(
        '{"stacks":[{"tags":["env:prod","service:payments-api"]}],"message":""}'
      )
    );
    const result = await readStackList(ctx);
    expect(result.ok).toBe(true);
  });

  it('fails with a clear note on non-JSON output, as from a CLI build with no "stack" command at all', async () => {
    const ctx = fakeExecCtx(async () => ({
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr:
        'Error: unknown command "stack" for "supabase"\nRun \'supabase --help\' for usage.',
    }));
    const result = await readStackList(ctx);
    expect(result.ok).toBe(false);
    expect((result as { notes: string }).notes).toContain('unknown command');
  });

  it('fails with a clear note when the output is a JSON error envelope with no "stacks" array', async () => {
    const ctx = fakeExecCtx(async () =>
      commandResult(
        '{"_tag":"Error","error":{"code":"UnknownSubcommand","message":"unknown command \\"stack\\""}}',
        false
      )
    );
    const result = await readStackList(ctx);
    expect(result.ok).toBe(false);
    expect((result as { notes: string }).notes).toContain('UnknownSubcommand');
  });
});

describe('collectStringValues / stackEntryMatchesName', () => {
  it('matches a name at the top level of an entry', () => {
    expect(
      stackEntryMatchesName({ name: 'legacy-import' }, 'legacy-import')
    ).toBe(true);
  });

  it('matches a name nested one level deep', () => {
    expect(
      stackEntryMatchesName(
        { stack: { label: 'legacy-import' } },
        'legacy-import'
      )
    ).toBe(true);
  });

  it('matches a name inside an array field', () => {
    expect(
      stackEntryMatchesName(
        { tags: ['env:prod', 'service:legacy-import'] },
        'legacy-import'
      )
    ).toBe(true);
  });

  it('matches a name nested inside an array of objects several levels deep', () => {
    expect(
      stackEntryMatchesName(
        { metadata: { services: [{ id: 1, name: 'legacy-import' }] } },
        'legacy-import'
      )
    ).toBe(true);
  });

  it('does not match an unrelated entry', () => {
    expect(
      stackEntryMatchesName({ name: 'checkout-service' }, 'legacy-import')
    ).toBe(false);
  });

  it('collects every string value found anywhere inside a value', () => {
    expect(
      collectStringValues({ a: 'x', b: { c: 'y', d: ['z', 1, null] } })
    ).toEqual(['x', 'y', 'z']);
  });
});

const LEGACY_UNREACHABLE: StackProbe = { ok: false, notes: 'no stack' };
const LEGACY_REACHABLE: StackProbe = {
  ok: true,
  backend: 'legacy',
  dbUrl: 'postgresql://postgres:postgres@localhost:54321/postgres',
  runtime: 'docker',
};
const STACK_LIST_EMPTY: StackListProbe = { ok: true, stacks: [] };
const STACK_LIST_WITH_LEGACY: StackListProbe = {
  ok: true,
  stacks: [{ name: 'legacy-import' }],
};
const STACK_LIST_UNAVAILABLE: StackListProbe = {
  ok: false,
  notes: 'unknown command "stack" for "supabase"',
};

// Commands proving the agent actually tore legacy-import down, vs. a run
// where it was never started at all.
const TORE_DOWN = [
  'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack destroy --stack legacy-import',
];
const NEVER_STARTED: string[] = [
  'supabase stack list',
  'cd checkout-service && supabase stack start --stack checkout-service',
];

describe('hasLegacyTeardownCommand', () => {
  it.each([
    'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack destroy --stack legacy-import',
    `supabase stack destroy --stack 'legacy-import'`,
    'supabase stack destroy --stack "legacy-import"',
    `bash -lc 'supabase stack destroy --stack legacy-import'`,
    'cd legacy-import && supabase stop',
    'supabase stack stop --stack legacy-import && echo done',
  ])('counts %s as a teardown', (command) => {
    expect(hasLegacyTeardownCommand([command])).toBe(true);
  });

  it.each([
    // Describing the plan is not performing it — the same passive-word rule
    // the detour policy uses.
    'echo "next I will run supabase stack destroy --stack legacy-import"',
    "printf 'supabase stack destroy --stack legacy-import\\n' >> PLAN.md",
    'git commit -m "supabase stack destroy --stack legacy-import"',
    // Teardown of a different service must not count.
    'supabase stack destroy --stack payments-api',
    // Reading about legacy-import is not tearing it down.
    'supabase stack status --stack legacy-import',
    'ls legacy-import',
  ])('does not count %s', (command) => {
    expect(hasLegacyTeardownCommand([command])).toBe(false);
  });

  it('is false for an empty transcript', () => {
    expect(hasLegacyTeardownCommand([])).toBe(false);
  });
});

describe('checkLegacyImportGone', () => {
  it('passes when legacy-import is absent from the fleet listing, unreachable, and was torn down', () => {
    const result = checkLegacyImportGone(
      STACK_LIST_EMPTY,
      LEGACY_UNREACHABLE,
      TORE_DOWN
    );
    expect(result.passed).toBe(true);
  });

  // The vacuous pass this gate exists to close: the agent created the
  // legacy-import directory but never started its stack, so "gone" is
  // indistinguishable from "never existed" on outcomes alone.
  it('fails when legacy-import is unreachable but no teardown command ever ran', () => {
    const result = checkLegacyImportGone(
      STACK_LIST_EMPTY,
      LEGACY_UNREACHABLE,
      NEVER_STARTED
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('NO teardown command');
  });

  it('fails when the teardown was only described, never executed', () => {
    const result = checkLegacyImportGone(STACK_LIST_EMPTY, LEGACY_UNREACHABLE, [
      'echo "cleaning up: supabase stack destroy --stack legacy-import"',
    ]);
    expect(result.passed).toBe(false);
  });

  // The core negative: the fleet listing alone must fail this check even
  // though the stack is otherwise unreachable.
  it('fails when legacy-import is still listed even though it is unreachable', () => {
    const result = checkLegacyImportGone(
      STACK_LIST_WITH_LEGACY,
      LEGACY_UNREACHABLE,
      TORE_DOWN
    );
    expect(result.passed).toBe(false);
  });

  it('fails when legacy-import is still reachable even though the fleet listing does not mention it', () => {
    const result = checkLegacyImportGone(
      STACK_LIST_EMPTY,
      LEGACY_REACHABLE,
      TORE_DOWN
    );
    expect(result.passed).toBe(false);
  });

  it('fails when legacy-import is both listed and reachable', () => {
    const result = checkLegacyImportGone(
      STACK_LIST_WITH_LEGACY,
      LEGACY_REACHABLE,
      TORE_DOWN
    );
    expect(result.passed).toBe(false);
  });

  it('passes with a note that the listing check was skipped when "stack list" is unavailable and legacy-import is unreachable', () => {
    const result = checkLegacyImportGone(
      STACK_LIST_UNAVAILABLE,
      LEGACY_UNREACHABLE,
      TORE_DOWN
    );
    expect(result.passed).toBe(true);
    expect(result.notes).toContain('unavailable');
    expect(result.notes).toContain('skipped');
  });

  it('fails when "stack list" is unavailable but legacy-import is still reachable', () => {
    const result = checkLegacyImportGone(
      STACK_LIST_UNAVAILABLE,
      LEGACY_REACHABLE,
      TORE_DOWN
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('unavailable');
  });

  it('fails when "stack list" is unavailable and no teardown ran, even though legacy-import is unreachable', () => {
    const result = checkLegacyImportGone(
      STACK_LIST_UNAVAILABLE,
      LEGACY_UNREACHABLE,
      NEVER_STARTED
    );
    expect(result.passed).toBe(false);
  });
});

describe('readServiceMarkers', () => {
  it('parses the marker rows out of a jsonb_agg result', async () => {
    const ctx = fakeExecCtx(async (command) => {
      expect(command).toContain('service_marker');
      expect(command).toContain('jsonb_agg');
      return commandResult('[{"id":1,"name":"checkout-service"}]');
    });
    expect(await readServiceMarkers(ctx, LEGACY_REACHABLE)).toEqual({
      ok: true,
      markers: ['checkout-service'],
    });
  });

  it('reports the table as missing when psql errors on public.service_marker', async () => {
    const ctx = fakeExecCtx(async () => ({
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: 'ERROR: relation "public.service_marker" does not exist',
    }));
    const result = await readServiceMarkers(ctx, LEGACY_REACHABLE);
    expect(result.ok).toBe(false);
    expect((result as { notes: string }).notes).toContain(
      'public.service_marker'
    );
  });

  it('fails immediately when the stack never resolved', async () => {
    const ctx = fakeExecCtx(async () => commandResult(''));
    expect(await readServiceMarkers(ctx, LEGACY_UNREACHABLE)).toEqual({
      ok: false,
      notes: 'no stack',
    });
  });
});

describe('checkMarkerIsolation', () => {
  it('passes when each surviving database holds only its own marker', () => {
    const result = checkMarkerIsolation(
      { ok: true, markers: ['checkout-service'] },
      { ok: true, markers: ['payments-api'] }
    );
    expect(result.passed).toBe(true);
  });

  // The most important negative case: both marker rows landed in the SAME
  // database, proving the agent addressed the wrong stack (or only one
  // stack), not by luck.
  it('fails when both marker rows are in the same database', () => {
    const result = checkMarkerIsolation(
      { ok: true, markers: ['checkout-service', 'payments-api'] },
      { ok: true, markers: [] }
    );
    expect(result.passed).toBe(false);
  });

  it('fails when a surviving service is missing its own marker even without cross-contamination', () => {
    const result = checkMarkerIsolation(
      { ok: true, markers: [] },
      { ok: true, markers: ['payments-api'] }
    );
    expect(result.passed).toBe(false);
  });

  it('fails when the service_marker table is missing in either database', () => {
    const result = checkMarkerIsolation(
      { ok: false, notes: 'relation "public.service_marker" does not exist' },
      { ok: true, markers: ['payments-api'] }
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('public.service_marker');
  });
});

describe('checkMetrics', () => {
  it('reports channel "pinned" when the environment marker is missing', async () => {
    const ctx = fakeExecCtx(async () => commandResult('', false));
    const result = await checkMetrics(
      ctx,
      undefined,
      [],
      [],
      STACK_LIST_EMPTY,
      LEGACY_UNREACHABLE,
      LEGACY_UNREACHABLE
    );
    expect(result.passed).toBe(true);
    expect(JSON.parse(result.notes as string).channel).toBe('pinned');
  });
});

describe('hasLegacyTeardownCommand cd-context', () => {
  it('counts a legacy-path teardown reached via cd', () => {
    expect(
      hasLegacyTeardownCommand(['cd legacy-import && supabase stop'])
    ).toBe(true);
  });

  it('does not count a teardown after cd moved to another service', () => {
    expect(
      hasLegacyTeardownCommand([
        'cd legacy-import && cd ../payments-api && supabase stop',
      ])
    ).toBe(false);
  });

  it('does not count a teardown of another service reached via cd', () => {
    expect(hasLegacyTeardownCommand(['cd payments-api && supabase stop'])).toBe(
      false
    );
  });
});
