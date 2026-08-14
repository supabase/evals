/**
 * Eval discovery and the small pieces of run setup that both entry points
 * share: `run-eval.ts` (agent runs) and `run-solution.ts` (scoring a committed
 * solution). Keeping them here means the two can't drift on what an eval is or
 * how its seed data is found.
 */

import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEvalMarkdown } from '@supabase-evals/core/eval-markdown';

import type { EvalInterface, EvalManifest, EvalMode } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..', '..');

// Fixed identifiers for the mocked hosted project a local-stack eval links to.
// Both must satisfy the CLI's format checks: ref is `^[a-z]{20}$`, token is
// `^sbp_[a-f0-9]{40}$`. platform-lite accepts whatever token it's booted with.
export const HOSTED_PROJECT_REF = 'evalshostedprojectxy';
export const HOSTED_ACCESS_TOKEN = 'sbp_' + '0'.repeat(40);

/**
 * Resolve the run mode. The sandbox (local-stack) is needed when the agent
 * uses the Supabase CLI (`interface: cli`) — including bootstrap scenarios that
 * start from an empty workspace — or when the eval ships a `local/` workspace
 * of starting files. Everything else runs against the in-memory tools runtime.
 *
 * `interface` is otherwise a benchmark dimension (KPI), not a runtime switch.
 */
export function resolveEvalMode(
  interfaceKind: EvalInterface | undefined,
  hasLocal: boolean
): EvalMode {
  if (interfaceKind === 'cli' || hasLocal) return 'local-stack';
  return 'tools';
}

export function discoverEvals(): EvalManifest[] {
  const dir = join(ROOT, 'evals');
  if (!existsSync(dir)) return [];
  const out: EvalManifest[] = [];
  for (const id of readdirSync(dir)) {
    const evalDir = join(dir, id);
    if (!statSync(evalDir).isDirectory()) continue;
    const localDir = join(evalDir, 'local');
    const promptPath = join(evalDir, 'PROMPT.md');
    const evalPath = join(evalDir, 'EVAL.ts');
    const metadata = parseEvalMarkdown(
      readFileSync(promptPath, 'utf8'),
      `evals/${id}/PROMPT.md`
    ).metadata;
    const hasLocal = existsSync(localDir) && statSync(localDir).isDirectory();
    const mode = resolveEvalMode(metadata.interface, hasLocal);
    out.push({
      id,
      mode,
      metadata,
      stage: metadata.stage,
      product: metadata.product,
      suite: metadata.suite,
      topic: metadata.topic,
      dir: evalDir,
      localDir: hasLocal ? localDir : undefined,
      promptPath,
      evalPath,
      remoteDir: join(evalDir, 'remote'),
    });
  }
  return out;
}

export function readSessionSeedArgs(ev: EvalManifest) {
  const projectSeedSql = join(ev.remoteDir, 'project.sql');
  const logsSeedJsonl = join(ev.remoteDir, 'logs.jsonl');
  const functionsSeedDir = join(ev.remoteDir, 'functions');

  return {
    projectSeedSql: existsSync(projectSeedSql) ? projectSeedSql : undefined,
    logsSeedJsonl: existsSync(logsSeedJsonl) ? logsSeedJsonl : undefined,
    functionsSeedDir: existsSync(functionsSeedDir)
      ? functionsSeedDir
      : undefined,
    pgvector: ev.metadata.product.includes('vectors'),
  };
}

export function copyWithheldTests(ev: EvalManifest, workspace: string) {
  const testsDir = join(ev.dir, 'tests');
  if (existsSync(testsDir)) {
    cpSync(testsDir, join(workspace, 'tests'), { recursive: true });
  }
}

/**
 * Adapt a `{ close() }` resource to `AsyncDisposable` so it can be bound with
 * `await using` — cleanup then runs on scope exit (normal fall-through, `continue`,
 * `return`, or a throw), including when a *later* resource created in the same
 * scope throws before its own `try`/`finally` is reached.
 */
export function disposable<T extends { close(): Promise<unknown> }>(
  resource: T
): T & AsyncDisposable {
  return Object.assign(resource, {
    [Symbol.asyncDispose]: async () => {
      await resource.close();
    },
  });
}
