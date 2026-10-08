# deploy-database-003: two dev branches on a paid plan

The happy-path counterpart to `deploy-database-002`: when the org can branch,
the availability check stays out of the way and both branches go through the
cost flow
([Slack thread](https://supabase.slack.com/archives/C051L8U2EJF/p1791383434405579)).

**Setup.** `remote/organization.json` puts the org on the Pro plan, so
platform-lite's `/branching` endpoint reports `available: true`. The MCP server
runs account-scoped with the `branching` feature.

**Checks.** The first branch is created via `get_cost` -> `confirm_cost` ->
`create_branch`, two branches exist at the end, and there are no Supabase MCP
tool errors.

**Legacy cost flow.** The `get_cost` -> `confirm_cost` -> `create_branch` order
is what the server expects from clients on MCP protocol revisions before
2026-07-28, and it's the flow the eval runs go through. Clients that support form
elicitation (revision 2026-07-28) don't call `get_cost`/`confirm_cost`.
`create_branch` asks the user to confirm the cost itself. The eval doesn't
cover that flow.

**Single prompt, not two turns.** The second request ("can you make another one
for the payments work too?") would ideally be a follow-up turn, but the harness
runs one prompt per eval, so the prompt asks for both, one after the other.

**Cost consent.** `get_cost` tells the agent to confirm the price with the user
before going ahead. A single-turn harness can't answer that, so the prompt ends
with "Whatever it costs is fine, no need to check with me." The line is the
same in 002-004. Some runs still stop after `get_cost` to confirm the price,
because its description says to "always" confirm with the user. Read that
failure shape (no branches, last message asks to approve the cost) as a harness
limit, not an agent mistake or a server gap. The checks aren't relaxed for it.
