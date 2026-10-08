# deploy-database-004: dev branch on a free plan, project-scoped MCP

`deploy-database-002` with the MCP server scoped to the project
(`projectScoped: true`, i.e. `--project-ref`), as with a project-scoped MCP URL
([Slack thread](https://supabase.slack.com/archives/C051L8U2EJF/p1791383434405579)).
Account tools (`get_organization`, `get_cost`, `confirm_cost`) aren't available
in this mode. See 002's README for the expected server behavior.

**Setup.** `remote/organization.json` puts the org on the free plan, so
platform-lite's `/branching` endpoint reports `available: false`.

**Checks.** Exactly one branching-tool call (e.g. `list_branches` or
`create_branch`) returns the non-error "branching isn't available" result
(recognized by its billing link), no `confirm_cost`, and no Supabase MCP tool
errors. `create_branch` isn't required. The same judge as 002 requires the
reply to say the
organization's current plan doesn't include branching. Mentioning the upgrade
is fine but not required.

**Cost consent.** The prompt ends with "Whatever it costs is fine, no need to
check with me." It stands in for the approval turn a single-turn harness can't
provide. The line is the same in 002-004, so only the seeded plan and the MCP
scoping differ.

**Expected to fail** until the MCP server calls the `/branching` endpoint and
`MCP_SERVER_VERSION` is bumped. The released server requires a `confirm_cost_id`
in this mode that no available tool can produce, and on a free org the
platform's 402 comes back as a tool error.
