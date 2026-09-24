# Auditing a check for accuracy

A check is accurate when it reds exactly the solutions it claims to red. Two questions per check, and
both have to be answered with a solution you could write out, not with a judgement about the code.

The known defects are catalogued in
`evals/docs/.claude/skills/docs-eval-planning/references/flakiness.md`, each with the PR that recorded
it. This file is how to look for them in an eval that already exists.

## Start from the end state, not the name

For each check, answer in order:

1. What does it actually read? A file, a row, a response, a tool call.
2. What is the smallest change to the agent's work that flips it?
3. Is that change the thing the `README.md` says the check is for?

A gap between 2 and 3 is the finding, and it usually reads as an over-claiming name rather than as a
broken assertion.

## Question one: what passes this that should red?

Work the list against the code. Each line is a defect somebody has shipped.

- **A static scan the agent can route around.** A shell `export` prefix, a config value reached
  through a variable, an environment variable under an innocuous alias, a wrapper function around the
  call being matched. Any of the four defeats a source-level claim, and the check then reports
  compliance.
- **A literal match that counts dead code.** Finding `.signUp(` in a file proves the string is in the
  file. Pair it with a check that proves the path runs, or name it in the `README.md` as a
  source-level claim.
- **A control satisfied by a hardcoded value.** If the control greps a response for something the seed
  already contains, a handler returning a literal passes it. The state has to be inserted after the
  agent's code was written, with a run-scoped marker, and the marker required back.
- **Only the first call site.** `sites[0]` greens a workspace holding one correct client and one wrong
  one. Range over every site.
- **A blacklist.** Enumerating spellings cannot close a class; every list is incomplete by
  construction. Whitelist what the project was given and fail everything else.
- **An empty result set reading as clean.** `!error && leaked.length === 0` is true when nothing was
  read at all. Assert the subject's own row is present, then that nobody else's is.
- **A refusal the probe caused itself.** A probe asserting that a request was denied passes on a
  not-null violation, a missing column, or a typo in the payload. Send the complete contract row so
  access control is the only thing left that can refuse it, confirm the outcome as the superuser rather
  than inferring it from the error, and treat any code outside the expected one as could-not-measure.
- **A path that never consults the mechanism.** A public Storage bucket serves its objects from the
  bucket flag and never reads the policies, so every policy-shaped check agrees while the file is
  world-readable. Ask of each probe which component decides its outcome, and whether that is the
  component under test.
- **A scan with nothing to scan.** `git ls-files` in a scorer matches nothing, because the harness
  strips `.git` when it copies the seed in. A vacuous scan is green forever. Confirm the thing being
  read exists at the moment the check runs.
- **A substring match on the guide url.** `includes` on a path means a fetch of the published page
  satisfies a check meant to prove a preview was read. Match the host too when an eval points at a
  docs preview.
- **A check that only ever ran as the superuser.** `ctx.query` bypasses RLS. Any claim about who can
  read what has to go through a client with an identity, not through `query`.

## Question two: what reds this that should pass?

The `README.md`'s "what this eval does not score" section is the reference for this question. Every
design it declares acceptable is a solution that must green.

- **A structural read of where code sits.** Requiring a constructor at module scope reds a factory
  called once at module scope. Count the effect instead: one connection across repeated invocations
  proves the same thing and has no opinion about how the client was built.
- **A check tracking a literal the seed shipped.** Agents replace seeded credentials with their own,
  and the sandbox may carry a live one. Assert on the name the code reads, minus the names the
  platform injects, never on the value.
- **An answer with nowhere to land.** If the correct move is to let the platform supply a value, a
  correct agent writes nothing and the check reds correct work. The seed has to give the answer a
  place to go.
- **A lifecycle the page never mentions.** Correct SQL in a migration nobody applied reds every check
  that reads the database. Run `supabase migration up --local` before reading anything, and give the
  lifecycle a check of its own so it costs one check instead of nine. `migration up` rather than
  `db reset`, because a reset discards state the agent created at runtime through a client, which is
  equally correct.
- **A correct behavior the environment cannot support.** A handler requiring TLS cannot reach a local
  database that speaks none. Either the harness supports it or the `README.md` declares the claim
  unscored.
- **An ambiguity the checks resolve one way.** If the prompt does not say, the check passes. A rule
  the prompt never stated is not a defect in the solution.
- **A value the platform decides.** Which keys a runtime hands a function, what a pinned CLI version
  does, what a default grant is today. A check on one of these reports an upgrade as a docs change.
  Drop it.
- **A regex over a tool call that is too strict.** An extra flag in the command defeated one. Match
  the part that carries the meaning.
- **Objects the extension created.** pgTAP installs views into `public`. Anti-join `pg_depend` on
  `deptype = 'e'` before asserting on a catalog listing.

## Naming, and the history it keys

The published results series is keyed on the eval id and on check names, so a rename breaks history.
That makes naming a blocking review item before the first run and a costly one after.

Read each name as a claim and ask whether the code proves that claim or a member of it. A name that
says "the app never exposes a secret" and a check that matches two spellings in one file are a finding
even when the check is otherwise sound.

## Judges

A judge is right only where the artifact class is unbounded: free prose, or files whose shape nobody
can predict. Anything a query or a file read settles should not be a judge.

Where there is one, check that the rubric makes one claim, states what not to grade, and carries a
tie-break. An eval passes only when every check passes, so an ambitious rubric on a secondary check
fails the whole page.

Before blaming a judge for variance, read the notes on the failing runs. A rubric that complains
differently each run is usually tracking real variance in what the agent produced, and that
misdiagnosis has already produced two wrong fixes in this repo before anyone read the notes.

## How to write a finding

> `the app never exposes a secret to the browser` greens a workspace whose `.env` reads
> `export VITE_ADMIN_KEY=...`, because the parse splits on `=` and takes the first field, which is
> `export VITE_ADMIN_KEY` and not a name the whitelist knows. Fix: parse the `export` prefix, and
> commit the counterexample as a fixture.

The check name, the solution, the mechanism, the fix. If you cannot write the solution, the finding is
not ready and Phase 5 is where it goes to be settled.
