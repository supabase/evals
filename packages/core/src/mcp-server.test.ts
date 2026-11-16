import {
  afterAll,
  afterEach,
  assert,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createPlatform,
  MCP_SERVER_VERSION,
} from '@supabase-evals/platform-lite';
import { rewriteLoopback } from './agents/shared.js';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import {
  platformLiteRuntime,
  supabaseMcpServer,
  supabaseMcpServerMounts,
} from './index.js';
import * as mcpRevision from './mcp-revision.js';

function clearEnv() {
  vi.stubEnv('SUPABASE_MCP_REPO_PATH', undefined);
}

let fixtureDir: string;
let fixtureEntry: string;
beforeAll(() => {
  // Use canonical paths to match Docker's bind-mount view on macOS.
  fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-override-')));
  const dist = join(fixtureDir, 'packages', 'mcp-server-supabase', 'dist');
  fixtureEntry = join(dist, 'cli.js');
  mkdirSync(dist, { recursive: true });
  writeFileSync(fixtureEntry, '');
  writeFileSync(join(dist, '..', 'package.json'), '{}');
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

describe('supabaseMcpServer().createConfig', () => {
  beforeEach(() => {
    vi.spyOn(mcpRevision, 'buildMcpCheckout').mockResolvedValue(fixtureEntry);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('rejects a revision combined with a package version', () => {
    expect(() =>
      supabaseMcpServer({ revision: 'a'.repeat(40), version: '1.0.0' })
    ).toThrow('mutually exclusive');
  });

  it('rejects a local override combined with a revision', async () => {
    vi.stubEnv('SUPABASE_MCP_REPO_PATH', fixtureDir);
    await expect(
      supabaseMcpServer({ revision: 'a'.repeat(40) }).createConfig()
    ).rejects.toThrow('Unset SUPABASE_MCP_REPO_PATH');
  });

  it('carries the source build and commit into the runtime', async () => {
    clearEnv();
    const build = vi.spyOn(mcpRevision, 'buildMcpRevision').mockResolvedValue({
      entry: fixtureEntry,
      mountRoot: fixtureDir,
      commitSha: 'b'.repeat(40),
    });
    try {
      const runtime = platformLiteRuntime({
        mcpServers: [supabaseMcpServer({ revision: 'a'.repeat(40) })],
      });
      const session = await runtime.startSession({});
      try {
        expect(build).toHaveBeenCalledWith('a'.repeat(40));
        expect(session.repoSources).toEqual({
          'supabase/mcp': {
            revision: 'a'.repeat(40),
            commitSha: 'b'.repeat(40),
          },
        });
        expect(session.mcpServers['supabase-mcp']?.args?.[0]).toBe(
          fixtureEntry
        );
        expect(session.mounts).toEqual([
          { hostPath: fixtureDir, readonly: true },
        ]);
      } finally {
        await session.close();
      }
    } finally {
      build.mockRestore();
    }
  });

  it('defaults to the published package via npx', async () => {
    clearEnv();
    const { config } = await supabaseMcpServer().createConfig({
      apiUrl: 'http://api.test',
    });
    expect(config.command).toBe('npx');
    expect(config.args?.[0]).toBe(
      `@supabase/mcp-server-supabase@${MCP_SERVER_VERSION}`
    );
    expect(config.args).toContain('--api-url');
  });

  it('launches the built server from the configured repo root', async () => {
    clearEnv();
    vi.stubEnv('SUPABASE_MCP_REPO_PATH', fixtureDir);
    const { config } = await supabaseMcpServer().createConfig({});
    expect(mcpRevision.buildMcpCheckout).toHaveBeenCalledWith(fixtureDir);
    expect(config.command).toBe('node');
    expect(config.args?.[0]).toBe(fixtureEntry);
  });

  it('propagates checkout preparation failures', async () => {
    vi.stubEnv('SUPABASE_MCP_REPO_PATH', fixtureDir);
    vi.mocked(mcpRevision.buildMcpCheckout).mockRejectedValue(
      new Error('build failed')
    );
    await expect(supabaseMcpServer().createConfig()).rejects.toThrow(
      'build failed'
    );
  });

  it('rejects package directories and entrypoints as repo roots', async () => {
    clearEnv();
    for (const path of [
      join(fixtureDir, 'packages', 'mcp-server-supabase'),
      fixtureEntry,
    ]) {
      vi.stubEnv('SUPABASE_MCP_REPO_PATH', path);
      await expect(supabaseMcpServer().createConfig({})).rejects.toThrow(
        'Point it at the MCP repo root'
      );
    }
  });

  it('preserves --api-url on the local override path', async () => {
    clearEnv();
    vi.stubEnv('SUPABASE_MCP_REPO_PATH', fixtureDir);
    const { config } = await supabaseMcpServer().createConfig({
      apiUrl: 'http://api.test',
    });
    assert(config.args);
    const i = config.args.indexOf('--api-url');
    expect(i).toBeGreaterThan(-1);
    expect(config.args[i + 1]).toBe('http://api.test');
  });

  it('fails fast with an actionable error when the override path does not exist', async () => {
    clearEnv();
    vi.stubEnv('SUPABASE_MCP_REPO_PATH', join(fixtureDir, 'not-built'));
    await expect(supabaseMcpServer().createConfig({})).rejects.toThrow(
      /does not exist.*Point it at the MCP repo root/s
    );
  });
  it('resolves a relative override path against the evals checkout root', async () => {
    clearEnv();
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();
    vi.stubEnv('SUPABASE_MCP_REPO_PATH', relative(repoRoot, fixtureDir));
    const { config } = await supabaseMcpServer().createConfig({});
    expect(config.args?.[0]).toBe(fixtureEntry);
  });

  it('realpaths a symlinked override so the command matches the container mount', async () => {
    clearEnv();
    const linkDir = mkdtempSync(join(tmpdir(), 'mcp-link-'));
    const link = join(linkDir, 'pkg');
    symlinkSync(fixtureDir, link);
    try {
      vi.stubEnv('SUPABASE_MCP_REPO_PATH', link);
      const { config } = await supabaseMcpServer().createConfig({});
      expect(config.args?.[0]).toBe(fixtureEntry); // the real path, not the symlink
      expect(supabaseMcpServerMounts()).toEqual([
        { hostPath: realpathSync(fixtureDir), readonly: true },
      ]);
    } finally {
      rmSync(linkDir, { recursive: true, force: true });
    }
  });
});

describe('supabaseMcpServer feedback redirect', () => {
  afterEach(() => vi.unstubAllEnvs());

  it("sends staging feedback calls to platform-lite's feedback project", async () => {
    clearEnv();
    await using platform = await createPlatform({ accessToken: 't' });
    await using server = await platform.listen();
    const { config } = await supabaseMcpServer().createConfig({
      apiUrl: server.url,
    });

    // Same calls the MCP server makes, against the real staging origin.
    const script = `
      const base = 'https://actixlblmrqglneypada.supabase.co/rest/v1';
      const submit = await fetch(base + '/rpc/submit_interfaces_feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: 'hi' }),
      });
      const token = await submit.json();
      const del = await fetch(base + '/interfaces_feedback?delete_token=eq.' + token, {
        method: 'DELETE',
        headers: { Prefer: 'count=exact', 'x-feedback-token': token },
      });
      console.log(del.headers.get('content-range'));
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', script],
      { env: { ...process.env, ...config.env } }
    );

    expect(stdout.trim()).toBe('*/1');
  });

  it('keeps the redirect target rewritable for sandboxes', async () => {
    clearEnv();
    const { config } = await supabaseMcpServer().createConfig({
      apiUrl: 'http://127.0.0.1:5000',
    });

    const { env } = rewriteLoopback({ mcp: config }).mcp;

    expect(decodeURIComponent(env?.NODE_OPTIONS ?? '')).toContain(
      '"http://host.docker.internal:5000/feedback"'
    );
  });

  it('leaves the environment alone when feedback is disabled', async () => {
    clearEnv();
    const { config } = await supabaseMcpServer({
      features: ['database'],
    }).createConfig({ apiUrl: 'http://127.0.0.1:5000' });

    expect(config.env).toBeUndefined();
  });

  it.each([
    ['no apiUrl', undefined],
    ['the production apiUrl', 'https://api.supabase.com'],
  ])('drops feedback with %s', async (_, apiUrl) => {
    clearEnv();
    const { config } = await supabaseMcpServer({
      features: ['docs', 'feedback'],
    }).createConfig({ apiUrl });

    assert(config.args);
    const i = config.args.indexOf('--features');
    expect(config.args[i + 1]).toBe('docs');
    expect(config.env).toBeUndefined();
  });

  it('refuses feedback-only production config instead of enabling defaults', async () => {
    clearEnv();
    await expect(
      supabaseMcpServer({ features: ['feedback'] }).createConfig({})
    ).rejects.toThrow(/non-production apiUrl/);
  });
});

describe('supabaseMcpServerMounts', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is empty when no override is set', () => {
    clearEnv();
    expect(supabaseMcpServerMounts()).toEqual([]);
  });
  it('mounts the configured repo root read-only', () => {
    clearEnv();
    vi.stubEnv('SUPABASE_MCP_REPO_PATH', fixtureDir);
    expect(supabaseMcpServerMounts()).toEqual([
      { hostPath: fixtureDir, readonly: true },
    ]);
  });
});
