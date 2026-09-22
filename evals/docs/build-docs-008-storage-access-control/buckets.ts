import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

export type BucketRow = {
  id: string;
  name: string;
  public: boolean;
};

export async function loadBuckets(
  ctx: LocalStackEvalContext
): Promise<BucketRow[]> {
  const { rows } = await ctx.query(
    'SELECT id, name, public FROM storage.buckets ORDER BY created_at, id;'
  );
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name ?? row.id),
    public: row.public === true,
  }));
}

export function checkBucketExists(buckets: BucketRow[]): CheckResult {
  return {
    name: 'the project has a bucket for the profile pictures',
    passed: buckets.length > 0,
    notes:
      buckets.length > 0
        ? buckets.map((bucket) => bucket.id).join(', ')
        : 'storage.buckets is empty',
  };
}

export function checkBucketsArePrivate(buckets: BucketRow[]): CheckResult {
  const exposed = buckets.filter((bucket) => bucket.public);
  return {
    name: 'every bucket in the project is private',
    passed: buckets.length > 0 && exposed.length === 0,
    notes:
      buckets.length === 0
        ? 'not run: the agent created no bucket'
        : exposed.length > 0
          ? `public: ${exposed.map((bucket) => bucket.id).join(', ')}`
          : `private: ${buckets.map((bucket) => bucket.id).join(', ')}`,
  };
}

export async function checkRlsEnabled(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(`
    SELECT c.relrowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage' AND c.relname = 'objects';
  `);
  const enabled = rows[0]?.relrowsecurity === true;
  return {
    name: 'row level security is enabled on storage.objects',
    passed: enabled,
    notes: enabled ? undefined : 'relrowsecurity is false',
  };
}

export function pickProbeBucket(buckets: BucketRow[]): BucketRow | undefined {
  const feature = /avatar|profile|picture|photo|image|upload/i;
  return buckets.find((bucket) => feature.test(bucket.id)) ?? buckets[0];
}
