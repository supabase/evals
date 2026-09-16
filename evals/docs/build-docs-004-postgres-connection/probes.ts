import { randomUUID } from 'node:crypto';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

import { readEnvFiles, type Workspace } from './connection.js';

const PROBE_PATH = '.evals/probe.mjs';
const MARKER = '__PROBE__';

const PROXY_PORT = 55432;
const KEY_PATH = '.evals/proxy.key';
const CERT_PATH = '.evals/proxy.crt';

const PROBE_SOURCE = `
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';

const SSL_REQUEST_CODE = 80877103;
const marker = process.env.PROBE_MARKER;
const out = { get: null, post: null, errors: [], tls: 'not requested', connections: 0 };

const [upstreamHost, upstreamPort] = process.env.PROBE_UPSTREAM.split(',');
let credentials;
try {
  credentials = {
    key: readFileSync(process.env.PROBE_KEY),
    cert: readFileSync(process.env.PROBE_CERT),
  };
} catch {
  credentials = undefined;
}

// Postgres starts in plaintext and upgrades on request, so this cannot be a
// plain tls server. Read the 8-byte SSLRequest, answer it, then wrap.
const proxy = net.createServer((client) => {
  out.connections += 1;
  client.once('data', (first) => {
    const upstream = net.connect(Number(upstreamPort), upstreamHost);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());

    const isSslRequest =
      first.length === 8 &&
      first.readInt32BE(0) === 8 &&
      first.readInt32BE(4) === SSL_REQUEST_CODE;

    if (!isSslRequest) {
      upstream.write(first);
      client.pipe(upstream);
      upstream.pipe(client);
      return;
    }

    if (!credentials) {
      out.tls = 'requested, refused, no certificate available';
      client.write(Buffer.from('N'));
      client.pipe(upstream);
      upstream.pipe(client);
      return;
    }

    out.tls = 'requested, terminated by the probe';
    client.write(Buffer.from('S'));
    const secured = new tls.TLSSocket(client, { isServer: true, ...credentials });
    secured.on('error', () => upstream.destroy());
    secured.pipe(upstream);
    upstream.pipe(secured);
  });
});

await new Promise((resolve) => proxy.listen(${PROXY_PORT}, '127.0.0.1', resolve));

function nodeResponse() {
  const captured = { status: 200, body: '' };
  const res = {
    statusCode: 200,
    setHeader() {},
    status(code) {
      captured.status = code;
      return res;
    },
    json(value) {
      captured.body = JSON.stringify(value);
      return res;
    },
    send(value) {
      captured.body = typeof value === 'string' ? value : JSON.stringify(value);
      return res;
    },
    end(value) {
      if (value !== undefined) captured.body = String(value);
      return res;
    },
  };
  return { res, captured };
}

async function call(handler, method, body) {
  const request = new Request('http://localhost/api/items', {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await handler(request);
  if (result instanceof Response) {
    return { status: result.status, body: await result.text() };
  }
  const { res, captured } = nodeResponse();
  await handler(
    { method, url: '/api/items', headers: { 'content-type': 'application/json' }, body },
    res
  );
  return { status: captured.status || res.statusCode, body: captured.body };
}

let handler;
try {
  const mod = await import('../api/items.mjs');
  handler = mod.default ?? mod.handler ?? mod.GET;
} catch (error) {
  out.errors.push('import ' + (error?.message ?? String(error)));
}

if (typeof handler !== 'function') {
  out.errors.push('api/items.mjs exports no callable handler');
} else {
  try {
    for (let i = 0; i < 5; i += 1) {
      out.get = await call(handler, 'GET');
    }
  } catch (error) {
    out.errors.push('GET ' + (error?.message ?? String(error)));
  }
  try {
    out.post = await call(handler, 'POST', { name: 'probe ' + marker, note: marker });
  } catch (error) {
    out.errors.push('POST ' + (error?.message ?? String(error)));
  }
}

console.log('${MARKER}' + JSON.stringify(out));
process.exit(0);
`;

type ProbeResult = {
  get: { status: number; body: string } | null;
  post: { status: number; body: string } | null;
  errors: string[];
  tls: string;
  connections: number;
};

async function execSql(ctx: LocalStackEvalContext, dbUrl: string, sql: string) {
  const encoded = Buffer.from(sql, 'utf-8').toString('base64');
  return ctx.exec(
    `echo ${encoded} | base64 -d | psql "${dbUrl}" -v ON_ERROR_STOP=1 -q`
  );
}

async function readDbUrl(ctx: LocalStackEvalContext): Promise<string> {
  const status = await ctx.exec('supabase status -o json');
  const start = status.stdout.indexOf('{');
  const end = status.stdout.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(
      `could not read \`supabase status\`: ${status.stderr || status.stdout}`
    );
  }
  const parsed = JSON.parse(status.stdout.slice(start, end + 1));
  if (typeof parsed.DB_URL !== 'string' || !parsed.DB_URL) {
    throw new Error(
      `\`supabase status\` reported no DB_URL, got keys: ${Object.keys(parsed).join(', ')}`
    );
  }
  return parsed.DB_URL;
}

