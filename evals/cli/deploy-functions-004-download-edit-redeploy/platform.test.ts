// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-004-download-edit-redeploy
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  bootPlatformBackend,
  type PlatformBackend,
} from '@supabase-evals/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkFunctionRedeployed,
  checkJwtVerificationKept,
  type DeploymentProbe,
  readDeployment,
} from './hosted.js';
import {
  checkLowercaseCodesApply,
  checkOtherRulesKept,
  probePromos,
} from './responses.js';
import { FUNCTION_SLUG } from './seed.js';

const SEED_DIR = fileURLToPath(new URL('./remote/functions', import.meta.url));

const SEED_SOURCE = readFileSync(
  new URL('./remote/functions/apply-promo/index.ts', import.meta.url),
  'utf8'
);

const LOOKUP = 'PROMOS.get(code)';

const UPPERCASED_SOURCE = SEED_SOURCE.replace(
  LOOKUP,
  'PROMOS.get(code.toUpperCase())'
);

const LOWERCASED_SOURCE = SEED_SOURCE.replace(
  LOOKUP,
  'PROMOS.get(code.toLowerCase())'
).replace(
  /\['(WELCOME10|FREESHIP|LOYAL15)'/g,
  (_match, key: string) => `['${key.toLowerCase()}'`
);

const ALIASED_SOURCE = SEED_SOURCE.replace(
  'function json(',
  'for (const [key, promo] of [...PROMOS]) PROMOS.set(key.toLowerCase(), promo);\n\nfunction json('
);

const PARTIAL_SOURCE = SEED_SOURCE.replace(
  "['LOYAL15'",
  "['welcome10', { percentOff: 10 }],\n  ['freeship', { centsOff: 495, minCartCents: 3000 }],\n  ['LOYAL15'"
);

const RESPONSE_JSON_SOURCE = UPPERCASED_SOURCE.replace(
  /return new Response\(JSON\.stringify\(body\), \{\s*status,\s*headers: \{ 'content-type': 'application\/json' \},\s*\}\);/,
  'return Response.json(body, { status });'
);

const JSON_HEADERS = "{ 'content-type': 'application/json' }";

const REWRITE_SOURCE = `
Deno.serve(async (req) => {
  const { code, cartCents } = await req.json();
  const upper = String(code).trim().toUpperCase();
  if (upper === 'WELCOME10') {
    return new Response(JSON.stringify({ valid: true, discountCents: Math.round(cartCents / 10) }), { headers: ${JSON_HEADERS} });
  }
  if (upper === 'FREESHIP') {
    return new Response(JSON.stringify({ valid: true, discountCents: 495 }), { headers: ${JSON_HEADERS} });
  }
  return new Response(JSON.stringify({ valid: false }), { headers: ${JSON_HEADERS} });
});
`;

const ACCEPT_EVERYTHING_SOURCE = `
Deno.serve(async (req) => {
  const { cartCents } = await req.json();
  return new Response(JSON.stringify({ valid: true, discountCents: Math.round(cartCents / 10) }), { headers: ${JSON_HEADERS} });
});
`;

const HELLO_SOURCE = "Deno.serve(() => new Response('ok'));";

const open: PlatformBackend[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((backend) => backend.close()));
});

async function bootSeeded({ seeded = true }: { seeded?: boolean } = {}) {
  const beforeBootMs = Date.now();
  const backend = await bootPlatformBackend(
    seeded ? { functionsSeedDir: SEED_DIR } : {}
  );
  open.push(backend);
  const bootedMs = Date.now();
  const invokeHostedFunction = vi.fn(backend.invokeFunction);
  const ctx = {
    hostedRef: backend.ref,
    hostedMgmt: backend.mgmt,
    invokeHostedFunction,
  };
  return { backend, ctx, invokeHostedFunction, beforeBootMs, bootedMs };
}

type Booted = Awaited<ReturnType<typeof bootSeeded>>;

async function postDeploy(
  { backend }: Booted,
  slug: string,
  metadata: Record<string, unknown>,
  files: { name: string; content: string }[]
) {
  const form = new FormData();
  form.set('metadata', JSON.stringify({ name: slug, ...metadata }));
  for (const file of files) {
    form.append('file', new File([file.content], file.name));
  }
  const response = await fetch(
    `${backend.url}/v1/projects/${backend.ref}/functions/deploy?slug=${slug}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${backend.accessToken}` },
      body: form,
    }
  );
  expect({
    status: response.status,
    body: await response.text(),
  }).toMatchObject({ status: 201 });
}

