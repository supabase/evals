# Brief: propose a Supabase docs navigation tree

## Goal
A navigation tree where developers and AI agents find the right docs page using the navigation labels alone. It will be scored with tree tests: participants get a task in plain words, see only labels (a section's label and its children's labels), open sections, go back, and choose one page. We measure success (chose a right page), directness (no backtracking), first-click correctness (the first top-level choice leads to the answer), and clicks.

## Hard rules (the build script enforces them)
1. No node has more than 7 children. This includes the top level.
2. Every page in today's tree appears exactly once. No duplicates, nothing dropped. Today's pages: `pages.tsv` (661 pages with where each appears today; pages listed in several places are today's duplicates, and you must pick ONE home for each).
3. You may add group nodes freely. A group may also link a page (`"page"` on the group), which makes it "a page, and a section", like today's section headers. Don't also list that page as a child.

## Inputs
- `today-outline.txt`: today's full tree, indented, `Label [children] -> page`.
- `pages.tsv`: every page and where it appears today.
- Docs source, if you need to know what a page covers: ../supabase/apps/docs/content (guides/platform/sso -> content/guides/platform/sso.mdx).

## Evidence: where navigation fails today (300 agent runs, link-only navigation of the live docs)
- The top and the product areas work. Getting started (quickstarts 1-2 clicks), database, auth, cron, queues, and CLI tasks never failed badly. Product hubs work for single-product tasks.
- Every big failure was an OPERATOR task, in Platform, Deployment, and Security: 38% of operator runs failed badly, 0% elsewhere. The model knows little about operator topics, so the navigation is the only way in.
- Where agents (and people) looked first, versus where the page lives:
  - Dashboard SSO for the team (org SSO with Google Workspace/Okta): looked in Platform, then Access Control; it lives in Platform > Project & Account Management > Single Sign-On, and Access Control didn't lead there.
  - Production checklist: looked under Platform; it lives under Build > Deployment & Branching (and under Security > Guides).
  - SSL enforcement: looked in Database, then "Connecting to Postgres"; it lives in Platform > Platform Configuration.
  - Network restrictions / IP allowlist: looked in Database first; lives in Platform.
  - Terraform: looked in Integrations, the Management API, and Platform; lives in Deployment.
  - Org MFA enforcement: looked in Platform > Access Control; lives in Platform > Multi-factor Authentication.
  - Org audit logs: looked in Platform > Access Control and guessed /guides/platform/audit-logs; lives in Security > Product security.
  - Scheduling an Edge Function: went to Cron; the Edge Function scheduling guide lives under Edge Functions and Cron didn't lead to it.
  - Preview branches per pull request: looked in Platform first; lives in Deployment & Branching.
  - SOC 2 report: reached only through Platform > HIPAA > shared responsibility; Security was never on the way.
- Q3 IA audit, top problems (ranked by recurrence across 8 runs and 3 models):
  1. "Build" is a mixed catch-all (AI tools, local dev & CLI, deployment, self-hosting, integrations).
  2. Operations, security, and deployment have no single home: operator paths are split across Manage, Build, and product trees.
  3. The database tree duplicates itself and spills into other sections (e.g., Data API repeats database pages).
  4. Product hubs are repeated across the product and workflow trees.
  5. "Platform Management" is the operator catch-all, a vague label.
- Labels matter: information scent. A group label must predict what's inside, and siblings must not overlap. Avoid vague catch-alls ("Build", "Platform Management", "Modules", "Configuration", "Advanced", "Guides", "More"). Prefer the words people use for the need ("Organization access", "Backups and restore", "Connect to your database").

## Constraints
- URLs don't change because of the tree. Where a page's new home is in a different docs section than its URL, that's fine; we'll list redirects separately later.
- Getting-started, quickstart, and AI pages can move in the navigation, but they're sensitive for agents, so keep them easy to find from the top.
- Keep page labels from today unless a label is vague in its new place; then rename it (`"label"` on a page node). Don't rename for the sake of it.
- Depth costs clicks. Prefer depth 3 to 4 for most pages (top level is depth 1). With 7 children max and 661 pages, some depth 5 is unavoidable for long reference-like lists (e.g., 20 framework quickstarts, 25 usage-billing items, social login providers).

## Spec format
JSON: `{"name": "<given name>", "description": "<one sentence>", "root": [ <top-level nodes> ]}`.
A node is either a page path string (keeps today's label), or an object:
`{"label": "Organization access", "page": "guides/platform/access-control", "children": [ ... ]}`.
`label` on a page node renames it. Groups need a `label`; `page` is optional.

Build and validate (run until it prints OK):
`cd /home/user/evals && PATH=/opt/node24/bin:$PATH pnpm --silent docs-tree-build -- <spec.json> <tree.json>`
It lists every problem: missing pages, duplicates, nodes over 7 children, unknown pages. Writing the spec with a script (e.g., Python that walks today's structure and moves subtrees) is fine and often easier than hand-writing 661 entries.
