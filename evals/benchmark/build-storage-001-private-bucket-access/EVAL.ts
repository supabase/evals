import {
  judge,
  serializeTranscript,
  type CheckResult,
  type SupabaseClient,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const BUCKET = 'user-files';
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

    await seedObjects(ctx, bucket.id, users);

    const checks: CheckResult[] = [
      { name: `bucket ${BUCKET} exists`, passed: true },
      {
        name: `bucket ${BUCKET} is private`,
        passed: bucket.public !== true,
      },
      await checkRlsStillEnabled(ctx),
      await checkUserAListsOnlyOwnFiles(users, bucket.id),
      await checkUserBCannotReadUserAFiles(users, bucket.id),
      await checkAnonReadsNoFiles(ctx, bucket.id),
      await checkUserACanUploadToOwnFolder(users, bucket.id),
      await checkUserBCannotUploadIntoUserAFolder(ctx, users, bucket.id),
      await checkPrivateAccessConfiguration(ctx),
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
          name: 'scorer evaluated private storage access',
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

const fileA1 = (users: TestUsers) => `${users.userAId}/receipt-alpha.pdf`;
const fileA2 = (users: TestUsers) => `${users.userAId}/receipt-beta.pdf`;
const fileB = (users: TestUsers) => `${users.userBId}/receipt-gamma.pdf`;

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
    email: `private-files-a-${Date.now()}@example.com`,
    password: PASSWORD,
  });
  const { data: authB, error: authBError } = await clientB.auth.signUp({
    email: `private-files-b-${Date.now()}@example.com`,
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

async function seedObjects(
  ctx: ToolEvalContext,
  bucketId: string,
  users: TestUsers
): Promise<void> {
  await ctx.query(`
INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
  ('${bucketId}', '${fileA1(users)}', '${users.userAId}', '${users.userAId}'),
  ('${bucketId}', '${fileA2(users)}', '${users.userAId}', '${users.userAId}'),
  ('${bucketId}', '${fileB(users)}', '${users.userBId}', '${users.userBId}');
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

async function checkUserAListsOnlyOwnFiles(
  users: TestUsers,
  bucketId: string
): Promise<CheckResult> {
  const { data, error } = await storageObjects(users.clientA)
    .select('name')
    .eq('bucket_id', bucketId)
    .order('name');

  return {
    name: 'user A lists only own files',
    passed:
      !error &&
      data?.length === 2 &&
      data[0]?.name === fileA1(users) &&
      data[1]?.name === fileA2(users),
    notes:
      error?.message ??
      `saw: ${data?.map((row) => row.name).join(', ') || '(none)'}`,
  };
}

async function checkUserBCannotReadUserAFiles(
  users: TestUsers,
  bucketId: string
): Promise<CheckResult> {
  const { data, error } = await storageObjects(users.clientB)
    .select('id')
    .eq('bucket_id', bucketId)
    .eq('name', fileA1(users));

  return {
    name: 'user B cannot read user A files',
    passed: !error && Array.isArray(data) && data.length === 0,
    notes: error?.message,
  };
}

async function checkAnonReadsNoFiles(
  ctx: ToolEvalContext,
  bucketId: string
): Promise<CheckResult> {
  const { data, error } = await storageObjects(ctx.getClient())
    .select('id')
    .eq('bucket_id', bucketId);

  return {
    name: 'anon reads no files',
    passed: error !== null || data?.length === 0,
  };
}

async function checkUserACanUploadToOwnFolder(
  users: TestUsers,
  bucketId: string
): Promise<CheckResult> {
  const { data, error } = await storageObjects(users.clientA)
    .insert({
      bucket_id: bucketId,
      name: `${users.userAId}/receipt-delta.pdf`,
      owner: users.userAId,
      owner_id: users.userAId,
    })
    .select('name');

  return {
    name: 'user A can upload into own folder',
    passed: !error && data?.length === 1,
    notes: error?.message,
  };
}

async function checkUserBCannotUploadIntoUserAFolder(
  ctx: ToolEvalContext,
  users: TestUsers,
  bucketId: string
): Promise<CheckResult> {
  await storageObjects(users.clientB)
    .insert({
      bucket_id: bucketId,
      name: `${users.userAId}/planted.pdf`,
      owner: users.userAId,
      owner_id: users.userAId,
    })
    .select('id');
  const { rows } = await ctx.query(
    `SELECT count(*)::int AS count FROM storage.objects WHERE name = '${users.userAId}/planted.pdf';`
  );

  return {
    name: 'user B cannot upload into user A folder',
    passed: rows[0]?.count === 0,
  };
}

async function checkPrivateAccessConfiguration(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, {
      includeToolCallInputs: true,
    }),
    rubric: stripIndent`
      Pass if the assistant configures private per-user Storage access: a private user-files bucket, owner-scoped RLS policies on storage.objects, and supabase-js code that shares a file through a short-lived signed URL.

      A passing answer should:
      - Create the user-files bucket as private (public = false or default).
      - Create a SELECT (download) policy on storage.objects for the authenticated role scoped to the user-files bucket and to the file owner, e.g. (storage.foldername(name))[1] = auth.uid()::text or owner_id = auth.uid()::text.
      - Create an INSERT (upload) policy on storage.objects for the authenticated role enforcing the same owner scoping via WITH CHECK.
      - Keep RLS enabled on storage.objects.
      - Provide supabase-js code that calls createSignedUrl (or createSignedUrls) with an expiry to produce the temporary sharing link.

      Fail if the assistant makes the bucket public, disables RLS on storage.objects, writes permissive policies such as USING (true), scopes object access policies to anon/public roles, produces the sharing link with getPublicUrl or by making the bucket public, or tells the app to use the service role key in client-side code.
    `,
  });

  return {
    name: 'configured private per-user storage access',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
