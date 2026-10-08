import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cliDebUrl } from '../src/cli-channel.js';

const PINS_ENV = 'SUPABASE_CLI_DIST_TAG_PINS';
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

function headResponse(ok: boolean, status?: number, statusText?: string) {
  return {
    ok,
    status: status ?? (ok ? 200 : 404),
    statusText: statusText ?? (ok ? 'OK' : 'Not Found'),
  };
}

/**
 * Routes a single stubbed `fetch` by method + URL, mirroring the real
 * mixture of GET (dist-tags, packument) and HEAD (amd64 + arm64 asset check)
 * calls resolveCliDistTag makes.
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
  delete process.env[PINS_ENV];
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[PINS_ENV];
});

describe('resolveCliDistTag', () => {
  it('resolves the "latest" dist-tag when its asset exists', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '1.3.0-beta.1' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('latest')).resolves.toBe('1.2.3');

    const headCalls = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === 'HEAD'
    );
    expect(headCalls.map(([url]) => url)).toEqual([
      cliDebUrl('1.2.3', 'amd64'),
      cliDebUrl('1.2.3', 'arm64'),
    ]);
  });

  it('resolves the "beta" dist-tag when its asset exists', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '1.3.0-beta.1' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('beta')).resolves.toBe('1.3.0-beta.1');
  });

  it('resolves the "next" dist-tag when its asset exists', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '1.3.0-beta.1', next: '3.0.0-next.2' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('next')).resolves.toBe('3.0.0-next.2');
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
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('latest')).rejects.toThrow(
      `${DIST_TAGS_URL} -> 500 Internal Server Error`
    );
  });

  it('throws listing the available dist-tags when the requested one is missing', async () => {
    const fetchMock = routedFetchMock({ distTags: { beta: '1.0.0-beta.1' } });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('latest')).rejects.toThrow(
      'npm has no "latest" dist-tag for "supabase"; available dist-tags: beta'
    );
  });

  it('throws when the dist-tag value is not a valid version string', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: 'not-a-version' },
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('latest')).rejects.toThrow(
      /did not have a valid "latest" version/
    );
  });

  it('treats an array dist-tags response as invalid rather than a record', async () => {
    const fetchMock = routedFetchMock({ distTags: ['not', 'a', 'record'] });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('latest')).rejects.toThrow(
      /were not a JSON object/
    );
  });

  it('memoises a successful resolution so a second call does not refetch', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '1.3.0-beta.1' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('latest')).resolves.toBe('1.2.3');
    await expect(resolveCliDistTag('latest')).resolves.toBe('1.2.3');

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
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('latest')).rejects.toThrow('500');
    await expect(resolveCliDistTag('latest')).resolves.toBe('1.2.3');
    // A third call must still hit the cache populated by the successful
    // retry — the rejected first promise's cleanup must not evict it.
    await expect(resolveCliDistTag('latest')).resolves.toBe('1.2.3');

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not let a beta rejection clear the latest cache entry', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return headResponse(true);
      if (url === DIST_TAGS_URL) {
        return jsonResponse({ latest: '1.2.3', beta: 'not-a-version' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('latest')).resolves.toBe('1.2.3');
    await expect(resolveCliDistTag('beta')).rejects.toThrow(
      /did not have a valid "beta" version/
    );
    await expect(resolveCliDistTag('latest')).resolves.toBe('1.2.3');

    // Two dist-tags GETs (latest, beta) + two HEAD (latest's amd64+arm64
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
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('beta')).resolves.toBe('2.118.0-beta.51');

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
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('beta')).resolves.toBe('2.118.0-beta.60');
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
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('beta')).resolves.toBe('2.118.0-beta.10');

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
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('beta')).resolves.toBe('2.118.0-beta.49');
  });

  it('aborts the walk-back and propagates when a candidate probe throws, rather than continuing to the next candidate', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        if (url.includes('2.118.0-beta.52')) return headResponse(false);
        if (url.includes('2.118.0-beta.51')) {
          return headResponse(false, 500, 'Internal Server Error');
        }
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
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('beta')).rejects.toThrow(
      /2\.118\.0-beta\.51.*-> 500 Internal Server Error/
    );

    const headUrls = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'HEAD')
      .map(([url]) => url);
    // beta.50 is never probed — the throw on beta.51 aborts the walk-back.
    expect(headUrls).toEqual([
      cliDebUrl('2.118.0-beta.52', 'amd64'),
      cliDebUrl('2.118.0-beta.52', 'arm64'),
      cliDebUrl('2.118.0-beta.51', 'amd64'),
      cliDebUrl('2.118.0-beta.51', 'arm64'),
    ]);
  });

  it('advances to the second walk-back candidate when the first is a 404', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '2.118.0-beta.52' },
      assetOk: (version) => version === '2.118.0-beta.50',
      packument: {
        versions: {
          '2.118.0-beta.52': {},
          '2.118.0-beta.51': {},
          '2.118.0-beta.50': {},
        },
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('beta')).resolves.toBe('2.118.0-beta.50');

    const headUrls = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'HEAD')
      .map(([url]) => url);
    expect(headUrls).toEqual([
      cliDebUrl('2.118.0-beta.52', 'amd64'),
      cliDebUrl('2.118.0-beta.52', 'arm64'),
      cliDebUrl('2.118.0-beta.51', 'amd64'),
      cliDebUrl('2.118.0-beta.51', 'arm64'),
      cliDebUrl('2.118.0-beta.50', 'amd64'),
      cliDebUrl('2.118.0-beta.50', 'arm64'),
    ]);
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
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('beta')).rejects.toThrow();

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
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('beta')).rejects.toThrow(
      /2\.118\.0-beta\.52.*2\.118\.0-beta\.51/
    );
  });

  it('throws instead of guessing when the latest dist-tag asset is a 404', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '1.3.0-beta.1' },
      assetOk: () => false,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('latest')).rejects.toThrow(
      'checked amd64 and arm64 .deb assets at ' +
        'https://github.com/supabase/cli/releases/tag/v1.2.3'
    );
  });

  it('throws instead of walking back when a non-beta-shaped dist-tag asset is a 404', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', next: '3.0.0-next.2' },
      assetOk: () => false,
      packument: {
        versions: { '3.0.0-next.2': {}, '3.0.0-next.1': {} },
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('next')).rejects.toThrow(
      `npm's "next" dist-tag for "supabase" points at 3.0.0-next.2, but its ` +
        'release asset is missing (checked amd64 and arm64 .deb assets at ' +
        'https://github.com/supabase/cli/releases/tag/v3.0.0-next.2)'
    );

    expect(fetchMock.mock.calls.some(([url]) => url === PACKUMENT_URL)).toBe(
      false
    );
  });

  it('throws naming the URL and status when the dist-tag asset HEAD is a GitHub error, without fetching the packument', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return url.includes('_amd64')
          ? headResponse(false, 500, 'Internal Server Error')
          : headResponse(true);
      }
      if (url === DIST_TAGS_URL) {
        return jsonResponse({ latest: '1.2.3', beta: '2.118.0-beta.52' });
      }
      if (url === PACKUMENT_URL) {
        throw new Error('packument must not be fetched');
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('beta')).rejects.toThrow(
      `${cliDebUrl('2.118.0-beta.52', 'amd64')} -> 500 Internal Server Error`
    );

    expect(fetchMock.mock.calls.some(([url]) => url === PACKUMENT_URL)).toBe(
      false
    );
  });

  it('resolves an arbitrary dist-tag name', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', canary: '1.4.0-canary.7' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('canary')).resolves.toBe('1.4.0-canary.7');
  });

  it('throws without fetching when the dist-tag name is invalid', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('1bad tag')).rejects.toThrow(
      /neither an exact Supabase CLI version nor a valid npm dist-tag name/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('walks back a beta-shaped version even when the dist-tag is not named beta', async () => {
    const fetchMock = routedFetchMock({
      distTags: { canary: '2.118.0-beta.52' },
      assetOk: (version) => version === '2.118.0-beta.51',
      packument: {
        versions: { '2.118.0-beta.52': {}, '2.118.0-beta.51': {} },
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('canary')).resolves.toBe('2.118.0-beta.51');
  });

  it('throws instead of walking back a missing asset that is not beta-shaped, even on the beta dist-tag', async () => {
    const fetchMock = routedFetchMock({
      distTags: { beta: '1.4.0-rc.2' },
      assetOk: () => false,
      packument: { versions: { '1.4.0-rc.2': {} } },
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliDistTag } = await import('../src/cli-channel.js');

    await expect(resolveCliDistTag('beta')).rejects.toThrow(
      `npm's "beta" dist-tag for "supabase" points at 1.4.0-rc.2, but its release asset is missing`
    );
    expect(fetchMock.mock.calls.some(([url]) => url === PACKUMENT_URL)).toBe(
      false
    );
  });

  describe(PINS_ENV, () => {
    it('uses a pinned version without touching the network and strips a leading v', async () => {
      process.env[PINS_ENV] = JSON.stringify({ latest: 'v9.9.9' });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const { resolveCliDistTag } = await import('../src/cli-channel.js');

      await expect(resolveCliDistTag('latest')).resolves.toBe('9.9.9');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('only pins the tags it names and resolves the rest from npm', async () => {
      process.env[PINS_ENV] = JSON.stringify({ latest: '9.9.9' });
      const fetchMock = routedFetchMock({
        distTags: { latest: '1.2.3', beta: '1.3.0-beta.1' },
        assetOk: () => true,
      });
      vi.stubGlobal('fetch', fetchMock);
      const { resolveCliDistTag } = await import('../src/cli-channel.js');

      await expect(resolveCliDistTag('latest')).resolves.toBe('9.9.9');
      await expect(resolveCliDistTag('beta')).resolves.toBe('1.3.0-beta.1');
    });

    it('treats a blank or whitespace-only value as unset', async () => {
      process.env[PINS_ENV] = '   ';
      const fetchMock = routedFetchMock({
        distTags: { latest: '1.2.3' },
        assetOk: () => true,
      });
      vi.stubGlobal('fetch', fetchMock);
      const { resolveCliDistTag } = await import('../src/cli-channel.js');

      await expect(resolveCliDistTag('latest')).resolves.toBe('1.2.3');
    });

    it.each([
      ['malformed JSON', '{not json', /is not valid JSON/],
      ['a non-object', '["9.9.9"]', /must be a JSON object/],
      [
        'an invalid version',
        JSON.stringify({ latest: 'not-a-version' }),
        /pins "latest" to "not-a-version", which is not a valid Supabase CLI version/,
      ],
    ])('throws for %s', async (_name, value, message) => {
      process.env[PINS_ENV] = value;
      vi.stubGlobal('fetch', vi.fn());
      const { resolveCliDistTag } = await import('../src/cli-channel.js');

      await expect(resolveCliDistTag('latest')).rejects.toThrow(message);
    });
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

  it('strips a leading v from an exact version', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionOption } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionOption('v2.109.1')).resolves.toBe('2.109.1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves a "latest" dist-tag against npm', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '1.3.0-beta.1' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionOption } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionOption('latest')).resolves.toBe('1.2.3');
  });

  it('resolves an arbitrary dist-tag against npm', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', canary: '1.4.0-canary.7' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionOption } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionOption('canary')).resolves.toBe(
      '1.4.0-canary.7'
    );
  });

  it('throws listing the available dist-tags for an unknown tag', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '1.3.0-beta.1' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionOption } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionOption('canary')).rejects.toThrow(
      'npm has no "canary" dist-tag for "supabase"; available dist-tags: latest, beta'
    );
  });
});

describe('isExactCliVersion', () => {
  it.each(['2.109.1', 'v2.109.1', '2.118.0-beta.5', '1.4.0-rc.2'])(
    'accepts %s',
    async (value) => {
      const { isExactCliVersion } = await import('../src/cli-channel.js');
      expect(isExactCliVersion(value)).toBe(true);
    }
  );

  it.each(['latest', 'beta', 'next', 'canary', 'v1', '1.2'])(
    'rejects %s',
    async (value) => {
      const { isExactCliVersion } = await import('../src/cli-channel.js');
      expect(isExactCliVersion(value)).toBe(false);
    }
  );
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
