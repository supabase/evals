import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cliDebUrl } from '../src/cli-channel.js';

const STABLE_ENV = 'SUPABASE_CLI_STABLE_VERSION';
const BETA_ENV = 'SUPABASE_CLI_BETA_VERSION';
const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/supabase/dist-tags';
const PACKUMENT_URL = 'https://registry.npmjs.org/supabase';
const INSTALL_V1_ACCEPT = 'application/vnd.npm.install-v1+json';

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
 * mixture of GET (dist-tags, packument) and HEAD (amd64 + arm64 asset check)
 * calls resolveCliVersion makes.
 */
function routedFetchMock(routes: {
  distTags?: unknown;
  distTagsInit?: { ok?: boolean; status?: number; statusText?: string };
  assetOk?: (version: string, arch: 'amd64' | 'arm64') => boolean;
  packument?: unknown;
}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'HEAD') {
      const match = url.match(/supabase_(.+)_linux_(amd64|arm64)\.deb$/);
      const [, version, arch] = match ?? [];
      return headResponse(
        version && arch
          ? (routes.assetOk?.(version, arch as 'amd64' | 'arm64') ?? false)
          : false
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
    const { resolveCliVersion } = await import('../src/cli-channel.js');

    await expect(resolveCliVersion('stable')).resolves.toBe('1.2.3');

    const headCalls = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === 'HEAD'
    );
    expect(headCalls.map(([url]) => url)).toEqual([
      cliDebUrl('1.2.3', 'amd64'),
      cliDebUrl('1.2.3', 'arm64'),
    ]);
  });

  it('resolves the beta channel from the "beta" dist-tag when its asset exists', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '1.3.0-beta.1' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('../src/cli-channel.js');

    await expect(resolveCliVersion('beta')).resolves.toBe('1.3.0-beta.1');
  });

  it('prefers the env override over the network and strips a leading v', async () => {
    process.env[STABLE_ENV] = 'v9.9.9';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('../src/cli-channel.js');

    await expect(resolveCliVersion('stable')).resolves.toBe('9.9.9');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace from the env override', async () => {
    process.env[BETA_ENV] = '  1.4.0-rc.2  ';
    vi.stubGlobal('fetch', vi.fn());
    const { resolveCliVersion } = await import('../src/cli-channel.js');

    await expect(resolveCliVersion('beta')).resolves.toBe('1.4.0-rc.2');
  });

  it('throws naming the env var when the override is not a valid version', async () => {
    process.env[BETA_ENV] = 'not-a-version';
    vi.stubGlobal('fetch', vi.fn());
    const { resolveCliVersion } = await import('../src/cli-channel.js');

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
    const { resolveCliVersion } = await import('../src/cli-channel.js');

    await expect(resolveCliVersion('stable')).rejects.toThrow(
      `${DIST_TAGS_URL} -> 500 Internal Server Error`
    );
  });

  it('throws when the requested dist-tag is missing from the response', async () => {
    const fetchMock = routedFetchMock({ distTags: { beta: '1.0.0-beta.1' } });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('../src/cli-channel.js');

    await expect(resolveCliVersion('stable')).rejects.toThrow(
      /did not have a valid "latest" version for the stable channel/
    );
  });

  it('throws when the dist-tag value is not a valid version string', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: 'not-a-version' },
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('../src/cli-channel.js');

    await expect(resolveCliVersion('stable')).rejects.toThrow(
      /did not have a valid "latest" version for the stable channel/
    );
  });

  it('treats an array dist-tags response as invalid rather than a record', async () => {
    const fetchMock = routedFetchMock({ distTags: ['not', 'a', 'record'] });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('../src/cli-channel.js');

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
    const { resolveCliVersion } = await import('../src/cli-channel.js');

    await expect(resolveCliVersion('stable')).resolves.toBe('1.2.3');
    await expect(resolveCliVersion('stable')).resolves.toBe('1.2.3');

    // One GET (dist-tags) + two HEAD (amd64+arm64 asset check) — the second
    // call hits the cache.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('clears the cache entry on rejection so a later call refetches, and keeps the retry memoised', async () => {
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
    const { resolveCliVersion } = await import('../src/cli-channel.js');

    await expect(resolveCliVersion('stable')).rejects.toThrow('500');
    await expect(resolveCliVersion('stable')).resolves.toBe('1.2.3');
    // A third call must still hit the cache populated by the successful
    // retry — the rejected first promise's cleanup must not evict it.
    await expect(resolveCliVersion('stable')).resolves.toBe('1.2.3');

    expect(fetchMock).toHaveBeenCalledTimes(4);
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
    const { resolveCliVersion } = await import('../src/cli-channel.js');

    await expect(resolveCliVersion('stable')).resolves.toBe('1.2.3');
    await expect(resolveCliVersion('beta')).rejects.toThrow(
      /did not have a valid "beta" version for the beta channel/
    );
    await expect(resolveCliVersion('stable')).resolves.toBe('1.2.3');

    // Two dist-tags GETs (stable, beta) + two HEAD (stable's amd64+arm64
    // asset check only — beta never gets that far).
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
    const { resolveCliVersion } = await import('../src/cli-channel.js');

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
      cliDebUrl('2.118.0-beta.52', 'amd64'),
      cliDebUrl('2.118.0-beta.52', 'arm64'),
      cliDebUrl('2.118.0-beta.51', 'amd64'),
      cliDebUrl('2.118.0-beta.51', 'arm64'),
    ]);
  });

  it("falls back across a minor version boundary to the previous minor's newest beta", async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '2.118.0', beta: '2.119.0-beta.1' },
      assetOk: (version) => version === '2.118.0-beta.60',
      packument: {
        versions: {
          '2.119.0-beta.1': {},
          '2.118.0-beta.60': {},
          '2.118.0-beta.59': {},
          '2.117.0': {},
        },
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('../src/cli-channel.js');

    await expect(resolveCliVersion('beta')).resolves.toBe('2.118.0-beta.60');
  });

  it('orders beta.10 ahead of beta.9 during the walk-back (not a string compare)', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '2.118.0-beta.11' },
      // Only the unpublished dist-tag version (11) 404s; both walk-back
      // candidates would succeed, so probe order is what decides the result.
      assetOk: (version) => version !== '2.118.0-beta.11',
      packument: {
        versions: {
          '2.118.0-beta.11': {},
          '2.118.0-beta.10': {},
          '2.118.0-beta.9': {},
        },
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('../src/cli-channel.js');

    await expect(resolveCliVersion('beta')).resolves.toBe('2.118.0-beta.10');

    const headUrls = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'HEAD')
      .map(([url]) => url);
    // A naive string compare would sort "beta.9" ahead of "beta.10" (since
    // '9' > '1' character-wise), probing 9 before 10.
    expect(headUrls).toEqual([
      cliDebUrl('2.118.0-beta.11', 'amd64'),
      cliDebUrl('2.118.0-beta.11', 'arm64'),
      cliDebUrl('2.118.0-beta.10', 'amd64'),
      cliDebUrl('2.118.0-beta.10', 'arm64'),
    ]);
  });

  it('never selects a beta candidate newer than the unpublished dist-tag version', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '2.118.0-beta.50' },
      // Every candidate downloads except the unpublished one — if the newer
      // candidate (51) were ever probed, this would resolve to beta.51
      // instead of walking further back to beta.49.
      assetOk: (version) => version !== '2.118.0-beta.50',
      packument: {
        versions: {
          '2.118.0-beta.51': {},
          '2.118.0-beta.50': {},
          '2.118.0-beta.49': {},
        },
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('../src/cli-channel.js');

    await expect(resolveCliVersion('beta')).resolves.toBe('2.118.0-beta.49');
  });

  it('treats a walk-back candidate whose asset check throws as unavailable and continues to the next', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        if (url.includes('2.118.0-beta.52')) return headResponse(false);
        if (url.includes('2.118.0-beta.51')) throw new Error('network blip');
        if (url.includes('2.118.0-beta.50')) return headResponse(true);
        return headResponse(false);
      }
      if (url === DIST_TAGS_URL) {
        return jsonResponse({ latest: '1.2.3', beta: '2.118.0-beta.52' });
      }
      if (url === PACKUMENT_URL) {
        return jsonResponse({
          versions: {
            '2.118.0-beta.52': {},
            '2.118.0-beta.51': {},
            '2.118.0-beta.50': {},
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('../src/cli-channel.js');

    await expect(resolveCliVersion('beta')).resolves.toBe('2.118.0-beta.50');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('2.118.0-beta.51')
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('network blip')
    );

    warnSpy.mockRestore();
  });

  it('caps the beta walk-back at MAX_BETA_FALLBACK_CANDIDATES, probing newest-first', async () => {
    const versions: Record<string, unknown> = {};
    for (let n = 50; n <= 59; n += 1) versions[`2.118.0-beta.${n}`] = {};
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '2.118.0-beta.60' },
      assetOk: () => false,
      packument: { versions },
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('../src/cli-channel.js');

    await expect(resolveCliVersion('beta')).rejects.toThrow();

    const probedVersions = [
      ...new Set(
        fetchMock.mock.calls
          .filter(([, init]) => init?.method === 'HEAD')
          .map(([url]) => url.match(/supabase_(.+)_linux_/)?.[1])
      ),
    ];
    // The unpublished dist-tag version itself is checked first (outside the
    // walk-back budget), followed by exactly MAX_BETA_FALLBACK_CANDIDATES (5)
    // older published betas, newest-first.
    expect(probedVersions).toEqual([
      '2.118.0-beta.60',
      '2.118.0-beta.59',
      '2.118.0-beta.58',
      '2.118.0-beta.57',
      '2.118.0-beta.56',
      '2.118.0-beta.55',
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
    const { resolveCliVersion } = await import('../src/cli-channel.js');

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
    const { resolveCliVersion } = await import('../src/cli-channel.js');

    await expect(resolveCliVersion('stable')).rejects.toThrow(
      'checked amd64 and arm64 .deb assets at ' +
        'https://github.com/supabase/cli/releases/tag/v1.2.3'
    );
  });

  it('does not hit the network at all for an env override', async () => {
    process.env[STABLE_ENV] = '9.9.9';
    process.env[BETA_ENV] = '9.9.9-beta.1';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersion } = await import('../src/cli-channel.js');

    await expect(resolveCliVersion('stable')).resolves.toBe('9.9.9');
    await expect(resolveCliVersion('beta')).resolves.toBe('9.9.9-beta.1');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('resolveCliVersionOption', () => {
  it('passes an exact version through unchanged, without touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionOption } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionOption('2.109.1')).resolves.toBe('2.109.1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes undefined through unchanged, without touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionOption } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionOption(undefined)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves a "stable" channel tag against npm', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '1.3.0-beta.1' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionOption } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionOption('stable')).resolves.toBe('1.2.3');
  });

  it('resolves a "beta" channel tag against npm', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '1.3.0-beta.1' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionOption } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionOption('beta')).resolves.toBe('1.3.0-beta.1');
  });
});

