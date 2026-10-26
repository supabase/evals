# Delete an account and revoke access

Use this procedure when an authenticated user requests permanent account deletion and must lose access to application data.

## Prerequisites

- Work in a migration or another reviewed database change path, and confirm the target project before applying it.
- Identify every user-owned table, view, RPC, and other service that can expose or mutate the user's data. Enable RLS and define the intended policies on every client-accessible table.
- Use a privileged database owner for the migration. The client must not receive direct access to `auth.users`.
- Check whether the user owns Storage objects. Auth user deletion can fail while the user owns Storage objects; remove or reassign those objects according to your retention policy first.
- Decide which application rows should cascade from the Auth identity. Add foreign keys to `auth.users(id)` with `ON DELETE CASCADE` where that matches the data-retention requirements.

## Why removing application data is not enough

A soft-delete flag in an application table leaves the Auth identity able to sign in and refresh sessions. Deleting only the user's sessions also leaves that identity able to authenticate again. Permanently deleting the Auth user removes the identity, cascades to its sessions, invalidates refresh tokens, and prevents future sign-in.

Deleting an identity does not retroactively revoke a previously issued access-token JWT. A service that verifies only its signature may accept it until its `exp` time. For database requests protected by RLS, add a live identity check so the deleted user's stale JWT no longer authorizes rows. For other services, perform an equivalent current-account or session check, or bound the exposure with a short access-token lifetime. A live RLS check only protects operations that actually evaluate that policy.

## Create a caller-scoped deletion RPC

Adapt this example to your schema and retention rules. It deletes only the identity matching the caller's JWT. Add application-table cleanup only for tables that do not already cascade from `auth.users`.

```sql
create or replace function public.delete_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from auth.users
  where id = (select auth.uid());
end;
$$;

revoke all on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;
```

The fixed empty `search_path` and schema-qualified table names reduce object-shadowing risk in a privileged function. Keep the function narrowly scoped: do not accept a user ID from the caller, and do not grant execution to `anon`. Review ownership and privileges in the target database so the function owner can delete Auth identities. If deletion errors, handle the failure instead of reporting success; for example, resolve Storage ownership constraints before retrying.

Call `delete_account` through the signed-in client's RPC method. The client should clear its local session after a successful response. Clearing the client session improves the user experience, but server-side deletion and authorization checks provide the access control.

## Deny stale-token requests in RLS

A JWT can still contain the deleted user's `sub`. Do not treat `auth.uid()` alone as proof that the identity remains active. One adaptable pattern is a narrowly privileged helper that checks the current Auth table, then include that helper in every policy that grants user-owned access.

```sql
create or replace function public.auth_identity_exists(user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users
    where id = user_id
  );
$$;

revoke all on function public.auth_identity_exists(uuid) from public, anon;
grant execute on function public.auth_identity_exists(uuid) to authenticated;

-- Adapt table and ownership column names to your schema.
create policy "active users read their own records"
on public.records
for select
to authenticated
using (
  user_id = (select auth.uid())
  and (select public.auth_identity_exists((select auth.uid())))
);
```

The helper must be owned by a role allowed to read `auth.users`; its security-definer body should stay minimal and use a fixed search path. For each table, apply the active-identity predicate to every applicable operation, including `INSERT` checks and both the `USING` and `WITH CHECK` sides of `UPDATE`. Preserve the table's existing ownership or membership conditions. Review views, RPCs, and service-side routes separately: privileged calls that bypass RLS need their own authorization check.

An alternative for particularly sensitive operations is to check the JWT's `session_id` against the live `auth.sessions` table. Deleting the Auth user also deletes its sessions, so that check rejects stale tokens for operations that perform it. It does not protect other operations that omit the check.

## Verify revocation independently

Use disposable test accounts and keep a second, unrelated account as a control. Record the target user's access token and refresh token before deletion. After the RPC succeeds, check each condition independently:

1. A fresh sign-in for the deleted identity fails.
2. Refreshing with the saved refresh token fails.
3. Send a request with the saved access JWT directly to each relevant RLS-protected read and write path. The deleted user's protected rows must not be readable or writable, even though the JWT may remain cryptographically valid until expiry.
4. Verify the unrelated user's permitted reads and writes still work.
5. Check other routes and services that accept user JWTs; confirm they check live identity/session state when immediate revocation is required.

A successful sign-out response or a missing row in one query does not prove all these conditions. Assert the expected denial or unchanged target row for writes that RLS filters to zero rows. Clean up disposable accounts and data after verification.
