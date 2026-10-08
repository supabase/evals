/**
 * Resolves a Supabase CLI version from an exact version or any npm dist-tag of
 * the `supabase` package. npm can point a tag at a still-draft release with no
 * downloadable asset, so the resolved version's `.deb` is verified first.
 */

import { isRecord } from '@supabase-evals/core/json';

const NPM_DIST_TAGS_URL =
  'https://registry.npmjs.org/-/package/supabase/dist-tags';

// Makes npm return the abbreviated packument instead of the full one.
const NPM_PACKUMENT_URL = 'https://registry.npmjs.org/supabase';
const NPM_INSTALL_V1_ACCEPT = 'application/vnd.npm.install-v1+json';

// A dist-tag can carry any prerelease suffix (-rc.1, -next.2), not just -beta.N.
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

const DIST_TAG_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;

// Only the -beta.N shape has a defined ordering the walk-back below can search.
const BETA_SUFFIX_RE = /^\d+\.\d+\.\d+-beta\.\d+$/;

// Feeds compareBetaVersionsDesc's numeric comparison; matches any version, unlike BETA_SUFFIX_RE.
const BETA_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;

// Caps the walk-back so a broken release can't chain into unbounded GitHub requests.
const MAX_BETA_FALLBACK_CANDIDATES = 5;

/** JSON object mapping dist-tag names to exact versions, pinning a run's resolution. */
const DIST_TAG_PINS_ENV = 'SUPABASE_CLI_DIST_TAG_PINS';

const versionCache = new Map<string, Promise<string>>();

/** Whether `value` has the shape of an exact CLI version (optionally `v`-prefixed) rather than a dist-tag name. */
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

/**
 * Resolves an npm dist-tag of `supabase` to a concrete CLI version, memoised
 * per tag for the process lifetime. A rejection clears the cache entry so the
 * next call retries; never falls back to the pinned SUPABASE_CLI_VERSION,
 * since that would silently mislabel data.
 */
export async function resolveCliDistTag(tag: string): Promise<string> {
  const cached = versionCache.get(tag);
  if (cached) return cached;

  const promise = resolveCliDistTagUncached(tag);
  versionCache.set(tag, promise);
  promise.catch(() => {
    if (versionCache.get(tag) === promise) versionCache.delete(tag);
  });
  return promise;
}

/** Resolves `value`: an exact version passes through (minus any leading `v`), `undefined` stays `undefined`, anything else is an npm dist-tag. */
export async function resolveCliVersionOption(
  value: string | undefined
): Promise<string | undefined> {
  if (value === undefined) return undefined;
  return isExactCliVersion(value)
    ? stripVersionPrefix(value)
    : resolveCliDistTag(value);
}

function readDistTagPins(): Record<string, string> {
  const raw = process.env[DIST_TAG_PINS_ENV]?.trim();
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${DIST_TAG_PINS_ENV} is not valid JSON: ${raw}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(
      `${DIST_TAG_PINS_ENV} must be a JSON object mapping dist-tags to versions`
    );
  }

  const pins: Record<string, string> = {};
  for (const [tag, value] of Object.entries(parsed)) {
    const version =
      typeof value === 'string' ? stripVersionPrefix(value.trim()) : '';
    if (!VERSION_RE.test(version)) {
      throw new Error(
        `${DIST_TAG_PINS_ENV} pins "${tag}" to ${JSON.stringify(value)}, which is not a valid Supabase CLI version`
      );
    }
    pins[tag] = version;
  }
  return pins;
}

async function resolveCliDistTagUncached(distTag: string): Promise<string> {
  if (!DIST_TAG_RE.test(distTag)) {
    throw new Error(
      `${JSON.stringify(distTag)} is neither an exact Supabase CLI version nor a valid npm dist-tag name`
    );
  }

  // An explicit pin is trusted as-is — no asset check, network or otherwise.
  const pinned = readDistTagPins()[distTag];
  if (pinned) return pinned;

  const response = await fetch(NPM_DIST_TAGS_URL, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `failed to resolve the "${distTag}" Supabase CLI dist-tag: ` +
        `GET ${NPM_DIST_TAGS_URL} -> ${response.status} ${response.statusText}`
    );
  }
  const tags = await response.json();
  if (!isRecord(tags)) {
    throw new Error(
      `npm dist-tags for "supabase" were not a JSON object: ${JSON.stringify(tags)}`
    );
  }
  const version = tags[distTag];
  if (version === undefined) {
    throw new Error(
      `npm has no "${distTag}" dist-tag for "supabase"; available dist-tags: ` +
        Object.keys(tags).join(', ')
    );
  }
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error(
      `npm dist-tags for "supabase" did not have a valid "${distTag}" version: ` +
        JSON.stringify(version)
    );
  }

  // A transient failure here throws rather than silently walking back to an
  // older beta (or never walking back, for other shapes).
  if (await debAssetExists(version)) return version;

  // npm's dist-tag can point at a version whose GitHub release is still a
  // draft with no downloadable .deb. Only -beta.N versions walk back to an
  // older published version; other shapes are never guessed at.
  if (!BETA_SUFFIX_RE.test(version)) {
    throw new Error(
      `npm's "${distTag}" dist-tag for "supabase" points at ${version}, but its ` +
        `release asset is missing (checked amd64 and arm64 .deb assets at ` +
        `${releaseTagUrl(version)})`
    );
  }

  return resolveFallbackBetaVersion(version, distTag);
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
  unpublishedVersion: string,
  distTag: string
): Promise<string> {
  const response = await fetch(NPM_PACKUMENT_URL, {
    headers: { Accept: NPM_INSTALL_V1_ACCEPT },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `failed to look up published beta versions for the "${distTag}" dist-tag of "supabase": ` +
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
    `no published beta Supabase CLI release has a downloadable .deb asset for the "${distTag}" dist-tag; ` +
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
