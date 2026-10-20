// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-002-deploy-and-call
import { readFileSync } from 'node:fs';
import {
  bootPlatformBackend,
  type PlatformBackend,
} from '@supabase-evals/core';
import { afterEach, describe, expect, it } from 'vitest';
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

const open: PlatformBackend[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((backend) => backend.close()));
});

async function deployThroughApi(
  source: string,
  { verifyJwt }: { verifyJwt: boolean }
) {
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

  const ctx = {
    hostedRef: backend.ref,
    hostedMgmt: backend.mgmt,
    invokeHostedFunction: backend.invokeFunction,
  };
  const deployment = await readDeployment(ctx);
  const quotes = await probeQuotes(ctx);
  return {
    deployed: checkFunctionDeployed(deployment),
    jwt: checkJwtVerificationKept(deployment),
    answered: checkQuotesAnswered(quotes),
  };
}

describe('seeded function deployed through the platform-lite Management API', () => {
  it('passes the deployed, JWT and quotes checks when the seed is deployed with verification on', async () => {
    const { deployed, jwt, answered } = await deployThroughApi(SEED_SOURCE, {
      verifyJwt: true,
    });
    expect(deployed).toMatchObject({
      passed: true,
      notes: 'status ACTIVE (version 1)',
    });
    expect(jwt.passed).toBe(true);
    expect(answered).toMatchObject({
      passed: true,
      notes: 'IE 2.3kg: quote 810 EUR; US 0.4kg: quote 894 USD',
    });
  }, 30_000);

  it('fails only the JWT check when the seed is deployed with verification off', async () => {
    const { deployed, jwt, answered } = await deployThroughApi(SEED_SOURCE, {
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
    const { deployed, jwt, answered } = await deployThroughApi(STUB_SOURCE, {
      verifyJwt: true,
    });
    expect(answered.passed).toBe(false);
    expect(answered.notes).toContain('IE 2.3kg: answered ok, expected 810 EUR');
    expect(answered.notes).toContain('US 0.4kg: answered ok, expected 894 USD');
    expect(deployed.passed).toBe(true);
    expect(jwt.passed).toBe(true);
  }, 30_000);
});
