# Designing the checks

Ordered by what a violation costs. The first three matter most.

## 1. The check must be observable in the end state

If the correct answer is to let the platform supply a value, a correct agent writes nothing and the
check reds correct work.

**Before writing a check, decide where its answer lands.** Give the seed a place for it: an empty
`.env.example`, a config file, a named file the contract points at. If there is nowhere for the answer
to go, there is no check yet.

## 2. Behaviour over structure

A check that reads where code sits fails correct refactorings. Count the effect instead.

The same rule applies to static scans of source and config. A shell `export` prefix, a config value
reached through a variable, a renamed environment variable, and a wrapper function around the call
being matched each defeat one. Replace the static claim with a behavioral probe, or commit a
counterexample as a local solution and confirm the check rejects it.

Where a static check is the only option, name it for what it proves and say in the `README.md` that it
is a source-level claim.

## 3. Positive controls, and not ones a literal satisfies

Every absence check needs a paired proof that the allowed path changes state.

An absence check passes for an agent that built nothing, so the paired control is what makes it mean
anything.

**A control must not be satisfiable by a literal.** A control that greps a response for a seeded value
passes a hardcoded value. Insert state with a run-scoped marker after the code was written, and require
the marker back.

## 4. Every call site qualifies, not the first

Reading the first match passes a workspace that holds one correct call site and one wrong one. Range
over every site.

## 5. Write the absence semantics down, per check

Decide what the check does when the object it inspects does not exist, put it in the table, then read
the code to confirm it does that.

A check on an object the prompt names fails when the object is missing. A check on a class of object
the agent may not have created passes when there are none. A conditional check says so in its notes,
so a not-applicable pass does not read as a real one.

## 6. Whitelist, not blacklist

Enumerating spellings cannot close a class; any list is incomplete by construction. Whitelist what the
project was given and fail everything else.

## 7. Name the check for what it proves

Not for what you meant. A name that claims a class while the check proves a few members of it is a
false name.

The published results series is keyed on check names, so renaming one breaks history. Get the name
right before the first run.

## 8. The environment must not decide the verdict

Transport security, address family, and port availability can each fail correct work, and the eval then
reports the environment rather than the page.

Two ways out. Make the harness support the correct behaviour, or declare the claim unscored in the
`README.md` and say why.

The same trap catches a check that scores something the platform decides rather than something the page
says. A pinned CLI version or a runtime default is not the subject under test, and a check on one
reports an upgrade as a docs change.

## 9. Predict which checks will saturate

If the seed labels the answer, the check is free and carries no signal.

Write the prediction into the plan, so a reviewer sees where the signal actually is.

## 10. A blocked check fails, it never skips

A missing artifact is the absence of evidence. Reporting it green hands a clean sheet to a run that
produced nothing. Give the blocked path its own note saying why it did not run.

## 11. Split the phases, and say why the order matters

Static scans run before anything installs or writes. Snapshot state before running anything the agent
wrote. A probe that mutates a fixture runs after every probe that reads it.

Scope every marker to the run. A fixed literal leaks between runs.

**Return errors instead of throwing.** A throwing setup step collapses the whole result to one check.
Fold the error into a check of its own, so a failed step costs only the checks that needed it.

## 12. Reach for a judge only when the artifact class is unbounded

Free prose or arbitrary test files, not anything a query or a file read can settle.

When you do: one claim per check, a checklist rubric rather than an adjective, an explicit statement of
what not to grade, and a tie-break.

Read the notes on a failing run before blaming the judge. A rubric that complains differently each run
is usually tracking real variance in what the agent produced.
