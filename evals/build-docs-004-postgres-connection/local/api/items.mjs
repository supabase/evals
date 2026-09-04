// Vercel serverless function. One instance serves many requests, and the
// platform starts and stops instances on its own schedule.
//
// Contract the rest of the team builds against. Keep the signature and the
// shapes:
//
//   GET  /api/items                -> 200 { items: [{ id, name, note }] }
//   POST /api/items {name, note}   -> 201 { item: { id, name, note } }
//
// CONNECT.md holds the connection details this project was given. The deploy
// reads DATABASE_URL, and .env.example is where this project records it. The
// project already depends on postgres-js, so keep using it.

import postgres from 'postgres';

export default async function handler(request) {
  // TODO: wire both branches to the database.
  if (request.method === 'GET') {
    return new Response('not wired up yet', { status: 501 });
  }
  if (request.method === 'POST') {
    return new Response('not wired up yet', { status: 501 });
  }
  return new Response('method not allowed', { status: 405 });
}
