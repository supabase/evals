# What has gone wrong before

Every entry is from a run or a review, with the PR that recorded it. A citation per entry is what keeps
a plausible-sounding rule from creeping in.

Add to this file. A documentation eval is not finished until whatever went wrong on it is here.

## False green: the check passes broken work

- **A static scan is defeated by aliasing, four ways.** In a `.env` file, `export VITE_ADMIN=<secret>`
  slips past a key-name parse. A bundler config that computes `envPrefix` through a variable is
  invisible to a literal read of the config. An environment variable renamed to an innocuous alias
  defeats a name blocklist. A wrapper function defeats a match on the call inside it. #212
  **Fix.** Commit the counterexample as a local fixture, or replace the static claim with a behavioral
  probe.
- **A literal match counts dead code as working code.** `.auth.signUp(` anywhere in client source
  satisfied a check, including in code nothing reaches. #212
  **Fix.** Pair it with a check that proves the path runs, and name the check as a literal match.
- **A control that greps for a seeded value passes a hardcoded array.** A handler returning a literal
  containing the seeded row's name cleared a read control. #257
  **Fix.** Insert a row with a run-scoped marker after the code was written and require the marker back.
- **Reading only the first call site.** Checking `sites[0]` cleared a workspace holding one correct
  client and one constructed per request elsewhere. #257
  **Fix.** Range over every site.
- **Enumerating spellings cannot close a class.** Six key-name patterns still missed two more. #168
  **Fix.** Whitelist what the project was given and fail everything else.
- **The result is green when nothing was read.** `!error && leaked.length === 0` is true of an empty
  result set. #168
  **Fix.** Assert the subject's own row is present, then that nobody else's is.
- **Repointing REFERENCE at a docs preview without matching the preview host.** The guide-read check
  matches on `includes`, so a fetch of the published page satisfies a check meant to prove the preview
  was read. #218
  **Fix.** Match the full preview host, not the path.

## False red: the check fails correct work

- **A structural read of where code sits.** Requiring the client constructor at module scope red a
  factory called once at module scope, which is correct. #257
  **Fix.** Count the effect. One connection across repeated invocations proves the same thing and does
  not care how the client was built.
- **The correct answer is not observable.** Agents left a connection string to the deploy, as the seed
  told them to, so nothing in the workspace carried their choice and the central check red all six
  runs. One of them named the right answer in a code comment. #257
  **Fix.** Give the choice somewhere to land in the seed.
- **The environment cannot support the correct behaviour.** A handler setting `ssl: 'require'` could
  not reach a local database that speaks no TLS, so both end-to-end checks red on a more correct
  solution. #257
  **Fix.** Terminate TLS in front of the database, or declare the claim unscored.
- **The sandbox image made the task unwinnable.** `npm install -g` failed with `EACCES` because the
  image ran as a user with no writable global prefix, so the agent could not complete step one. #108
  **Fix.** Change the image, and add a test that locks the behaviour in.
- **A prompt ambiguity the checks resolve one way.** An agent gated an endpoint on being signed in,
  which the prompt never ruled out, and it red in CI. #212
  **Fix.** Either the check accepts it, or the prompt says which it wants.
- **A design choice scored as a defect.** A probe requiring two rows in one response would fail an
  agent that paginated. #212
  **Fix.** Name it in the README as a narrow edge, or probe in a way that tolerates it.
- **The check measures the platform, not the page.** Two checks scored which keys a runtime hands a
  function, which the pinned CLI decides. Both were reverted. #212, #218
  **Fix.** Drop it. Keeping it means a CLI upgrade reports as a docs change.
- **The guide-read check drops non-apex hosts.** `isSupabaseApexUrl` accepts only `supabase.com`, so a
  preview fetch never reaches `docsCalls` and the check reds a run that did read the page. #218
  **Fix.** Widen the host predicate when pointing an eval at an unmerged docs PR.
- **A regex over a tool call is too strict.** A plugin-install check missed the command because the
  agent added `--yes`. #108
  **Fix.** Match the part that carries the meaning.
- **Extension-owned objects land in scope.** pgTAP creates views in `public` when installed there. #168
  **Fix.** Anti-join `pg_depend` on `deptype = 'e'`.

## Nondeterminism

- **Judge variance was misdiagnosed twice.** A rubric's complaint changed run to run. The first
  response blamed reasoning effort and proposed a per-eval override; the second raised the global
  default; the third proved the variance was never in the judge. It tracked whichever test suite the
  agent wrote that run. #220, #222, #224
  **Fix.** Read the notes on the failing runs before blaming the judge. Then scope the rubric to what
  the check is worth, drop every craft requirement, and give it a tie-break.
