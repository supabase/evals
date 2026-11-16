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

const checkoutBuilds = new Map<string, Promise<string>>();

export function buildMcpCheckout(repoRoot: string): Promise<string> {
  const cached = checkoutBuilds.get(repoRoot);
  if (cached) return cached;
  const build = (async () => {
    console.log(`Preparing MCP checkout at ${repoRoot}`);
    await exec('pnpm', ['install', '--frozen-lockfile'], { cwd: repoRoot });
    await exec('pnpm', ['build'], { cwd: repoRoot });
    const entry = join(repoRoot, 'packages/mcp-server-supabase/dist/cli.js');
    if (!existsSync(entry))
      throw new Error(`MCP build did not produce ${entry}`);
    return entry;
  })().catch((cause: unknown) => {
    checkoutBuilds.delete(repoRoot);
    throw new Error(`Failed to prepare MCP checkout at ${repoRoot}`, { cause });
  });
  checkoutBuilds.set(repoRoot, build);
  return build;
}

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
    const entry = await buildMcpCheckout(mountRoot);
    // Docker's node user needs access even when the host UID differs.
    chmodSync(mountRoot, 0o755);
    process.once('exit', () =>
      rmSync(mountRoot, { recursive: true, force: true })
    );
    return { entry, mountRoot, commitSha };
  } catch (cause) {
    rmSync(mountRoot, { recursive: true, force: true });
    throw new Error(`Failed to build MCP revision ${revision}`, { cause });
  }
}
