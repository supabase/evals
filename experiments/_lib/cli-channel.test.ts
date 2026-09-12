// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. experiments/_lib evals/build-database-002-stack-lifecycle
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STABLE_ENV = 'SUPABASE_CLI_STABLE_VERSION';
const BETA_ENV = 'SUPABASE_CLI_BETA_VERSION';
const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/supabase/dist-tags';

function distTagsResponse(
  body: unknown,
  init: { ok?: boolean; status?: number; statusText?: string } = {}
) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    json: async () => body,
  };
}

beforeEach(() => {
  vi.resetModules();
  delete process.env[STABLE_ENV];
  delete process.env[BETA_ENV];
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[STABLE_ENV];
  delete process.env[BETA_ENV];
});

describe('resolveCliVersion', () => {
  it('resolves the stable channel from the "latest" dist-tag', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        distTagsResponse({ latest: '1.2.3', beta: '1.3.0-rc.1' })
      );
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('stable')).resolves.toBe('1.2.3');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(DIST_TAGS_URL);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('resolves the beta channel from the "beta" dist-tag', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        distTagsResponse({ latest: '1.2.3', beta: '1.3.0-rc.1' })
      );
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('beta')).resolves.toBe('1.3.0-rc.1');
  });

  it('prefers the env override over the network and strips a leading v', async () => {
    process.env[STABLE_ENV] = 'v9.9.9';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('stable')).resolves.toBe('9.9.9');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace from the env override', async () => {
    process.env[BETA_ENV] = '  1.4.0-rc.2  ';
    vi.stubGlobal('fetch', vi.fn());
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('beta')).resolves.toBe('1.4.0-rc.2');
  });

  it('throws naming the env var when the override is not a valid version', async () => {
    process.env[BETA_ENV] = 'not-a-version';
    vi.stubGlobal('fetch', vi.fn());
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('beta')).rejects.toThrow(
      `${BETA_ENV}="not-a-version" is not a valid Supabase CLI version`
    );
  });

  it('throws with the HTTP status when the registry request fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      distTagsResponse(undefined, {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('stable')).rejects.toThrow(
      `${DIST_TAGS_URL} -> 500 Internal Server Error`
    );
  });

  it('throws when the requested dist-tag is missing from the response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(distTagsResponse({ beta: '1.0.0' }));
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('stable')).rejects.toThrow(
      /did not have a valid "latest" version for the stable channel/
    );
  });

  it('throws when the dist-tag value is not a valid version string', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(distTagsResponse({ latest: 'not-a-version' }));
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('stable')).rejects.toThrow(
      /did not have a valid "latest" version for the stable channel/
    );
  });

  it('memoises a successful resolution so a second call does not refetch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(distTagsResponse({ latest: '1.2.3', beta: '1.3.0' }));
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('stable')).resolves.toBe('1.2.3');
    await expect(resolveCliVersion('stable')).resolves.toBe('1.2.3');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears the cache entry on rejection so a later call refetches', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        distTagsResponse(undefined, {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        })
      )
      .mockResolvedValueOnce(
        distTagsResponse({ latest: '1.2.3', beta: '1.3.0' })
      );
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('stable')).rejects.toThrow('500');
    await expect(resolveCliVersion('stable')).resolves.toBe('1.2.3');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not let a beta rejection clear the stable cache entry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        distTagsResponse({ latest: '1.2.3', beta: '1.3.0' })
      )
      .mockResolvedValueOnce(
        distTagsResponse(undefined, {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('stable')).resolves.toBe('1.2.3');
    await expect(resolveCliVersion('beta')).rejects.toThrow('500');
    await expect(resolveCliVersion('stable')).resolves.toBe('1.2.3');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
