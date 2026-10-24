# Supabase email authentication and profiles in JavaScript

Use this guide when an application needs email/password signup, returning-user sign-in, and the signed-in user's profile from JavaScript. It uses `@supabase/supabase-js`, which handles Auth requests and browser session persistence. Adapt the examples to the application's existing function signatures, result shapes, runtime, and schema.

## Prerequisites

- A Supabase project with Auth available and email/password sign-in enabled.
- The project URL and a publishable key. In a client-side module, use only the publishable key; never bundle a secret or service-role key. These values identify the project and authorize public client requests. Database access must still be constrained by grants and row-level security (RLS).
- A profile table and policies appropriate to the application. Inspect the project's migrations for table names, columns, signup triggers, grants, and RLS policies before writing profile code. A common design uses `profiles.id` referencing the Auth user ID and a `display_name` field, but schemas differ.
- The app's exported function stubs or callers, so the implementation preserves the required argument order and returned values.

For a local Supabase CLI project, obtain its connection values with `supabase status --output env` while the stack is running. The CLI may label these `API_URL` and `PUBLISHABLE_KEY`; map them to the application's expected `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` variables. For a deployed client application, configure the project URL and publishable key using that build system's public environment variable mechanism. Do not copy local values into committed source.

Install the SDK from the application directory if it is not already a dependency:

```sh
npm install @supabase/supabase-js
```

## Create one client for the app runtime

Read the URL and publishable key from the app's configuration and initialize a client once in the module or shared client utility used by these functions:

```js
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
)
```

This is an adaptable Vite example. Replace the `import.meta.env` names with the framework's client-safe configuration mechanism. In Node or another server runtime, use its environment API, and keep secret keys confined to trusted server code. The standard browser client persists and refreshes its auth session; do not add a second independent token store without a concrete runtime requirement.

## Implement the auth functions

Keep each stub's public signature and contract. The SDK methods return `{ data, error }`; handle `error` explicitly so a rejected credential attempt becomes the function's documented error result instead of an uncaught exception.

### Sign up and attach profile metadata

Pass the display name as Auth user metadata during signup. This makes the value available to a database trigger that creates a profile, when the project has such a trigger:

```js
const { data, error } = await supabase.auth.signUp({
  email,
  password,
  options: { data: { display_name: displayName } },
})

if (error) return { error: error.message }
if (!data.user) return { error: 'Signup did not return a user.' }
return { userId: data.user.id }
```

If email confirmation is enabled, signup can create the account without immediately returning a signed-in session. Do not treat an absent session as a failed account creation unless the application's contract requires immediate authentication. The person may need to confirm email before signing in. A profile trigger that depends on auth-user insertion can create the row at signup regardless of whether the client receives a session.

### Sign in with email and password

```js
const { data, error } = await supabase.auth.signInWithPassword({ email, password })

if (error) return { error: error.message }
if (!data.user) return { error: 'Sign-in did not return a user.' }
return { userId: data.user.id }
```

Do not throw for ordinary bad credentials when the caller's contract promises `{ error }`. Catch unexpected failures at the function boundary too if the surrounding interface requires errors to be returned rather than thrown. Keep useful error messages for the UI, but avoid exposing internal configuration or secret values.

### Load the current user's profile

Resolve the authenticated user, then select only the profile fields the app needs. Filtering by the authenticated ID is clear and limits the requested row; RLS remains the actual data security boundary.

```js
const { data: userData, error: userError } = await supabase.auth.getUser()
if (userError) return { error: userError.message }
if (!userData.user) return { error: 'No user is signed in.' }

const { data: profile, error: profileError } = await supabase
  .from('profiles')
  .select('display_name, plan')
  .eq('id', userData.user.id)
  .maybeSingle()

if (profileError) return { error: profileError.message }
if (!profile) return { error: 'Profile not found.' }
return { displayName: profile.display_name, plan: profile.plan }
```

Adapt table and column names to the migration. Do not insert a profile from the browser merely because a read returns no row until you have checked whether signup is meant to create it automatically. If the table has RLS, verify that the signed-in role has the needed grant and a policy allowing that user to read their own row. A client-side ID filter does not replace RLS.

## Verify the flow independently

1. Confirm the local stack is running and the app receives the intended URL and publishable key. Check that neither a secret key nor a database password is exposed to browser code.
2. Review and apply the project's migrations using its established local workflow. Confirm the profile table, signup trigger (if used), grants, and RLS policies match the query and metadata field.
3. Check the edited module's syntax with the runtime or build tool used by the app.
4. With a fresh test email, call signup and confirm the returned user ID. If email confirmation is enabled, complete the configured confirmation step before testing password sign-in.
5. Sign in with the same credentials and confirm the returned ID matches signup. Then load the profile and check that its display name matches the submitted signup metadata and that required profile fields are present.
6. Try a deliberately incorrect password and confirm the function resolves to its documented error shape without an uncaught rejection. Also call the profile function signed out and confirm it returns the documented unauthenticated result.
7. Sign out and sign in again to confirm the SDK session is restored and profile retrieval still works. Use a second test account to verify that RLS does not return the first account's profile.

A successful signup alone does not verify confirmation behavior, wrong-password handling, profile-trigger behavior, session restoration, or row isolation. Exercise each behavior the application relies on.