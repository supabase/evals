// The dashboard. It renders on the server, and it renders for whoever is
// viewing it.
//
// Contract the rest of the team builds against:
//
//   - Show the viewer's own email address inside the element below, keeping the
//     `data-testid` as it is.
//   - Anyone who is not signed in belongs on / instead.
//
// Read the project url and publishable key from the environment. .env.example
// holds the names the deploy sets.

export default async function DashboardPage() {
  // TODO: work out who is viewing, and send anyone else to /.
  const email = '';

  return (
    <main>
      <h1>Dashboard</h1>
      <p data-testid="viewer-email">{email}</p>
    </main>
  );
}
