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
const BETA_SUFFIX_RE = /^(\d+\.\d+\.\d+-beta\.)(\d+)$/;

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

function isCliChannel(value: string): value is CliChannel {
  return CLI_CHANNELS.has(value as CliChannel);
}

/** Arch suffix the CLI's own release `.deb` filenames use. */
export function hostDebArch(): 'amd64' | 'arm64' {
  return process.arch === 'arm64' ? 'arm64' : 'amd64';
}

/** Mirrors installSupabaseCli's download URL template in packages/sandbox/src/supabase.ts. */
export function cliDebUrl(
  version: string,
  arch: 'amd64' | 'arm64' = hostDebArch()
): string {
  return `https://github.com/supabase/cli/releases/download/v${version}/supabase_${version}_linux_${arch}.deb`;
}

/** HEAD-checks that a release's `.deb` asset is actually downloadable (not behind a draft release). */
async function debAssetExists(version: string): Promise<boolean> {
  const response = await fetch(cliDebUrl(version), {
    method: 'HEAD',
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  return response.ok;
}

/**
 * Resolve a channel to a concrete Supabase CLI version. Memoised per channel
 * so a single nightly run only hits the registry once per channel; the cache
 * entry is cleared on rejection so a later retry can hit the network again.
 * Never falls back to the pinned SUPABASE_CLI_VERSION on failure — that would
 * silently mislabel data — so callers must let the throw propagate.
 */
export async function resolveCliVersion(channel: CliChannel): Promise<string> {
  const cached = versionCache.get(channel);
  if (cached) return cached;

  const promise = resolveCliVersionUncached(channel);
  versionCache.set(channel, promise);
  promise.catch(() => versionCache.delete(channel));
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

  if (await debAssetExists(version)) return version;

  // The dist-tag pointed at a version whose GitHub release has no
  // downloadable .deb (e.g. still a draft) — this is exactly what broke the
  // beta channel in CI run 35274970438. A stable release is never guessed at;
  // only beta walks back to the newest published version that does have one.
  if (channel === 'stable') {
    throw new Error(
      `npm's "latest" dist-tag for "supabase" points at ${version}, but its ` +
        `release asset is missing: HEAD ${cliDebUrl(version)} was not ok`
    );
  }

  return resolveFallbackBetaVersion(version);
}

/**
 * Walks back through published npm versions sharing the same `X.Y.Z-beta.`
 * prefix as `unpublishedVersion`, newest first, and returns the first one
 * whose release `.deb` asset actually downloads.
 */
async function resolveFallbackBetaVersion(
  unpublishedVersion: string
): Promise<string> {
  const match = BETA_SUFFIX_RE.exec(unpublishedVersion);
  if (!match) {
    throw new Error(
      `npm's "beta" dist-tag for "supabase" points at ${unpublishedVersion}, ` +
        `whose release asset is missing (HEAD ${cliDebUrl(unpublishedVersion)} ` +
        'was not ok), and its version does not match the X.Y.Z-beta.N shape ' +
        'this fallback can walk back through'
    );
  }
  const [, prefix] = match;

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

  const suffixRe = new RegExp(`^${escapeRegExp(prefix)}(\\d+)$`);
  const candidates = Object.keys(versions)
    .filter((candidate) => candidate !== unpublishedVersion)
    .map((candidate) => {
      const suffixMatch = suffixRe.exec(candidate);
      return suffixMatch
        ? { version: candidate, suffix: Number(suffixMatch[1]) }
        : null;
    })
    .filter((entry): entry is { version: string; suffix: number } =>
      Boolean(entry)
    )
    .sort((a, b) => b.suffix - a.suffix)
    .slice(0, MAX_BETA_FALLBACK_CANDIDATES)
    .map((entry) => entry.version);

  for (const candidate of candidates) {
    if (await debAssetExists(candidate)) return candidate;
  }

  throw new Error(
    `no published beta Supabase CLI release has a downloadable .deb asset; ` +
      `checked ${[unpublishedVersion, ...candidates].join(', ')} via ` +
      `${NPM_PACKUMENT_URL}`
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
