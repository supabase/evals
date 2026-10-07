/**
 * Proposed IA fixes: links the docs don't have today, by the page that would
 * gain them. The `navigate-linked` arm adds these to the pages the docs
 * navigator shows, so a fix is measured before anyone changes the docs.
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

export const PROPOSED_LINKS: Record<string, ProposedLink[]> = {
  [`${DOCS}/guides/platform`]: [SSO, GOING_INTO_PROD],
  [`${DOCS}/guides/platform/access-control`]: [SSO],
  [`${DOCS}/guides/cron`]: [SCHEDULE_FUNCTIONS],
  [`${DOCS}/guides/cron/quickstart`]: [SCHEDULE_FUNCTIONS],
  [`${DOCS}/guides/functions/schedule-functions`]: [
    link('guides/cron/quickstart', 'Cron quickstart'),
  ],
};
