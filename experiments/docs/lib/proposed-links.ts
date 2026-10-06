/**
 * The IA fixes under test: links the docs don't have today, by the page that
 * would gain them. The `navigate-linked` arm and the click-depth crawler add
 * these to the navigator's view, so each fix is measured before it ships.
 */
type ProposedLink = { href: string; label: string };

const DOCS = 'https://supabase.com/docs';
const link = (path: string, label: string): ProposedLink => ({
  href: `${DOCS}/${path}`,
  label,
});

const SSO = link('guides/platform/sso', 'Enable SSO for your organization');
const GOING_INTO_PROD = link(
  'guides/deployment/going-into-prod',
  'Production checklist: going into production'
);
const SCHEDULE_FUNCTIONS = link(
  'guides/functions/schedule-functions',
  'Schedule Edge Functions with Cron'
);
const CRON_QUICKSTART = link('guides/cron/quickstart', 'Cron quickstart');
const SEEDING = link(
  'guides/local-development/seeding-your-database',
  'Guide: Seeding your database'
);
const MIGRATIONS = link(
  'guides/deployment/database-migrations',
  'Guide: Database migrations'
);
const TYPES = link(
  'guides/api/rest/generating-types',
  'Guide: Generating TypeScript types'
);

export const PROPOSED_LINKS: Record<string, ProposedLink[]> = {
  // Platform → SSO and Platform → Going into production.
  [`${DOCS}/guides/platform`]: [SSO, GOING_INTO_PROD],
  [`${DOCS}/guides/platform/access-control`]: [SSO],
  // Cron ↔ Schedule functions.
  [`${DOCS}/guides/cron`]: [SCHEDULE_FUNCTIONS],
  [`${DOCS}/guides/cron/quickstart`]: [SCHEDULE_FUNCTIONS],
  [`${DOCS}/guides/functions/schedule-functions`]: [CRON_QUICKSTART],
  // CLI reference → guides.
  [`${DOCS}/reference/cli/supabase-db-reset`]: [SEEDING],
  [`${DOCS}/reference/cli/supabase-seed`]: [SEEDING],
  [`${DOCS}/reference/cli/supabase-db-push`]: [MIGRATIONS],
  [`${DOCS}/reference/cli/supabase-migration-new`]: [MIGRATIONS],
  [`${DOCS}/reference/cli/supabase-gen-types`]: [TYPES],
};
