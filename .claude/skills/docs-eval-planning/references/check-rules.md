# Designing the checks

Ordered by what a violation costs. The first three have each sunk a run.

## 1. The check must be observable in the end state

If the correct answer is to let the platform supply a value, a correct agent writes nothing and the
check reds correct work.

The connection eval scored 0/6 on its central check for exactly this. The seed told the agent the
deploy sets `DATABASE_URL`, so agents read it from the environment and recorded the string nowhere.
One run named the transaction pooler and port 6543 in its own code comment and still scored red. The
choice was right and unmeasurable.

**Before writing a check, decide where its answer lands.** Give the seed a place for it: an empty
`.env.example`, a config file, a named file the contract points at. If there is nowhere for the answer
to go, there is no check yet.

## 2. Behaviour over structure

A check that reads *where* code sits reds correct refactorings.

Reading whether a client was constructed inside a function red a factory called once at module scope,
which is correct. Counting how many connections open across repeated invocations does not care how the
client was built.

The same rule kills static scans of source and config, which are defeated by four independent moves:
a shell `export` prefix in a `.env` file, a config value reached through a variable, a renamed
environment variable, and a wrapper function around the call being matched. A reviewer asked for the
same remedy four times on one PR: commit the counterexample as a fixture, or replace the static claim
with a behavioral probe.

Where a static check is the only option, name it for what it proves and say in the `README.md` that it
is a source-level claim.

## 3. Positive controls, and not ones a literal satisfies

Every absence check needs a paired proof that the allowed path changes state.

"No secret key in the bundle" and "not the direct connection" both pass for an agent that built
nothing. The paired control is what makes them mean anything.

**A control must not be satisfiable by a literal.** A control that greps the response for a seeded
value passes a hardcoded array containing that value. Insert a row with a run-scoped marker *after the
code was written* and require the marker back.

## 4. Every call site qualifies, not the first

Reading `sites[0]` passes a workspace holding one correct client and one wrong one somewhere else.
Range over all of them.

## 5. Write the absence semantics down, per check

Decide what the check does when the object it inspects does not exist, put it in the table, then read
the code to confirm it does that.

"RLS is enabled on `todos`" fails if `todos` is missing. "No client role can read a materialized view"
passes if the agent made none. A check that is conditional says so in its notes, so a not-applicable
pass does not read as a real one.

## 6. Whitelist, not blacklist

Enumerating spellings cannot close a class. Six key-name patterns still missed two more. A whitelist of
what the project was given fails everything else by construction.

## 7. Name the check for what it proves

Not for what you meant. "No write grant anywhere" proven by three privileges is a false name while a
fourth is still reachable.

Names are also history: the published results series is keyed on them, so renaming a check breaks it.
Get the name right before the first run.

## 8. The environment must not decide the verdict

TLS, address family, and ports have each red correct work.

A handler that sets `ssl: 'require'` cannot connect to a local database that speaks no TLS. A direct
connection is IPv6-only. A stale token shadows a real one. In each case the eval reports the
environment rather than the page.

Two ways out. Make the harness support the correct behaviour, which is what terminating TLS in front of
the database does. Or declare the claim unscored in the `README.md` and say why.

The same trap catches a check that measures the platform. Two checks were built, shipped, and reverted
for scoring which keys a runtime hands a function, which the pinned CLI decides. Keeping either means a
CLI upgrade reports as a docs change.

## 9. Predict which checks will saturate

If the seed labels the answer, the check is free.

The connection eval's fixture names the three connection modes the way the dashboard does, so picking
the right one costs an agent nothing, and that check came back 6/6. Every check but one did. Write the
prediction into the plan, so a reviewer sees where the signal actually is.

## 10. A blocked check fails, it never skips

A missing artifact is the absence of evidence. Reporting it green hands a clean sheet to a run that
produced nothing. Give the blocked path its own note saying why it did not run.

## 11. Split the phases, and say why the order matters

Static scans run before anything installs or writes. Snapshot state before running anything the agent
wrote. A probe that mutates a fixture runs after every probe that reads it.

Scope every marker to the run. A fixed literal leaks between runs.

**Return errors instead of throwing.** A throwing setup step collapses a whole result to one check, and
the drop is only visible by comparing check counts against the previous commit. Fold the error into a
check of its own so a failed step costs only the checks that needed it.

## 12. Reach for a judge only when the artifact class is unbounded

Free prose or arbitrary test files, not anything a query or a file read can settle.

When you do: one claim per check, a checklist rubric rather than an adjective, an explicit statement of
what not to grade, and a tie-break. And read the notes on a run that failed before blaming the judge.
Effort was raised twice on one rubric before someone checked and found the variance was in the agent's
output, not the judge.