function connectionEnvNames(ws: Workspace): string[] {
  const names = new Set([
    'DATABASE_URL',
    'POSTGRES_URL',
    'POSTGRES_URL_NON_POOLING',
    'POSTGRES_PRISMA_URL',
    'SUPABASE_DB_URL',
    'DIRECT_URL',
    'MIGRATION_DATABASE_URL',
  ]);
  for (const [name, value] of readEnvFiles(ws)) {
    if (/^postgres(ql)?:\/\//i.test(value)) names.add(name);
  }
  return [...names];
}

function parseProbe(stdout: string): ProbeResult | undefined {
  const index = stdout.lastIndexOf(MARKER);
  if (index === -1) return undefined;
  try {
    return JSON.parse(stdout.slice(index + MARKER.length).trim());
  } catch {
    return undefined;
  }
}

function preview(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 200);
}

export async function runProbes(
  ctx: LocalStackEvalContext,
  ws: Workspace
): Promise<CheckResult[]> {
  try {
    return await probe(ctx, ws);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      { name: 'project dependencies installed', passed: false, notes: message },
      notRun('the handler reads a row the scorer inserted'),
      notRun('the handler writes a row that lands in items'),
    ];
  }
}

async function probe(
  ctx: LocalStackEvalContext,
  ws: Workspace
): Promise<CheckResult[]> {
  const install = await ctx.exec('npm install --no-audit --no-fund --silent', {
    timeoutMs: 240_000,
  });
  const installed: CheckResult = {
    name: 'project dependencies installed',
    passed: install.ok,
    notes: install.ok
      ? `exit ${install.exitCode}`
      : preview(install.stderr || install.stdout),
  };
  if (!install.ok) {
    return [
      installed,
      notRun('the handler reads a row the scorer inserted'),
      notRun('the handler writes a row that lands in items'),
    ];
  }

  const dbUrl = await readDbUrl(ctx);
  const readMarker = randomUUID();
  const marker = randomUUID();
  const seeded = await execSql(
    ctx,
    dbUrl,
    `insert into public.items (name, note) values ('read probe', '${readMarker}')`
  );
  if (!seeded.ok) {
    return [
      installed,
      {
        name: 'the handler reads a row the scorer inserted',
        passed: false,
        notes: `could not insert the read probe row — ${preview(seeded.stderr || seeded.stdout)}`,
      },
      notRun('the handler writes a row that lands in items'),
    ];
  }
  const encoded = Buffer.from(PROBE_SOURCE, 'utf-8').toString('base64');
  const write = await ctx.exec(
    `mkdir -p .evals && echo ${encoded} | base64 -d > ${PROBE_PATH} && ` +
      `openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost ` +
      `-keyout ${KEY_PATH} -out ${CERT_PATH} 2>/dev/null || true`
  );
  if (!write.ok) {
    return [
      installed,
      notRun('the handler reads a row the scorer inserted'),
      notRun('the handler writes a row that lands in items'),
    ];
  }

  const upstream = new URL(dbUrl);
  const proxied = new URL(dbUrl);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(PROXY_PORT);
  const env = [
    `PROBE_MARKER=${marker}`,
    `PROBE_UPSTREAM="${upstream.hostname},${upstream.port || 5432}"`,
    `PROBE_KEY=${KEY_PATH}`,
    `PROBE_CERT=${CERT_PATH}`,
    ...connectionEnvNames(ws).map((name) => `${name}="${proxied.toString()}"`),
  ].join(' ');
  const run = await ctx.exec(`${env} node ${PROBE_PATH}`, {
    timeoutMs: 90_000,
  });
  const probe = parseProbe(run.stdout);

  const reason = probe?.errors.length
    ? probe.errors.join('; ')
    : preview(run.stderr || run.stdout);

  const getBody = probe?.get?.body ?? '';
  const readsDatabase =
    probe?.get?.status === 200 && getBody.includes(readMarker);

  const { rows } = await ctx.query(
    `select count(*)::int as landed from public.items where note = '${marker}'`
  );
  const landed = Number(rows[0]?.landed ?? 0);

  const connections = probe?.connections ?? 0;

  return [
    installed,
    {
      name: 'the handler reads a row the scorer inserted',
      passed: readsDatabase,
      notes: probe?.get
        ? `GET ${probe.get.status}, TLS ${probe.tls}, ${preview(getBody)}`
        : `handler produced no GET response — ${reason}`,
    },
    {
      name: 'the handler writes a row that lands in items',
      passed: landed === 1,
      notes:
        landed === 1
          ? `POST ${probe?.post?.status ?? '?'}, one row with the run marker`
          : `${landed} rows carry the run marker — ${probe?.post ? `POST ${probe.post.status} ${preview(probe.post.body)}` : reason}`,
    },
    {
      name: 'the database client is created once per module, not per request',
      passed: readsDatabase && connections === 1,
      notes: readsDatabase
        ? `${connections} database connection${connections === 1 ? '' : 's'} opened across six invocations`
        : 'not measured, the handler never reached the database',
    },
  ];
}

function notRun(name: string): CheckResult {
  return { name, passed: false, notes: 'not run, dependencies unavailable' };
}
