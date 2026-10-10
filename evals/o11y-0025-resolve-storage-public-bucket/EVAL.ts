import {
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: storage bucket 'public-assets' has public=true and no owner policy.
// The fix sets public=false and adds an owner-scoped SELECT policy.

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkBucketIsPrivate(ctx),
      await checkOwnerPolicyExists(ctx),
    ];
    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: 'scorer evaluated public bucket fix', passed: false, notes: msg }],
    };
  }
};

export default scorer;

async function checkBucketIsPrivate(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT name, public FROM storage.buckets
    WHERE id = 'public-assets';
  `);
  if (rows.length === 0) {
    return {
      name: 'public-assets bucket is private',
      passed: false,
      notes: 'bucket not found',
    };
  }
  return {
    name: 'public-assets bucket is private (public=false)',
    passed: rows[0]?.public === false,
    notes: `public=${rows[0]?.public}`,
  };
}

async function checkOwnerPolicyExists(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND (cmd = 'SELECT' OR cmd = 'ALL');
  `);
  return {
    name: 'owner-scoped SELECT policy exists on storage.objects',
    passed: rows.length >= 1,
    notes: `policies: ${rows.map(r => r.policyname).join(', ') || 'none'}`,
  };
}