function deployThroughApi(
  booted: Booted,
  source: string,
  {
    slug = FUNCTION_SLUG,
    verifyJwt,
  }: { slug?: string; verifyJwt?: boolean } = {}
) {
  return postDeploy(
    booted,
    slug,
    {
      entrypoint_path: 'index.ts',
      ...(verifyJwt === undefined ? {} : { verify_jwt: verifyJwt }),
    },
    [{ name: 'index.ts', content: source }]
  );
}

async function score(booted: Booted, sessionStartMs: number | null) {
  const { ctx } = booted;
  const deployment = await readDeployment(ctx);
  const responses = await probePromos(ctx, { deployment, sessionStartMs });
  return {
    deployment,
    responses,
    redeployed: checkFunctionRedeployed(deployment, sessionStartMs),
    jwt: checkJwtVerificationKept(deployment, sessionStartMs),
    lowercase: checkLowercaseCodesApply(responses),
    kept: checkOtherRulesKept(responses),
  };
}

const passedOf = (responses: Awaited<ReturnType<typeof score>>['responses']) =>
  responses.ok ? responses.outcomes.map(({ passed }) => passed) : null;

const verdicts = (scored: Awaited<ReturnType<typeof score>>) => [
  scored.redeployed.passed,
  scored.jwt.passed,
  scored.lowercase.passed,
  scored.kept.passed,
];

async function deployAndScore(
  source: string,
  options: { slug?: string; verifyJwt?: boolean } = {}
) {
  const booted = await bootSeeded();
  await deployThroughApi(booted, source, options);
  return { booted, scored: await score(booted, booted.bootedMs) };
}

