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

async function deployThroughApi(
  { backend }: Booted,
  source: string,
  {
    slug = FUNCTION_SLUG,
    verifyJwt,
  }: { slug?: string; verifyJwt?: boolean } = {}
) {
  const form = new FormData();
  form.set(
    'metadata',
    JSON.stringify({
      name: slug,
      entrypoint_path: 'index.ts',
      ...(verifyJwt === undefined ? {} : { verify_jwt: verifyJwt }),
    })
  );
  form.append('file', new File([source], 'index.ts'));
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
    expect(passedOf(responses)).toEqual([false, false, true, true, true]);
    expect(checkLowercaseCodesApply(responses).passed).toBe(false);
    expect(checkOtherRulesKept(responses).passed).toBe(true);
    expect(booted.invokeHostedFunction).toHaveBeenCalledTimes(5);
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
      ]);
      expect(scored.lowercase.passed).toBe(true);
      expect(scored.kept.passed).toBe(true);
      expect(booted.invokeHostedFunction).toHaveBeenCalledTimes(5);
    },
    30_000
  );

  it('reports the probes in the notes of the lowercase check', async () => {
    const { scored } = await deployAndScore(UPPERCASED_SOURCE, {
      verifyJwt: true,
    });
    expect(scored.lowercase.notes).toContain('welcome10 @6000: discount 600');
    expect(scored.lowercase.notes).toContain('freeship @6000: discount 495');
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
      true,
      true,
      true,
    ]);
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

  it('fails only the other-rules check, and only on the loyalty code and the minimum cart, for a case-insensitive rewrite of WELCOME10 and FREESHIP', async () => {
    const { scored } = await deployAndScore(REWRITE_SOURCE, {
      verifyJwt: true,
    });
    expect(passedOf(scored.responses)).toEqual([
      true,
      true,
      false,
      false,
      true,
    ]);
    expect(verdicts(scored)).toEqual([true, true, true, false]);
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
