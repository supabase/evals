/**
 * Resolves "latest stable"/"latest beta" Supabase CLI versions from npm's
 * dist-tags. npm can point at a still-draft release with no downloadable
 * asset, so the resolved version's `.deb` is verified first.
 */

import { isRecord } from '@supabase-evals/core/json';

export type CliChannel = 'stable' | 'beta';

const NPM_DIST_TAGS_URL =
  'https://registry.npmjs.org/-/package/supabase/dist-tags';

// Makes npm return the abbreviated packument instead of the full one.
const NPM_PACKUMENT_URL = 'https://registry.npmjs.org/supabase';
const NPM_INSTALL_V1_ACCEPT = 'application/vnd.npm.install-v1+json';

// npm's beta dist-tag can carry a prerelease suffix like -rc.1, not just -beta.N.
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

// Only the -beta.N shape has a defined ordering the walk-back below can search.
const BETA_SUFFIX_RE = /^\d+\.\d+\.\d+-beta\.\d+$/;

// Feeds compareBetaVersionsDesc's numeric comparison; matches any version, unlike BETA_SUFFIX_RE.
const BETA_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;

// Caps the walk-back so a broken release can't chain into unbounded GitHub requests.
const MAX_BETA_FALLBACK_CANDIDATES = 5;

const ENV_OVERRIDE: Record<CliChannel, string> = {
  stable: 'SUPABASE_CLI_STABLE_VERSION',
  beta: 'SUPABASE_CLI_BETA_VERSION',
};

const DIST_TAG: Record<CliChannel, string> = {
  stable: 'latest',
  beta: 'beta',
};

const versionCache = new Map<CliChannel, Promise<string>>();

const CLI_CHANNELS = new Set<CliChannel>(['stable', 'beta']);

export function isCliChannel(value: string): value is CliChannel {
  return CLI_CHANNELS.has(value as CliChannel);
}

/** Must match the download URL installSupabaseCli() uses in supabase.ts. */
export function cliDebUrl(version: string, arch: 'amd64' | 'arm64'): string {
  return `https://github.com/supabase/cli/releases/download/v${version}/supabase_${version}_linux_${arch}.deb`;
}

/** GitHub release page for a version, used in error messages. */
function releaseTagUrl(version: string): string {
  return `https://github.com/supabase/cli/releases/tag/v${version}`;
}

/** Only a 404 means the asset is absent; any other non-2xx (e.g. a GitHub 429/5xx) is an error, not a missing-asset signal. */
async function debAssetHeadOk(url: string): Promise<boolean> {
  const response = await fetch(url, {
    method: 'HEAD',
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.ok) return true;
  if (response.status === 404) return false;
  throw new Error(`HEAD ${url} -> ${response.status} ${response.statusText}`);
}

/** HEAD-checks both the amd64 and arm64 `.deb` assets, since the resolver's host architecture need not match the sandbox's. */
async function debAssetExists(version: string): Promise<boolean> {
  const [amd64, arm64] = await Promise.all([
    debAssetHeadOk(cliDebUrl(version, 'amd64')),
    debAssetHeadOk(cliDebUrl(version, 'arm64')),
  ]);
  return amd64 && arm64;
}

/**
 * Resolves a channel to a concrete CLI version, memoised per channel for the
 * process lifetime. A rejection clears the cache entry so the next call
 * retries; never falls back to the pinned SUPABASE_CLI_VERSION, since that
 * would silently mislabel data.
 */
export async function resolveCliVersion(channel: CliChannel): Promise<string> {
  const cached = versionCache.get(channel);
  if (cached) return cached;

  const promise = resolveCliVersionUncached(channel);
  versionCache.set(channel, promise);
  promise.catch(() => {
    if (versionCache.get(channel) === promise) versionCache.delete(channel);
  });
  return promise;
}

/** Resolves `value`: a channel tag (`'stable'` | `'beta'`) resolves against npm; an exact version or `undefined` passes through unchanged. */
export async function resolveCliVersionOption(
  value: string | CliChannel | undefined
): Promise<string | undefined> {
  if (value === undefined) return undefined;
  return isCliChannel(value) ? resolveCliVersion(value) : value;
}

async function resolveCliVersionUncached(channel: CliChannel): Promise<string> {
  const envVar = ENV_OVERRIDE[channel];
  const override = process.env[envVar]?.trim().replace(/^v/, '');
  if (override) {
    if (!VERSION_RE.test(override)) {
      throw new Error(
        `${envVar}=${JSON.stringify(override)} is not a valid Supabase CLI version`
      );
    }
    // An explicit pin is trusted as-is — no asset check, network or otherwise.
    return override;
  }

  const response = await fetch(NPM_DIST_TAGS_URL, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `failed to resolve the latest ${channel} Supabase CLI version: ` +
        `GET ${NPM_DIST_TAGS_URL} -> ${response.status} ${response.statusText}`
    );
  }
  const tags = await response.json();
  const distTag = DIST_TAG[channel];
  const version = isRecord(tags) ? tags[distTag] : undefined;
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error(
      `npm dist-tags for "supabase" did not have a valid "${distTag}" version ` +
        `for the ${channel} channel: ${JSON.stringify(version)}`
    );
  }

  // A transient failure here throws rather than silently walking back to an
  // older beta (or never walking back, for stable).
  if (await debAssetExists(version)) return version;

  // npm's dist-tag can point at a version whose GitHub release is still a
  // draft with no downloadable .deb. Only beta walks back to an older
  // published version; stable is never guessed at.
  if (channel === 'stable') {
    throw new Error(
      `npm's "latest" dist-tag for "supabase" points at ${version}, but its ` +
        `release asset is missing (checked amd64 and arm64 .deb assets at ` +
        `${releaseTagUrl(version)})`
    );
  }

  return resolveFallbackBetaVersion(version);
}

