import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from "@supabase-evals/core";
import { stripIndent } from "common-tags";

const BUCKET = "user-files";
const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const FILE_A1 = `${USER_A}/receipt-alpha.pdf`;
const FILE_A2 = `${USER_A}/receipt-beta.pdf`;
const FILE_B = `${USER_B}/receipt-gamma.pdf`;

const asUser = (sub: string, body: string, finish: "COMMIT" | "ROLLBACK" = "COMMIT") => `
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '${sub}';
SET LOCAL request.jwt.claim.role = 'authenticated';
${body}
${finish};
`;

const asAnon = (body: string) => `
BEGIN;
SET LOCAL ROLE anon;
SET LOCAL request.jwt.claim.role = 'anon';
${body}
COMMIT;
`;

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

    await seedObjects(ctx, bucket.id);

    const checks: CheckResult[] = [
      { name: `bucket ${BUCKET} exists`, passed: true },
      {
        name: `bucket ${BUCKET} is private`,
        passed: bucket.public !== true,
      },
      await checkRlsStillEnabled(ctx),
      await checkUserAListsOnlyOwnFiles(ctx, bucket.id),
      await checkUserBCannotReadUserAFiles(ctx, bucket.id),
      await checkAnonReadsNoFiles(ctx, bucket.id),
      await checkUserACanUploadToOwnFolder(ctx, bucket.id),
      await checkUserBCannotUploadIntoUserAFolder(ctx, bucket.id),
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
          name: "scorer evaluated private storage access",
          passed: false,
          notes: msg,
        },
      ],
    };
  }
};

export default scorer;

async function findBucket(
  ctx: ToolEvalContext,
): Promise<{ id: string; public: boolean | null } | undefined> {
  const { rows } = await ctx.query(
    `SELECT id, public FROM storage.buckets WHERE id = '${BUCKET}' OR name = '${BUCKET}' LIMIT 1;`,
  );
  const row = rows[0];
  if (!row) return undefined;
  return { id: String(row.id), public: row.public as boolean | null };
}

async function seedObjects(ctx: ToolEvalContext, bucketId: string): Promise<void> {
  await ctx.query(`
INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
  ('${bucketId}', '${FILE_A1}', '${USER_A}', '${USER_A}'),
  ('${bucketId}', '${FILE_A2}', '${USER_A}', '${USER_A}'),
  ('${bucketId}', '${FILE_B}', '${USER_B}', '${USER_B}');
  `);
}

async function resetTx(ctx: ToolEvalContext): Promise<void> {
  try {
    await ctx.query("ROLLBACK;");
  } catch {
    // Clear aborted scorer transactions.
  }
}

async function checkRlsStillEnabled(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(`
SELECT c.relrowsecurity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'storage' AND c.relname = 'objects';
  `);

  return {
    name: "RLS still enabled on storage.objects",
    passed: rows[0]?.relrowsecurity === true,
  };
}

async function checkUserAListsOnlyOwnFiles(
  ctx: ToolEvalContext,
  bucketId: string,
): Promise<CheckResult> {
  try {
    const { rows } = await ctx.query(
      asUser(
        USER_A,
        `SELECT name FROM storage.objects WHERE bucket_id = '${bucketId}' ORDER BY name;`,
      ),
    );

    return {
      name: "user A lists only own files",
      passed: rows.length === 2 && rows[0]?.name === FILE_A1 && rows[1]?.name === FILE_A2,
      notes: `saw: ${rows.map((row) => row.name).join(", ") || "(none)"}`,
    };
  } catch (error) {
    await resetTx(ctx);
    const msg = error instanceof Error ? error.message : String(error);
    return { name: "user A lists only own files", passed: false, notes: msg };
  }
}

async function checkUserBCannotReadUserAFiles(
  ctx: ToolEvalContext,
  bucketId: string,
): Promise<CheckResult> {
  try {
    const { rows } = await ctx.query(
      asUser(
        USER_B,
        `SELECT id FROM storage.objects WHERE bucket_id = '${bucketId}' AND name = '${FILE_A1}';`,
      ),
    );

    return {
      name: "user B cannot read user A files",
      passed: rows.length === 0,
    };
  } catch (error) {
    await resetTx(ctx);
    const msg = error instanceof Error ? error.message : String(error);
    return { name: "user B cannot read user A files", passed: false, notes: msg };
  }
}

async function checkAnonReadsNoFiles(
  ctx: ToolEvalContext,
  bucketId: string,
): Promise<CheckResult> {
  try {
    const { rows } = await ctx.query(
      asAnon(`SELECT id FROM storage.objects WHERE bucket_id = '${bucketId}';`),
    );

    return {
      name: "anon reads no files",
      passed: rows.length === 0,
    };
  } catch {
    // A permission error also means anon cannot read files.
    await resetTx(ctx);
    return { name: "anon reads no files", passed: true };
  }
}

async function checkUserACanUploadToOwnFolder(
  ctx: ToolEvalContext,
  bucketId: string,
): Promise<CheckResult> {
  try {
    const { rows } = await ctx.query(
      asUser(
        USER_A,
        `
INSERT INTO storage.objects (bucket_id, name, owner, owner_id)
VALUES ('${bucketId}', '${USER_A}/receipt-delta.pdf', '${USER_A}', '${USER_A}')
RETURNING id;
        `,
        "ROLLBACK",
      ),
    );

    return {
      name: "user A can upload into own folder",
      passed: rows.length === 1,
    };
  } catch (error) {
    await resetTx(ctx);
    const msg = error instanceof Error ? error.message : String(error);
    return { name: "user A can upload into own folder", passed: false, notes: msg };
  }
}

async function checkUserBCannotUploadIntoUserAFolder(
  ctx: ToolEvalContext,
  bucketId: string,
): Promise<CheckResult> {
  try {
    const { rows } = await ctx.query(
      asUser(
        USER_B,
        `
INSERT INTO storage.objects (bucket_id, name, owner, owner_id)
VALUES ('${bucketId}', '${USER_A}/planted.pdf', '${USER_A}', '${USER_A}')
RETURNING id;
        `,
        "ROLLBACK",
      ),
    );

    return {
      name: "user B cannot upload into user A folder",
      passed: rows.length === 0,
    };
  } catch {
    await resetTx(ctx);
    return { name: "user B cannot upload into user A folder", passed: true };
  }
}

async function checkPrivateAccessConfiguration(
  ctx: ToolEvalContext,
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
    name: "configured private per-user storage access",
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
