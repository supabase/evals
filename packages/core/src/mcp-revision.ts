import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const builds = new Map<
  string,
  Promise<{ entry: string; mountRoot: string; commitSha: string }>
>();

export const MCP_SERVER_ENTRY_PATH = 'packages/mcp-server-supabase/dist/cli.js';

export function buildMcpRevision(revision: string) {
  const cached = builds.get(revision);
  if (cached) return cached;
  const build = buildRevision(revision).catch((error: unknown) => {
    builds.delete(revision);
    throw error;
  });
  builds.set(revision, build);
  return build;
}

async function buildRevision(revision: string) {
  const mountRoot = realpathSync(mkdtempSync(join(tmpdir(), 'eval-mcp-')));
  try {
    await exec('git', ['check-ref-format', '--allow-onelevel', revision]);
    console.log(`Building supabase/mcp at ${revision}`);
    await exec('git', ['init', '-q', mountRoot]);
    await exec(
      'git',
      [
        'fetch',
        '--depth=1',
        '--',
        'https://github.com/supabase/mcp.git',
        revision,
      ],
      { cwd: mountRoot }
    );
    await exec('git', ['checkout', '--detach', 'FETCH_HEAD'], {
      cwd: mountRoot,
    });
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], {
      cwd: mountRoot,
    });
    const commitSha = stdout.trim();
    console.log(`Resolved MCP revision ${revision} to ${commitSha}`);
    await exec('pnpm', ['install', '--frozen-lockfile'], { cwd: mountRoot });
    await exec('pnpm', ['build'], { cwd: mountRoot });
    const entry = join(mountRoot, MCP_SERVER_ENTRY_PATH);
    if (!existsSync(entry))
      throw new Error(`MCP build did not produce ${entry}`);
    // Docker's node user needs access even when the host UID differs.
    chmodSync(mountRoot, 0o755);
    process.once('exit', () =>
      rmSync(mountRoot, { recursive: true, force: true })
    );
    return { entry, mountRoot, commitSha };
  } catch (cause) {
    rmSync(mountRoot, { recursive: true, force: true });
    const message = cause instanceof Error ? cause.message : String(cause);
    const stdout =
      cause instanceof Error &&
      'stdout' in cause &&
      typeof cause.stdout === 'string'
        ? cause.stdout.trim()
        : '';
    throw new Error(
      `Failed to build MCP revision ${revision}: ${message}${stdout ? `\n${stdout}` : ''}`,
      { cause }
    );
  }
}
