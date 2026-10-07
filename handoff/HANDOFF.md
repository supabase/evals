# Handoff: docs IA tree tests (continue locally)

Original brief: Notion "Handoff: docs IA tree tests and an optimal prototype tree"
(https://app.notion.com/p/3f25004b775f81d0bee9cbe1eff3a65d). Read it for the full task, background links, and the user's conventions. This doc covers only what has happened since.

## State

Branch `claude/dreamy-lovelace-yf9qxk` in supabase/evals, branched from `docs/wayfinding-navigation` (supabase/evals#372). Read `git log docs/wayfinding-navigation..HEAD` and `evals/wayfinding-tree/README.md` first. `handoff/` holds scratch tooling and isn't for merge: delete it before opening the PR.

Done:
- `pnpm docs-tree-export -- ../supabase` writes `experiments/docs/trees/today.json`. Today's tree has 661 pages, 710 links, 45 duplicated pages, and 31 nodes with more than 7 children. 5 pages are only group-header urls, which the sidebar never renders as links: storage/security, storage/uploads, storage/serving, api/data-apis, observability/metrics.
- The label-only navigator is `experiments/docs/lib/tree-navigator.mjs`. The scorer is `evals/wayfinding-tree/lib/tree-test.ts`, and the summary and `HOLDOUT_TASKS` are in `lib/summary.ts`. The report is `pnpm tree-test-report`. `pnpm docs-tree-build -- spec.json out.json` checks the rules.
- 93 tasks are in `evals/wayfinding-tree/`, with the source of truth in `handoff/tasks.json`. `handoff/gen-evals.py` regenerates the eval folders; run `biome check --write` after it. There are 24 holdout tasks: never revise a tree from their per-task results.
- The round-1 proposals are `proposal-a1` (minimal change), `b1` (journey-first), and `c1` (audience-first). Their specs are in `experiments/docs/trees/specs/`, and the generator scripts are in `handoff/designs/`. The designers never saw the tasks.
- CI run 37682948140 (https://github.com/supabase/evals/actions/runs/37682948140) succeeded. It scored today, a1, b1, and c1, with 93 tasks and 3 runs each. **Results aren't analyzed yet.**

## Next steps

1. Get the round-1 results: `gh run download 37682948140 -n raw-results` (it expires about 3 days after Oct 7). Unpack the artifact into `results/`, then run `pnpm tree-test-report`. If the artifact has expired, fetch from Braintrust with `handoff/bt-fetch.mts <prefix>` (Evals project). It rescores the tool spans. Braintrust's BTQL allows 20 requests a minute, and the script retries. Set `MATCH=<sha or stamp>` to narrow the experiments. Then run `handoff/analyze.mts <files> --tasks --detail <tree>`; it hides holdout per-task results.
2. Synthesize round 2 from the strongest tree and the design-set failures. Build it with `docs-tree-build`, add an experiment file `claude-code-sonnet-5-tree-<name>.experiment.ts`, push, and dispatch:
   `gh workflow run eval-refresh.yml --ref <branch> -f suite=wayfinding-tree -f experiments=<names> -f runs=3 -f commit_to_branch=true`
   Always set `commit_to_branch=true`, or the workflow opens a results PR. Only one run per branch goes at a time; a third dispatch cancels the pending one.
3. Iterate until success and directness stop improving, then report holdout totals.
4. Final deliverables:
   - The redirect map: only pages whose nav section changes enough to warrant a url move. Never move getting-started, quickstart, or AI urls, because DOCS-1216 doesn't list the AEO-sensitive urls, so treat them all as fixed.
   - The Notion report, as a private draft.
   - The stacked PR, with Problem, Solution, and Manual testing, and no Claude attribution.
   - Ask the user whether to rename the branch to `docs/...` before opening the PR.

## Gotchas

- Claude Code refuses a harness system prompt, so an MCP `promptAddendum` breaks every run. Tree-test instructions go in `PROMPT.md` and in the MCP `instructions`.
- The repo needs Node 24 (`engines`).
- The "Docs wayfinding findings" and "Proposal: top 5 focus areas" Notion pages showed as deleted (in the trash) when they were read. Confirm with the user before linking the report from them.
- Tracking plan inputs: docs events live in `packages/common/telemetry-constants.ts` and use past-tense verbs, such as `docs_*_clicked` and `_opened`. Model new nav events on `DocsContentListingClickedEvent`. The project plans A/B tests behind a flag like `docs:ia_mvp_v1`, with the gates Prototype, Limited A/B, Redirect bundle, and Cutover.

## Suggested skills

- `personal-writing-style`: the Notion report and PR body.
- `telemetry-standards`: before proposing the nav-click PostHog events.
- `ask-the-docs` and `pm-the-docs`: placement and audience calls.
- `dataviz`: charts of success and directness across rounds.
- `workflow-authoring`: only if the user opts into multi-agent tree design.
