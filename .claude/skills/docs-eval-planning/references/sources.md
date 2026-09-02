# Where the checks come from

The page under test is not a source. Everything here is.

Half of these need an MCP connector or private-repo access. Try the source; if the tool is missing or
unauthorized, stop and ask for it. Then record in the plan which sources were reachable. Silently
skipping a gated source produces a thin inventory that reads as complete.

| Source | Access | How | What it gives |
| --- | --- | --- | --- |
| Linear feedback intake | Linear MCP | `list_issues` with a topic query | The recurring ask in customers' words, with ids to cite. Skip anything already closed as `Duplicate`. |
| Linear docs team | Linear MCP | `list_issues` scoped to the Docs team | Whether the gap is already filed, and the paired improve-the-doc ticket. |
| Slack | Slack MCP | `slack_search_public_and_private` on the topic | Support and team threads naming the failure and its error text. |
| Hex | Hex MCP | The docs popularity and feedback project | Views, negative rate, and agent share, for `motivation:`. |
| Supacademy | `supabase/supacademy`, private | `content/<topic>/` | `foundations/` carries the internal model, stated more plainly than the public page. `troubleshooting/` names the concrete failures. |
| Agent skills | In repo | `submodules/agent-skills/skills/*/references/` | The parameter names and flag values a check can assert on. |
| Agent skills feedback | Public | `gh issue list --repo supabase/agent-skills` | Issues titled `user-feedback:` are first-party reports of an agent failing a task. The highest-value source and the easiest to miss. |
| Troubleshooting guides | Public | `supabase.com/docs/guides/troubleshooting/` | Remediations with concrete values, which is what a check needs. |
| Neighbour pages | Public | `apps/docs/content/guides` in `supabase/supabase` | What the sibling pages treat as essential. |
| External communities | Public | `WebSearch`, and `gh` on `supabase/supabase` | Failures that never reached a ticket. |
| A question to a channel | Slack MCP | Draft it | Only when a gap looks like something a team knows and nothing on this list records it. Draft the message; do not post it. |

The five public sources are enough for a usable plan. The gated ones are what turn a plausible check
list into one with issue ids behind it.

## Reading Slack results

A topic search can exceed the token limit and come back as a path to a file instead of a result. The
file's lines are too long for line-based reading, so slice it by character range or extract the message
bodies with a script.

## The diff step

This is the point of the phase.

1. Build the check list from the sources above.
2. Compare it against the page.
3. Anything the sources treat as essential and the page omits is a candidate check.
4. Confirm the candidate would fail a solution written by following the page. If it would pass, it is
   not measuring a gap.

A gap no scenario can exercise is not a check yet. Give the seed an affordance first, or the check
passes by default and measures nothing.

## What a finding looks like

One bullet. What goes wrong, and the id, thread, or url that says so.

Two kinds are worth separating in the inventory, because they lead to different checks:

- **A recurring ask.** Several customers asking the same question means the page does not answer it.
  This is what `motivation:` cites.
- **A first-party agent failure.** A report of an agent doing the task and getting it wrong. This is
  the strongest evidence a check is worth writing, because someone has already run the experiment.
