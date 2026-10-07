# deploy-database-002: dev branch on a free plan

Most MCP `create_branch` failures are free-plan orgs hitting the platform's 402
("Branching is supported only on the Pro plan or above"), usually after the
agent already quoted a branch price from `get_cost`
([Slack thread](https://supabase.slack.com/archives/C051L8U2EJF/p1791383434405579)).

**Setup.** `remote/organization.json` puts the org on the free plan. The MCP
server runs account-scoped with the `branching` feature, so `get_organization`
(which returns the plan) is available. The project has three migrations.

**Checks.** The agent calls `get_organization`, never calls `get_cost`,
`confirm_cost` or `create_branch`, gets no tool errors, and tells the user
branching needs a paid plan (judge).

**Expected to fail** until the MCP server's `create_branch`/`get_cost`/
`confirm_cost` descriptions tell agents to check the plan first and
`MCP_SERVER_VERSION` is bumped to that release.

**Not covered: the upgrade follow-up.** The ideal scenario continues with "ok I
upgraded, try again" after switching the org to Pro, and expects a branch. The
harness runs one prompt per eval with no way to change seeded state between
turns, so that turn is left out.
