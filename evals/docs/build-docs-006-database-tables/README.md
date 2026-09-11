# build-docs-006-database-tables

## What this eval measures

**The page is the subject, not the agent.** The prompt is a product request plus
the url of [Tables and Data](https://supabase.com/docs/guides/database/tables),
and the checks say whether an agent that read that page produced a schema that
protects its own data. A gap in the page counts as a failure here.

The one claim: **a page that teaches table creation and never mentions row level
security leaves an agent creating world-readable tables.**

The page covers its own subject competently. Primary keys get a section
recommending `bigint generated always as identity`, foreign keys get a section,
and the `private` schema example is correct. It never once says to protect a
table. `row level security` appears one time in 573 lines, at the `security_invoker`
note about views. There is no `alter table ... enable row level security`, no
policy, and no `auth.uid()` anywhere on the page.

## Do not reintroduce the vocabulary

These words are stripped from `PROMPT.md` and from every seed file, and putting
any of them back turns the eval into a test of whether an agent can follow an
instruction:

> RLS, row level security, policy, policies, secure, security, private, public,
> permission, access, grant, `auth.uid`, tenant, isolation

`local/README.md` and the comments in `local/src/queries.ts` are written in
product vocabulary for the same reason. "This runs for visitors who have not
signed up yet" is a fact about the product. "This table must be publicly
readable" would be the answer.

## The prompt carries the contract

`local/` seeds a `supabase/` project and the app's data layer, and **no
migrations**. The schema is what the agent produces, so seeding one would
remove the subject.

`PROMPT.md` and `local/src/queries.ts` both fix the table and column names:
`routines` (`owner_id`, `title`, `cadence`, `created_at`), `routine_logs`
(`routine_id`, `completed_on`), and `routine_library` (`title`, `category`).

**The prompt states them because the page does not.** The scorer finds the
agent's tables by name, so a schema it cannot find scores near zero however well
that schema is protected. Leaving the names to be inferred measures whether the
agent read the data layer, which is a fact about the agent rather than about the
page. Naming them costs a discovery question and buys a positive control the
scorer can prove.

`routines.id` has no fixed type on purpose. `uuid` and
`bigint generated always as identity` are both correct, so the scorer resolves
routine ids by title through a subselect rather than inventing one.

## Do not drop the positive controls

Two checks pass for an agent that built nothing useful, and both are what make
the rest mean something:

- **`the app's tables exist and accept the rows its queries write`** gates all
  four probes. Without it, `no rows came back` and `the data is protected` are
  the same result: `!error && rows.length === 0` is true of an empty set.
- **`a signed-out visitor can browse the starter routine library`** and
  **`the signed-in owner reads their own routines and nobody else's`** are why a
  schema that refuses everyone is not a pass. Enabling row level security and
  writing no policy fails both.

The marker rows are written **after** the agent's code exists, with a value
scoped to the run, so a hardcoded array cannot clear a read control and no
literal leaks between runs.

The probe that writes runs last. It inserts into `routines` when the schema lets
it, and every probe that reads that table has to have run first.

**The write probe has to send the whole contract row.** An earlier version sent
`owner_id` and `title` only, so on a schema whose `cadence` is `not null` the
insert came back as a not-null violation and the check read that as a refusal, so a
wide-open table scored as protected. A probe asserting that a request was
*refused* has to send a request the database would otherwise accept, confirm the
row's absence as the superuser, and treat any error outside `42501` as
`could not measure` rather than as a pass. Do not narrow that insert again.

## The guide has to actually be read

`the agent read the Tables and Data guide the prompt referenced` resolves the url
from the harness's own docs result rather than the raw tool call, because a
`search_docs` hit carries the guide's url in its result and not in its request.

**The reliance instruction in `PROMPT.md` is load-bearing. Do not remove it.**
The first baseline shipped without it, and all six runs came back with zero docs
calls. Agents wrote a correctly protected schema from memory, never opened the
page, and still scored 7/8. Without that sentence a pass is evidence about the
model rather than about the page.

Even with it, the check proves the page was opened and not that the page caused
the outcome. A model that already knows to enable row level security produces the
same schema from memory, so read a pass as regression cover rather than as
attribution.

## What this eval does not score

- **Data types.** `schema-data-types.md` in `supabase-postgres-best-practices`
  is impact HIGH, and the page lists `timestamp`/`timestamptz` and `int`/`bigint`
  in a reference table while recommending neither side. It is a second claim and
  a storage bug rather than a breach, so it is named here rather than measured.
- **Primary keys, foreign keys, `not null`, lowercase identifiers.** The page
  transmits these, so a check on them would pass a solution written from the page
  and measure nothing. They are the page working, not the page failing.
- **Views and `security_invoker`.** The one thing the page does say about row
  level security. `build-docs-002-rls-guide` owns it.
- **Bulk loading with `COPY`.** Real content on the page, no security
  consequence, and no affordance in the seed to exercise it.
- **Schema modeling.** The prompt names the tables and columns, so nothing here
  measures whether an agent derives them. One shape protected correctly and
  another shape protected correctly score the same.
- **Whether `anon` holds a write grant.** Planned, then dropped deliberately. Supabase's
  default privileges grant `anon` write on new tables in `public` and the
  standard pattern leaves them in place while row level security gates the rows,
  so asserting the grant is gone would fail the canonical correct answer.
  `a signed-out visitor cannot create a routine` measures the outcome instead.

## Overlap with build-docs-002-rls-guide

002 carries a check with almost this name and a much larger policy suite, but it
is a different question. 002 asks the agent to set up access rules and points at
the Row Level Security guide, so it measures whether *that* guide transmits row
level security **when row level security is what was asked for**. This eval asks
for a database, points at a page that is silent on the subject, and measures
whether an agent gets there unprompted.

## A risk worth knowing

This measures a docs gap that customers are asking the **platform** to close
(FDBKIN-2454, FDBKIN-30897). If the default grants for `anon` on new `public`
tables ever change, the central check saturates and the finding goes stale. That
is the "check measures the platform, not the page" trap, and it is better named
here than discovered on a CLI bump.
