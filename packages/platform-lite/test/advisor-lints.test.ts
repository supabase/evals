import { describe, it, expect } from 'vitest';
import { createTestApp, request } from './helpers.js';

type Lint = {
  name: string;
  level: string;
  categories: string[];
  detail: string;
  remediation: string;
  metadata: { schema: string; name: string; type: string };
  cache_key: string;
};

async function lints(sql: string, kind: 'security' | 'performance') {
  const app = await createTestApp([{ ref: 'lint-proj', sql }]);
  const { status, data } = await request<{ lints: Lint[] }>(
    app,
    'GET',
    `/v1/projects/lint-proj/advisors/${kind}`
  );
  expect(status).toBe(200);
  return data.lints;
}

const names = (ls: Lint[], name: string) =>
  ls.filter((l) => l.name === name).map((l) => l.metadata.name);

describe('advisor lints', () => {
  it('policy_exists_rls_disabled flags a policy on a table without RLS', async () => {
    const ls = await lints(
      `CREATE TABLE public.notes (id int PRIMARY KEY);
       CREATE POLICY p ON public.notes FOR SELECT USING (true);
       CREATE TABLE public.ok (id int PRIMARY KEY);
       ALTER TABLE public.ok ENABLE ROW LEVEL SECURITY;
       CREATE POLICY p ON public.ok FOR SELECT USING (true);`,
      'security'
    );
    expect(names(ls, 'policy_exists_rls_disabled')).toEqual(['notes']);
    const lint = ls.find((l) => l.name === 'policy_exists_rls_disabled')!;
    expect(lint.level).toBe('ERROR');
    expect(lint.remediation).toBe(
      'https://supabase.com/docs/guides/database/database-linter?lint=0007_policy_exists_rls_disabled'
    );
  });

  it('rls_enabled_no_policy flags RLS on with no policy', async () => {
    const ls = await lints(
      `CREATE TABLE public.locked (id int PRIMARY KEY);
       ALTER TABLE public.locked ENABLE ROW LEVEL SECURITY;`,
      'security'
    );
    expect(names(ls, 'rls_enabled_no_policy')).toEqual(['locked']);
    expect(names(ls, 'rls_disabled_in_public')).toEqual([]);
  });

  it('security_definer_view flags views without security_invoker', async () => {
    const ls = await lints(
      `CREATE TABLE public.t (id int PRIMARY KEY);
       ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;
       CREATE POLICY p ON public.t FOR SELECT USING (true);
       CREATE VIEW public.v_definer AS SELECT id FROM public.t;
       CREATE VIEW public.v_invoker WITH (security_invoker = true) AS SELECT id FROM public.t;`,
      'security'
    );
    expect(names(ls, 'security_definer_view')).toEqual(['v_definer']);
  });

  it('function_search_path_mutable flags functions without search_path', async () => {
    const ls = await lints(
      `CREATE FUNCTION public.loose() RETURNS int LANGUAGE sql AS 'select 1';
       CREATE FUNCTION public.pinned() RETURNS int LANGUAGE sql SET search_path = '' AS 'select 1';`,
      'security'
    );
    expect(names(ls, 'function_search_path_mutable')).toEqual(['loose']);
    const lint = ls.find((l) => l.name === 'function_search_path_mutable')!;
    expect(lint.metadata.type).toBe('function');
    expect(lint.level).toBe('WARN');
  });

  it('materialized_view_in_api flags public matviews', async () => {
    const ls = await lints(
      `CREATE TABLE public.t (id int PRIMARY KEY);
       ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;
       CREATE POLICY p ON public.t FOR SELECT USING (true);
       CREATE MATERIALIZED VIEW public.mv AS SELECT id FROM public.t;`,
      'security'
    );
    expect(names(ls, 'materialized_view_in_api')).toEqual(['mv']);
  });

  it('unindexed_foreign_keys flags fks without a covering index', async () => {
    const ls = await lints(
      `CREATE TABLE public.orgs (id int PRIMARY KEY);
       CREATE TABLE public.a (id int PRIMARY KEY, org_id int REFERENCES public.orgs(id));
       CREATE TABLE public.b (id int PRIMARY KEY, org_id int REFERENCES public.orgs(id));
       CREATE INDEX ON public.b (org_id);`,
      'performance'
    );
    expect(names(ls, 'unindexed_foreign_keys')).toEqual(['a']);
    expect(ls.find((l) => l.name === 'unindexed_foreign_keys')!.categories).toEqual([
      'PERFORMANCE',
    ]);
  });

  it('no_primary_key flags tables without a pk', async () => {
    const ls = await lints(
      `CREATE TABLE public.heap (v text);
       CREATE TABLE public.keyed (id int PRIMARY KEY);`,
      'performance'
    );
    expect(names(ls, 'no_primary_key')).toEqual(['heap']);
  });

  it('auth_rls_initplan flags unwrapped auth calls only', async () => {
    const ls = await lints(
      `CREATE TABLE public.t (id int PRIMARY KEY, owner_id uuid);
       ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;
       CREATE POLICY slow ON public.t FOR SELECT USING (owner_id = auth.uid());
       CREATE POLICY fast ON public.t FOR UPDATE USING (owner_id = (select auth.uid()));`,
      'performance'
    );
    const hits = ls.filter((l) => l.name === 'auth_rls_initplan');
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain('"slow"');
  });

  it('multiple_permissive_policies flags overlap per role and action', async () => {
    const ls = await lints(
      `CREATE TABLE public.t (id int PRIMARY KEY);
       ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;
       CREATE POLICY a ON public.t FOR SELECT TO authenticated USING (true);
       CREATE POLICY b ON public.t FOR ALL TO authenticated USING (true);`,
      'performance'
    );
    const hits = ls.filter((l) => l.name === 'multiple_permissive_policies');
    expect(hits).toHaveLength(1);
    expect(hits[0].cache_key).toBe(
      'multiple_permissive_policies_public_t_authenticated_SELECT'
    );
  });

  it('duplicate_index flags identical indexes', async () => {
    const ls = await lints(
      `CREATE TABLE public.t (id int PRIMARY KEY, created_at timestamptz);
       CREATE INDEX t_created_1 ON public.t (created_at);
       CREATE INDEX t_created_2 ON public.t (created_at);
       CREATE INDEX t_created_desc ON public.t (created_at DESC);`,
      'performance'
    );
    const hits = ls.filter((l) => l.name === 'duplicate_index');
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain('t_created_1');
    expect(hits[0].detail).toContain('t_created_2');
    expect(hits[0].detail).not.toContain('t_created_desc');
  });

  it('a clean schema returns no performance lints', async () => {
    const ls = await lints(
      `CREATE TABLE public.orgs (id int PRIMARY KEY);
       CREATE TABLE public.a (id int PRIMARY KEY, org_id int REFERENCES public.orgs(id));
       CREATE INDEX ON public.a (org_id);`,
      'performance'
    );
    expect(ls).toEqual([]);
  });
});
