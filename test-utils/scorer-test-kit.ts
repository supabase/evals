/**
 * Helpers for testing eval scorers against a real platform-lite backend.
 *
 * Lives at the repo root rather than inside a package on purpose: it hardcodes
 * the monorepo layout (`ROOT`, `seedPath`) and is test-only, so shipping it
 * from `@supabase-evals/core` would make a production package own repo-shaped
 * test infrastructure. Canonical types come from core; nothing here reaches
 * into an app's internals.
 *
 * Scorer tests live next to the scorer they cover (`evals/<id>/EVAL.test.ts`)
 * and import it directly; harness tests live beside the harness module they
 * cover. Both import from here so a test stays a description of the scenario
 * rather than a pile of backend plumbing.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootPlatformBackend } from '@supabase-evals/core';
import type {
  EdgeFunctionsInvokeResult,
  PlatformBackend,
  ToolEvalContext,
  TranscriptPart,
} from '@supabase-evals/core';

/** Repo root, from `test-utils/`. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Path to a file in an eval's `remote/` seed directory, resolved from the
 * calling test's own location. Pass `import.meta.url`: a colocated
 * `EVAL.test.ts` always seeds its own scenario, where a hand-written directory
 * string can silently point at a different eval's fixtures and still pass.
 */
export function seedPath(testUrl: string, file: string): string {
  return join(dirname(fileURLToPath(testUrl)), 'remote', file);
}

/** A `ToolEvalContext` backed by a live platform-lite project. */
export function scorerCtx(
  backend: PlatformBackend,
  extra?: { agentReport?: string; transcript?: TranscriptPart[] }
): ToolEvalContext {
  return {
    mgmt: backend.mgmt,
    ref: backend.ref,
    client: backend.client,
    getClient: backend.getClient,
    query: backend.query,
    invokeFunction: backend.invokeFunction,
    toolCalls: [],
    transcript: extra?.transcript ?? [],
    agentReport: extra?.agentReport,
  };
}

/** Boot a backend, run `fn` against it, and always close it. */
export async function withBackend<T>(
  opts: { projectSeedSql?: string; logsSeedJsonl?: string },
  fn: (backend: PlatformBackend) => Promise<T>
): Promise<T> {
  const backend = await bootPlatformBackend(opts);
  try {
    return await fn(backend);
  } finally {
    await backend.close();
  }
}

/** Serialized checks, for use as an assertion failure message. */
export function checksMessage(result: { checks?: unknown[] }) {
  return JSON.stringify(result.checks ?? []);
}

/** Names of the checks that failed, for asserting on *which* check broke. */
export function failedCheckNames(result: {
  checks?: { name: string; passed: boolean }[];
}) {
  return (
    result.checks
      ?.filter((check) => !check.passed)
      .map((check) => check.name) ?? []
  );
}

/** An edge function response, as the scorer's `invokeFunction` would see it. */
export function functionResponse(
  status: number,
  body = '',
  outboundBearerTokens: string[] = []
): EdgeFunctionsInvokeResult {
  return { type: 'response', status, headers: {}, body, outboundBearerTokens };
}

/**
 * Deploy an edge function through platform-lite's management API, the same
 * path the real harness uses.
 */
export async function deployFunction(
  backend: PlatformBackend,
  slug: string,
  source: string,
  opts: { verifyJwt: boolean }
): Promise<void> {
  const form = new FormData();
  form.append(
    'metadata',
    JSON.stringify({
      name: slug,
      verify_jwt: opts.verifyJwt,
      entrypoint_path: 'index.ts',
    })
  );
  form.append(
    'file',
    new File([source], 'index.ts', { type: 'application/typescript' })
  );

  const res = await fetch(
    `${backend.url}/v1/projects/${backend.ref}/functions/deploy?slug=${slug}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${backend.accessToken}` },
      body: form,
    }
  );

  if (res.status !== 201) {
    throw new Error(`deploy of ${slug} failed: ${await res.text()}`);
  }
}
