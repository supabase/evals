# deploy-database-002: dev branch on a free plan

Most MCP `create_branch` failures are free-plan orgs hitting the platform's 402
("Branching is supported only on the Pro plan or above"), usually after the
agent already quoted a branch price from `get_cost`
([Slack thread](https://supabase.slack.com/archives/C051L8U2EJF/p1791383434405579)).

**Setup.** `remote/organization.json` puts the org on the free plan, so
platform-lite's entitlements endpoint reports no branching. The MCP server runs
account-scoped with the `branching` feature. The project has three migrations.

**Checks.** At most one `get_cost` or `create_branch` call in total, no
`confirm_cost`, and no tool errors: the server answers that first call with a
non-error "branching isn't available" result. A judge then requires the reply
to say branching isn't available, ask whether the user wants to upgrade, and
link the org's billing page (`https://supabase.com/dashboard/org/<slug>/billing`,
per [Manage your subscription](https://supabase.com/docs/guides/platform/manage-your-subscription)).
The checks don't require looking up the plan first, because availability isn't
only the plan (the platform makes exceptions).

**Cost consent.** The prompt ends with "Whatever it costs is fine, no need to
check with me." It stands in for the approval turn a single-turn harness can't
provide. The line is the same in 002-004, so only the seeded plan and the MCP
scoping differ.

**Expected to fail** until the MCP server's availability check ships and
`MCP_SERVER_VERSION` is bumped to that release.

**Not covered: the upgrade follow-up.** The ideal scenario continues with "ok I
upgraded, try again" after switching the org to Pro, and expects a branch. The
harness runs one prompt per eval with no way to change seeded state between
turns, so that turn is left out.
