# build-docs-022-full-text-search

## What this eval measures

The [Full Text Search](https://supabase.com/docs/guides/database/full-text-search) guide, not the agent. The
prompt is a product request plus the page's url, and the checks say whether an agent that read the page built a
search that returns ranked matches for what a visitor really types. A gap in the page counts as a failure.

One claim: **a text search returns ranked matches**, meaning the right articles, best first. The page's
[ranking section](https://supabase.com/docs/guides/database/full-text-search#ranking) says ranking has to run
server-side through a function and shows `ts_rank`, weighted columns and `websearch_to_tsquery`. Three things in
that section are what this eval leans on:

- The ranked examples pass the query to `to_tsquery(search_query)`. That function takes query syntax, so a
  visitor's `cancel boats?` is a syntax error. The page's `websearch_books` example is the one that takes plain
  text, and the page shows it last.
- The `fts` column the page builds joins columns with `description || ' ' || title`. A row whose text is null
  produces a null document and never matches.
- Without weights, a repeated word in the text outranks the same word once in the title. The page shows weights
  and never shows the unweighted result.

Checked against the page at supabase/supabase `6ac5ba4322`.

## Where the checks came from

No user evidence for this page turned up, which the ticket said to expect. The inventory is thin and says so.

- **Reached:** `supabase/agent-skills` issues (no user-feedback on full text search; #83 touches the FTS
  reference doc but is about `LIKE`), `supabase/supabase` and `supabase/postgrest-js` issues (postgrest-js #402
  is about `textSearch`'s default config, which this eval doesn't exercise because it calls SQL), and Postgres'
  own behavior, which the three bullets above were checked against on PGlite before any check was written.
- **Out of reach:** Linear, Slack, Hex, the internal report.

So the three traps come from reading the page against how Postgres behaves, not from a report of an agent
failing. If a user-feedback issue turns up, add it here.

## Do not reintroduce the vocabulary

Keep all of these out of `PROMPT.md`:

full text, tsvector, tsquery, `to_tsquery`, `websearch_to_tsquery`, `plainto_tsquery`, `@@`, rank, ranking,
relevance, weight, stemming, index, gin, generated column, function, rpc, language configuration.

"Search" stays, because it's the user's word, and so does "title" and "text". "Coming before" is how a user says
ranked.

## The seed carries the contract

- `local/app/help-center.ts` is the page's side of the search box. It fixes what the scorer needs and the agent
  would otherwise have to guess: the database function is `search_articles`, it takes `term`, it returns rows
  with `id` and `title`, and the page lists rows in the order they come back. This is the discovery question the
  eval gives up for an observable answer. The comment says visitors' text goes in "as it is", with examples that
  have capitals, a question mark and extra spaces, without naming the mechanism.
- `local/supabase/migrations/20240101000000_create_articles.sql` has a nullable `body` with a comment that
  support starts an article with just a title, and one seeded article with no text. That is the null trap, shown
  in the world the user already has.
- No seeded article mentions the scorer's marker word, so the seed can't satisfy a probe.
- `services: []`, because only Postgres is needed. `[db.seed]` is off.

## Do not drop the positive controls

- `the search runs the way the help center calls it` is the control for the four checks after it. When the call
  fails they fail with a `not run` note instead of passing.
- `the articles that mention the word come back, and no others` fails a search that returns every article
  sorted by rank, and it requires both matches present, so an empty answer fails.
- The articles go in after the agent is done and carry a made-up marker word, so nothing can be satisfied by a
  hardcoded list or by rows the agent wrote. The body-heavy article is inserted first, so an answer in insertion
  order is the wrong order.
- The scorer calls the function by name with `term =>`, the way PostgREST does, so a different parameter name
  fails the contract. Rows are read with `with ordinality`, so the order is the one the function returned.

## Predicted to saturate, and what failed

The probes were run on PGlite against example solutions (kept local, never committed), not against a real stack. Predictions were
written before running and all held.

| Solution | Red checks |
| --- | --- |
| weighted, `coalesce`, `websearch_to_tsquery` | none |
| `plainto_tsquery`, weighted, `coalesce` | none |
| the page's body-only `search_books` shape, raw `to_tsquery` | matches, no text, order, typed |
| `title \|\| body`, unweighted, raw `to_tsquery` | no text, order, typed |
| weighted and `coalesce`, raw `to_tsquery` | typed |
| `coalesce` and `websearch_to_tsquery`, unweighted | order |
| weighted and `websearch_to_tsquery`, `\|\|` without `coalesce` | no text, typed |
| no `where`, ordered by rank only | matches |
| weighted and `websearch_to_tsquery`, no `order by` | order |
| function in a schema other than `public` | all five |
| `ILIKE` with title-first ordering | typed |
| nothing built | all five |

`the agent applied the migrations it wrote` and the guide-read check are the cheap ones. The signal is in
`order`, `no text` and `typed`, one per trap above. An agent that already knows to weight, `coalesce` and use
`websearch_to_tsquery` passes everything, which is a correct answer and not a defect.

## The guide has to actually be read

`the agent read the full text search guide the prompt referenced` fails unless a docs call returned the page's
content. Read `docs.calls` before the score. Reading the page and knowing Postgres produce the same result on a
mainstream task, so a pass doesn't attribute the work to the page.

## What this eval does not score

- **How the matching is done.** Any approach that returns the right rows in the right order passes. The `ILIKE`
  solution above fails only the multi-word check, so a trigram or `ILIKE` design that handled typed words would
  pass.
- **Indexes (`gin`) and generated columns.** A speed claim, and the prompt doesn't ask for one. The page's
  `Creating indexes` section is a separate claim.
- **Stemming (`resetting` finds `reset`).** It depends on the text search configuration, which differs between
  `to_tsvector(x)` and `to_tsvector('english', x)`, so a probe could report the environment's default instead of
  the page.
- **Ordering among articles that tie, and ordering beyond title against text.** The prompt asks for nothing
  finer.
- **Partial or as-you-type matching (`:*`), phrases, negation.** The prompt asks for none of them.
- **Reaching the function over the API.** The scorer calls it in SQL as the superuser. Exposure and grants are a
  different page.
- **How the change was persisted.** The scorer applies pending migrations first and gives that its own check,
  so a function written straight into the database passes. Whether it survives a reset is the migrations
  guide's claim.
- **Schema changes to `articles`.** The probes insert `title` and `body`, so a new `not null` column without a
  default fails every probe with a `could not add the probe articles` note. The prompt asks for no such change.