- **One ambitious check fails a whole eval.** An eval passes only when every check passes, so a bonus
  check turned a page red while forty real checks were green. #224
  **Fix.** Scope a bonus check to a low bar, and rename it if the old name claimed more.
- **Retry layers multiply.** A pair-level retry wrapping a create-level retry produced 39 attempts over
  588 seconds for one unrecoverable credential error. At high concurrency a single bad secret makes
  every pair thrash. #192
  **Fix.** Classify errors as retryable or not, and do not nest retries.
- **Stop-on-pass retries hide variance.** `attempts: 2` means attempt one failed. That can be agent
  variance rather than a scorer defect, and the two read identically in a summary. #218
  **Fix.** Read the attempts, and treat one green run as a signal rather than proof.
- **Fixed marker literals leak between runs.** #168
  **Fix.** Scope markers to the run.

## Crashes and contamination

- **A throwing setup step collapses the result.** One uncaught insert took a 35-check result down to
  one, visible only by comparing check counts against the previous commit. #168
  **Fix.** Return the error and fold it into a check of its own.
- **`ON CONFLICT` pins a schema the prompt invites the agent to change.** #168
  **Fix.** `INSERT ... SELECT ... WHERE NOT EXISTS`.
- **A probe mutates what a later check reads.** #168
  **Fix.** Snapshot the catalog first, run the agent's own suite last, and put a probe that rewrites a
  fixture after every probe that reads it.
- **`export-results` merge never prunes.** It overwrites keys present in the new results and leaves
  stale keys alive, so renaming an eval leaves the old row beside the new one and a skipped pair keeps
  its last recorded verdict forever. Found twice, six weeks apart, by two reviewers. #168, #108
  **Fix.** Pass the requested pairs and drop rows that were requested but produced nothing.
- **An empty `results/` overwrites the export with `[]`.** Easy to do by accident. #228
- **A bot pushed refreshed results onto a measurement branch**, where the results were measured against
  a preview url rather than the published page. #218
  **Fix.** Do not refresh results from a scratch branch.

## Environment and reproducibility

- **Ports.** The range is 54321 to 54329. Another project's stack holding them blocked local runs
  entirely, and one eval shipped for review having never run end to end because of it. #168, #206
  **Fix.** Preflight the ports. Both later evals open their testing steps with it.
- **`pnpm check` needs `OPENAI_API_KEY`** and stops without it, which reads as a broken diff. The same
  unattributed failure appears six weeks earlier. #228, #168
- **A stale local `VERCEL_OIDC_TOKEN` shadows the real one** and every sandbox create fails. #192
- **An env-isolation assertion cannot be strict.** Vite sets `NODE_ENV` and macOS injects
  `__CF_USER_TEXT_ENCODING` even with a controlled environment, so asserting an exact key set fails.
  #188
- **`pnpm format:check` fails on local artifacts that are nobody's diff.** Biome walks
  `.claude/worktrees/`, where it hits broken symlinks, `.solution-runs/`, and the git-excluded
  `evals/*/solutions/`, which is where a deliberate parse-error fixture lives. The failure reads as a
  broken branch. #259
  **Fix.** Scope Biome to the paths you touched, or add those three to `biome.json`.

## Metadata

- **An optional dimension is a silent hole.** `interface:` was optional, so six scenarios never
  declared one and fell out of any categorization on that axis. #228
  **Fix.** Require it, so the gap becomes a load-time error.
- **`motivation:` is required by `CONTRIBUTING.md` and is not in the schema**, so the preprocess step
  drops it and two evals have none. #228
- **Renaming breaks history.** The published series is keyed on the eval id and on check names. #168,
  #230
  **Fix.** Get both right before the first run, and keep name strings byte-identical when refactoring.

## Process

- **Verify your own predictions.** A PR body predicted a check would fail an agent following the page.
  The reviewer found it passing locally and in CI and asked why. #212
- **An unmeasured rule in the prompt is a defect.** A reviewer found a prompt rule with no check and no
  README entry. #168
  **Fix.** Measure it or name it out of scope.
- **The harness can leak the answer.** A system-prompt addendum gave agents a head start on what they
  should have discovered. #108, #241
- **The scorer copied the guide's own AI prompt panel into `PROMPT.md`**, so the rules that spell out
  the answer were the prompt. #168
  **Fix.** The prompt is a product request. The page is the thing being tested.
