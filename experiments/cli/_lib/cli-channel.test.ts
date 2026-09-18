// Run: pnpm --filter @supabase-evals/framework test:cli-lib
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STABLE_ENV = 'SUPABASE_CLI_STABLE_VERSION';
const BETA_ENV = 'SUPABASE_CLI_BETA_VERSION';
const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/supabase/dist-tags';
const PACKUMENT_URL = 'https://registry.npmjs.org/supabase';
const INSTALL_V1_ACCEPT = 'application/vnd.npm.install-v1+json';

// Mirrors hostDebArch()'s mapping so this test's expected URLs match
// whatever host architecture actually runs it.
const HOST_ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64';

function debUrl(version: string): string {
  return `https://github.com/supabase/cli/releases/download/v${version}/supabase_${version}_linux_${HOST_ARCH}.deb`;
}

function jsonResponse(
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

function headResponse(ok: boolean) {
  return { ok, status: ok ? 200 : 404, statusText: ok ? 'OK' : 'Not Found' };
}

/**
 * Routes a single stubbed `fetch` by method + URL, mirroring the real
 * mixture of GET (dist-tags, packument) and HEAD (asset check) calls
 * resolveCliVersion makes.
 */
function routedFetchMock(routes: {
  distTags?: unknown;
  distTagsInit?: { ok?: boolean; status?: number; statusText?: string };
  assetOk?: (version: string) => boolean;
  packument?: unknown;
}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'HEAD') {
      const version = url.match(/supabase_(.+)_linux_/)?.[1];
      return headResponse(
        version ? (routes.assetOk?.(version) ?? false) : false
      );
    }
    if (url === DIST_TAGS_URL) {
      return jsonResponse(routes.distTags, routes.distTagsInit);
    }
    if (url === PACKUMENT_URL) {
      return jsonResponse(routes.packument);
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
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
  it('resolves the stable channel from the "latest" dist-tag when its asset exists', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '1.3.0-beta.1' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('stable')).resolves.toBe('1.2.3');

    const headCalls = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === 'HEAD'
    );
    expect(headCalls).toHaveLength(1);
    expect(headCalls[0]?.[0]).toBe(debUrl('1.2.3'));
  });

  it('resolves the beta channel from the "beta" dist-tag when its asset exists', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '1.3.0-beta.1' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('beta')).resolves.toBe('1.3.0-beta.1');
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
    const fetchMock = routedFetchMock({
      distTags: undefined,
      distTagsInit: {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('stable')).rejects.toThrow(
      `${DIST_TAGS_URL} -> 500 Internal Server Error`
    );
  });

  it('throws when the requested dist-tag is missing from the response', async () => {
    const fetchMock = routedFetchMock({ distTags: { beta: '1.0.0-beta.1' } });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('stable')).rejects.toThrow(
      /did not have a valid "latest" version for the stable channel/
    );
  });

  it('throws when the dist-tag value is not a valid version string', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: 'not-a-version' },
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('stable')).rejects.toThrow(
      /did not have a valid "latest" version for the stable channel/
    );
  });

  it('memoises a successful resolution so a second call does not refetch', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '1.3.0-beta.1' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('stable')).resolves.toBe('1.2.3');
    await expect(resolveCliVersion('stable')).resolves.toBe('1.2.3');

    // One GET (dist-tags) + one HEAD (asset check) — the second call hits the cache.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clears the cache entry on rejection so a later call refetches', async () => {
    let failNextDistTags = true;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return headResponse(true);
      if (url === DIST_TAGS_URL) {
        if (failNextDistTags) {
          failNextDistTags = false;
          return jsonResponse(undefined, {
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
          });
        }
        return jsonResponse({ latest: '1.2.3', beta: '1.3.0-beta.1' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('stable')).rejects.toThrow('500');
    await expect(resolveCliVersion('stable')).resolves.toBe('1.2.3');

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not let a beta rejection clear the stable cache entry', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return headResponse(true);
      if (url === DIST_TAGS_URL) {
        return jsonResponse({ latest: '1.2.3', beta: 'not-a-version' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('stable')).resolves.toBe('1.2.3');
    await expect(resolveCliVersion('beta')).rejects.toThrow(
      /did not have a valid "beta" version for the beta channel/
    );
    await expect(resolveCliVersion('stable')).resolves.toBe('1.2.3');

    // Two dist-tags GETs (stable, beta) + one HEAD (stable's asset check
    // only — beta never gets that far).
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('falls back to the newest published beta.N-1 when the dist-tag asset is a 404', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '2.118.0-beta.52' },
      assetOk: (version) => version !== '2.118.0-beta.52',
      packument: {
        versions: {
          '2.118.0-beta.52': {},
          '2.118.0-beta.51': {},
          '2.118.0-beta.50': {},
          '2.117.0': {},
        },
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('beta')).resolves.toBe('2.118.0-beta.51');

    const packumentCall = fetchMock.mock.calls.find(
      ([url]) => url === PACKUMENT_URL
    );
    expect(packumentCall?.[1]?.headers).toMatchObject({
      Accept: INSTALL_V1_ACCEPT,
    });

    const headUrls = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'HEAD')
      .map(([url]) => url);
    expect(headUrls).toEqual([
      debUrl('2.118.0-beta.52'),
      debUrl('2.118.0-beta.51'),
    ]);
  });

  it('throws naming the unpublished versions when no published beta has a downloadable asset', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '2.118.0-beta.52' },
      assetOk: () => false,
      packument: {
        versions: {
          '2.118.0-beta.52': {},
          '2.118.0-beta.51': {},
        },
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('beta')).rejects.toThrow(
      /2\.118\.0-beta\.52.*2\.118\.0-beta\.51/
    );
  });

  it('throws instead of guessing when the stable dist-tag asset is a 404', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '1.3.0-beta.1' },
      assetOk: () => false,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('stable')).rejects.toThrow(
      `HEAD ${debUrl('1.2.3')} was not ok`
    );
  });

  it('does not hit the network at all for an env override', async () => {
    process.env[STABLE_ENV] = '9.9.9';
    process.env[BETA_ENV] = '9.9.9-beta.1';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('./cli-channel.js');

    await expect(resolveCliVersion('stable')).resolves.toBe('9.9.9');
    await expect(resolveCliVersion('beta')).resolves.toBe('9.9.9-beta.1');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
