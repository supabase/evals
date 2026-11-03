# Docs navigation evals

These evals measure whether an agent can find the docs page that answers a task by following links on supabase.com, starting at the docs root. The agent has no search and can't open a URL it remembers.

## Terms

| Term | Meaning |
| --- | --- |
| Arm | One experiment. Both arms run the same cases on the same day. |
| Target | A docs path in a case's `TARGETS` that answers the task. |
| Hop | One `open_page` call, refused ones included. |
| Blocked jump | A refused call: the agent asked for a page that no opened page links. |
| Reached | The agent opened a target, or a judged page, in under 10 hops. |
| Judged | No opened page was a target, so a judge found the page that answers the task. |
| Direct | The agent reached a target without opening a page twice or going back to the docs root. |
| Grounded | A judge found that the reached page answers the task and the agent's answer uses it. |

## Personas

Each prompt is one of these people, in their own words, with one thing they don't know. A case's `motivation` names its persona and that gap.

| Persona | Who they are |
| --- | --- |
| Solo founder | Builds and runs a SaaS alone. Knows their app well and Supabase's platform features less. |
| Agency developer | Builds apps for clients and hands the Supabase project over at launch. |
| Backend engineer | Works at a startup. Comfortable with SQL and new to Supabase's settings. |
| Engineering lead | Owns who on the team can reach what. |
| Frontend developer | Works through supabase-js and avoids SQL. |
| Hobbyist | Runs a side project on the free plan. |

## Cases

| Group | Cases |
| --- | --- |
| Hard to reach | `001`, `002`, `003`, `004` |
| Option 1 topics | `005` to `011`, one per Option 1 topic |
| Set aside | `012`, `013`, `014`, tasks kept out of navigation design |

## Arms

| Experiment | Docs |
| --- | --- |
| `claude-code-sonnet-5-docs-nav` | Control: the navigation every visitor gets |
| `claude-code-sonnet-5-docs-nav-option-1` | Option 1, forced with `?docs-ia-mvp-v1=option-1` on every request |

The option-1 arm runs only while Option 1 is behind its flag. Without it, control is the regression arm.

## Scoring

The navigator is `experiments/docs-nav/lib/docs-navigator.mjs`, and the scorer is `lib/navigation.ts`.

- **Reached a target page in under 10 hops.** This check decides the pass. 0 to 3 hops is clean, 4 to 6 friction, 7 to 9 failure, and 10 or more, or never reaching a target, a big failure. Its notes hold the hops, the opened pages, blocked jumps, direct, judged, and the docs origin.
- **Answer is grounded in the reached page.** Reported, never part of the pass.

A judged run means `TARGETS` may need updating. Check the page it reached and add it when it answers the task.

## Editing

- Never use a page's title, or a distinctive word from the labels on the way to it, in a prompt. Third-party names a person would say, like Vercel or Google Workspace, are fine.
- When a target moves, update `TARGETS`.

## Running

```bash
pnpm eval -- --suite docs-nav --runs 3
pnpm --filter @supabase-evals/framework exec tsx ../../experiments/docs-nav/lib/print-report.ts
```

The report lists each case per arm, then the cases reached and direct per arm. Refresh both arms on the same day. A drop of 2 or more reached or direct cases on an arm since the last refresh is a regression.

To run against a docs deploy preview, set `DOCS_ORIGIN`:

```bash
DOCS_ORIGIN=https://docs-git-<branch>-supabase.vercel.app pnpm eval -- --suite docs-nav
```

The navigator accepts only `https://docs-git-*-supabase.vercel.app` and refuses `DOCS_ORIGIN` in CI. Don't upload preview runs to Braintrust.

In CI, dispatch `eval-refresh.yml` with `suite=docs-nav`.
