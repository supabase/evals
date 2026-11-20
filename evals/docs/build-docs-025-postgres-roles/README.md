# What this eval measures

The subject under test is the [Postgres Roles guide](https://supabase.com/docs/guides/database/postgres/roles), not the agent. A gap in the guide counts as a failure.

The claim is **a limited role can do its job and nothing more**. The user hands a dashboard tool to finance and wants it to read two tables, change nothing, and stay out of payroll. The scorer signs in with the connection string the agent left behind and tries to do exactly those things.

## Confirming the claim

The ticket lists no evidence, so the claim is a reading of the page. Before writing a check I ran the page's own statements, and the cases an agent following it runs into, on PostgreSQL 17 (the major version the seed pins). Predictions were written first.

- `create role "r"` and `create role "r" with login password '...'` run as printed.
- `create role "child_role_name" inherit "parent_role_name";` **does not run.** Postgres answers `unrecognized role option "parent_role_name"`. `INHERIT` is an option, not a way to name a parent, and `IN ROLE` is the clause that does.
- `alter role "child_role_name" noinherit;` **does not stop an existing membership inheriting** on PostgreSQL 16 and later. Inheritance is a property of each membership, set when the membership is granted, and the role attribute only supplies the default for memberships made afterwards. `pg_has_role(child, parent, 'usage')` stayed `true`. The page links a troubleshooting article titled "Custom role inherits privileges that were not explicitly granted". I did not read it, so this is my reading of the symptom and not its explanation.
- A new role with no grant is refused with `42501`. Grant `select` on a table that has row level security on and no policy for the role, and the role reads **zero rows with no error**. The page says application access belongs to RLS and says nothing about what RLS does to a role it creates.
- `revoke ... from role` does not undo a grant held by `public`.

Not run against a real stack: the same probes ran against PGlite with the sign-in stood in for. See Risks.

## Existing coverage

None of these makes a login and connects as it.

- `build-docs-002-rls-guide` scores policies for `anon` and `authenticated`, which are the application's roles.
- `build-docs-009-custom-claims-rbac` is role-based access inside the application, carried in a token.
- `build-docs-011-database-functions` scores execute grants on functions.
- `build-docs-004-postgres-connection` is about which connection string to use and leaves grants alone on purpose.
- `resolve-dataapi-002-secure-default-grants` is about default grants for the Data API roles.

## Do not reintroduce the vocabulary

`PROMPT.md` never says role, user, login, password, group, grant, revoke, permission, privilege, inherit, policy, row level security, RLS, admin, superuser, or least privilege. It says "the connection string the tool should use", because the settings file is the contract and the string is what lands in it. The prompt says "what we pay our staff", and the table is called `payroll`, so the agent has to find it.

Stripping the vocabulary is the measurement. It tells the agent to rely on the guide rather than on what it already knows, so a pass is evidence about the page. Keep that instruction when loosening the rest.

## The seed carries the contract

`integrations/bi-tool.env` ships with `BI_TOOL_DATABASE_URL` empty and a comment in product words. Filling it is where the agent's choice becomes observable: the account's name, its password, and how the password was written into a url. The scorer reads the account out of the string the way the tool would, and never from the transcript.

The migration seeds `customers`, `orders` and `payroll` with row level security on and no policies, which is how a Supabase project looks when its tables are only ever reached by the backend. That is a deliberate trap and the likeliest thing to hold a baseline down. An account that is granted `select` and nothing else signs in, passes every "cannot" check, and reads zero rows. The comment in the seed says who touches the tables and never mentions policies. If every run reds `the tool can read every order and every customer`, that is a finding about the page and not a scorer defect. Read the notes first, they say how many rows the tool saw.

Rows are not seeded for the scorer's benefit. The scorer inserts its own, with a per-run marker, after the agent finished: a customer who owns an order, a spare customer who owns nothing, and an order. A hardcoded answer cannot match them.

## Do not drop the positive controls

Every "cannot" check passes for an account that can do nothing at all, and an agent that built nothing passes none of them because there is nothing to sign in with. What makes the negatives mean something:

- `the tool's connection string signs in` runs first. If it fails, every check that needs the tool reports `not run:` and fails, never skips.
- `the tool can read every order and every customer` is the job. It requires the full row count **and** the row the scorer just added, so an empty result and a stale answer both fail.

## The probes refuse for one reason only

Each statement the tool is asked to run is a complete, valid row against the real schema, so access is the only thing that can refuse it. Deleting the order's customer would fail on a foreign key whatever the tool may do, so the delete probe aims at the spare customer. A statement counts as refused on `42501` and on nothing else. Any other error is `could not measure`, which fails. Whether a statement changed anything is read back as the superuser, never inferred from the error, so a role granted `update` behind row level security that matches nothing reads as unable to change data, which is the truth.

## What each check proves

| Check | Proves | Runs code |
| --- | --- | --- |
| `the agent applied the migrations it wrote` | Nothing the agent wrote is left pending. The scorer applies anything pending so the rest can run. | yes |
| `the tool's connection string signs in` | The string in the settings file authenticates as the account it names. A password with a symbol in it that was not percent-encoded fails here. | yes |
| `the tool's account is its own and carries no admin powers` | Not a role the platform ships, not a superuser, cannot create roles or databases or replicate, and cannot become a role the platform ships. | catalog read |
| `the tool's password is at least 12 characters` | The page's one numeric rule. | no |
| `the tool can read every order and every customer` | The job. | yes |
| `the tool cannot add, change or remove an order or a customer` | Six statements, state read back. | yes |
| `the tool cannot create tables` | It cannot change the schema either. | yes |
| `the tool cannot see payroll` | Sees nothing in the table, refused or filtered. | yes |
| `the agent read the postgres roles guide the prompt referenced` | The page was opened with content. | no |

`the tool's account is its own...` is the one check that is about structure and not behavior, on purpose. A role that is a member of `service_role` can still be shut out of every table by row level security, and every behavioral probe passes it, while it can `set role service_role` and bypass row level security. Membership is the only place that shows up.

Row level security bypass is allowed. An account with `bypassrls` that is granted only the two tables is a legitimate answer to the zero-rows trap, and it is measured by what it can then reach.

## Predictions, and what the probes were run against

Each example solution was run against the scorer's probe code on PGlite before this was written down. The sign-in was stood in for: PGlite has no password login, so the harness compares the string's password to the one it set. Predictions were written first, one per solution, and all 13 held once two harness defects (a collapsed column in the stand-in, a wrong password in my own fixture) were fixed. One prediction was wrong and was corrected: an unparseable string fails `signIn` and leaves nothing for `the tool's password...` to read, so that check reports not run too.

| Example solution | Red |
| --- | --- |
| Correct: its own account, read on both tables, a select policy for it | none |
| A group role holding the grants and a login that is a member | none |
| Select grants, no policy | `reads` |
| `bypassrls` and select on every table in `public` | `payroll` |
| All privileges on both tables and permissive policies | `writes` |
| A member of `service_role` with a read policy | `account` |
| The admin account | `account`, `password`, `writes`, `create`, `payroll` |
| Eight character password, otherwise right | `password` |
| Read, plus `create` on `public` | `create` |
| Read, plus select and a policy on `payroll` | `payroll` |
| String left empty | everything |
| Password with an unencoded `%` | everything |
| Wrong password in the string | everything but `password` |

## The guide has to actually be read

`the agent read the postgres roles guide the prompt referenced` matches docs calls against the guide's path, resolving the url from the harness's own docs result rather than the raw tool call. Without it, a run that never opened the page and passed on prior knowledge would read as the guide working. A mainstream task like this one is likely to pass either way, so read `docs.calls` before reading the score.

## What this eval does not score

- **The rest of the password advice.** Mixed case and symbols, no dictionary words, and a password manager. Length is the one rule a check can read without opining on strength.
- **Percent-encoding as a claim of its own.** It is only measured through `signIn`. An agent that picks a password with no symbols never needs it, and that is fine.
- **Role hierarchy.** Any shape that gives the tool the right access passes, a single login or a group with a member. The page's hierarchy snippet does not run, and an agent that copies it and recovers scores the same as one that never tried. The two findings above go to the docs ticket, not to a check.
- **Tables created later.** Default privileges and whether the tool would see next month's tables are a different question.
- **Column-level access.** The tool may read every column of the two tables.
- **A password written into a migration or committed.** The page is silent on it and the seed does not say where credentials belong.
- **A pooler username.** The string is a direct connection, so a `role.project` username that the pooler wants fails `signIn`. The seed comment says it is direct.
- **The descriptions of Supabase's own roles, `pg_stat_statements`, and changing the project password.** Reference material, with nothing an agent builds from it.

## Risks

- **Row level security is the likeliest cause of a low baseline.** See the seed section.
- **Not run against a real stack.** Three things were assumed and not observed: `supabase status -o json` reports a `DB_URL` the scorer can reuse for host and port, password login works over that port for a role the agent made, and the sandbox has `psql`. The last is what `execSql` already relies on, the first two are what a first run settles.
- **Creating a role with `bypassrls` as `postgres`.** Allowed on a hosted project because `postgres` holds the attribute. Assumed, not verified, on the local image.
- **Refresh twice before describing how agents fail.** One baseline's failure mode is not the eval's.
