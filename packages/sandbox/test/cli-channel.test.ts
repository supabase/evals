import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cliDebUrl } from '../src/cli-channel.js';

const PINS_ENV = 'SUPABASE_CLI_VERSION_PINS';
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
 * calls resolveCliVersionSpec makes.
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

function packument(latest: string, versions: string[]) {
  return {
    'dist-tags': { latest },
    versions: Object.fromEntries(versions.map((version) => [version, {}])),
  };
}

function urlsOf(
  fetchMock: ReturnType<typeof routedFetchMock>,
  method: 'GET' | 'HEAD'
): string[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init?.method ?? 'GET') === method)
    .map(([url]) => url);
}

beforeEach(() => {
  vi.resetModules();
  delete process.env[PINS_ENV];
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[PINS_ENV];
});

describe('resolveCliVersionSpec', () => {
  it('resolves the "latest" dist-tag when its asset exists', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '1.3.0-beta.1' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionSpec('latest')).resolves.toBe('1.2.3');

    expect(urlsOf(fetchMock, 'HEAD')).toEqual([
      cliDebUrl('1.2.3', 'amd64'),
      cliDebUrl('1.2.3', 'arm64'),
    ]);
  });

  it('resolves the "beta" and "next" dist-tags', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '1.3.0-beta.1', next: '3.0.0-next.2' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionSpec('beta')).resolves.toBe('1.3.0-beta.1');
    await expect(resolveCliVersionSpec('next')).resolves.toBe('3.0.0-next.2');
  });

  it('resolves an arbitrary dist-tag name', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', canary: '1.4.0-canary.7' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionSpec('canary')).resolves.toBe(
      '1.4.0-canary.7'
    );
  });

  it('passes an exact version through without touching the network, stripping a leading v', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionSpec('2.109.1')).resolves.toBe('2.109.1');
    await expect(resolveCliVersionSpec('v2.109.1')).resolves.toBe('2.109.1');
    expect(fetchMock).not.toHaveBeenCalled();
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
    const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionSpec('latest')).rejects.toThrow(
      `${DIST_TAGS_URL} -> 500 Internal Server Error`
    );
  });

  it('throws listing the available dist-tags when the requested one is missing', async () => {
    const fetchMock = routedFetchMock({ distTags: { beta: '1.0.0-beta.1' } });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionSpec('latest')).rejects.toThrow(
      'npm has no "latest" dist-tag for "supabase"; available dist-tags: beta'
    );
  });

  it('does not resolve a spec named after a prototype member', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionSpec('constructor')).rejects.toThrow(
      'npm has no "constructor" dist-tag for "supabase"; available dist-tags: latest'
    );
    await expect(resolveCliVersionSpec('toString')).rejects.toThrow(
      'npm has no "toString" dist-tag'
    );
  });

  it('throws when the dist-tag value is not a valid version string', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: 'not-a-version' },
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionSpec('latest')).rejects.toThrow(
      /did not have a valid "latest" version/
    );
  });

  it('treats an array dist-tags response as invalid rather than a record', async () => {
    const fetchMock = routedFetchMock({ distTags: ['not', 'a', 'record'] });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionSpec('latest')).rejects.toThrow(
      /were not a JSON object/
    );
  });

  it('throws without fetching when the spec is neither a version, range nor dist-tag name', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionSpec('1bad tag')).rejects.toThrow(
      /not an exact Supabase CLI version, a semver range, or a valid npm dist-tag name/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty spec instead of reading it as the "*" range', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionSpec('')).rejects.toThrow(
      /not an exact Supabase CLI version, a semver range, or a valid npm dist-tag name/
    );
    await expect(resolveCliVersionSpec('  ')).rejects.toThrow(
      /not an exact Supabase CLI version/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('memoises a successful resolution so a second call does not refetch', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '1.3.0-beta.1' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionSpec('latest')).resolves.toBe('1.2.3');
    await expect(resolveCliVersionSpec('latest')).resolves.toBe('1.2.3');

    // One GET (dist-tags) + two HEAD (amd64+arm64 asset check).
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
    const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionSpec('latest')).rejects.toThrow('500');
    await expect(resolveCliVersionSpec('latest')).resolves.toBe('1.2.3');
    await expect(resolveCliVersionSpec('latest')).resolves.toBe('1.2.3');

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not let a beta rejection clear the latest cache entry', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: 'not-a-version' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionSpec('latest')).resolves.toBe('1.2.3');
    await expect(resolveCliVersionSpec('beta')).rejects.toThrow(
      /did not have a valid "beta" version/
    );
    await expect(resolveCliVersionSpec('latest')).resolves.toBe('1.2.3');
  });

  it('fetches the dist-tags once across multiple specs', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3', beta: '1.3.0-beta.1', next: '3.0.0-next.2' },
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

    await Promise.all(
      ['latest', 'beta', 'next'].map((spec) => resolveCliVersionSpec(spec))
    );

    expect(urlsOf(fetchMock, 'GET')).toEqual([DIST_TAGS_URL]);
  });

  describe('missing release asset', () => {
    it.each([
      ['latest', { latest: '1.2.3' }, '1.2.3'],
      ['next', { next: '3.0.0-next.2' }, '3.0.0-next.2'],
      ['beta', { beta: '2.118.0-beta.52' }, '2.118.0-beta.52'],
    ])(
      'throws for the %s dist-tag without walking back to another version',
      async (spec, distTags, version) => {
        const fetchMock = routedFetchMock({
          distTags,
          assetOk: () => false,
          packument: packument(version, [version, '2.118.0-beta.51']),
        });
        vi.stubGlobal('fetch', fetchMock);
        const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

        await expect(resolveCliVersionSpec(spec)).rejects.toThrow(
          `"${spec}" resolves to supabase@${version}, but its release asset is missing ` +
            `(checked amd64 and arm64 .deb assets at https://github.com/supabase/cli/releases/tag/v${version})`
        );

        expect(urlsOf(fetchMock, 'GET')).toEqual([DIST_TAGS_URL]);
        expect(urlsOf(fetchMock, 'HEAD')).toEqual([
          cliDebUrl(version, 'amd64'),
          cliDebUrl(version, 'arm64'),
        ]);
      }
    );

    it('throws naming the URL and status when the asset HEAD is a GitHub error', async () => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'HEAD') {
          return url.includes('_amd64')
            ? headResponse(false, 500, 'Internal Server Error')
            : headResponse(true);
        }
        if (url === DIST_TAGS_URL) {
          return jsonResponse({ beta: '2.118.0-beta.52' });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

      await expect(resolveCliVersionSpec('beta')).rejects.toThrow(
        `${cliDebUrl('2.118.0-beta.52', 'amd64')} -> 500 Internal Server Error`
      );
    });

    it('throws for a range that resolves to a version without an asset', async () => {
      const fetchMock = routedFetchMock({
        packument: packument('2.121.0', ['2.121.0']),
        assetOk: () => false,
      });
      vi.stubGlobal('fetch', fetchMock);
      const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

      await expect(resolveCliVersionSpec('^2.120.0')).rejects.toThrow(
        '"^2.120.0" resolves to supabase@2.121.0, but its release asset is missing'
      );
    });
  });

  describe('semver ranges', () => {
    it('picks the latest dist-tag when it satisfies the range', async () => {
      const fetchMock = routedFetchMock({
        packument: packument('2.121.0', [
          '2.119.0',
          '2.120.0',
          '2.121.0',
          '2.121.1',
        ]),
        assetOk: () => true,
      });
      vi.stubGlobal('fetch', fetchMock);
      const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

      await expect(resolveCliVersionSpec('^2.120.0')).resolves.toBe('2.121.0');

      const packumentCall = fetchMock.mock.calls.find(
        ([url]) => url === PACKUMENT_URL
      );
      expect(packumentCall?.[1]?.headers).toMatchObject({
        Accept: INSTALL_V1_ACCEPT,
      });
      expect(urlsOf(fetchMock, 'HEAD')).toEqual([
        cliDebUrl('2.121.0', 'amd64'),
        cliDebUrl('2.121.0', 'arm64'),
      ]);
    });

    it('falls back to the highest satisfying version when latest is outside the range', async () => {
      const fetchMock = routedFetchMock({
        packument: packument('3.0.0', [
          '2.119.0',
          '2.120.0',
          '2.121.0',
          '2.120.5',
          '3.0.0',
        ]),
        assetOk: () => true,
      });
      vi.stubGlobal('fetch', fetchMock);
      const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

      await expect(resolveCliVersionSpec('^2.120.0')).resolves.toBe('2.121.0');
    });

    it('excludes prereleases from a plain range, including a prerelease latest', async () => {
      const fetchMock = routedFetchMock({
        packument: packument('2.122.0-rc.1', [
          '2.120.0',
          '2.121.0',
          '2.122.0-beta.1',
          '2.122.0-rc.1',
        ]),
        assetOk: () => true,
      });
      vi.stubGlobal('fetch', fetchMock);
      const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

      await expect(resolveCliVersionSpec('^2.120.0')).resolves.toBe('2.121.0');
    });

    it('throws naming the spec when nothing satisfies the range', async () => {
      const fetchMock = routedFetchMock({
        packument: packument('2.121.0', ['2.120.0', '2.121.0']),
        assetOk: () => true,
      });
      vi.stubGlobal('fetch', fetchMock);
      const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

      await expect(resolveCliVersionSpec('^9.0.0')).rejects.toThrow(
        'no published "supabase" version on npm satisfies "^9.0.0"'
      );
      expect(urlsOf(fetchMock, 'HEAD')).toEqual([]);
    });

    it('throws when the packument has no versions object', async () => {
      const fetchMock = routedFetchMock({ packument: {} });
      vi.stubGlobal('fetch', fetchMock);
      const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

      await expect(resolveCliVersionSpec('^2.120.0')).rejects.toThrow(
        /did not include a "versions" object/
      );
    });

    it('fetches the packument once across multiple range specs', async () => {
      const fetchMock = routedFetchMock({
        packument: packument('2.121.0', ['1.5.0', '2.120.0', '2.121.0']),
        assetOk: () => true,
      });
      vi.stubGlobal('fetch', fetchMock);
      const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

      await expect(
        Promise.all([
          resolveCliVersionSpec('^2.120.0'),
          resolveCliVersionSpec('^1.0.0'),
          resolveCliVersionSpec('>=2'),
        ])
      ).resolves.toEqual(['2.121.0', '1.5.0', '2.121.0']);

      expect(urlsOf(fetchMock, 'GET')).toEqual([PACKUMENT_URL]);
    });
  });

  describe(PINS_ENV, () => {
    it('uses a pinned version without touching the network and strips a leading v', async () => {
      process.env[PINS_ENV] = JSON.stringify({ latest: 'v9.9.9' });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

      await expect(resolveCliVersionSpec('latest')).resolves.toBe('9.9.9');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('pins a range spec', async () => {
      process.env[PINS_ENV] = JSON.stringify({ '^2.120.0': '2.121.0' });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

      await expect(resolveCliVersionSpec('^2.120.0')).resolves.toBe('2.121.0');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('only pins the specs it names and resolves the rest from npm', async () => {
      process.env[PINS_ENV] = JSON.stringify({ latest: '9.9.9' });
      const fetchMock = routedFetchMock({
        distTags: { latest: '1.2.3', beta: '1.3.0-beta.1' },
        assetOk: () => true,
      });
      vi.stubGlobal('fetch', fetchMock);
      const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

      await expect(resolveCliVersionSpec('latest')).resolves.toBe('9.9.9');
      await expect(resolveCliVersionSpec('beta')).resolves.toBe('1.3.0-beta.1');
      await expect(resolveCliVersionSpec('toString')).rejects.toThrow(
        'npm has no "toString" dist-tag'
      );
    });

    it('treats a blank or whitespace-only value as unset', async () => {
      process.env[PINS_ENV] = '   ';
      const fetchMock = routedFetchMock({
        distTags: { latest: '1.2.3' },
        assetOk: () => true,
      });
      vi.stubGlobal('fetch', fetchMock);
      const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

      await expect(resolveCliVersionSpec('latest')).resolves.toBe('1.2.3');
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
      const { resolveCliVersionSpec } = await import('../src/cli-channel.js');

      await expect(resolveCliVersionSpec('latest')).rejects.toThrow(message);
    });
  });
});

describe('resolveCliVersionOption', () => {
  it('passes undefined through unchanged, without touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionOption } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionOption(undefined)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes an exact version through unchanged, without touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionOption } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionOption('2.109.1')).resolves.toBe('2.109.1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves a dist-tag and a range against npm', async () => {
    const fetchMock = routedFetchMock({
      distTags: { latest: '1.2.3' },
      packument: packument('1.2.3', ['1.2.3']),
      assetOk: () => true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveCliVersionOption } = await import('../src/cli-channel.js');

    await expect(resolveCliVersionOption('latest')).resolves.toBe('1.2.3');
    await expect(resolveCliVersionOption('^1.0.0')).resolves.toBe('1.2.3');
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

  it.each(['latest', 'beta', 'next', 'canary', 'v1', '1.2', '^2.120.0'])(
    'rejects %s',
    async (value) => {
      const { isExactCliVersion } = await import('../src/cli-channel.js');
      expect(isExactCliVersion(value)).toBe(false);
    }
  );
});
