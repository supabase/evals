import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createPlatform } from '@supabase-evals/platform-lite';
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
  MCP_SERVER_VERSION,
  supabaseMcpServer,
  supabaseMcpServerMounts,
} from './index.js';

// Stub (not mutate) env so a pre-existing SUPABASE_MCP_SERVER_PATH is restored
// per test.
function clearEnv() {
  vi.stubEnv('SUPABASE_MCP_SERVER_PATH', undefined);
}

// A real on-disk build layout: the override path is existence-checked, so the
// fixtures must actually exist for the happy paths (and not for the error one).
let fixtureDir: string;
let fixtureEntry: string;
beforeAll(() => {
  // realpath'd: the resolver realpaths the override (command must match the
  // container mount view), so unresolved tmpdir paths (macOS /var symlink)
  // would fail every exact-path assertion below.
  fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-override-')));
  fixtureEntry = join(fixtureDir, 'dist', 'cli.js');
  mkdirSync(join(fixtureDir, 'dist'), { recursive: true });
  writeFileSync(fixtureEntry, '');
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

describe('supabaseMcpServer().createConfig', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to the published package via npx', async () => {
    clearEnv();
    const { config } = await supabaseMcpServer().createConfig({
      apiUrl: 'http://api.test',
    });
    expect(config.command).toBe('npx');
    expect(config.args[0]).toBe(
      `@supabase/mcp-server-supabase@${MCP_SERVER_VERSION}`
    );
    expect(config.args).toContain('--api-url');
  });

  it('launches a local build dir with node when SUPABASE_MCP_SERVER_PATH is set', async () => {
    clearEnv();
    vi.stubEnv('SUPABASE_MCP_SERVER_PATH', fixtureDir);
    const { config } = await supabaseMcpServer().createConfig({});
    expect(config.command).toBe('node');
    expect(config.args[0]).toBe(fixtureEntry);
  });

  it('uses a direct .js override path as-is', async () => {
    clearEnv();
    vi.stubEnv('SUPABASE_MCP_SERVER_PATH', fixtureEntry);
    const { config } = await supabaseMcpServer().createConfig({});
    expect(config.args[0]).toBe(fixtureEntry);
  });

  it('preserves --api-url on the local override path', async () => {
    clearEnv();
    vi.stubEnv('SUPABASE_MCP_SERVER_PATH', fixtureDir);
    const { config } = await supabaseMcpServer().createConfig({
      apiUrl: 'http://api.test',
    });
    const i = config.args.indexOf('--api-url');
    expect(i).toBeGreaterThan(-1);
    expect(config.args[i + 1]).toBe('http://api.test');
  });

  it('fails fast with an actionable error when the override path does not exist', async () => {
    clearEnv();
    vi.stubEnv('SUPABASE_MCP_SERVER_PATH', join(fixtureDir, 'not-built'));
    await expect(supabaseMcpServer().createConfig({})).rejects.toThrow(
      /does not exist.*build the server first/s
    );
  });
  it('resolves a relative override path against the evals checkout root', async () => {
    clearEnv();
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();
    vi.stubEnv('SUPABASE_MCP_SERVER_PATH', relative(repoRoot, fixtureEntry));
    const { config } = await supabaseMcpServer().createConfig({});
    expect(config.args[0]).toBe(fixtureEntry);
  });

  it('realpaths a symlinked override so the command matches the container mount', async () => {
    clearEnv();
    const linkDir = mkdtempSync(join(tmpdir(), 'mcp-link-'));
    const link = join(linkDir, 'pkg');
    symlinkSync(fixtureDir, link);
    try {
      vi.stubEnv('SUPABASE_MCP_SERVER_PATH', link);
      const { config } = await supabaseMcpServer().createConfig({});
      expect(config.args[0]).toBe(fixtureEntry); // the real path, not the symlink
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
  it("mounts the override checkout root read-only (a CLI agent's MCP command runs in-container)", () => {
    clearEnv();
    // A git checkout wrapping the package dir: the mount must cover the whole
    // checkout (the unbundled build needs its node_modules), not just dist/.
    const checkout = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-mount-')));
    try {
      execFileSync('git', ['init', '-q'], { cwd: checkout });
      const pkgDir = join(checkout, 'packages', 'server');
      mkdirSync(join(pkgDir, 'dist'), { recursive: true });
      writeFileSync(join(pkgDir, 'dist', 'cli.js'), '');
      vi.stubEnv('SUPABASE_MCP_SERVER_PATH', pkgDir);
      expect(supabaseMcpServerMounts()).toEqual([
        { hostPath: checkout, readonly: true },
      ]);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it('falls back to the package dir when the override is not inside a git checkout', () => {
    clearEnv();
    vi.stubEnv('SUPABASE_MCP_SERVER_PATH', fixtureDir);
    expect(supabaseMcpServerMounts()).toEqual([
      { hostPath: realpathSync(fixtureDir), readonly: true },
    ]);
  });
});
