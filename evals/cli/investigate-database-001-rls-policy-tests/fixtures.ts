export const NOTES_TABLE = 'notes';
export const SEEDED_MIGRATION_VERSION = '20260101000000';
export const SEEDED_MIGRATION_FILE = '20260101000000_create_notes.sql';
export const LEAKY_POLICY_NAME = 'Enable read access for authenticated users';
export const TESTS_DIR = 'supabase/tests';
export const PROBE_TITLE_PREFIX = 'eval-probe-';

export const PROBE_USERS = {
  owner: {
    id: 'e7a1c0de-0000-4000-8000-00000000000a',
    email: 'eval-probe-owner@example.test',
  },
  other: {
    id: 'e7a1c0de-0000-4000-8000-00000000000b',
    email: 'eval-probe-other@example.test',
  },
};

/** The seeded migration's `create policy` statements on public.notes, verbatim and in order, without trailing semicolons. */
export const SEEDED_NOTES_POLICIES: readonly string[] = [
  `create policy "Users can view their own notes"
  on public.notes for select
  to authenticated
  using ((select auth.uid()) = owner_id)`,
  `create policy "Users can create their own notes"
  on public.notes for insert
  to authenticated
  with check ((select auth.uid()) = owner_id)`,
  `create policy "Users can update their own notes"
  on public.notes for update
  to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id)`,
  `create policy "Users can delete their own notes"
  on public.notes for delete
  to authenticated
  using ((select auth.uid()) = owner_id)`,
  `create policy "Enable read access for authenticated users"
  on public.notes for select
  to authenticated
  using (true)`,
];
