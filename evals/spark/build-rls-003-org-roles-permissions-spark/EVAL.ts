import type {
  CheckResult,
  SupabaseClient,
  ToolScorer,
} from '@supabase-evals/core';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const ADMIN_DOC = '10000000-0000-0000-0000-000000000001';
const EDITOR_DOC = '10000000-0000-0000-0000-000000000002';
const OTHER_DOC = '20000000-0000-0000-0000-000000000001';

const scorer: ToolScorer = async (ctx) => {
  const actors = new Map<string, { client: SupabaseClient; id: string }>();
  for (const spec of [
    { name: 'admin', previous: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
    { name: 'editor', previous: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
    { name: 'viewer', previous: 'cccccccc-cccc-cccc-cccc-cccccccccccc' },
    { name: 'multi', previous: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' },
  ]) {
    const client = ctx.getClient();
    const { data, error } = await client.auth.signUp({
      email: `${spec.name}@example.com`,
      password: 'spark-role-password-123',
    });
    if (
      error ||
      !data.session ||
      !data.user ||
      !/^[0-9a-f-]{36}$/i.test(data.user.id)
    )
      return {
        passed: false,
        checks: [
          {
            name: 'created real auth sessions',
            passed: false,
            notes: error?.message ?? 'missing session or valid user id',
          },
        ],
      };
    actors.set(spec.name, { client, id: data.user.id });
    await ctx.query(
      `update memberships set user_id = '${data.user.id}' where user_id = '${spec.previous}'`
    );
  }
  const actor = (name: string) => {
    const value = actors.get(name);
    if (!value) throw new Error(`missing actor ${name}`);
    return value;
  };
  const resetDocs = () =>
    ctx.query(`
    delete from documents;
    insert into documents(id, org_id, owner_id, title, body) values
      ('${ADMIN_DOC}', '${ORG_A}', '${actor('admin').id}', 'Admin plan', 'org A admin document'),
      ('${EDITOR_DOC}', '${ORG_A}', '${actor('editor').id}', 'Editor draft', 'org A editor document'),
      ('${OTHER_DOC}', '${ORG_B}', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'Org B draft', 'org B editor document');
  `);
  const checks: CheckResult[] = [];
  const check = async (name: string, run: () => Promise<boolean>) => {
    try {
      // The original SQL checks rolled back each request. Reset only business rows here.
      await resetDocs();
      checks.push({ name, passed: await run() });
    } catch (error) {
      checks.push({
        name,
        passed: false,
        notes: error instanceof Error ? error.message : String(error),
      });
    }
  };
  await check('RLS enabled on documents', async () => {
    const { rows } = await ctx.query(
      "select relrowsecurity from pg_class where relname = 'documents'"
    );
    return rows[0]?.relrowsecurity === true || rows[0]?.relrowsecurity === 1;
  });
  await check('viewer sees only documents in their org', async () => {
    const { data, error } = await actor('viewer')
      .client.from('documents')
      .select('org_id')
      .order('title');
    return (
      !error && data?.length === 2 && data.every((row) => row.org_id === ORG_A)
    );
  });
  await check('viewer cannot insert', async () =>
    denied(
      await actor('viewer')
        .client.from('documents')
        .insert({
          org_id: ORG_A,
          owner_id: actor('viewer').id,
          title: 'probe',
          body: 'probe',
        })
        .select('id')
    )
  );
  await check('editor can insert own org document', async () => {
    const result = await actor('editor')
      .client.from('documents')
      .insert({
        org_id: ORG_A,
        owner_id: actor('editor').id,
        title: 'probe',
        body: 'probe',
      })
      .select('id');
    return !result.error && result.data?.length === 1;
  });
  await check('editor can update own document', async () => {
    const result = await actor('editor')
      .client.from('documents')
      .update({ body: 'updated' })
      .eq('id', EDITOR_DOC)
      .select('id');
    return !result.error && result.data?.length === 1;
  });
  await check("editor cannot update another user's document", async () =>
    denied(
      await actor('editor')
        .client.from('documents')
        .update({ body: 'updated' })
        .eq('id', ADMIN_DOC)
        .select('id')
    )
  );
  await check("editor cannot delete another user's document", async () =>
    denied(
      await actor('editor')
        .client.from('documents')
        .delete()
        .eq('id', ADMIN_DOC)
        .select('id')
    )
  );
  await check('admin can update any document in their org', async () => {
    const result = await actor('admin')
      .client.from('documents')
      .update({ body: 'updated' })
      .eq('id', EDITOR_DOC)
      .select('id');
    return !result.error && result.data?.length === 1;
  });
  await check('admin can delete any document in their org', async () => {
    const result = await actor('admin')
      .client.from('documents')
      .delete()
      .eq('id', EDITOR_DOC)
      .select('id');
    return !result.error && result.data?.length === 1;
  });
  await check('admin cannot affect another org', async () =>
    denied(
      await actor('admin')
        .client.from('documents')
        .update({ body: 'updated' })
        .eq('id', OTHER_DOC)
        .select('id')
    )
  );
  await check('WITH CHECK blocks moving a document to another org', async () =>
    denied(
      await actor('editor')
        .client.from('documents')
        .update({ org_id: ORG_B })
        .eq('id', EDITOR_DOC)
        .select('id')
    )
  );
  await check('editor sees their own org membership roster', async () => {
    const result = await actor('editor')
      .client.from('memberships')
      .select('user_id')
      .eq('org_id', ORG_A);
    return !result.error && result.data?.length === 4;
  });
  await check('editor cannot see another org membership roster', async () =>
    denied(
      await actor('editor')
        .client.from('memberships')
        .select('user_id')
        .eq('org_id', ORG_B)
    )
  );
  await check(
    'admin role in another org does not grant writes here',
    async () =>
      denied(
        await actor('multi')
          .client.from('documents')
          .update({ body: 'updated' })
          .eq('id', ADMIN_DOC)
          .select('id')
      )
  );
  await check('own-org admin role still grants writes', async () => {
    const result = await actor('multi')
      .client.from('documents')
      .update({ body: 'updated' })
      .eq('id', OTHER_DOC)
      .select('id');
    return !result.error && result.data?.length === 1;
  });
  return { passed: checks.every((result) => result.passed), checks };
};

function denied(result: {
  error: { code: string } | null;
  data: unknown[] | null;
}): boolean {
  return result.error
    ? result.error.code === '42501'
    : result.data?.length === 0;
}

export default scorer;
