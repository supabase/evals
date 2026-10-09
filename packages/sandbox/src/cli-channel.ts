/**
 * Resolves a Supabase CLI version spec: an exact version, an npm dist-tag of
 * `supabase`, or a semver range. npm can point at a release whose GitHub draft
 * has no downloadable asset, so a resolved version's `.deb` is verified first.
 */

import { isRecord } from '@supabase-evals/core/json';
import { maxSatisfying, satisfies, validRange } from 'semver';

const NPM_DIST_TAGS_URL =
  'https://registry.npmjs.org/-/package/supabase/dist-tags';

// Makes npm return the abbreviated packument instead of the full one.
const NPM_PACKUMENT_URL = 'https://registry.npmjs.org/supabase';
const NPM_INSTALL_V1_ACCEPT = 'application/vnd.npm.install-v1+json';

// A dist-tag can carry any prerelease suffix (-rc.1, -next.2), not just -beta.N.
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

const DIST_TAG_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;

/** JSON object mapping version specs to exact versions, pinning a run's resolution. */
const VERSION_PINS_ENV = 'SUPABASE_CLI_VERSION_PINS';

const versionCache = new Map<string, Promise<string>>();
const registryDocCache = new Map<string, Promise<unknown>>();

/** Whether `value` has the shape of an exact CLI version (optionally `v`-prefixed) rather than a dist-tag or range. */
export function isExactCliVersion(value: string): boolean {
  return VERSION_RE.test(stripVersionPrefix(value));
}

function stripVersionPrefix(value: string): string {
  return value.replace(/^v/, '');
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

/** Shares one in-flight load per key; a rejection clears the entry so the next call retries. */
function memoise<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>
): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = load();
  cache.set(key, promise);
  promise.catch(() => {
    if (cache.get(key) === promise) cache.delete(key);
  });
  return promise;
}

function fetchRegistryDoc(
  url: string,
  headers?: Record<string, string>
): Promise<unknown> {
  return memoise(registryDocCache, url, async () => {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(
        `GET ${url} -> ${response.status} ${response.statusText}`
      );
    }
    return response.json();
  });
}

/**
 * Resolves an exact version, npm dist-tag or semver range of `supabase` to a
 * concrete CLI version, memoised per spec for the process lifetime. A
 * rejection clears the cache entry so the next call retries; never falls back
 * to the pinned SUPABASE_CLI_VERSION, since that would silently mislabel data.
 */
export function resolveCliVersionSpec(spec: string): Promise<string> {
  if (isExactCliVersion(spec)) return Promise.resolve(stripVersionPrefix(spec));
  return memoise(versionCache, spec, () => resolveCliVersionSpecUncached(spec));
}

/** Resolves `value`: `undefined` stays `undefined`, anything else goes through {@link resolveCliVersionSpec}. */
export async function resolveCliVersionOption(
  value: string | undefined
): Promise<string | undefined> {
  return value === undefined ? undefined : resolveCliVersionSpec(value);
}

function readVersionPins(): Record<string, string> {
  const raw = process.env[VERSION_PINS_ENV]?.trim();
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${VERSION_PINS_ENV} is not valid JSON: ${raw}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(
      `${VERSION_PINS_ENV} must be a JSON object mapping version specs to versions`
    );
  }

  const pins: Record<string, string> = Object.create(null);
  for (const [spec, value] of Object.entries(parsed)) {
    const version =
      typeof value === 'string' ? stripVersionPrefix(value.trim()) : '';
    if (!VERSION_RE.test(version)) {
      throw new Error(
        `${VERSION_PINS_ENV} pins "${spec}" to ${JSON.stringify(value)}, which is not a valid Supabase CLI version`
      );
    }
    pins[spec] = version;
  }
  return pins;
}

async function resolveCliVersionSpecUncached(spec: string): Promise<string> {
  // semver reads '' as '*', which would silently resolve to the newest release.
  const isRange = spec.trim() !== '' && validRange(spec) !== null;
  if (!isRange && !DIST_TAG_RE.test(spec)) {
    throw new Error(
      `${JSON.stringify(spec)} is not an exact Supabase CLI version, a semver range, or a valid npm dist-tag name`
    );
  }

  // An explicit pin is trusted as-is — no asset check, network or otherwise.
  const pins = readVersionPins();
  if (Object.hasOwn(pins, spec)) return pins[spec];

  const version = isRange
    ? await resolveRange(spec)
    : await resolveDistTag(spec);

  if (!(await debAssetExists(version))) {
    throw new Error(
      `"${spec}" resolves to supabase@${version}, but its release asset is missing ` +
        `(checked amd64 and arm64 .deb assets at ${releaseTagUrl(version)})`
    );
  }
  return version;
}

async function resolveDistTag(distTag: string): Promise<string> {
  const tags = await fetchRegistryDoc(NPM_DIST_TAGS_URL);
  if (!isRecord(tags)) {
    throw new Error(
      `npm dist-tags for "supabase" were not a JSON object: ${JSON.stringify(tags)}`
    );
  }
  if (!Object.hasOwn(tags, distTag)) {
    throw new Error(
      `npm has no "${distTag}" dist-tag for "supabase"; available dist-tags: ` +
        Object.keys(tags).join(', ')
    );
  }
  const version = tags[distTag];
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error(
      `npm dist-tags for "supabase" did not have a valid "${distTag}" version: ` +
        JSON.stringify(version)
    );
  }
  return version;
}

/** Follows npm-pick-manifest: the `latest` dist-tag when it satisfies the range, otherwise the highest satisfying non-prerelease version. */
async function resolveRange(range: string): Promise<string> {
  const packument = await fetchRegistryDoc(NPM_PACKUMENT_URL, {
    Accept: NPM_INSTALL_V1_ACCEPT,
  });
  const versions = isRecord(packument) ? packument.versions : undefined;
  if (!isRecord(versions)) {
    throw new Error(
      `npm packument for "supabase" did not include a "versions" object`
    );
  }
  const tags = isRecord(packument) ? packument['dist-tags'] : undefined;
  const latest =
    isRecord(tags) && Object.hasOwn(tags, 'latest') ? tags.latest : undefined;
  if (typeof latest === 'string' && satisfies(latest, range)) return latest;

  const version = maxSatisfying(Object.keys(versions), range);
  if (version === null) {
    throw new Error(
      `no published "supabase" version on npm satisfies "${range}"`
    );
  }
  return version;
}
