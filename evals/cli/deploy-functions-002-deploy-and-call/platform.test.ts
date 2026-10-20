// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-002-deploy-and-call
import { readFileSync } from 'node:fs';
import {
  bootPlatformBackend,
  type PlatformBackend,
} from '@supabase-evals/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkFunctionDeployed,
  checkJwtVerificationKept,
  readDeployment,
} from './hosted.js';
import { checkQuotesAnswered, probeQuotes } from './responses.js';
import { FUNCTION_SLUG } from './seed.js';

const SEED_SOURCE = readFileSync(
  new URL(
    './local/supabase/functions/shipping-quote/index.ts',
    import.meta.url
  ),
  'utf8'
);

const STUB_SOURCE = "Deno.serve(() => new Response('ok'));";

const GB_RATE = "GB: { currency: 'GBP', baseCents: 395, perKgCents: 110 }";
const GB_CHANGED_SOURCE = SEED_SOURCE.replace(
  GB_RATE,
  "GB: { currency: 'GBP', baseCents: 1, perKgCents: 1 }"
);

const ALL_QUOTES =
  'IE 2.3kg: quote 810 EUR; US 0.4kg: quote 894 USD; GB 1.5kg: quote 615 GBP';

const iso = (ms: number) => new Date(ms).toISOString();

const open: PlatformBackend[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((backend) => backend.close()));
});

async function deployThroughApi(
  source: string,
  { verifyJwt }: { verifyJwt: boolean }
) {
  const beforeDeployMs = Date.now();
  const backend = await bootPlatformBackend({});
  open.push(backend);
  const form = new FormData();
  form.set(
    'metadata',
    JSON.stringify({
      name: FUNCTION_SLUG,
      entrypoint_path: 'index.ts',
      verify_jwt: verifyJwt,
    })
  );
  form.append('file', new File([source], 'index.ts'));
  const response = await fetch(
    `${backend.url}/v1/projects/${backend.ref}/functions/deploy?slug=${FUNCTION_SLUG}`,
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

  const invokeHostedFunction = vi.fn(backend.invokeFunction);
  const ctx = {
    hostedRef: backend.ref,
    hostedMgmt: backend.mgmt,
    invokeHostedFunction,
  };
  return { ctx, invokeHostedFunction, beforeDeployMs };
}

async function score(
  ctx: Parameters<typeof readDeployment>[0] & Parameters<typeof probeQuotes>[0],
  sessionStartMs: number | null
) {
  const deployment = await readDeployment(ctx);
  const quotes = await probeQuotes(ctx, { deployment, sessionStartMs });
  return {
    deployment,
    deployed: checkFunctionDeployed(deployment, sessionStartMs),
    jwt: checkJwtVerificationKept(deployment, sessionStartMs),
    answered: checkQuotesAnswered(quotes),
  };
}

async function deployAndScore(source: string, options: { verifyJwt: boolean }) {
  const { ctx, beforeDeployMs } = await deployThroughApi(source, options);
  return score(ctx, beforeDeployMs);
}

describe('seeded function deployed through the platform-lite Management API', () => {
  it('passes the deployed, JWT and quotes checks when the seed is deployed with verification on', async () => {
    const { deployed, jwt, answered } = await deployAndScore(SEED_SOURCE, {
      verifyJwt: true,
    });
    expect(deployed).toMatchObject({
      passed: true,
      notes: 'status ACTIVE (version 1)',
    });
    expect(jwt.passed).toBe(true);
    expect(answered).toMatchObject({ passed: true, notes: ALL_QUOTES });
  }, 30_000);

  it('fails only the JWT check when the seed is deployed with verification off', async () => {
    const { deployed, jwt, answered } = await deployAndScore(SEED_SOURCE, {
      verifyJwt: false,
    });
    expect(jwt).toMatchObject({
      passed: false,
      notes: 'verify_jwt is off: the project config keeps it on',
    });
    expect(deployed.passed).toBe(true);
    expect(answered.passed).toBe(true);
  }, 30_000);

  it('fails only the quotes check when a stub is deployed under the slug', async () => {
    const { deployed, jwt, answered } = await deployAndScore(STUB_SOURCE, {
      verifyJwt: true,
    });
    expect(answered.passed).toBe(false);
    expect(answered.notes).toContain('IE 2.3kg: answered ok, expected 810 EUR');
    expect(answered.notes).toContain('US 0.4kg: answered ok, expected 894 USD');
    expect(answered.notes).toContain('GB 1.5kg: answered ok, expected 615 GBP');
    expect(deployed.passed).toBe(true);
    expect(jwt.passed).toBe(true);
  }, 30_000);

  it('fails only the quotes check, and only on GB, when only the GB rates were changed', async () => {
    expect(GB_CHANGED_SOURCE).not.toBe(SEED_SOURCE);
    const { deployed, jwt, answered } = await deployAndScore(
      GB_CHANGED_SOURCE,
      { verifyJwt: true }
    );
    expect(answered.passed).toBe(false);
    expect(answered.notes).toContain('IE 2.3kg: quote 810 EUR');
    expect(answered.notes).toContain('US 0.4kg: quote 894 USD');
    expect(answered.notes).toContain('GB 1.5kg: answered');
    expect(answered.notes).toContain('expected 615 GBP');
    expect(deployed.passed).toBe(true);
    expect(jwt.passed).toBe(true);
  }, 30_000);
});

describe('a function deployed before the session on platform-lite', () => {
  it('fails the deployed, JWT and quotes checks, without invoking, when the agent did nothing after the session started', async () => {
    const { ctx, invokeHostedFunction } = await deployThroughApi(SEED_SOURCE, {
      verifyJwt: true,
    });
    const sessionStartMs = Date.now() + 1;
    const { deployment, deployed, jwt, answered } = await score(
      ctx,
      sessionStartMs
    );
    const updatedAtMs = deployment.ok
      ? deployment.deployed?.updatedAtMs
      : undefined;
    expect(updatedAtMs).toBeTypeOf('number');
    const note = `the deployed shipping-quote predates this run (updated ${iso(updatedAtMs as number)}, session started ${iso(sessionStartMs)})`;
    expect(deployed).toMatchObject({ passed: false, notes: note });
    expect(jwt).toMatchObject({ passed: false, notes: note });
    expect(answered).toMatchObject({
      passed: false,
      notes: `not probed: ${note}`,
    });
    expect(invokeHostedFunction).not.toHaveBeenCalled();
  }, 30_000);

  it('passes all three checks when the session started before the deploy', async () => {
    const { ctx, beforeDeployMs } = await deployThroughApi(SEED_SOURCE, {
      verifyJwt: true,
    });
    const { deployed, jwt, answered } = await score(ctx, beforeDeployMs);
    expect([deployed.passed, jwt.passed, answered.passed]).toEqual([
      true,
      true,
      true,
    ]);
  }, 30_000);

  it('fails the deployed, JWT and quotes checks when the session start is unknown', async () => {
    const { ctx, invokeHostedFunction } = await deployThroughApi(SEED_SOURCE, {
      verifyJwt: true,
    });
    const { deployed, jwt, answered } = await score(ctx, null);
    expect([deployed.passed, jwt.passed, answered.passed]).toEqual([
      false,
      false,
      false,
    ]);
    expect(deployed.notes).toContain('session start time unavailable');
    expect(invokeHostedFunction).not.toHaveBeenCalled();
  }, 30_000);
});
