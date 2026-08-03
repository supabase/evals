/**
 * Hand-authored ground truth for the trigger suite, derived from the 38
 * canonical Supabase eval prompts (evals/<id>/PROMPT.md). For each prompt,
 * records which of the two closed-set skills should load on the prompt text
 * alone.
 *
 * Rule (unchanged from the prior corpus):
 *   supabase (S) ∈ expected  iff the prompt carries a Supabase signal. All 38
 *     canonical prompts name Supabase (or an unmistakable Supabase-only
 *     concern: Edge Functions, Realtime, storage buckets, self-hosting), so
 *     every entry expects S.
 *   supabase-postgres-best-practices (P) ∈ expected  iff the prompt is about
 *     Postgres mechanics the reference rules cover — schema/RLS/migration/
 *     query/index/performance. Edge-function/Realtime/storage/auth/
 *     self-hosting/observability-integration prompts are Supabase-meta, not
 *     Postgres mechanics, so a correct agent skips P on them.
 */
import type { Category } from './prompts.js';

export const SKILL_SUPABASE = 'supabase';
export const SKILL_POSTGRES = 'supabase-postgres-best-practices';

/** The closed set of skills the trigger suite exercises. */
export const TRIGGER_SKILLS = [SKILL_SUPABASE, SKILL_POSTGRES] as const;

export type GoldenEntry = {
  promptIndex: number;
  category: Category;
  expectedSkills: readonly string[];
  sourceEval: string;
  notes?: string;
};

const S = SKILL_SUPABASE;
const P = SKILL_POSTGRES;

