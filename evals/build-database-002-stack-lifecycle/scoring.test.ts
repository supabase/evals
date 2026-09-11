// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. experiments/_lib evals/build-database-002-stack-lifecycle
import { describe, expect, it } from 'vitest';
import {
  commandSegments,
  countRawDockerSocketProbes,
  findDetours,
  leadingWord,
} from './scoring.js';

// Exact `.source` text of the DETOUR_PATTERNS entries in scoring.ts, kept
// independent of that array's declaration order so a reorder there doesn't
// silently weaken these assertions.
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
const CHMOD_DOCKER_SOCK = '\\bchmod\\s+\\d+\\s+\\S*docker\\.sock';
const CHOWN_DOCKER_SOCK = '\\bchown\\b[^\\n]*docker\\.sock';

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
    ['timeout 30 podman info', ['leading:podman']],
    ['usermod -aG docker node', [USERMOD_DOCKER]],
    ['chmod 666 /var/run/docker.sock', [CHMOD_DOCKER_SOCK]],
    ['chown node /var/run/docker.sock', [CHOWN_DOCKER_SOCK]],
    [`bash -lc "sudo -n true"`, ['leading:sudo']],
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
});

describe('leadingWord', () => {
  it('strips chained VAR=val assignments before sudo', () => {
    expect(leadingWord('FOO=bar BAZ=1 sudo x')).toBe('sudo');
  });

  it('strips env, nohup, and timeout <arg> prefixes down to the real binary', () => {
    expect(leadingWord('env FOO=1 nohup timeout 5 dockerd')).toBe('dockerd');
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
