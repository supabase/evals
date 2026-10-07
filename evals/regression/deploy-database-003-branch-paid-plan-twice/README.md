# deploy-database-003: two dev branches on a paid plan

The happy-path counterpart to `deploy-database-002`: once the agent knows the
org is on a paid plan, branching should go through the cost flow and not
re-check the plan for a second branch
([Slack thread](https://supabase.slack.com/archives/C051L8U2EJF/p1791383434405579)).

**Setup.** `remote/organization.json` puts the org on the Pro plan. The MCP
server runs account-scoped with the `branching` feature.

**Checks.** The first branch is created via `get_cost` -> `confirm_cost` ->
`create_branch`, two branches exist at the end, `get_organization` is called at
most once (calling it first is fine), and there are no tool errors.

**Single prompt, not two turns.** The second request ("can you make another one
for the payments work too?") would ideally be a follow-up turn, but the harness
runs one prompt per eval, so the prompt asks for both, one after the other.

An agent that stops to ask the user to confirm the branch price before
`confirm_cost` will fail here, since nobody answers. Check the transcript before
reading such a failure as an agent gap.
