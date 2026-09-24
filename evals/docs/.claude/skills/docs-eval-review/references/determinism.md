# Auditing a scorer for flakiness

One question, asked of every check: with the agent's work held fixed, what else could change the
verdict?

Anything that can is noise, and noise in a docs eval is expensive in a specific way. The results are a
series over time, so a check that flips reads as the page having changed.

## The check list itself has to be stable

Before the individual checks, read the shape of the result.

- **Same names, same count, every run, including the failure paths.** Checks assembled inside
  branching logic disappear when their path is not taken, and a missing row is not a red row. Build
  the list declaratively in `EVAL.ts` and return it from one place.
- **A blocked check fails, it never skips.** A missing artifact is the absence of evidence, and
  reporting it green hands a clean sheet to a run that produced nothing. The blocked path gets its own
  note saying why it did not run.
- **Setup returns errors, it does not throw.** One uncaught insert took a 35-check result down to a
  single check, which was visible only by comparing check counts against the previous commit. Fold the
  error into a check of its own so a failed step costs the checks that needed it and no others.
- **The catch in `EVAL.ts` returns one self-named failing check.** Confirm it exists and that its name
  is a name, not a stack trace.

## Sweep for the sources, in order of how often they bite

**Order and mutation.** Static reads run before anything installs or writes. Snapshot catalog state
before running anything the agent wrote. A probe that rewrites a fixture runs after every probe that
reads it. Ask of each pair of checks whether swapping them would change either verdict; if it would,
the order is load-bearing and `EVAL.ts` should say why in a comment.

**Markers and fixtures.** Every value the scorer inserts is scoped to the run. A fixed literal leaks
between runs on a reused stack and greens a check the current run never earned. The same goes for
object names in Storage, which a scorer cannot delete: `storage.objects` and `storage.buckets` carry
delete-protection triggers that `postgres` cannot drop.

**Lazily discovered stack state.** `ctx.stackStatus()` requires its three values together and throws
when any is missing, so an eval needing only the api url and one key has to read `supabase status`
directly and accept either key spelling. Anything read from `supabase status` also arrives with
`Stopped services` chatter and an upgrade notice in front of it; a scorer that surfaces the raw text
files real failures as infrastructure.

**Values the environment supplies.** Ports 54321 to 54329, keys the platform injects, `NODE_ENV`,
OS-injected variables. An assertion on an exact environment key set fails for reasons that have
nothing to do with the agent. A check whose verdict a pinned CLI version decides is measuring the
platform, not the page.

**Anything unordered or unbounded.** A query with no `ORDER BY` that reads `rows[0]`. A float compared
exactly. A timestamp compared against now. A tolerance is a design decision and belongs in the
`README.md`: an eval asserting cent-exact totals states that it allows a cent either way.

**Network and installs inside the scorer.** An install or build in a check is wall-clock the agent's
timeout does not bound, and a registry hiccup reds the eval rather than the work. Make the install its
own check so a failure costs only what depended on it, and set the per-command timeout deliberately.

**Transcript-derived checks.** The guide-read check depends on how a harness reports a page open, and
that has already changed under an agent upgrade and red three runs that plainly read the page. Resolve
the url through `buildDocsResult` rather than raw tool calls, and before blaming the check, replay the
run's recorded tool calls through `buildDocsResult`. CI keeps them in the `raw-results` artifact even
though the published results drop them.

**Judges.** Variance in a rubric's complaint is usually variance in what the agent produced. Read the
notes on the failing runs first, then scope the rubric, drop the craft requirements, and give it a
tie-break.

**Retries.** A pair-level retry wrapping a create-level retry produced 39 attempts over 588 seconds
for one unrecoverable error. Nested retries and stop-on-pass retries both hide variance rather than
removing it.

**Loss the eval cannot control.** A sandbox can lose its database container mid-run. There is no fix
at the eval's level: report the run as lost, read the surviving checks, and run three or more times
per experiment rather than once.

## The empirical test

Reading finds candidates. Two runs settle them.

Score the same fixture workspace twice, without changing a byte, and diff the results on check names
and verdicts. Notes may legitimately differ, since they carry uuids and timings; names and verdicts
may not. Any check that moves is a defect, and you now have the cheapest possible reproduction of it.

Where a check depends on a fresh stack, score it once against a stack the scorer has already run
against. A check that greens the first time and reds the second is holding state between runs.

## Telling a flaky scorer from a varying agent

They read identically in a summary, and the distinction decides who fixes what.

- `attempts: 2` means attempt one failed. That is a signal to investigate, not a verdict.
- Two runs of the same fixture disagreeing is the scorer. Two runs of the same *agent* disagreeing may
  be the agent.
- Read the notes on both runs before forming a theory. The most expensive misdiagnoses in this repo's
  catalog are the ones where the notes said plainly what happened and nobody read them.
