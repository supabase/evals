import { randomUUID } from 'node:crypto';
import type {
  CheckResult,
  LocalStackEvalContext,
  SupabaseClient,
} from '@supabase-evals/core';
import type { BucketRow } from './buckets.js';

const PASSWORD = 'secret123';

export type Probes = {
  bucket: BucketRow;
  anonClient: SupabaseClient;
  ownerClient: SupabaseClient;
  strangerClient: SupabaseClient;
  ownerId: string;
  strangerId: string;
  picturePath: string;
  marker: string;
};

export type Setup = { probes: Probes } | { failure: string };

export async function setupProbes(
  ctx: LocalStackEvalContext,
  bucket: BucketRow
): Promise<Setup> {
  const anonClient = await ctx.getClient();
  const ownerClient = await ctx.getClient();
  const strangerClient = await ctx.getClient();
  const run = randomUUID().slice(0, 8);
  const { data: owner, error: ownerError } = await ownerClient.auth.signUp({
    email: `pictures-owner-${run}@example.com`,
    password: PASSWORD,
  });
  const { data: stranger, error: strangerError } =
    await strangerClient.auth.signUp({
      email: `pictures-stranger-${run}@example.com`,
      password: PASSWORD,
    });
  if (
    ownerError ||
    strangerError ||
    !owner.user?.id ||
    !owner.session ||
    !stranger.user?.id ||
    !stranger.session
  ) {
    return {
      failure:
        ownerError?.message ??
        strangerError?.message ??
        'signed up without a session',
    };
  }
  return {
    probes: {
      bucket,
      anonClient,
      ownerClient,
      strangerClient,
      ownerId: owner.user.id,
      strangerId: stranger.user.id,
      picturePath: `${owner.user.id}/portrait-${run}.txt`,
      marker: `lumen-picture-${run}`,
    },
  };
}

export async function checkOwnerCanUpload(
  ctx: LocalStackEvalContext,
  probes: Probes
): Promise<CheckResult> {
  const { error } = await probes.ownerClient.storage
    .from(probes.bucket.id)
    .upload(probes.picturePath, new Blob([probes.marker]), {
      contentType: 'text/plain',
    });
  const stored = await objectExists(ctx, probes);
  return {
    name: 'the owner can upload their own profile picture',
    passed: stored,
    notes: stored
      ? `${probes.bucket.id}/${probes.picturePath}`
      : `nothing stored at ${probes.bucket.id}/${probes.picturePath}: ${error?.message ?? 'upload reported no error'}`,
  };
}

export async function checkOwnerSeesOwnPicture(
  probes: Probes
): Promise<CheckResult> {
  const { data, error } = await probes.ownerClient.storage
    .from(probes.bucket.id)
    .list(probes.ownerId);
  const names = (data ?? []).map((entry) => entry.name);
  const file = probes.picturePath.slice(probes.ownerId.length + 1);
  return {
    name: 'the owner can see their own profile picture listed',
    passed: names.includes(file),
    notes:
      error?.message ??
      `saw in ${probes.bucket.id}/${probes.ownerId}: ${names.join(', ') || '(nothing)'}`,
  };
}

export async function checkOwnerCanRead(probes: Probes): Promise<CheckResult> {
  const { data, error } = await probes.ownerClient.storage
    .from(probes.bucket.id)
    .download(probes.picturePath);
  const body = data ? await data.text() : undefined;
  return {
    name: 'the owner can read their own profile picture back',
    passed: body === probes.marker,
    notes:
      error?.message ??
      (body === probes.marker
        ? undefined
        : `downloaded ${body === undefined ? 'nothing' : `${body.length} bytes that are not this run's file`}`),
  };
}

export async function checkStrangerCannotRead(
  probes: Probes
): Promise<CheckResult> {
  const { data, error } = await probes.strangerClient.storage
    .from(probes.bucket.id)
    .download(probes.picturePath);
  const body = data ? await data.text() : undefined;
  return {
    name: "another signed-in person cannot read the owner's profile picture",
    passed: body !== probes.marker,
    notes:
      body === probes.marker
        ? `a second signed-in account downloaded ${probes.bucket.id}/${probes.picturePath}`
        : (error?.message ?? 'returned no file'),
  };
}

export async function checkStrangerCannotList(
  probes: Probes
): Promise<CheckResult> {
  const prefix = await probes.strangerClient.storage
    .from(probes.bucket.id)
    .list(probes.ownerId);
  const root = await probes.strangerClient.storage
    .from(probes.bucket.id)
    .list('');
  const seen = [
    ...(prefix.data ?? []).map((entry) => `${probes.ownerId}/${entry.name}`),
    ...(root.data ?? []).map((entry) => entry.name),
  ];
  return {
    name: "another signed-in person cannot list the owner's profile pictures",
    passed: seen.length === 0,
    notes:
      seen.length === 0
        ? (prefix.error?.message ?? root.error?.message ?? 'listed nothing')
        : `a second signed-in account listed: ${seen.join(', ')}`,
  };
}

export async function checkAnonCannotRead(
  probes: Probes
): Promise<CheckResult> {
  const { data, error } = await probes.anonClient.storage
    .from(probes.bucket.id)
    .download(probes.picturePath);
  const body = data ? await data.text() : undefined;
  return {
    name: "a signed-out visitor cannot read the owner's profile picture",
    passed: body !== probes.marker,
    notes:
      body === probes.marker
        ? `an unauthenticated caller downloaded ${probes.bucket.id}/${probes.picturePath}`
        : (error?.message ?? 'returned no file'),
  };
}

export async function checkPublicUrlDoesNotServe(
  probes: Probes
): Promise<CheckResult> {
  const { publicUrl } = probes.anonClient.storage
    .from(probes.bucket.id)
    .getPublicUrl(probes.picturePath).data;
  let status: number;
  let body: string;
  try {
    const response = await fetch(publicUrl);
    status = response.status;
    body = await response.text();
  } catch (error) {
    return {
      name: "the owner's profile picture is not served over the bucket's public url",
      passed: false,
      notes: `could not reach ${publicUrl}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const served = status === 200 && body === probes.marker;
  return {
    name: "the owner's profile picture is not served over the bucket's public url",
    passed: !served,
    notes: served
      ? `${publicUrl} returned the file`
      : `${publicUrl} answered ${status}`,
  };
}

export async function checkStrangerCannotWrite(
  ctx: LocalStackEvalContext,
  probes: Probes
): Promise<CheckResult> {
  const planted = `${probes.ownerId}/planted-${probes.marker}.txt`;
  const { error } = await probes.strangerClient.storage
    .from(probes.bucket.id)
    .upload(planted, new Blob([probes.marker]), { contentType: 'text/plain' });
  const { rows } = await ctx.query(`
    SELECT count(*)::int AS count
    FROM storage.objects
    WHERE bucket_id = '${probes.bucket.id}' AND name = '${planted}';
  `);
  const count = Number(rows[0]?.count ?? 0);
  return {
    name: "another signed-in person cannot write into the owner's own area",
    passed: count === 0,
    notes:
      count === 0
        ? (error?.message ?? 'stored nothing')
        : `a second signed-in account stored ${probes.bucket.id}/${planted}`,
  };
}

async function objectExists(
  ctx: LocalStackEvalContext,
  probes: Probes
): Promise<boolean> {
  const { rows } = await ctx.query(`
    SELECT count(*)::int AS count
    FROM storage.objects
    WHERE bucket_id = '${probes.bucket.id}' AND name = '${probes.picturePath}';
  `);
  return Number(rows[0]?.count ?? 0) > 0;
}
