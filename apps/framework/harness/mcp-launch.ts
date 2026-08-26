import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { MCP_SERVER_VERSION } from '@supabase-evals/core';

/** First stable MCP release containing supabase/mcp#343. */
export const CONTENT_API_FLAG_MIN_VERSION = '0.10.0';

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function supportsContentApiFlag(version: string): boolean {
  const parse = (value: string, label: string) => {
    const match = VERSION_RE.exec(value.trim());
    if (!match) {
      throw new Error(
        `${label} is not a MAJOR.MINOR.PATCH version: ${JSON.stringify(value)}`
      );
    }
    return {
      numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4] !== undefined,
    };
  };
  const current = parse(version, 'mcp server version');
  const minimum = parse(
    CONTENT_API_FLAG_MIN_VERSION,
    'CONTENT_API_FLAG_MIN_VERSION'
  );
  if (current.prerelease) return false;
  for (let index = 0; index < 3; index++) {
    if (current.numbers[index] !== minimum.numbers[index]) {
      return current.numbers[index] > minimum.numbers[index];
    }
  }
  return true;
}

export function resolveMcpServerPath(raw: string): string {
  let path = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  if (!existsSync(path)) throw new Error(`--mcp path does not exist: ${path}`);
  const packageDir = join(path, 'packages', 'mcp-server-supabase');
  if (existsSync(packageDir)) path = packageDir;
  if (!existsSync(join(path, 'dist', 'transports', 'stdio.js'))) {
    throw new Error(
      `no built server at ${path} (dist/transports/stdio.js missing) — build it first:\n  pnpm install && pnpm build`
    );
  }
  try {
    const localVersion = JSON.parse(
      readFileSync(join(path, 'package.json'), 'utf8')
    ).version;
    if (localVersion && localVersion !== MCP_SERVER_VERSION) {
      console.error(
        `note: local mcp build is v${localVersion}; the harness fixture (platform-lite) tracks the v${MCP_SERVER_VERSION} pin — endpoint drift is possible`
      );
    }
  } catch {
    // An unversioned checkout is valid when it has the expected built entry.
  }
  return realpathSync(path);
}

const CONTENT_API_OPTION = /[,{]\s*(["'])(?:--)?content-api-url\1\s*:/;

export function validateContentApi(
  contentApiUrl: string,
  mcpServerPath?: string
) {
  if (!mcpServerPath) {
    if (supportsContentApiFlag(MCP_SERVER_VERSION)) return;
    throw new Error(
      `--content-api needs --mcp <path>: the harness launches the pinned v${MCP_SERVER_VERSION} package, which has no --content-api-url flag (added in v${CONTENT_API_FLAG_MIN_VERSION} via supabase/mcp#343), so search_docs would query production docs while the receipt claims ${contentApiUrl}`
    );
  }
  const stdio = join(mcpServerPath, 'dist', 'transports', 'stdio.js');
  if (!CONTENT_API_OPTION.test(readFileSync(stdio, 'utf8'))) {
    throw new Error(
      `the mcp build at ${mcpServerPath} has no --content-api-url flag (predates supabase/mcp#343) — search_docs would query production docs, not ${contentApiUrl}`
    );
  }
}
