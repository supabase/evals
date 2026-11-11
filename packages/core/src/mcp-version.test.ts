import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../platform-lite/package.json');
  vi.resetModules();
});

it('exports the same MCP version from platform-lite and core', async () => {
  const platformLite = await import('@supabase-evals/platform-lite');
  const core = await import('./index.js');

  expect(platformLite.MCP_SERVER_VERSION).toBeTypeOf('string');
  expect(core.MCP_SERVER_VERSION).toBe(platformLite.MCP_SERVER_VERSION);
});

it('rejects a version range before configuring the MCP server', async () => {
  vi.doMock('../../platform-lite/package.json', () => ({
    default: {
      devDependencies: { '@supabase/mcp-server-supabase': '^0.16.1' },
    },
  }));

  await expect(import('./index.js')).rejects.toThrow(
    'MCP version must be an exact stable version'
  );
});
