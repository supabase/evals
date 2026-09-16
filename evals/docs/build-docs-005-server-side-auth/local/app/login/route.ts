// POST /login. The sign-in screen posts `email` and `password` here as form
// data.
//
// Contract the rest of the team builds against:
//
//   - On success, respond 303 to /dashboard, and whatever the browser needs to
//     stay signed in on later requests has to come back on this response.
//   - On failure, respond 303 to / so the person can try again.
//
// Read the project url and publishable key from the environment. .env.example
// holds the names the deploy sets.

export async function POST(request: Request) {
  // TODO: sign the person in and send them to the dashboard.
  const form = await request.formData();
  void form;

  return new Response(null, { status: 303, headers: { Location: '/' } });
}
