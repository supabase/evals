# Diagnose and grant Data API table access

Use this procedure when a table exists in PostgreSQL but requests through Supabase clients, REST, or GraphQL cannot read or write it. It covers Data API roles and PostgreSQL grants; it does not diagnose direct database connections.

## Prerequisites

- Identify the exact Supabase project and database environment used by the failing application (local, branch, or hosted).
- Have permission to inspect its Data API settings and database ACLs. To apply a migration, use the project’s normal reviewed migration workflow and an authorized database role.
- Confirm the client request uses the expected project URL and key. A publishable/legacy anon key without a signed-in user session acts as the anon role; with a valid user access token it acts as authenticated.
- Know which operations the app needs. Grant only those operations to the relevant role. For a private user journal, the usual client operations are SELECT and INSERT for authenticated; do not grant anonymous access unless the product explicitly requires it.

## Diagnose the access layers

A table can exist and contain rows while being inaccessible through the Data API. Check these layers in order:

1. Confirm the Data API is enabled and the table is in an exposed schema (commonly public). Direct SQL visibility does not prove API exposure.
2. Check the request’s effective role and exact database/API error. A PostgREST 42501 “permission denied for table” response, especially with a grant hint, indicates that the current role lacks a needed table privilege. SELECT, INSERT, UPDATE, and DELETE are independent. An empty successful response can instead mean RLS filtered out rows; check policies and test with known owner and non-owner identities.
3. Inspect the target database’s effective table grants. Adapt the table name below and run it as a database administrator:

   ```sql
   select grantee, privilege_type
   from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name = 'example_table'
     and grantee in ('anon', 'authenticated', 'service_role')
   order by grantee, privilege_type;
   ```

4. Compare the grants for the request’s role and operation with the required access. If the needed grant is absent, repair that table’s grants. If it is present, secure-by-default exposure does not explain this request’s failure; continue with schema exposure, column privileges, the request identity, and RLS.

### Understand automatic exposure defaults

The Automatically expose new tables setting (also labeled Default privileges for new entities in some interfaces) controls automatic privileges for objects created under that configuration. Supabase is rolling out secure-by-default behavior in stages, so projects can differ. A new table created while automatic exposure is disabled can lack client-role grants. This may explain a missing grant when the table’s creation timing and project configuration support that explanation.

The setting is not a current-access check: changing it does not add or remove privileges on existing tables. For an existing table, its actual grants on the database handling the request determine whether its role can access it. If those grants include the required privilege, the automatic-exposure setting does not account for a failure of that operation. If grants are missing but the table’s creation-time configuration is unknown, report that cause as unconfirmed; diagnose and repair from the actual grants and API error.

Use this decision rule when explaining the cause:

- **Missing required table privilege for the request role:** this establishes why that operation is denied now. If the request returns PostgREST 42501 with a grant hint for that role and operation, record it as direct evidence of the missing grant.
- **Missing privilege plus confirmed restrictive defaults when the table was created:** secure-by-default exposure is a supported explanation for why the grant was absent. The setting affects new objects; it does not retroactively change existing table grants.
- **Missing privilege but unknown creation-time configuration:** report the access cause as missing privilege and the reason it is missing as unknown. Do not claim the secure-default rollout caused it based only on the project’s current setting or a current runtime probe.
- **Required privilege is present:** automatic exposure defaults do not explain the current failure for that role and operation. Continue checking whether the request reaches this database and schema, whether column privileges permit the operation, and whether the authenticated identity and RLS policies permit the requested rows or write.

The name `api.auto_expose_new_tables` may appear in troubleshooting. Where supported, probe it with:

```sql
select current_setting('api.auto_expose_new_tables', true) as auto_expose_new_tables;
```

A NULL result means the database runtime does not expose a setting under that name. It does not reveal the Dashboard setting, the configuration at the time a table was created, or the table’s current grants. Treat it as inconclusive and use the ACL query above. A current setting value also does not prove what was in effect when an existing table was created; check the project configuration/history if you need to attribute the missing grant.

Grants decide whether a role may reach an object. RLS then decides which rows that role can access. Missing grants reject the request before row policies can help; adding a grant does not bypass RLS. An RLS policy cannot compensate for a missing table privilege.

## Repair with a migration

First inspect the existing RLS policies and confirm they enforce the intended ownership rule. For a journal with a user_id column, owner policies commonly compare it with auth.uid() for SELECT and INSERT. Preserve correct policies; if they are absent or incorrect, repair them as a separate, reviewed change.

For a private table that signed-in users may read and create rows in, an adaptable migration is:

```sql
-- Example: replace example_table with the schema-qualified target table.
-- Remove these client roles' table privileges, then add only the intended ones.
revoke all privileges on table public.example_table
  from anon, authenticated;
grant select, insert on table public.example_table to authenticated;
```

Use the exact requested role and operation set for the application. Do not grant service_role, anon, UPDATE, or DELETE just to make a request work; add a privilege only when the product requires it and the access path is designed for that role. This example narrows table-level ACLs for anon and authenticated; inspect column-level grants and other roles separately if the resulting ACL does not match the intended boundary. Do not change automatic default privileges project-wide as a shortcut for fixing one table.

Put the SQL in a timestamped migration using the repository’s established naming and deployment process. Apply it first to the intended local or preview database, inspect the resulting grants, then deploy through the project’s normal migration process. Do not treat a successful direct SQL query as proof that the Data API role can access the table.

## Verify allowed and denied requests

Use two distinct authenticated test users and the ordinary client key plus each user’s access token. Never use a secret/service key for these checks because it changes the authorization path and can bypass RLS.

- With user A signed in, read entries and confirm only rows whose user_id is A are returned.
- With user A signed in, insert an entry without trusting a caller-supplied owner ID. Confirm the row is saved with A’s identity and is readable by A.
- With user B signed in, confirm A’s row is not returned. Attempt an insert claiming A’s user_id; RLS should reject it.
- Without a user session, confirm the anonymous request cannot read or create private entries.
- Confirm UPDATE and DELETE remain unavailable if the feature does not require them. Check the effective grants as well as API responses; a denied row under RLS is not the same as a missing table privilege.

These are examples to adapt to the project’s table columns, endpoint, and test identities. Do not include real credentials in shell history or documentation.

If grants now match the intended role set but requests still fail, check the request’s project URL, schema exposure, JWT/session, column privileges, and RLS policy predicates. State what the ACL and API response establish; do not attribute an existing-table failure to automatic defaults without evidence.
