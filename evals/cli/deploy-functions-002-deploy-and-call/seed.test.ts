// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-002-deploy-and-call
import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { FUNCTION_SLUG, QUOTE_PROBES } from './seed.js';

const here = (path: string) => new URL(`./${path}`, import.meta.url);
const read = (path: string) => readFileSync(here(path), 'utf8');

const FUNCTION_SOURCE = read(
  'local/supabase/functions/shipping-quote/index.ts'
);

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
  new Request('http://functions.test/shipping-quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('seed constants', () => {
  it('names the seeded function', () => {
    expect(FUNCTION_SLUG).toBe('shipping-quote');
  });

  it('probes an Irish and a US shipment with the seeded rates', () => {
    expect([...QUOTE_PROBES]).toEqual([
      {
        request: { country: 'IE', weightKg: 2.3 },
        expected: { quoteCents: 810, currency: 'EUR' },
      },
      {
        request: { country: 'US', weightKg: 0.4 },
        expected: { quoteCents: 894, currency: 'USD' },
      },
    ]);
  });
});

describe('seeded shipping-quote function', () => {
  it.each(
    QUOTE_PROBES.map((probe) => [
      `${probe.request.country} ${probe.request.weightKg}kg`,
      probe,
    ])
  )(
    'answers the %s probe with its expected quote and a 200',
    async (_label, probe) => {
      const response = await loadHandler(FUNCTION_SOURCE)(post(probe.request));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ...probe.request,
        ...probe.expected,
      });
    }
  );

  it('rejects a GET with 405', async () => {
    const response = await loadHandler(FUNCTION_SOURCE)(
      new Request('http://functions.test/shipping-quote')
    );
    expect(response.status).toBe(405);
  });

  it('charges the base plus every started kilogram', async () => {
    const handler = loadHandler(FUNCTION_SOURCE);
    const quote = async (country: string, weightKg: number) =>
      (await (await handler(post({ country, weightKg }))).json()).quoteCents;
    expect(await quote('IE', 2)).toBe(690);
    expect(await quote('IE', 2.01)).toBe(810);
    expect(await quote('GB', 1)).toBe(505);
    expect(await quote('US', 0.01)).toBe(894);
  });

  it('reads the country case-insensitively', async () => {
    const response = await loadHandler(FUNCTION_SOURCE)(
      post({ country: 'ie', weightKg: 2.3 })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      country: 'IE',
      quoteCents: 810,
    });
  });

  it.each([
    ['a body that is not JSON', 'not json', 400],
    ['a country it does not ship to', { country: 'FR', weightKg: 1 }, 400],
    ['no country', { weightKg: 1 }, 400],
    ['a zero weight', { country: 'IE', weightKg: 0 }, 400],
    ['a negative weight', { country: 'IE', weightKg: -1 }, 400],
    ['a non-numeric weight', { country: 'IE', weightKg: 'heavy' }, 400],
  ])('rejects %s with %i', async (_label, body, status) => {
    const response = await loadHandler(FUNCTION_SOURCE)(post(body));
    expect(response.status).toBe(status);
  });
});

describe('local seed', () => {
  it('holds only the config and the functions folder', () => {
    expect(readdirSync(here('local/')).sort()).toEqual(['supabase']);
    expect(readdirSync(here('local/supabase/')).sort()).toEqual([
      'config.toml',
      'functions',
    ]);
  });

  it('ships a single function whose folder is a lone index.ts', () => {
    expect(readdirSync(here('local/supabase/functions/'))).toEqual([
      FUNCTION_SLUG,
    ]);
    expect(
      readdirSync(here(`local/supabase/functions/${FUNCTION_SLUG}/`))
    ).toEqual(['index.ts']);
  });

  it('imports nothing relative, since the invoker compiles one file', () => {
    const specifiers = [
      ...FUNCTION_SOURCE.matchAll(
        /(?:^|\s)(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/gm
      ),
    ].map((match) => match[1] ?? match[2] ?? match[3]);
    expect(specifiers).toEqual([
      'jsr:@supabase/functions-js/edge-runtime.d.ts',
    ]);
    expect(FUNCTION_SOURCE).not.toMatch(/from\s+['"]\.{1,2}\//);
  });

  describe('config.toml', () => {
    const config = read('local/supabase/config.toml');
    const settings = config
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));

    it('declares the function with JWT verification on', () => {
      const section = config.split(/^\[functions\.shipping-quote\]\s*$/m)[1];
      expect(section).toBeDefined();
      expect(section.split(/^\[/m)[0]).toMatch(/^verify_jwt\s*=\s*true\s*$/m);
    });

    it('sets nothing but the project id and the function section', () => {
      expect(settings).toEqual([
        'project_id = "storefront"',
        '[functions.shipping-quote]',
        'verify_jwt = true',
      ]);
    });
  });
});

describe('PROMPT.md', () => {
  const prompt = read('PROMPT.md');
  const [, frontmatter = '', body = ''] = prompt.split(/^---\s*$/m);

  it('names no command, flag, path, slug, URL, key, auth word or Docker', () => {
    expect(body.trim()).not.toBe('');
    const lowered = body.toLowerCase();
    for (const banned of [
      'supabase',
      'functions deploy',
      '--',
      'shipping-quote',
      'verify',
      'jwt',
      'key',
      'curl',
      'docker',
      'localhost',
      'http',
    ]) {
      expect(lowered).not.toContain(banned);
    }
    expect(body).not.toMatch(/\b[a-z]{20}\b/);
    expect(body.trim().split(/\s+/).length).toBeLessThan(80);
  });

  it('keeps the user words for the journey', () => {
    const lowered = body.toLowerCase();
    for (const word of [
      'edge function',
      'deploy',
      'project',
      'live',
      'responds',
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

  it('cites the tickets and issue the scenario comes from', () => {
    const motivation = /^motivation:(.*)$/m.exec(frontmatter)?.[1] ?? '';
    for (const cited of [
      'CLI-2705',
      'https://linear.app/supabase/issue/CLI-2705',
      'FDBKIN-32915',
      'https://linear.app/supabase/issue/FDBKIN-32915',
      'FDBKIN-2679',
      'https://linear.app/supabase/issue/FDBKIN-2679',
      'supabase/cli#5735',
      'https://github.com/supabase/cli/issues/5735',
    ]) {
      expect(motivation).toContain(cited);
    }
  });
});
