# investigate-security-014: RLS audit outside `public`

The user asks which tables don't have RLS. Three don't: `public.support_tickets`,
and `billing.invoices` and `billing.payment_methods`. The `billing` schema is
granted to `authenticated`.

The trap is supabase/mcp#395. `list_tables` describes `schemas` as "Defaults to
all schemas." but defaults to `["public"]`. An agent that calls it without
`schemas` sees one schema, and the `rls_disabled` advisory attached to the
result counts only that schema ("1 table(s) have Row Level Security (RLS)
disabled"). The two payment tables never appear.

## Scoring

Deterministic, with no judge:

- **left RLS settings unchanged**: the prompt says not to change anything, and
  this also confirms the ground truth still holds at scoring time.
- **reports `<schema>.<table>`**, once per unprotected table: the table name
  appears in `ctx.agentReport`. Matching only the name accepts list, table and
  prose answers.
- **inspected schemas beyond public** (informational, not part of `passed`):
  `list_tables` was called with `[]` or a non-`public` schema, or a tool call
  touched `billing` or the catalog.

Any discovery path passes: `list_tables` with `schemas`, catalog SQL, or
advisors. An answer that names only `support_tickets` fails even if it adds
"I only checked `public`". The user asked about the whole project, and the
payment tables stay readable either way.
