import type { LocalStackEvalContext } from '@supabase-evals/core';
import { createClient } from '@supabase/supabase-js';
import type { Store } from './probes.js';

// `ctx.stackStatus()` wants the publishable key too; this only needs the
// admin key, under whichever name the CLI reports it.
export async function readStack(
  ctx: LocalStackEvalContext
): Promise<{ apiUrl: string; key: string }> {
  const result = await ctx.exec('supabase status -o json 2>/dev/null', {
    timeoutMs: 180_000,
  });
  const out = result.stdout ?? '';
  const parsed = JSON.parse(
    out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)
  );
  const apiUrl = parsed.API_URL;
  const key = parsed.SERVICE_ROLE_KEY || parsed.SECRET_KEY;
  if (!apiUrl || !key) {
    throw new Error(
      `supabase status had no API_URL or admin key: ${Object.keys(parsed).join(', ')}`
    );
  }
  return { apiUrl, key };
}

export function realStore(
  ctx: LocalStackEvalContext,
  stack: { apiUrl: string; key: string }
): Store {
  const client = createClient(stack.apiUrl, stack.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async upload(bucket, path, body, contentType) {
      const { error } = await client.storage
        .from(bucket)
        .upload(path, new Blob([new Uint8Array(body)], { type: contentType }), {
          contentType,
        });
      return { error: error?.message };
    },
    async stored(bucket, path) {
      const { rows } = await ctx.query(
        `select count(*)::int as n from storage.objects where bucket_id = '${bucket}' and name = '${path}';`
      );
      return Number(rows[0]?.n) > 0;
    },
    async fetchPublic(bucket, path) {
      const url = client.storage.from(bucket).getPublicUrl(path).data.publicUrl;
      const response = await fetch(url);
      return {
        status: response.status,
        body: new Uint8Array(await response.arrayBuffer()),
      };
    },
    async download(bucket, path) {
      const { data } = await client.storage.from(bucket).download(path);
      return data ? new Uint8Array(await data.arrayBuffer()) : undefined;
    },
  };
}

export async function listBuckets(ctx: LocalStackEvalContext): Promise<string> {
  const { rows } = await ctx.query(
    'select id, public from storage.buckets order by id;'
  );
  return rows.length === 0
    ? 'none'
    : rows.map((row) => `${row.id}${row.public ? ' (public)' : ''}`).join(', ');
}
