import { beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  existsSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMcpCheckout, buildMcpRevision } from './mcp-revision.js';

const run = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: run,
  }),
}));

beforeEach(() => {
  run.mockReset();
});

it.each(['a'.repeat(40), 'feature/experimental-mcp', 'v1.0.0'])(
  'builds %s once and records its resolved commit',
  async (revision) => {
    const commitSha = 'a'.repeat(40);
    run.mockImplementation(async (command, args, options) => {
      if (command === 'git' && args[0] === 'rev-parse')
        return { stdout: `${commitSha}\n` };
      if (command === 'pnpm' && args[0] === 'build') {
        const dist = join(options.cwd, 'packages/mcp-server-supabase/dist');
        mkdirSync(dist, { recursive: true });
        writeFileSync(join(dist, 'cli.js'), '');
      }
    });
    const [first, second] = await Promise.all([
      buildMcpRevision(revision),
      buildMcpRevision(revision),
    ]);
    try {
      expect(first).toEqual(second);
      expect(first.commitSha).toBe(commitSha);
      expect(run).toHaveBeenCalledTimes(7);
      expect(run).toHaveBeenCalledWith(
        'git',
        [
          'fetch',
          '--depth=1',
          '--',
          'https://github.com/supabase/mcp.git',
          revision,
        ],
        { cwd: first.mountRoot }
      );
      expect(run).toHaveBeenCalledWith(
        'pnpm',
        ['install', '--frozen-lockfile'],
        { cwd: first.mountRoot }
      );
      expect(existsSync(first.entry)).toBe(true);
      expect(statSync(first.mountRoot).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(first.mountRoot, { recursive: true, force: true });
    }
  }
);

it.each(['', '../local', '--upload-pack=malicious', 'main:other', 'feature/*'])(
  'rejects invalid revision %s before fetching',
  async (revision) => {
    run.mockImplementation(async (command, args) => {
      execFileSync(command, args, { stdio: 'ignore' });
    });
    await expect(buildMcpRevision(revision)).rejects.toThrow(
      'Failed to build MCP revision'
    );
    expect(run).toHaveBeenCalledTimes(1);
  }
);

it('cleans up a failed build and allows retrying', async () => {
  const revision = 'b'.repeat(40);
  run.mockImplementation(async (_command, args) => {
    if (args[0] === 'fetch') throw new Error('fetch failed');
  });
  await expect(buildMcpRevision(revision)).rejects.toThrow(
    `Failed to build MCP revision ${revision}`
  );
  const firstRoot = run.mock.calls[1]?.[1][2];
  expect(existsSync(firstRoot)).toBe(false);
  await expect(buildMcpRevision(revision)).rejects.toThrow();
  expect(run).toHaveBeenCalledTimes(6);
});

it('prepares an unbuilt local checkout once for concurrent callers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-local-build-'));
  const entry = join(root, 'packages/mcp-server-supabase/dist/cli.js');
  run.mockImplementation(async (_command, args) => {
    if (args[0] === 'build') {
      mkdirSync(join(entry, '..'), { recursive: true });
      writeFileSync(entry, '');
    }
  });
  try {
    expect(existsSync(entry)).toBe(false);
    expect(
      await Promise.all([buildMcpCheckout(root), buildMcpCheckout(root)])
    ).toEqual([entry, entry]);
    expect(run.mock.calls).toEqual([
      ['pnpm', ['install', '--frozen-lockfile'], { cwd: root }],
      ['pnpm', ['build'], { cwd: root }],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps a local checkout on failure and allows retrying', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-local-retry-'));
  run.mockRejectedValue(new Error('install failed'));
  try {
    await expect(buildMcpCheckout(root)).rejects.toThrow(
      'Failed to prepare MCP checkout'
    );
    expect(existsSync(root)).toBe(true);
    run.mockResolvedValue({});
    await expect(buildMcpCheckout(root)).rejects.toThrow(
      'Failed to prepare MCP checkout'
    );
    expect(run).toHaveBeenCalledTimes(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
