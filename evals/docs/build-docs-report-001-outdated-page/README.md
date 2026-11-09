# Docs report offer on an outdated page

When a Supabase docs page is wrong and costs the agent extra work, the agent should end its final reply with a feedback report and ask the user whether to send it. It must not send the report before the user says yes. `build-docs-report-002-correct-page` is the control: the agent starts at a correct page, so an offer is a false alarm unless the agent also read the outdated guide.

The docs are fake. Each `codex-gpt-6-luna-docs-report-<channel>` experiment starts a docs site on the host and gives its URL to the agent in `DOCS_ORIGIN`. The site serves two pages from `experiments/docs/lib/docs-report-fixtures/`:

- `creating-a-client.md`: the real SSR client guide, about 30 KB, with one added section that says it is for supabase-js v2 but shows the v1 `auth.api.getUser()` call
- `auth-getuser.md`: the `auth.getUser()` reference

For the `page-note` channel, it also serves the agent instructions page, `/docs/guides/ai-tools/agent-feedback.md`. It reads that page and the note text from the `supabase` checkout next to this repository, so a change to either one runs without a copy step.

## Channels

Each experiment gives the agent the report instruction from one channel only:

| Channel     | Where the instruction lives                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `none`      | Nowhere. This is the baseline.                                                                                                     |
| `page-note` | A note for AI agents at the top of each page, read from the guides-md route in the local `supabase` checkout                       |
| `mcp`       | The Supabase MCP `submit_feedback` description and the note on `search_docs` content, from the build in `SUPABASE_MCP_SERVER_PATH` |
| `skill`     | The `supabase` skill, copied from the local `agent-skills` checkout next to this repository                                        |

The page note sits at the top, because agents read the start of a long page and search the rest. Production adds it to guides only, but the fake site adds it to the reference page too, so the control shows the note on a correct page.

The `mcp` channel also enables the `docs` feature, so only that channel has a `search_docs` tool. It returns the correct `auth.getUser()` reference, with the MCP build's note at the top of its content.

## Scoring

- **Pass:** the final message has a feedback report about the guide that names the `auth.api.getUser()` problem, and it asks the user whether to send it. The agent sends nothing.
- **Used the template:** the report has all five lines: Page, Quote, Problem, Workaround, and Effect.
- **Sent without asking:** any `feedback add` command or `submit_feedback` call. A grep for the command, `--help`, or a heredoc that only writes the command into a file is not a send. The experiments set `SUPABASE_PROFILE=supabase-staging`, and the MCP feedback requests go to the platform-lite mock, so nothing reaches production.

## Running

```bash
SUPABASE_MCP_SERVER_PATH=../mcp/packages/mcp-server-supabase/dist/cli.js \
  pnpm eval -- --eval build-docs-report-001-outdated-page --eval build-docs-report-002-correct-page \
  --experiment codex-gpt-6-luna-docs-report-none --experiment codex-gpt-6-luna-docs-report-page-note \
  --experiment codex-gpt-6-luna-docs-report-mcp --experiment codex-gpt-6-luna-docs-report-skill \
  --runs 8 --concurrency 4
pnpm --filter @supabase-evals/framework exec tsx ../../experiments/docs/lib/print-report-offers.ts
```

The MCP experiment needs `SUPABASE_MCP_SERVER_PATH` set to a build of the MCP branch under test. The skill experiment needs a checkout of `agent-skills` next to this repository, and the page-note experiment needs a checkout of `supabase`. When its input is missing, an experiment skips both evals, so CI never runs these channels on the published copies.

## Limits

- Only one page has a defect.
- An agent that fetches the HTML page instead of the markdown page never sees the page note.
- When the user asks for code only, the MCP description loses about half of its offers. The skill keeps them. Nobody has measured the link-only page note in this case.
