import {
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

// Regression eval for @supabase/middleware: the prompt names the package and
// asks for one built-in (CORS) plus one hand-written middleware (an API-key
// gate) composed in front of a handler. It guards the usability property —
// "when pointed at the package, agents compose with it correctly" — as a
// canary for package or docs changes that break agent usage. The "uses
// @supabase/middleware" and "uses defineMiddleware" checks are GATING.
//
// Requests go through the local Kong gateway, which owns CORS on
// /functions/v1/*; see README.md for what that leaves observable.
const FUNCTION = 'notes-api';
const ORIGIN = 'https://app.example.com';
// Mirrors local/supabase/functions/.env, which the agent is told about.
const API_KEY = 'nk_live_7f3a9c';
const KEY_ID = '7f3a9c';

interface InvokeResult {
  status: number;
  ok: boolean;
  body: string;
  headers: Headers;
}

const scorer: LocalStackScorer = async (ctx) => {
  const checks: CheckResult[] = [];
  try {
    const status = await readStatus(ctx);
    const apiUrl = str(status.API_URL);
    if (!apiUrl) {
      return fail(
        'read stack config from `supabase status`',
        `missing API_URL; got keys: ${Object.keys(status).join(', ')}`
      );
    }
    const url = `${apiUrl}/functions/v1/${FUNCTION}`;

    // 1. No key → 401 from the gate; the handler's body never appears. Kong
    // routes /functions/v1/* without an apikey, so the request arrives the
    // way a third-party caller's would.
    const noKey = await invoke(url, 'GET', {});
    checks.push({
      name: 'rejects a request with no x-api-key',
      passed: noKey.status === 401 && !noKey.body.includes(KEY_ID),
      notes: `status ${noKey.status}: ${preview(noKey.body)}`,
    });

    // 2. Wrong key → 401 as well.
    const wrongKey = await invoke(url, 'GET', {
      'x-api-key': 'nk_live_000000',
    });
    checks.push({
      name: 'rejects a request with the wrong x-api-key',
      passed: wrongKey.status === 401 && !wrongKey.body.includes(KEY_ID),
      notes: `status ${wrongKey.status}: ${preview(wrongKey.body)}`,
    });

    // 3. Right key → 200, and the handler reads what the gate contributed.
    const rightKey = await invoke(url, 'GET', {
      origin: ORIGIN,
      'x-api-key': API_KEY,
    });
    const parsed = parseJson(rightKey.body);
    checks.push({
      name: 'accepts the right key and returns the caller key id from ctx',
      passed:
        rightKey.status === 200 &&
        parsed?.ok === true &&
        parsed?.keyId === KEY_ID,
      notes: `status ${rightKey.status}: ${preview(rightKey.body)}`,
    });

    // 4. The function's CORS ran for the allowed origin. Kong's own CORS
    // plugin answers preflights and rewrites Access-Control-Allow-Origin to
    // `*` on every response, so neither is observable here. A CORS middleware
    // that resolved a specific origin appends `Vary: Origin`, and Kong leaves
    // that alone.
    const vary = rightKey.headers.get('vary') ?? '';
    checks.push({
      name: 'varies the handler response on Origin for the allowed origin',
      passed: /\bOrigin\b/i.test(vary),
      notes: `vary: ${vary || '(none)'}`,
    });

    // 5 + 6. GATING: built with @supabase/middleware, and the key check is a
    // real middleware rather than an `if` inside the handler.
    checks.push(...(await sourceChecks(ctx)));

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    checks.push({
      name: 'scorer completed without errors',
      passed: false,
      notes: msg,
    });
    return { passed: false, checks };
  }
};

export default scorer;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function preview(body: string): string {
  return body.replace(/\s+/g, ' ').slice(0, 160);
}

function parseJson(body: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function fail(
  name: string,
  notes: string
): { passed: false; checks: CheckResult[] } {
  return { passed: false, checks: [{ name, passed: false, notes }] };
}

async function invoke(
  url: string,
  method: string,
  headers: Record<string, string>
): Promise<InvokeResult> {
  const res = await fetch(url, { method, headers });
  return {
    status: res.status,
    ok: res.ok,
    body: await res.text(),
    headers: res.headers,
  };
}

/** Parse `supabase status -o json` for the stack's URL and keys. */
async function readStatus(
  ctx: LocalStackEvalContext
): Promise<Record<string, unknown>> {
  const res = await ctx.exec('supabase status -o json');
  const start = res.stdout.indexOf('{');
  const end = res.stdout.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(
      `could not read \`supabase status\`: ${res.stderr || res.stdout}`
    );
  }
  return JSON.parse(res.stdout.slice(start, end + 1));
}

/**
 * GATING: the function must import @supabase/middleware and declare its own
 * middleware with `defineMiddleware`. A hand-rolled CORS + `if (key !== …)`
 * handler fails this eval even if it behaves correctly.
 */
async function sourceChecks(
  ctx: LocalStackEvalContext
): Promise<CheckResult[]> {
  const candidates = [
    `supabase/functions/${FUNCTION}/index.ts`,
    `supabase/functions/${FUNCTION}/index.tsx`,
  ];
  for (const path of candidates) {
    if (await ctx.fileExists(path)) {
      const src = await ctx.readFile(path).catch(() => '');
      const importsPackage =
        /(?:from|import)\s*\(?\s*['"](?:npm:|jsr:)?@supabase\/middleware(?:@[^'"/]+)?(?:\/[^'"]*)?['"]/.test(
          src
        );
      const definesMiddleware = /\bdefineMiddleware\s*[<(]/.test(src);
      return [
        {
          name: 'implementation uses @supabase/middleware',
          passed: importsPackage,
          notes: importsPackage
            ? 'imports @supabase/middleware'
            : 'hand-rolled — this eval requires @supabase/middleware',
        },
        {
          name: 'the API-key check is a defineMiddleware middleware',
          passed: definesMiddleware,
          notes: definesMiddleware
            ? 'calls defineMiddleware'
            : 'no defineMiddleware call in the function source',
        },
      ];
    }
  }
  return [
    {
      name: 'implementation uses @supabase/middleware',
      passed: false,
      notes: 'could not locate function source to inspect',
    },
  ];
}
