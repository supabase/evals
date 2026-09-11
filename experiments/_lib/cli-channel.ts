/**
 * Resolves "latest stable" / "latest beta" Supabase CLI versions from npm's
 * dist-tags for the `supabase` package — no auth, no rate-limit exposure
 * (unlike the GitHub releases API), which matters because CI's sandbox only
 * forwards the model API keys, never a GITHUB_TOKEN.
 */

export type CliChannel = 'stable' | 'beta';

const NPM_DIST_TAGS_URL =
  'https://registry.npmjs.org/-/package/supabase/dist-tags';

// npm's beta dist-tag can carry a prerelease suffix like -rc.1, not just -beta.N.
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

const ENV_OVERRIDE: Record<CliChannel, string> = {
  stable: 'SUPABASE_CLI_STABLE_VERSION',
  beta: 'SUPABASE_CLI_BETA_VERSION',
};

const DIST_TAG: Record<CliChannel, string> = {
  stable: 'latest',
  beta: 'beta',
};

const versionCache = new Map<CliChannel, Promise<string>>();

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

async function resolveCliVersionUncached(channel: CliChannel): Promise<string> {
  const envVar = ENV_OVERRIDE[channel];
  const override = process.env[envVar]?.trim().replace(/^v/, '');
  if (override) {
    if (!VERSION_RE.test(override)) {
      throw new Error(
        `${envVar}=${JSON.stringify(override)} is not a valid Supabase CLI version`
      );
    }
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
  return version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
