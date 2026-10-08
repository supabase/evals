# deploy-database-004: dev branch on a free plan, project-scoped MCP

`deploy-database-002` with the MCP server scoped to the project
(`projectScoped: true`, i.e. `--project-ref`), as with a project-scoped MCP URL
([Slack thread](https://supabase.slack.com/archives/C051L8U2EJF/p1791383434405579)).
Account tools (`get_organization`, `get_cost`, `confirm_cost`) aren't available
in this mode, so the agent can't see the plan up front.

**Setup.** `remote/organization.json` puts the org on the free plan.

**Checks.** Exactly one `create_branch` call, no `confirm_cost`, no tool errors,
and the agent tells the user branching needs a paid plan and links the org's
billing page to upgrade (judge). The agent
can't see the plan in this mode, so it has to try once to find out; a reply
that only guesses at the plan doesn't count. The server is expected to answer
that `create_branch` with a non-error "requires Pro, upgrade here" result,
which is why zero tool errors is achievable.

**Cost consent.** The prompt ends with "Whatever it costs is fine, no need to
check with me." It stands in for the approval turn a single-turn harness can't
provide. The line is the same in 002-004, so only the seeded plan and the MCP
scoping differ.

**Expected to fail** until that server change ships and `MCP_SERVER_VERSION` is
bumped. With the current server, project-scoped `create_branch` requires a
`confirm_cost_id` that no available tool can produce, and on a free org the
platform's 402 comes back as a tool error.