describe('compareBetaVersionsDesc', () => {
  it('sorts newer beta numbers before older ones within the same minor', async () => {
    const { compareBetaVersionsDesc } = await import('../src/cli-channel.js');

    expect(
      compareBetaVersionsDesc('2.118.0-beta.10', '2.118.0-beta.9')
    ).toBeLessThan(0);
    expect(
      compareBetaVersionsDesc('2.118.0-beta.9', '2.118.0-beta.10')
    ).toBeGreaterThan(0);
  });

  it('sorts a newer minor before an older minor regardless of beta number', async () => {
    const { compareBetaVersionsDesc } = await import('../src/cli-channel.js');

    expect(
      compareBetaVersionsDesc('2.119.0-beta.1', '2.118.0-beta.60')
    ).toBeLessThan(0);
  });

  it('treats equal versions as equal', async () => {
    const { compareBetaVersionsDesc } = await import('../src/cli-channel.js');

    expect(compareBetaVersionsDesc('2.118.0-beta.1', '2.118.0-beta.1')).toBe(0);
  });

  it('throws for a non "X.Y.Z-beta.N" version', async () => {
    const { compareBetaVersionsDesc } = await import('../src/cli-channel.js');

    expect(() =>
      compareBetaVersionsDesc('2.118.0-rc.1', '2.118.0-beta.1')
    ).toThrow();
  });
});
