# Drafting the prompt

The prompt is a product request plus the page's url. Nothing else.

`CONTRIBUTING.md` already says prompts read as a real user's message, do not spoonfeed, and move
detail into seed data. Everything here is the strict reading of that for a page under test.

## Strip the vocabulary that gives away the answer

Write the request the way the user would write it, in product terms. Never name the mechanism, the
setting, or the concept the page teaches.

The stripped words are the measurement. An agent that only writes secure policies when the prompt says
"security" has not been served by the guide.

Worked examples:

| Eval | Words the prompt never says |
| --- | --- |
| RLS guide | RLS, policy, security, role, tenant, test |
| API keys guide | key, publishable, secret, service role, server, expose, environment variable |
| Connecting to Postgres | pooler, pooling, transaction, session, port, prepared statement, connection string |

**Say where the code runs. Never say how to reach the service.** "I'm deploying this to Vercel
serverless functions" is the user's own framing. "Use the transaction pooler" is the answer.

**List the stripped words in the eval's `README.md`.** They creep back otherwise, one loosening at a
time, and the next editor has no way to know they were deliberate.

## Strip from the prompt, not from everything

Fixture material a user would already have on screen may carry the vocabulary. The connection eval's
seed prints "Transaction pooler" and the port numbers, because that is what the dashboard's Connect
panel prints, and pretending otherwise would be a stranger fixture than the real one.

The line is the prompt. The prompt is the user's own words; the seed is the world the user is already
in.

## Keep the reliance instruction

End the request with this, verbatim:

```
Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.
```

Without it, a pass is evidence about the model rather than the page. The older, weaker form is "Read
this guide first and follow it". Use the sentence above.

## The REFERENCE block

Bare. No colon, no markdown link, no code fence.

```
REFERENCE
https://supabase.com/docs/guides/<path>.md
```

Use the `.md` variant. That is what an agent retrieves, and the guide-read check resolves against it.

## Do not spoonfeed, and watch for what the prompt leaves open

Detail belongs in the seed. A seeded table resolves column names, a seeded file fixes a contract, and
a comment explains structure the code does not show.

**If the prompt does not say, the check passes.** One eval red an agent that gated an endpoint on being
signed in, which the prompt never ruled out. The reviewer's read is the rule: either the check accepts
it, or the prompt says which it wants. An ambiguity the checks resolve one way is a false red waiting
for the run that resolves it the other way.

## Frontmatter

- `stage: build`, `interface: cli`, and `suite: regression`. Benchmark is gated on at least one agent
  failing the scenario, so it is a question for after the baseline, not before.
- `product:` and `topic:` from the closed enums in `packages/core/src/eval-metadata.ts`. `topic` has no
  `database` value; `sdk` is usually the fit.
- `services:` narrowed to what the scorer touches. This also decides what the agent can reach, which
  is a design lever: excluding a service the wrong answer would need makes the wrong answer fail
  locally.
- Do not add `skills: []`. The `*-no-skills` experiment variants are how a run sees the page without
  the product skills.
- `motivation:` as a folded `>-` block, in three moves: what agents are pointed at this page for, the
  blast radius of getting it wrong, and what the eval determines. Cite the evidence from Phase 1.
