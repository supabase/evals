/**
 * Standalone docs content GraphQL API for `search_docs`.
 *
 * Serves the docs app's own route handler (apps/docs/app/api/graphql/route.ts
 * in a supabase/supabase checkout) over plain node:http — no Next server.
 * Launched by `pnpm local docs api` with the docs checkout's tsx so the
 * route's TS + tsconfig conditions resolve; DOCS_ROUTE_PATH points at the
 * checkout, PORT picks the listen port.
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const routePath = process.env.DOCS_ROUTE_PATH;
if (!routePath) {
  console.error(
    'DOCS_ROUTE_PATH not set — run this through `pnpm local docs api`'
  );
  process.exit(1);
}
// The docs checkout location is user-supplied at runtime; a static import
// cannot name it.
const route = await import(pathToFileURL(routePath).href);
const handlers: Record<string, (req: Request) => Promise<Response>> = {
  GET: route.GET,
  OPTIONS: route.OPTIONS,
  POST: route.POST,
};
const port = Number(process.env.PORT ?? 3001);

createServer(async (incoming, outgoing) => {
  const url = new URL(
    incoming.url ?? '/',
    `http://${incoming.headers.host ?? `127.0.0.1:${port}`}`
  );
  const handler = handlers[incoming.method ?? ''];
  if (url.pathname !== '/docs/api/graphql' || !handler) {
    outgoing.writeHead(404).end();
    return;
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value))
      for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  const body =
    incoming.method === 'GET' || incoming.method === 'HEAD'
      ? undefined
      : Buffer.concat(chunks).toString('utf8');
  const response = await handler(
    new Request(url, { method: incoming.method, headers, body })
  );

  outgoing.writeHead(
    response.status,
    Object.fromEntries(response.headers.entries())
  );
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, '127.0.0.1', () => {
  console.log(`Docs content API: http://127.0.0.1:${port}/docs/api/graphql`);
});
