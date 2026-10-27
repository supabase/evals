// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-004-download-edit-redeploy
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { FUNCTION_SLUG, PROMO_PROBES, SEEDED_VERSION } from './seed.js';

const here = (path: string) => new URL(`./${path}`, import.meta.url);
const read = (path: string) => readFileSync(here(path), 'utf8');

const SEED_SOURCE = read('remote/functions/apply-promo/index.ts');

type Handler = (req: Request) => Response | Promise<Response>;

function loadHandler(source: string): Handler {
  const withoutJsrImport = source.replace(/^import\s+'jsr:[^']+';\s*$/m, '');
  const { outputText } = ts.transpileModule(withoutJsrImport, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  let handler: Handler | undefined;
  const Deno = {
    serve(fn: Handler) {
      handler = fn;
      return {};
    },
  };
  new Function('Deno', outputText)(Deno);
  if (handler === undefined)
    throw new Error('the function never called Deno.serve');
  return handler;
}

const post = (body: unknown) =>
  new Request('http://functions.test/apply-promo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const answer = async (
  source: string,
  request: { code: string; cartCents: number }
) => {
  const response = await loadHandler(source)(post(request));
  return { status: response.status, body: await response.json() };
};

const FIXED_SOURCE = SEED_SOURCE.replace(
  'PROMOS.get(code)',
  'PROMOS.get(code.toUpperCase())'
);

describe('seed constants', () => {
  it('names the seeded function', () => {
    expect(FUNCTION_SLUG).toBe('apply-promo');
  });

  it('records that platform-lite seeds remote functions at version 1', () => {
    expect(SEEDED_VERSION).toBe(1);
  });

  it('probes two lowercase codes that must start working and three rules that must be kept', () => {
    expect([...PROMO_PROBES]).toEqual([
      {
        group: 'fix',
        request: { code: 'welcome10', cartCents: 6000 },
        expected: { valid: true, discountCents: 600 },
      },
      {
        group: 'fix',
        request: { code: 'freeship', cartCents: 6000 },
        expected: { valid: true, discountCents: 495 },
      },
      {
        group: 'kept',
        request: { code: 'LOYAL15', cartCents: 6000 },
        expected: { valid: true, discountCents: 900 },
      },
      {
        group: 'kept',
        request: { code: 'FREESHIP', cartCents: 2000 },
        expected: { valid: false },
      },
      {
        group: 'kept',
        request: { code: 'SPRING50', cartCents: 6000 },
        expected: { valid: false },
      },
    ]);
  });

  it('sends the fix probes in lowercase and the kept probes in the exact case the seed already accepts', () => {
    for (const { group, request } of PROMO_PROBES) {
      if (group === 'fix')
        expect(request.code).toBe(request.code.toLowerCase());
      else expect(request.code).toBe(request.code.toUpperCase());
    }
  });
});

describe('seeded apply-promo function against the probe table', () => {
  it.each(
    PROMO_PROBES.filter(({ group }) => group === 'fix').map((probe) => [
      probe.request.code,
      probe,
    ])
  )(
    'rejects the lowercase %s probe, which is the bug the agent is asked to fix',
    async (_label, probe) => {
      const { status, body } = await answer(SEED_SOURCE, probe.request);
      expect(status).toBe(200);
      expect(body.valid).toBe(false);
    }
  );

  it.each(
    PROMO_PROBES.filter(({ group }) => group === 'kept').map((probe) => [
      `${probe.request.code} @${probe.request.cartCents}`,
      probe,
    ])
  )('answers the kept %s probe as expected', async (_label, probe) => {
    const { status, body } = await answer(SEED_SOURCE, probe.request);
    expect(status).toBe(200);
    expect(body.valid).toBe(probe.expected.valid);
    if (probe.expected.valid) {
      expect(body.discountCents).toBe(probe.expected.discountCents);
    }
  });

  it.each(
    PROMO_PROBES.map((probe) => [
      `${probe.request.code} @${probe.request.cartCents}`,
      probe,
    ])
  )(
    'answers every probe as expected once the lookup uppercases the code: %s',
    async (_label, probe) => {
      expect(FIXED_SOURCE).not.toBe(SEED_SOURCE);
      const { status, body } = await answer(FIXED_SOURCE, probe.request);
      expect(status).toBe(200);
      expect(body.valid).toBe(probe.expected.valid);
      if (probe.expected.valid) {
        expect(body.discountCents).toBe(probe.expected.discountCents);
      }
    }
  );

  it('holds the loyalty code and the minimum-cart rule that exist only in the deployed source', () => {
    expect(SEED_SOURCE).toContain("['LOYAL15', { percentOff: 15");
    expect(SEED_SOURCE).toContain('minCartCents: 3000');
    expect(SEED_SOURCE).toContain('minCartCents: 4000');
  });

  it('rejects a GET with 405', async () => {
    const response = await loadHandler(SEED_SOURCE)(
      new Request('http://functions.test/apply-promo')
    );
    expect(response.status).toBe(405);
  });

  it.each([
    ['a body that is not JSON', 'not json'],
    ['a zero cart', { code: 'WELCOME10', cartCents: 0 }],
    ['a negative cart', { code: 'WELCOME10', cartCents: -5 }],
    ['a fractional cart', { code: 'WELCOME10', cartCents: 10.5 }],
    ['a non-numeric cart', { code: 'WELCOME10', cartCents: 'lots' }],
    ['no cart', { code: 'WELCOME10' }],
  ])('rejects %s with 400', async (_label, body) => {
    const response = await loadHandler(SEED_SOURCE)(post(body));
    expect(response.status).toBe(400);
  });
});

describe('remote seed', () => {
  it('holds only the functions folder, so platform-lite seeds no SQL or logs', () => {
    expect(readdirSync(here('remote/')).sort()).toEqual(['functions']);
  });

  it('ships a single function whose folder is a lone index.ts', () => {
    expect(readdirSync(here('remote/functions/'))).toEqual([FUNCTION_SLUG]);
    expect(readdirSync(here(`remote/functions/${FUNCTION_SLUG}/`))).toEqual([
      'index.ts',
    ]);
  });

  it('imports nothing relative, since the invoker compiles one file', () => {
    const specifiers = [
      ...SEED_SOURCE.matchAll(
        /(?:^|\s)(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/gm
      ),
    ].map((match) => match[1] ?? match[2] ?? match[3]);
    expect(specifiers).toEqual([
      'jsr:@supabase/functions-js/edge-runtime.d.ts',
    ]);
    expect(SEED_SOURCE).not.toMatch(/from\s+['"]\.{1,2}\//);
  });

  it('builds responses with new Response, since the invoker rejects Response.json', () => {
    expect(SEED_SOURCE).toContain('new Response(');
    expect(SEED_SOURCE).not.toContain('Response.json');
  });

  it('looks the code up exactly, which is the case-sensitivity bug', () => {
    expect(SEED_SOURCE).toContain('PROMOS.get(code)');
    expect(SEED_SOURCE).not.toMatch(/toUpperCase|toLowerCase|localeCompare/);
  });
});

describe('local seed', () => {
  it('holds only the config, with no supabase/functions folder', () => {
    expect(readdirSync(here('local/')).sort()).toEqual(['supabase']);
    expect(readdirSync(here('local/supabase/'))).toEqual(['config.toml']);
    expect(existsSync(here('local/supabase/functions'))).toBe(false);
  });

  describe('config.toml', () => {
    const config = read('local/supabase/config.toml');
    const settings = config
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));

    it('sets nothing but the project id', () => {
      expect(settings).toEqual(['project_id = "storefront"']);
    });

    it('declares no function section, so a redeploy cannot inherit a verify_jwt setting from it', () => {
      expect(config).not.toMatch(/^\[functions/m);
      expect(config).not.toContain('verify_jwt');
    });
  });
});

describe('PROMPT.md', () => {
  const prompt = read('PROMPT.md');
  const [, frontmatter = '', body = ''] = prompt.split(/^---\s*$/m);

  it('names no command, flag, path, slug, URL, key, code, auth word or Docker', () => {
    expect(body.trim()).not.toBe('');
    const lowered = body.toLowerCase();
    for (const banned of [
      'supabase',
      'download',
      'deploy',
      'redeploy',
      'apply-promo',
      'npx',
      'curl',
      'docker',
      'jwt',
      'welcome10',
      'freeship',
      'loyal15',
      'case-insensitive',
      'uppercase',
      'touppercase',
      'http',
      'localhost',
      '--',
    ]) {
      expect(lowered).not.toContain(banned);
    }
    expect(lowered).not.toMatch(/\bcli\b/);
  });

  it('keeps the user words for the journey', () => {
    const lowered = body.toLowerCase();
    for (const word of [
      'promo codes',
      'lowercase',
      'edge function',
      'live',
      'our project',
      'repo',
    ]) {
      expect(lowered).toContain(word);
    }
  });

  it('declares a deploy-stage CLI journey for edge functions that needs neither Docker nor a running project', () => {
    expect(frontmatter).toMatch(/^stage: deploy$/m);
    expect(frontmatter).toMatch(/^interface: cli$/m);
    expect(frontmatter).toMatch(/^needsDocker: false$/m);
    expect(frontmatter).toMatch(/^projectRunning: false$/m);
    expect(frontmatter).toMatch(/^product:\s*\n\s*- edge-functions\s*$/m);
    expect(frontmatter).toMatch(/^topic:\s*\n\s*- security\s*$/m);
    expect(frontmatter).toMatch(/^area: edge-functions$/m);
    expect(frontmatter).toMatch(/^journeyPhase: deploy$/m);
  });

  it('leaves hostedProject and services unset so every CLI experiment runs it', () => {
    expect(frontmatter).not.toMatch(/^hostedProject:/m);
    expect(frontmatter).not.toMatch(/^services:/m);
  });

  it('cites the tickets the scenario comes from', () => {
    const motivation = /^motivation:(.*)$/m.exec(frontmatter)?.[1] ?? '';
    for (const cited of [
      'CLI-2737',
      'https://linear.app/supabase/issue/CLI-2737',
      'CLI-2705',
      'https://linear.app/supabase/issue/CLI-2705',
    ]) {
      expect(motivation).toContain(cited);
    }
  });
});
