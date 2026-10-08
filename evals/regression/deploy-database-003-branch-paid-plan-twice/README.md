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

**Known harness limit: stopping to approve the price.** `get_cost` tells the
agent to "repeat the cost to the user and confirm their understanding before
proceeding", so an agent that quotes the price and waits for an OK before
`confirm_cost` is doing the right thing. In a single-turn harness nobody
answers, so that run fails with no branches. Read that failure shape as a
harness limit, not an agent gap. The checks aren't relaxed for it, because a
run that never creates a branch can't be told apart from one that gave up.