export const golden: GoldenEntry[] = [
  // 0: build-cli-001-bootstrap-app
  {
    promptIndex: 0,
    category: 'general',
    expectedSkills: [S, P],
    sourceEval: 'build-cli-001-bootstrap-app',
  },
  // 1: build-cli-002-declarative-schema
  {
    promptIndex: 1,
    category: 'schema',
    expectedSkills: [S, P],
    sourceEval: 'build-cli-002-declarative-schema',
  },
  // 2: build-cli-003-pg-cron-queue-workflow
  {
    promptIndex: 2,
    category: 'general',
    expectedSkills: [S, P],
    sourceEval: 'build-cli-003-pg-cron-queue-workflow',
  },
  // 3: build-database-001-migrate-postgres-to-supabase
  {
    promptIndex: 3,
    category: 'schema',
    expectedSkills: [S, P],
    sourceEval: 'build-database-001-migrate-postgres-to-supabase',
  },
  // 4: build-frontend-001-todos-app
  {
    promptIndex: 4,
    category: 'general',
    expectedSkills: [S, P],
    sourceEval: 'build-frontend-001-todos-app',
  },
  // 5: build-functions-001-order-total
  {
    promptIndex: 5,
    category: 'general',
    expectedSkills: [S],
    sourceEval: 'build-functions-001-order-total',
  },
  // 6: build-functions-002-edge-auth-db
  {
    promptIndex: 6,
    category: 'general',
    expectedSkills: [S],
    sourceEval: 'build-functions-002-edge-auth-db',
  },
  // 7: build-functions-003-todos-crud-api
  {
    promptIndex: 7,
    category: 'general',
    expectedSkills: [S],
    sourceEval: 'build-functions-003-todos-crud-api',
  },
  // 8: build-functions-004-service-role-bypass
  {
    promptIndex: 8,
    category: 'security',
    expectedSkills: [S, P],
    sourceEval: 'build-functions-004-service-role-bypass',
  },
  // 9: build-functions-005-dual-auth-user-secret
  {
    promptIndex: 9,
    category: 'security',
    expectedSkills: [S],
    sourceEval: 'build-functions-005-dual-auth-user-secret',
  },
  // 10: build-functions-006-dual-auth-with-server
  {
    promptIndex: 10,
    category: 'security',
    expectedSkills: [S],
    sourceEval: 'build-functions-006-dual-auth-with-server',
  },
  // 11: build-realtime-001-live-chat-updates
  {
    promptIndex: 11,
    category: 'general',
    expectedSkills: [S],
    sourceEval: 'build-realtime-001-live-chat-updates',
  },
  // 12: build-rls-002-own-todos-client
  {
    promptIndex: 12,
    category: 'security',
    expectedSkills: [S, P],
    sourceEval: 'build-rls-002-own-todos-client',
  },
  // 13: build-rls-003-org-roles-permissions
  {
    promptIndex: 13,
    category: 'security',
    expectedSkills: [S, P],
    sourceEval: 'build-rls-003-org-roles-permissions',
  },
  // 14: build-storage-001-private-bucket-access
  {
    promptIndex: 14,
    category: 'security',
    expectedSkills: [S],
    sourceEval: 'build-storage-001-private-bucket-access',
  },
  // 15: build-tests-001-rls-tenant-isolation
  {
    promptIndex: 15,
    category: 'security',
    expectedSkills: [S, P],
    sourceEval: 'build-tests-001-rls-tenant-isolation',
  },
  // 16: build-vectors-001-rag-with-permissions
  {
    promptIndex: 16,
    category: 'schema',
    expectedSkills: [S, P],
    sourceEval: 'build-vectors-001-rag-with-permissions',
  },
  // 17: deploy-database-001-prometheus-metrics
  {
    promptIndex: 17,
    category: 'monitoring',
    expectedSkills: [S],
    sourceEval: 'deploy-database-001-prometheus-metrics',
  },
  // 18: deploy-functions-001-edge-function-secrets
  {
    promptIndex: 18,
    category: 'general',
    expectedSkills: [S],
    sourceEval: 'deploy-functions-001-edge-function-secrets',
  },
  // 19: deploy-self-hosting-001-docker-compose
  {
    promptIndex: 19,
    category: 'general',
    expectedSkills: [S],
    sourceEval: 'deploy-self-hosting-001-docker-compose',
  },
  // 20: investigate-auth-001-deleted-user-access
  {
    promptIndex: 20,
    category: 'security',
    expectedSkills: [S],
    sourceEval: 'investigate-auth-001-deleted-user-access',
  },
  // 21: investigate-db-001-table-row-counts
  {
    promptIndex: 21,
    category: 'schema',
    expectedSkills: [S, P],
    sourceEval: 'investigate-db-001-table-row-counts',
  },
  // 22: investigate-functions-001-546-resource-limit
  {
    promptIndex: 22,
    category: 'monitoring',
    expectedSkills: [S],
    sourceEval: 'investigate-functions-001-546-resource-limit',
  },
  // 23: investigate-logs-001-top-error-function
  {
    promptIndex: 23,
    category: 'monitoring',
    expectedSkills: [S],
    sourceEval: 'investigate-logs-001-top-error-function',
  },
  // 24: investigate-realtime-001-subscribed-no-events
  {
    promptIndex: 24,
    category: 'general',
    expectedSkills: [S],
    sourceEval: 'investigate-realtime-001-subscribed-no-events',
  },
  // 25: investigate-reliability-001-error-rate-spike
  {
    promptIndex: 25,
    category: 'monitoring',
    expectedSkills: [S],
    sourceEval: 'investigate-reliability-001-error-rate-spike',
  },
  // 26: investigate-reliability-002-subtle-error-spike
  {
    promptIndex: 26,
    category: 'monitoring',
    expectedSkills: [S],
    sourceEval: 'investigate-reliability-002-subtle-error-spike',
  },
  // 27: investigate-reliability-003-edge-function-5xx-correlation
  {
    promptIndex: 27,
    category: 'monitoring',
    expectedSkills: [S],
    sourceEval: 'investigate-reliability-003-edge-function-5xx-correlation',
  },
  // 28: investigate-security-001-public-table
  {
    promptIndex: 28,
    category: 'security',
    expectedSkills: [S, P],
    sourceEval: 'investigate-security-001-public-table',
  },
  // 29: resolve-dataapi-001-empty-results
  {
    promptIndex: 29,
    category: 'data-ops',
    expectedSkills: [S, P],
    sourceEval: 'resolve-dataapi-001-empty-results',
  },
  // 30: resolve-dataapi-002-secure-default-grants
  {
    promptIndex: 30,
    category: 'data-ops',
    expectedSkills: [S, P],
    sourceEval: 'resolve-dataapi-002-secure-default-grants',
  },
  // 31: resolve-dataapi-002-update-zero-rows-affected
  {
    promptIndex: 31,
    category: 'data-ops',
    expectedSkills: [S, P],
    sourceEval: 'resolve-dataapi-002-update-zero-rows-affected',
  },
  // 32: resolve-database-001-migration-history-mismatch
  {
    promptIndex: 32,
    category: 'schema',
    expectedSkills: [S, P],
    sourceEval: 'resolve-database-001-migration-history-mismatch',
  },
  // 33: resolve-performance-001-slow-query-cpu-spike
  {
    promptIndex: 33,
    category: 'performance',
    expectedSkills: [S, P],
    sourceEval: 'resolve-performance-001-slow-query-cpu-spike',
  },
  // 34: resolve-reliability-001-unhealthy-project-recovery
  {
    promptIndex: 34,
    category: 'monitoring',
    expectedSkills: [S],
    sourceEval: 'resolve-reliability-001-unhealthy-project-recovery',
  },
  // 35: resolve-security-001-rls-cross-user-leak
  {
    promptIndex: 35,
    category: 'security',
    expectedSkills: [S, P],
    sourceEval: 'resolve-security-001-rls-cross-user-leak',
  },
  // 36: resolve-security-002-rls-cross-tenant-leak
  {
    promptIndex: 36,
    category: 'security',
    expectedSkills: [S, P],
    sourceEval: 'resolve-security-002-rls-cross-tenant-leak',
  },
  // 37: resolve-storage-001-upsert-missing-update-policy
  {
    promptIndex: 37,
    category: 'security',
    expectedSkills: [S, P],
    sourceEval: 'resolve-storage-001-upsert-missing-update-policy',
  },
];

/** Invariant: one golden entry per prompt, in index order. */
export function assertGoldenCoversAll(
  prompts: { text: string; category: Category }[]
): void {
  if (golden.length !== prompts.length) {
    throw new Error(
      `golden has ${golden.length} entries; prompts has ${prompts.length}`
    );
  }
  for (let i = 0; i < golden.length; i++) {
    if (golden[i].promptIndex !== i) {
      throw new Error(
        `golden[${i}].promptIndex=${golden[i].promptIndex}, expected ${i}`
      );
    }
  }
}