describe('the seeded apply-promo function on platform-lite', () => {
  it('is deployed at version 1 with JWT verification on, which is what the redeploy check measures against', async () => {
    const { ctx } = await bootSeeded();
    const deployment = await readDeployment(ctx);
    expect(deployment).toMatchObject({
      ok: true,
      deployed: { status: 'ACTIVE', verifyJwt: true, version: 1 },
    });
  }, 30_000);

  it('fails the redeploy, JWT, lowercase and other-rules checks without invoking, when the agent did nothing after the session started', async () => {
    const booted = await bootSeeded();
    const sessionStartMs = booted.bootedMs + 1;
    const scored = await score(booted, sessionStartMs);
    expect(verdicts(scored)).toEqual([false, false, false, false]);
    expect(scored.redeployed.notes).toContain('before this run');
    expect(scored.jwt.notes).toBe(scored.redeployed.notes);
    expect(scored.responses).toMatchObject({ ok: false });
    expect(scored.lowercase.notes).toContain('not probed');
    expect(scored.kept.notes).toContain('not probed');
    expect(booted.invokeHostedFunction).not.toHaveBeenCalled();
  }, 30_000);

  it('fails closed on the seeded version even when the session started before the platform booted', async () => {
    const booted = await bootSeeded();
    const scored = await score(booted, booted.beforeBootMs);
    expect(verdicts(scored)).toEqual([false, false, false, false]);
    expect(scored.redeployed.notes).toContain('seeded');
    expect(scored.redeployed.notes).toContain('version 1');
    expect(booted.invokeHostedFunction).not.toHaveBeenCalled();
  }, 30_000);

  it('fails closed when the session start is unknown', async () => {
    const booted = await bootSeeded();
    const scored = await score(booted, null);
    expect(verdicts(scored)).toEqual([false, false, false, false]);
    expect(scored.redeployed.notes).toContain('session start time unavailable');
    expect(booted.invokeHostedFunction).not.toHaveBeenCalled();
  }, 30_000);

  it('rejects the lowercase probes and keeps every other rule when the probes reach the seeded source directly', async () => {
    const booted = await bootSeeded();
    const asIfRedeployed: DeploymentProbe = {
      ok: true,
      deployed: {
        status: 'ACTIVE',
        verifyJwt: true,
        version: 2,
        updatedAtMs: booted.bootedMs,
      },
    };
    const responses = await probePromos(booted.ctx, {
      deployment: asIfRedeployed,
      sessionStartMs: 0,
    });
    expect(passedOf(responses)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
    expect(checkLowercaseCodesApply(responses).passed).toBe(false);
    expect(checkOtherRulesKept(responses).passed).toBe(true);
    expect(booted.invokeHostedFunction).toHaveBeenCalledTimes(6);
  }, 30_000);
});

describe('apply-promo redeployed through the platform-lite multipart deploy API', () => {
  it.each([
    ['uppercasing the code before the lookup', UPPERCASED_SOURCE],
    ['lowercasing the keys and the code', LOWERCASED_SOURCE],
    ['adding lowercase aliases to the map', ALIASED_SOURCE],
  ])(
    'passes the four checks when the fix is %s',
    async (_label, source) => {
      expect(source).not.toBe(SEED_SOURCE);
      const { scored, booted } = await deployAndScore(source, {
        verifyJwt: true,
      });
      expect(scored.redeployed).toMatchObject({ passed: true });
      expect(scored.redeployed.notes).toContain('ACTIVE');
      expect(scored.redeployed.notes).toContain('version 2');
      expect(scored.jwt.passed).toBe(true);
      expect(passedOf(scored.responses)).toEqual([
        true,
        true,
        true,
        true,
        true,
        true,
      ]);
      expect(scored.lowercase.passed).toBe(true);
      expect(scored.kept.passed).toBe(true);
      expect(booted.invokeHostedFunction).toHaveBeenCalledTimes(6);
    },
    30_000
  );

  it('reports the probes in the notes of the lowercase check', async () => {
    const { scored } = await deployAndScore(UPPERCASED_SOURCE, {
      verifyJwt: true,
    });
    expect(scored.lowercase.notes).toContain('welcome10 @6000: discount 600');
    expect(scored.lowercase.notes).toContain('freeship @6000: discount 495');
    expect(scored.lowercase.notes).toContain('loyal15 @6000: discount 900');
    expect(scored.kept.notes).toContain('LOYAL15 @6000: discount 900');
  }, 30_000);

  it('passes the JWT check when the deploy omits verify_jwt, because the server default keeps it on', async () => {
    const { scored } = await deployAndScore(UPPERCASED_SOURCE);
    expect(scored.deployment).toMatchObject({
      ok: true,
      deployed: { verifyJwt: true, version: 2 },
    });
    expect(verdicts(scored)).toEqual([true, true, true, true]);
  }, 30_000);

  it('counts a second redeploy at version 3 as redeployed too', async () => {
    const booted = await bootSeeded();
    await deployThroughApi(booted, SEED_SOURCE, { verifyJwt: true });
    await deployThroughApi(booted, UPPERCASED_SOURCE, { verifyJwt: true });
    const scored = await score(booted, booted.bootedMs);
    expect(scored.redeployed.notes).toContain('version 3');
    expect(verdicts(scored)).toEqual([true, true, true, true]);
  }, 30_000);

  it('redeploying the unfixed seed passes the redeploy and other-rules checks but fails the lowercase one', async () => {
    const { scored } = await deployAndScore(SEED_SOURCE, { verifyJwt: true });
    expect(verdicts(scored)).toEqual([true, true, false, true]);
    expect(passedOf(scored.responses)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
  }, 30_000);

  it('fails the lowercase check, and only it, for a partial fix that aliases welcome10 and freeship but not loyal15', async () => {
    expect(PARTIAL_SOURCE).not.toBe(SEED_SOURCE);
    const { scored } = await deployAndScore(PARTIAL_SOURCE, {
      verifyJwt: true,
    });
    expect(passedOf(scored.responses)).toEqual([
      true,
      true,
      false,
      true,
      true,
      true,
    ]);
    expect(verdicts(scored)).toEqual([true, true, false, true]);
    expect(scored.lowercase.notes).toContain('loyal15 @6000: status 200');
  }, 30_000);

  it('fails only the JWT check when the fix is deployed with verification off', async () => {
    const { scored } = await deployAndScore(UPPERCASED_SOURCE, {
      verifyJwt: false,
    });
    expect(scored.jwt).toMatchObject({
      passed: false,
      notes:
        "verify_jwt is off: the deployed function had it on and the fix didn't ask to change it",
    });
    expect(scored.redeployed.passed).toBe(true);
    expect(scored.lowercase.passed).toBe(true);
    expect(scored.kept.passed).toBe(true);
  }, 30_000);

  it('fails both probe checks, on the loyalty code and the minimum cart, for a case-insensitive rewrite of WELCOME10 and FREESHIP', async () => {
    const { scored } = await deployAndScore(REWRITE_SOURCE, {
      verifyJwt: true,
    });
    expect(passedOf(scored.responses)).toEqual([
      true,
      true,
      false,
      false,
      false,
      true,
    ]);
    expect(verdicts(scored)).toEqual([true, true, false, false]);
    expect(scored.lowercase.notes).toContain('loyal15 @6000');
    expect(scored.kept.notes).toContain('LOYAL15 @6000');
    expect(scored.kept.notes).toContain('FREESHIP @2000');
  }, 30_000);

  it('fails the other-rules check for an accept-everything stub', async () => {
    const { scored } = await deployAndScore(ACCEPT_EVERYTHING_SOURCE, {
      verifyJwt: true,
    });
    expect(scored.kept.passed).toBe(false);
    const outcomes = scored.responses.ok ? scored.responses.outcomes : [];
    expect(
      outcomes.filter(({ group }) => group === 'kept').map((o) => o.passed)
    ).toEqual([false, false, false]);
    expect(scored.redeployed.passed).toBe(true);
    expect(scored.jwt.passed).toBe(true);
  }, 30_000);

  it('fails both probe checks for a hello-world stub deployed under the slug', async () => {
    const { scored } = await deployAndScore(HELLO_SOURCE, { verifyJwt: true });
    expect(verdicts(scored)).toEqual([true, true, false, false]);
    expect(passedOf(scored.responses)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  }, 30_000);

  it('fails the redeploy check, and probes nothing, when the fix is deployed as apply-promo-v2 and the original is left alone', async () => {
    const booted = await bootSeeded();
    await deployThroughApi(booted, UPPERCASED_SOURCE, {
      slug: 'apply-promo-v2',
      verifyJwt: true,
    });
    const copy = await booted.backend.mgmt.GET(
      '/v1/projects/{ref}/functions/{function_slug}',
      {
        params: {
          path: { ref: booted.backend.ref, function_slug: 'apply-promo-v2' },
        },
      }
    );
    expect(copy.response.status).toBe(200);

    const scored = await score(booted, booted.bootedMs);
    expect(verdicts(scored)).toEqual([false, false, false, false]);
    expect(scored.redeployed.notes).toContain('still the');
    expect(booted.invokeHostedFunction).not.toHaveBeenCalled();

    const original = await booted.backend.invokeFunction({
      name: FUNCTION_SLUG,
      method: 'POST',
      headers: {
        authorization: 'Bearer x',
        'content-type': 'application/json',
      },
      body: { code: 'welcome10', cartCents: 6000 },
    });
    expect(original).toMatchObject({ type: 'response', status: 200 });
    expect(
      JSON.parse(original.type === 'response' ? original.body : '{}').valid
    ).toBe(false);
  }, 30_000);

  it('fails every check with a not-deployed note, and probes nothing, when the project has no apply-promo function', async () => {
    const booted = await bootSeeded({ seeded: false });
    const scored = await score(booted, booted.bootedMs);
    expect(scored.deployment).toMatchObject({ ok: true, deployed: null });
    expect(verdicts(scored)).toEqual([false, false, false, false]);
    expect(scored.redeployed.notes).toContain('not deployed');
    expect(scored.lowercase.notes).toContain('not probed');
    expect(booted.invokeHostedFunction).not.toHaveBeenCalled();
  }, 30_000);
});

describe('platform-lite limits that fail a correct fix', () => {
  it('fails the probe checks when the redeploy uploads a deno.json ahead of the entrypoint, because the invoker compiles the first stored file', async () => {
    const booted = await bootSeeded();
    await postDeploy(
      booted,
      FUNCTION_SLUG,
      {
        entrypoint_path: 'supabase/functions/apply-promo/index.ts',
        import_map_path: 'supabase/functions/apply-promo/deno.json',
      },
      [
        {
          name: 'supabase/functions/apply-promo/deno.json',
          content: '{\n  "imports": {}\n}\n',
        },
        {
          name: 'supabase/functions/apply-promo/index.ts',
          content: UPPERCASED_SOURCE,
        },
      ]
    );
    const scored = await score(booted, booted.bootedMs);
    expect(verdicts(scored)).toEqual([true, true, false, false]);
    expect(scored.lowercase.notes).toContain('must call Deno.serve');
  }, 30_000);

  it('fails the probe checks when the fix switches responses to Response.json, because the invoker rejects it', async () => {
    expect(RESPONSE_JSON_SOURCE).toContain('Response.json(body');
    const { scored } = await deployAndScore(RESPONSE_JSON_SOURCE, {
      verifyJwt: true,
    });
    expect(verdicts(scored)).toEqual([true, true, false, false]);
    expect(scored.lowercase.notes).toContain('did not return a Response');
  }, 30_000);

  it('fails the lowercase check after a Docker-bundled redeploy, because the PATCH keeps the seeded files', async () => {
    const booted = await bootSeeded();
    const { backend } = booted;
    const response = await fetch(
      `${backend.url}/v1/projects/${backend.ref}/functions/${FUNCTION_SLUG}?entrypoint_path=file:///src/index.ts&verify_jwt=true&ezbr_sha256=abc`,
      {
        method: 'PATCH',
        headers: { authorization: `Bearer ${backend.accessToken}` },
        body: new Uint8Array([1, 2, 3]),
      }
    );
    expect(response.status).toBe(200);
    const scored = await score(booted, booted.bootedMs);
    expect(verdicts(scored)).toEqual([true, true, false, true]);
  }, 30_000);
});
