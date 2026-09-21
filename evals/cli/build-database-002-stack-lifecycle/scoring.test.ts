// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-database-002-stack-lifecycle
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  checkMigrationApplied,
  commandSegments,
  countRawDockerSocketProbes,
  findDetours,
  findNotesMigration,
  leadingWord,
  parseJsonObject,
  readDbUrl,
  readRuntimeKind,
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

// Minimal fake of LocalStackEvalContext — only the methods
// findNotesMigration/checkMigrationApplied actually call. Routes `exec` by
// substring/regex on the command text rather than call order, so tests read
// as "given this filesystem/database state" rather than "given this call
// sequence".
function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

function fakeMigrationCtx(options: {
  migrationsDirExists?: boolean;
  files?: string[];
  fileContents?: Record<string, string>;
  appliedVersions?: string[];
  psqlVersionCheckFails?: boolean;
}): LocalStackEvalContext {
  const {
    migrationsDirExists = true,
    files = [],
    fileContents = {},
    appliedVersions = [],
    psqlVersionCheckFails = false,
  } = options;

  const exec = async (command: string): Promise<CommandResult> => {
    if (command.includes('ls supabase/migrations')) {
      return commandResult(files.join('\n'));
    }
    const catMatch = command.match(/^cat 'supabase\/migrations\/(.+)'$/);
    if (catMatch) {
      return commandResult(fileContents[catMatch[1]] ?? '');
    }
    const versionMatch = command.match(
      /schema_migrations where version = '(\d+)'/
    );
    if (versionMatch) {
      if (psqlVersionCheckFails) return commandResult('', false);
      return commandResult(
        appliedVersions.includes(versionMatch[1]) ? '1' : '0'
      );
    }
    return commandResult('');
  };

  return {
    folderExists: async () => migrationsDirExists,
    exec,
  } as unknown as LocalStackEvalContext;
}

const RESOLVED_STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: 'postgresql://postgres:postgres@localhost:5432/postgres',
  runtime: 'native',
};

describe('findNotesMigration', () => {
  it('fails when supabase/migrations does not exist', async () => {
    const ctx = fakeMigrationCtx({ migrationsDirExists: false });
    expect(await findNotesMigration(ctx)).toEqual({
      ok: false,
      notes: expect.stringContaining('does not exist'),
    });
  });

  it('fails when there are no migration files', async () => {
    const ctx = fakeMigrationCtx({ files: [] });
    expect(await findNotesMigration(ctx)).toEqual({
      ok: false,
      notes: expect.stringContaining('no migration files found'),
    });
  });

  it('fails when no migration file creates notes', async () => {
    const ctx = fakeMigrationCtx({
      files: ['20240101000000_create_widgets.sql'],
      fileContents: {
        '20240101000000_create_widgets.sql':
          'create table public.widgets (id uuid);',
      },
    });
    expect(await findNotesMigration(ctx)).toEqual({
      ok: false,
      notes: expect.stringContaining('no migration contains CREATE TABLE'),
    });
  });

  it('does not match notes_archive/notes_tags, same as the original regex', async () => {
    const ctx = fakeMigrationCtx({
      files: ['20240101000000_create_notes_archive.sql'],
      fileContents: {
        '20240101000000_create_notes_archive.sql':
          'create table public.notes_archive (id uuid);',
      },
    });
    expect((await findNotesMigration(ctx)).ok).toBe(false);
  });

  it('identifies the specific file and version that creates notes among several migrations', async () => {
    const ctx = fakeMigrationCtx({
      files: [
        '20240101000000_create_widgets.sql',
        '20240102000000_create_notes.sql',
      ],
      fileContents: {
        '20240101000000_create_widgets.sql':
          'create table public.widgets (id uuid);',
        '20240102000000_create_notes.sql':
          'create table public.notes (id uuid);',
      },
    });
    expect(await findNotesMigration(ctx)).toEqual({
      ok: true,
      version: '20240102000000',
      file: '20240102000000_create_notes.sql',
    });
  });
});

describe('checkMigrationApplied', () => {
  it('fails immediately when the stack did not resolve', async () => {
    const ctx = fakeMigrationCtx({});
    const result = await checkMigrationApplied(
      ctx,
      { ok: false, notes: 'no stack' },
      { ok: false, notes: 'n/a' }
    );
    expect(result).toEqual(
      expect.objectContaining({ passed: false, notes: 'no stack' })
    );
  });

  it('fails immediately when no migration creates notes', async () => {
    const ctx = fakeMigrationCtx({});
    const result = await checkMigrationApplied(ctx, RESOLVED_STACK, {
      ok: false,
      notes: 'no migration contains CREATE TABLE for notes',
    });
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('no migration contains CREATE TABLE');
  });

  // The exact hand-created-table attack the reviewer described: a migration
  // file that creates notes exists, but its version was never actually
  // applied — because notes was created directly against the database
  // instead, alongside an unrelated migration that WAS applied.
  it('fails when the notes-creating migration file exists but its version was never applied', async () => {
    const ctx = fakeMigrationCtx({
      files: ['20240101000000_create_notes.sql'],
      fileContents: {
        '20240101000000_create_notes.sql':
          'create table public.notes (id uuid);',
      },
      appliedVersions: ['20240102000000'],
    });
    const notesMigration = await findNotesMigration(ctx);
    expect(notesMigration.ok).toBe(true);

    const result = await checkMigrationApplied(
      ctx,
      RESOLVED_STACK,
      notesMigration
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('20240101000000');
  });

  it('passes when the notes-creating migration version is present in applied history', async () => {
    const ctx = fakeMigrationCtx({
      files: ['20240101000000_create_notes.sql'],
      fileContents: {
        '20240101000000_create_notes.sql':
          'create table public.notes (id uuid);',
      },
      appliedVersions: ['20240101000000'],
    });
    const notesMigration = await findNotesMigration(ctx);
    expect(notesMigration).toEqual({
      ok: true,
      version: '20240101000000',
      file: '20240101000000_create_notes.sql',
    });

    const result = await checkMigrationApplied(
      ctx,
      RESOLVED_STACK,
      notesMigration
    );
    expect(result.passed).toBe(true);
    expect(result.notes).toContain('20240101000000');
  });

  it('fails without crashing when the psql version check itself fails', async () => {
    const ctx = fakeMigrationCtx({
      files: ['20240101000000_create_notes.sql'],
      fileContents: {
        '20240101000000_create_notes.sql':
          'create table public.notes (id uuid);',
      },
      psqlVersionCheckFails: true,
    });
    const notesMigration = await findNotesMigration(ctx);
    const result = await checkMigrationApplied(
      ctx,
      RESOLVED_STACK,
      notesMigration
    );
    expect(result.passed).toBe(false);
  });
});
