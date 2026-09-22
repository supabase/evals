/**
 * Resolves "latest stable" / "latest beta" Supabase CLI versions from npm's
 * dist-tags for the `supabase` package — no auth, no rate-limit exposure
 * (unlike the GitHub releases API), which matters because CI's sandbox only
 * forwards the model API keys, never a GITHUB_TOKEN.
 *
 * npm's dist-tag can point at a version whose GitHub release is still a
 * draft, so the resolved version's `.deb` release asset is HEAD-checked
 * before being trusted; for the beta channel only, a missing asset walks
 * back through older published `-beta.N` versions for one that downloads
 * (see resolveFallbackBetaVersion). A stable dist-tag with a missing asset
 * always throws instead — guessing at a "stable" release would defeat the
 * point of the channel.
 */

import { isRecord } from '@supabase-evals/core/json';

export type CliChannel = 'stable' | 'beta';

const NPM_DIST_TAGS_URL =
  'https://registry.npmjs.org/-/package/supabase/dist-tags';

// Abbreviated packument (versions + dist-tags only, no changelogs/READMEs) —
// this header is what makes npm serve the small form instead of the full one.
const NPM_PACKUMENT_URL = 'https://registry.npmjs.org/supabase';
const NPM_INSTALL_V1_ACCEPT = 'application/vnd.npm.install-v1+json';

// npm's beta dist-tag can carry a prerelease suffix like -rc.1, not just -beta.N.
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

// Only the -beta.N shape is walkable for the "try an older published beta"
// fallback below; a -rc.N or other prerelease suffix has no defined ordering
// we can search.
const BETA_SUFFIX_RE = /^\d+\.\d+\.\d+-beta\.\d+$/;

// Matches any published "X.Y.Z-beta.N" version (any major/minor/patch),
// captured for the numeric tuple comparison in compareBetaVersionsDesc —
// unlike BETA_SUFFIX_RE, it isn't anchored to one specific version's prefix.
const BETA_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;

// The number of older published beta versions to probe for a downloadable
// asset before giving up — keeps a broken release from turning one nightly
// run into an unbounded chain of GitHub requests.
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

/** Whether `value` names a channel (`'stable'` | `'beta'`) rather than an exact version. */
export function isCliChannel(value: string): value is CliChannel {
  return CLI_CHANNELS.has(value as CliChannel);
}

/** Mirrors installSupabaseCli's download URL template in packages/sandbox/src/supabase.ts. */
export function cliDebUrl(version: string, arch: 'amd64' | 'arm64'): string {
  return `https://github.com/supabase/cli/releases/download/v${version}/supabase_${version}_linux_${arch}.deb`;
}

/** The GitHub release page for a version, named in errors instead of a single arch's asset URL. */
function releaseTagUrl(version: string): string {
  return `https://github.com/supabase/cli/releases/tag/v${version}`;
}

async function debAssetHeadOk(url: string): Promise<boolean> {
  const response = await fetch(url, {
    method: 'HEAD',
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  return response.ok;
}

/**
 * HEAD-checks that a release's `.deb` assets are actually downloadable (not
 * behind a draft release) for both architectures the sandbox installs onto —
 * the host running this resolver and the sandbox container it targets can
 * differ (e.g. an Apple Silicon host building a linux/amd64 sandbox image),
 * so checking only one arch could pass while the other 404s. This also
 * catches a partially-uploaded release that a single-arch probe would miss.
 * Two HEAD requests per candidate, capped at MAX_BETA_FALLBACK_CANDIDATES
 * candidates in the walk-back below, is an acceptable request budget.
 */
async function debAssetExists(version: string): Promise<boolean> {
  const [amd64, arm64] = await Promise.all([
    debAssetHeadOk(cliDebUrl(version, 'amd64')),
    debAssetHeadOk(cliDebUrl(version, 'arm64')),
  ]);
  return amd64 && arm64;
}

/**
 * Resolve a channel to a concrete Supabase CLI version. Memoised per channel
 * so a single nightly run only hits the registry once per channel; the cache
 * entry is cleared on rejection so a later retry can hit the network again —
 * guarded by an identity check so a stale rejection can never evict a
 * different (newer) promise that has since taken its place in the cache.
 * Never falls back to the pinned SUPABASE_CLI_VERSION on failure — that would
 * silently mislabel data — so callers must let the throw propagate.
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

/**
 * Resolves `value` if it names a channel (`'stable'` | `'beta'`); an exact
 * version (or `undefined`) passes through unchanged. Split out from
 * localStackRuntime's startSession so the branching itself is unit-testable
 * without booting a sandbox.
 */
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

  // Deliberately not caught: a transient failure here (DNS blip, timeout)
  // must throw loud rather than silently walk back to an older beta, or
  // (for stable) never walk back at all.
  if (await debAssetExists(version)) return version;

  // The dist-tag pointed at a version whose GitHub release has no
  // downloadable .deb (e.g. still a draft) — this is exactly what broke the
  // beta channel in CI run 35274970438. A stable release is never guessed at;
  // only beta walks back to the newest published version that does have one.
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
 * Walks back through every published npm version matching the `X.Y.Z-beta.N`
 * shape that is strictly older than `unpublishedVersion` — not just versions
 * sharing its exact minor — newest first, and returns the first one whose
 * release `.deb` assets actually download. This lets a brand-new minor's
 * first beta (e.g. `2.119.0-beta.1`, still a draft) fall back across the
 * minor boundary to the previous minor's newest published beta (e.g.
 * `2.118.0-beta.60`). A candidate newer than `unpublishedVersion` is never
 * considered — if npm's dist-tag skipped it, it's likelier to be a draft too.
 *
 * A transient error probing one candidate (network blip, timeout) is logged
 * and skipped rather than aborting the whole walk-back, so one bad candidate
 * doesn't waste the rest of the probe budget.
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
    try {
      if (await debAssetExists(candidate)) return candidate;
    } catch (error) {
      console.warn(
        `[cli-channel] beta fallback candidate ${candidate} could not be checked, skipping: ` +
          (error instanceof Error ? error.message : String(error))
      );
    }
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
 * Orders two "X.Y.Z-beta.N" version strings newest-first — usable directly as
 * an `Array#sort` comparator for descending order. Compares each component
 * numerically so e.g. `2.118.0-beta.10` correctly sorts ahead of
 * `2.118.0-beta.9`; a plain string compare would invert that. Throws if
 * either string isn't a parseable `X.Y.Z-beta.N` version.
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
