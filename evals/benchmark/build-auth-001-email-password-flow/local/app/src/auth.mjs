// Auth layer for the app. The rest of the app calls these three functions;
// wire them up to our Supabase project (it's running locally — see
// ../../supabase). Connection settings come from the environment:
// SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.
//
// This module is used from client-side code, so it must only ever hold the
// publishable (client) key.

/**
 * Create an account with email + password. `displayName` should end up as
 * the user's profile display name.
 *
 * Resolves to `{ userId }` on success, or `{ error: string }` on failure.
 */
export async function signUp(email, password, displayName) {
  throw new Error('TODO: implement signUp');
}

/**
 * Sign in with email + password.
 *
 * Resolves to `{ userId }` on success, or `{ error: string }` on failure
 * (e.g. wrong password) — it must not throw for bad credentials.
 */
export async function signIn(email, password) {
  throw new Error('TODO: implement signIn');
}

/**
 * The currently signed-in user's profile from the `profiles` table, as
 * `{ displayName, plan }`. Resolves to `{ error: string }` when nobody is
 * signed in.
 */
export async function getMyProfile() {
  throw new Error('TODO: implement getMyProfile');
}
