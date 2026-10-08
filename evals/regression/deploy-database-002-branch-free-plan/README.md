# deploy-database-002: dev branch on a free plan

Most MCP `create_branch` failures are free-plan orgs hitting the platform's 402
("Branching is supported only on the Pro plan or above"), usually after the
agent already quoted a branch price from `get_cost`
([Slack thread](https://supabase.slack.com/archives/C051L8U2EJF/p1791383434405579)).

**Expected server behavior.** The MCP server asks the platform
(`GET /v1/projects/{ref}/branching` -> `{ "available": boolean }`) before
creating a branch or quoting its cost. When branching isn't available,
`create_branch` and `get_cost` (type `branch`, with `project_id`) return a
non-error result. It says branching isn't available for the organization, asks
whether the user wants to upgrade, and links
`https://supabase.com/dashboard/org/<slug>/billing`
([Manage your subscription](https://supabase.com/docs/guides/platform/manage-your-subscription)).
Availability is the platform's call, not the plan alone (allowlisted free orgs
and free orgs' K8s projects can branch), so agents get no plan-checking
guidance.

**Setup.** `remote/organization.json` puts the org on the free plan, so
platform-lite's `/branching` endpoint reports `available: false` (it only
models the plan). The MCP server runs account-scoped with the `branching`
feature. The project has three migrations.

**Checks.** At most one `get_cost` or `create_branch` call in total, no
`confirm_cost`, and no Supabase MCP tool errors. A judge requires the reply to
say no branch was created because the organization's current plan doesn't
include branching. Mentioning the upgrade (question or statement, link or not)
is fine but not required. `get_organization` is neither required nor forbidden.

**Cost consent.** The prompt ends with "Whatever it costs is fine, no need to
check with me." It stands in for the approval turn a single-turn harness can't
provide. The line is the same in 002-004, so only the seeded plan and the MCP
scoping differ.

**Expected to fail** until the MCP server calls the `/branching` endpoint and
`MCP_SERVER_VERSION` is bumped to that release.

**Not covered: the upgrade follow-up.** The ideal scenario continues with "ok I
upgraded, try again" after switching the org to Pro, and expects a branch. The
harness runs one prompt per eval with no way to change seeded state between
turns, so that turn is left out.
