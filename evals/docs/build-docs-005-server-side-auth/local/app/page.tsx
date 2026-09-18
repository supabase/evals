// The sign-in screen. The form below is what the rest of the team builds
// against, so keep the field names and the action target as they are.
//
// The form posts `email` and `password` as form data to POST /login.

export default function SignInPage() {
  return (
    <main>
      <h1>Sign in</h1>
      <form method="post" action="/login">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" required />
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
