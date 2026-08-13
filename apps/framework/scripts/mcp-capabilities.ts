/**
 * Which MCP server capabilities a given published version has.
 *
 * Split out of local.ts so the smoke suite can drive the version comparison
 * directly: the pin it actually gates on is a constant in @supabase-evals/core,
 * so an end-to-end check can only ever exercise whichever side of the boundary
 * today's pin happens to sit on.
 */

/**
 * First published release containing the `--content-api-url` flag
 * (supabase/mcp#343, merged 2026-07-23 as 6fcaaa3).
 *
 * Verified against the tags rather than assumed: #343 is an ancestor of
 * `mcp-server-supabase-v0.10.0` and is NOT contained in v0.9.0 or v0.8.3.
 */
export const CONTENT_API_FLAG_MIN_VERSION = '0.10.0';

/** `MAJOR.MINOR.PATCH` with an optional prerelease tail. */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Whether the published package at `version` honours `--content-api-url`.
 *
 * When it does, `--content-api` needs no local build: createConfig appends the
 * flag to the npx invocation exactly as it does for a local one (the flag list
 * is built once and shared by both launch paths), and `rewriteLoopback` still
 * maps 127.0.0.1 to host.docker.internal for in-container agents.
 *
 * Only stable releases count. Semver defines precedence, not content: a
 * `0.11.0-beta` sorts above `0.10.0` but could have been cut from a branch that
 * forked before the flag landed, so its number does not prove it carries it.
 * The costs are lopsided — wrongly trusting a pin buys a paid run that measures
 * production docs while the receipt claims otherwise, whereas wrongly refusing
 * one costs the user a `--mcp` flag — so any prerelease is treated as
 * incapable. Add it here explicitly if a prerelease ever needs to qualify.
 *
 * Throws on a version it cannot parse. Silently treating `0.10.foo` as 0.10.0
 * would report "capable" and buy exactly that bad run, and silently treating it
 * as incapable would send you chasing `--mcp` for the wrong reason. A malformed
 * pin is a bug in this repo, so it should be loud.
 */
export function supportsContentApiFlag(version: string): boolean {
  const parse = (v: string, label: string) => {
    const m = VERSION_RE.exec(v.trim());
    if (!m)
      throw new Error(
        `${label} is not a MAJOR.MINOR.PATCH version: ${JSON.stringify(v)}`
      );
    return {
      nums: [Number(m[1]), Number(m[2]), Number(m[3])],
      isPrerelease: m[4] !== undefined,
    };
  };
  const got = parse(version, 'mcp server version');
  const min = parse(
    CONTENT_API_FLAG_MIN_VERSION,
    'CONTENT_API_FLAG_MIN_VERSION'
  );

  // Before any comparison: a prerelease's number tells us nothing about whether
  // the flag is in its tree.
  if (got.isPrerelease) return false;
  for (let i = 0; i < 3; i++) {
    if (got.nums[i] !== min.nums[i]) return got.nums[i] > min.nums[i];
  }
  return true;
}