/**
 * Walks back through published `X.Y.Z-beta.N` versions strictly older than
 * `unpublishedVersion`, newest first, for one with a downloadable `.deb`.
 * Newer candidates are skipped too (likelier to be drafts). Only a 404
 * advances to the next candidate; any other probe error aborts the
 * walk-back, since it means GitHub is unhealthy rather than that the
 * candidate is absent.
 */
async function resolveFallbackBetaVersion(
  unpublishedVersion: string
): Promise<string> {
  if (!BETA_SUFFIX_RE.test(unpublishedVersion)) {
    throw new Error(
      `npm's "beta" dist-tag for "supabase" points at ${unpublishedVersion}, ` +
        `whose release asset is missing (checked amd64 and arm64 .deb assets ` +
        `at ${releaseTagUrl(unpublishedVersion)}), and its version does not ` +
        'match the X.Y.Z-beta.N shape this fallback can walk back through'
    );
  }

  const response = await fetch(NPM_PACKUMENT_URL, {
    headers: { Accept: NPM_INSTALL_V1_ACCEPT },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `failed to look up published beta versions for "supabase": ` +
        `GET ${NPM_PACKUMENT_URL} -> ${response.status} ${response.statusText}`
    );
  }
  const packument = await response.json();
  const versions = isRecord(packument) ? packument.versions : undefined;
  if (!isRecord(versions)) {
    throw new Error(
      `npm packument for "supabase" did not include a "versions" object`
    );
  }

  const candidates = Object.keys(versions)
    .filter((candidate) => BETA_VERSION_RE.test(candidate))
    .filter(
      (candidate) => compareBetaVersionsDesc(candidate, unpublishedVersion) > 0
    )
    .sort(compareBetaVersionsDesc)
    .slice(0, MAX_BETA_FALLBACK_CANDIDATES);

  for (const candidate of candidates) {
    if (await debAssetExists(candidate)) return candidate;
  }

  throw new Error(
    `no published beta Supabase CLI release has a downloadable .deb asset; ` +
      `checked ${[unpublishedVersion, ...candidates].join(', ')} via ` +
      `${NPM_PACKUMENT_URL}`
  );
}

function parseBetaVersion(
  version: string
): [major: number, minor: number, patch: number, beta: number] | undefined {
  const match = BETA_VERSION_RE.exec(version);
  if (!match) return undefined;
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
  ];
}

/**
 * Orders two `X.Y.Z-beta.N` versions newest-first, usable as an
 * `Array#sort` comparator; compares components numerically so `beta.10`
 * sorts ahead of `beta.9`. Throws if either string isn't parseable.
 */
export function compareBetaVersionsDesc(a: string, b: string): number {
  const tupleA = parseBetaVersion(a);
  const tupleB = parseBetaVersion(b);
  if (!tupleA || !tupleB) {
    throw new Error(
      `compareBetaVersionsDesc expected "X.Y.Z-beta.N" versions, got ${JSON.stringify(a)} and ${JSON.stringify(b)}`
    );
  }
  for (let index = 0; index < tupleA.length; index += 1) {
    if (tupleA[index] !== tupleB[index]) return tupleB[index] - tupleA[index];
  }
  return 0;
}
