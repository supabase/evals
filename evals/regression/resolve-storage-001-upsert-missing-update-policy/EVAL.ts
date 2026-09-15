import {
  judge,
  serializeTranscript,
  type CheckResult,
  type SupabaseClient,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const BUCKET = 'avatars';
const PASSWORD = 'secret123';

const scorer: ToolScorer = async (ctx) => {
  try {
    const bucket = await findBucket(ctx);
    if (!bucket) {
      return {
        passed: false,
        checks: [
          {
            name: `bucket ${BUCKET} exists`,
            passed: false,
            notes: `no row in storage.buckets with id or name '${BUCKET}'`,
          },
        ],
      };
    }

    const setup = await setupTestUsers(ctx);
    if ('failure' in setup) {
      return { passed: false, checks: [setup.failure] };
    }
    const users = setup.users;

    await seedExistingAvatar(ctx, bucket.id, users);

    const checks: CheckResult[] = [
      { name: `bucket ${BUCKET} exists`, passed: true },
      {
        name: `bucket ${BUCKET} stays public`,
        passed: bucket.public === true,
        notes:
          'the bucket being public is intentional (avatars need a public URL); it is not the bug',
      },
      await checkRlsStillEnabled(ctx),
      await checkAnyoneCanReadAvatar(ctx, bucket.id, users),
      await checkUserACanReplaceOwnAvatar(users),
      await checkUserBCannotReplaceUserAAvatar(ctx, users, bucket.id),
      await checkFixedUploadPolicyConfiguration(ctx),
    ];

    return {
      passed: checks.every((check) => check.passed),
      checks,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated avatar upsert fix',
          passed: false,
          notes: msg,
        },
      ],
    };
  }
};

export default scorer;

type TestUsers = {
  clientA: SupabaseClient;
  clientB: SupabaseClient;
  userAId: string;
  userBId: string;
};

const avatarPath = (userId: string) => `${userId}/avatar.png`;

function storageObjects(client: SupabaseClient) {
  return client.schema('storage').from('objects');
}

async function findBucket(
  ctx: ToolEvalContext
): Promise<{ id: string; public: boolean | null } | undefined> {
  const { rows } = await ctx.query(
    `SELECT id, public FROM storage.buckets WHERE id = '${BUCKET}' OR name = '${BUCKET}' LIMIT 1;`
  );
  const row = rows[0];
  if (!row) return undefined;
  return { id: String(row.id), public: row.public as boolean | null };
}

async function setupTestUsers(
  ctx: ToolEvalContext
): Promise<{ users: TestUsers } | { failure: CheckResult }> {
  const clientA = ctx.client;
  const clientB = ctx.getClient();

  const { data: authA, error: authAError } = await clientA.auth.signUp({
    email: `avatar-upsert-a-${Date.now()}@example.com`,
    password: PASSWORD,
  });
  const { data: authB, error: authBError } = await clientB.auth.signUp({
    email: `avatar-upsert-b-${Date.now()}@example.com`,
    password: PASSWORD,
  });

  if (
    authAError ||
    authBError ||
    !authA.user?.id ||
    !authA.session ||
    !authB.user?.id ||
    !authB.session
  ) {
    return {
      failure: {
        name: 'created auth sessions',
        passed: false,
        notes: authAError?.message ?? authBError?.message ?? 'missing session',
      },
    };
  }

  return {
    users: { clientA, clientB, userAId: authA.user.id, userBId: authB.user.id },
  };
}

async function seedExistingAvatar(
  ctx: ToolEvalContext,
  bucketId: string,
  users: TestUsers
): Promise<void> {
  await ctx.query(`
INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata) VALUES
  ('${bucketId}', '${avatarPath(users.userAId)}', '${users.userAId}', '${users.userAId}', '{"version":"original"}'::jsonb);
  `);
}

async function checkRlsStillEnabled(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(`
SELECT c.relrowsecurity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'storage' AND c.relname = 'objects';
  `);

  return {
    name: 'RLS still enabled on storage.objects',
    passed: rows[0]?.relrowsecurity === true,
  };
}

async function checkAnyoneCanReadAvatar(
  ctx: ToolEvalContext,
  bucketId: string,
  users: TestUsers
): Promise<CheckResult> {
  const { data, error } = await storageObjects(ctx.getClient())
    .select('name')
    .eq('bucket_id', bucketId)
    .eq('name', avatarPath(users.userAId));

  return {
    name: 'anon can still read the public avatar',
    passed: !error && data?.length === 1,
    notes: error?.message,
  };
}

async function checkUserACanReplaceOwnAvatar(
  users: TestUsers
): Promise<CheckResult> {
  const { data, error } = await storageObjects(users.clientA)
    .upsert(
      {
        bucket_id: BUCKET,
        name: avatarPath(users.userAId),
        owner: users.userAId,
        owner_id: users.userAId,
        metadata: { version: 'replacement' },
      },
      { onConflict: 'bucket_id,name' }
    )
    .select('name,metadata');

  return {
    name: 'user A can replace their own avatar via upsert',
    passed:
      !error &&
      data?.length === 1 &&
      (data[0]?.metadata as Record<string, unknown> | undefined)?.version ===
        'replacement',
    notes: error?.message ?? `saw: ${JSON.stringify(data)}`,
  };
}

async function checkUserBCannotReplaceUserAAvatar(
  ctx: ToolEvalContext,
  users: TestUsers,
  bucketId: string
): Promise<CheckResult> {
  await storageObjects(users.clientB)
    .upsert(
      {
        bucket_id: bucketId,
        name: avatarPath(users.userAId),
        owner: users.userAId,
        owner_id: users.userAId,
        metadata: { version: 'planted by user B' },
      },
      { onConflict: 'bucket_id,name' }
    )
    .select('name');
  const { rows } = await ctx.query(
    `SELECT metadata->>'version' AS version FROM storage.objects WHERE bucket_id = '${bucketId}' AND name = '${avatarPath(users.userAId)}';`
  );

  return {
    name: "user B cannot overwrite user A's avatar",
    passed: rows[0]?.version !== 'planted by user B',
  };
}

async function checkFixedUploadPolicyConfiguration(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, {
      includeToolCallInputs: true,
    }),
    rubric: stripIndent`
      Pass if the assistant diagnoses the failed avatar replacement as a missing Row Level Security policy on storage.objects and fixes it by adding an owner-scoped UPDATE policy, without weakening the bucket's existing public-read setup.

      A passing answer should:
      - Recognize that upsert (insert ... on conflict do update) needs an UPDATE policy in addition to SELECT and INSERT, and that the bucket being public only affects the public download URL, not other operations.
      - Diagnose that storage.objects has SELECT and INSERT policies for the avatars bucket but no UPDATE policy, so replacing an existing file is silently rejected by RLS.
      - Add an UPDATE policy on storage.objects for the authenticated role scoped to the file owner, e.g. (storage.foldername(name))[1] = auth.uid()::text or owner_id = auth.uid()::text, applied via USING and WITH CHECK.
      - Keep the avatars bucket public and keep RLS enabled on storage.objects.

      Fail if the assistant makes the bucket private, disables RLS, writes a permissive UPDATE policy such as USING (true), scopes the UPDATE policy to anon/public instead of authenticated, tells the app to use the service role key client-side, or never adds the missing UPDATE policy.
    `,
  });

  return {
    name: 'added an owner-scoped UPDATE policy without weakening public reads',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
