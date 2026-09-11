import { randomUUID } from 'node:crypto';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

const PROBE_PATH = '.evals/probe.mjs';
const MARKER = '__PROBE__';
const PORT = 3100;
const TESTID = 'viewer-email';

const PROBE_SOURCE = `
import { spawn } from 'node:child_process';

const PORT = ${PORT};
const base = 'http://127.0.0.1:' + PORT;
const apiUrl = process.env.PROBE_API_URL;
const key = process.env.PROBE_PUBLISHABLE_KEY;
const owner = process.env.PROBE_OWNER;
const intruder = process.env.PROBE_INTRUDER;
const password = process.env.PROBE_PASSWORD;

const out = {
  serverReady: false,
  signUps: [],
  login: null,
  real: null,
  tampered: null,
  second: null,
  tamperUnavailable: null,
  errors: [],
};

function rendered(body) {
  const match = /data-testid="${TESTID}"[^>]*>([^<]*)</.exec(body || '');
  return match ? match[1].trim() : null;
}

function parseCookies(list) {
  const jar = new Map();
  for (const raw of list) {
    const pair = raw.split(';')[0];
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  return jar;
}

function header(jar) {
  return [...jar].map(([name, value]) => name + '=' + value).join('; ');
}

async function signUp(email) {
  const res = await fetch(apiUrl + '/auth/v1/signup', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: key,
      authorization: 'Bearer ' + key,
    },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.text();
  return { email, status: res.status, ok: res.ok, body: body.slice(0, 200) };
}

async function dashboard(jar) {
  const res = await fetch(base + '/dashboard', {
    headers: { cookie: header(jar) },
    redirect: 'manual',
  });
  const body = res.status >= 200 && res.status < 300 ? await res.text() : '';
  return { status: res.status, email: rendered(body), length: body.length };
}

// Re-encode the session with another identity and leave the signature alone,
// so the token no longer verifies. Reading stored session state accepts it;
// verifying the token does not.
function tamper(jar, toEmail, toSub) {
  const names = [...jar.keys()].filter((name) => /auth-token(\\.\\d+)?$/.test(name));
  if (names.length === 0) return { error: 'no session cookie on the login response' };
  if (names.length > 1) return { error: 'session cookie is chunked across ' + names.length + ' cookies' };

  const name = names[0];
  const raw = decodeURIComponent(jar.get(name));
  const prefix = 'base64-';
  const encoded = raw.startsWith(prefix);
  let session;
  try {
    session = JSON.parse(
      encoded
        ? Buffer.from(raw.slice(prefix.length), 'base64url').toString('utf8')
        : raw
    );
  } catch (error) {
    return { error: 'session cookie is not JSON' };
  }

  const parts = String(session.access_token ?? '').split('.');
  if (parts.length !== 3) return { error: 'session cookie carries no JWT' };
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  claims.email = toEmail;
  claims.sub = toSub;
  if (claims.user_metadata) claims.user_metadata.email = toEmail;
  const swapped = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  session.access_token = parts[0] + '.' + swapped + '.' + parts[2];
  if (session.user) {
    session.user.email = toEmail;
    session.user.id = toSub;
  }

  const value = encoded
    ? prefix + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')
    : JSON.stringify(session);
  const next = new Map(jar);
  next.set(name, encodeURIComponent(value));
  return { jar: next };
}

const server = spawn('./node_modules/.bin/next', ['start', '-p', String(PORT)], {
  stdio: 'ignore',
  env: process.env,
});

try {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base + '/', { redirect: 'manual' });
      if (res.status < 500) {
        out.serverReady = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!out.serverReady) {
    out.errors.push('the app did not answer on port ' + PORT);
  } else {
    out.signUps.push(await signUp(owner));
    out.signUps.push(await signUp(intruder));

    const login = await fetch(base + '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: owner, password }).toString(),
      redirect: 'manual',
    });
    const cookies = login.headers.getSetCookie();
    out.login = {
      status: login.status,
      location: login.headers.get('location'),
      cookieCount: cookies.length,
    };

    const jar = parseCookies(cookies);
    out.real = await dashboard(jar);
    out.second = await dashboard(jar);

    const forged = tamper(jar, intruder, '00000000-0000-4000-8000-000000000000');
    if (forged.error) {
      out.tamperUnavailable = forged.error;
    } else {
      out.tampered = await dashboard(forged.jar);
    }
  }
} catch (error) {
  out.errors.push(error?.message ?? String(error));
}

console.log('${MARKER}' + JSON.stringify(out));
server.kill('SIGKILL');
process.exit(0);
`;

type Probe = {
  serverReady: boolean;
  signUps: { email: string; status: number; ok: boolean; body: string }[];
  login: {
    status: number;
    location: string | null;
    cookieCount: number;
  } | null;
  real: { status: number; email: string | null; length: number } | null;
  tampered: { status: number; email: string | null; length: number } | null;
  second: { status: number; email: string | null; length: number } | null;
  tamperUnavailable: string | null;
  errors: string[];
};

function preview(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function notRun(name: string, why: string): CheckResult {
  return { name, passed: false, notes: `not run, ${why}` };
}

const RUNTIME_CHECKS = [
  'the dashboard renders the signed-in viewer email',
  'a tampered session cookie does not get the dashboard',
  'the viewer stays signed in across two page loads',
];

export async function runProbes(
  ctx: LocalStackEvalContext
): Promise<CheckResult[]> {
  try {
    return await probe(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      { name: 'project dependencies installed', passed: false, notes: message },
      { name: 'the app builds', passed: false, notes: 'not run' },
      ...RUNTIME_CHECKS.map((name) =>
        notRun(name, 'the scorer could not start')
      ),
    ];
  }
}

// `ctx.stackStatus()` requires API_URL, PUBLISHABLE_KEY and SECRET_KEY together
// and throws when any is missing. This eval needs the api url and one client
// key, so read `supabase status` directly and accept either key name.
async function readStack(
  ctx: LocalStackEvalContext
): Promise<{ apiUrl: string; clientKey: string }> {
  const result = await ctx.exec('supabase status -o json');
  const start = result.stdout.indexOf('{');
  const end = result.stdout.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(
      `could not read \`supabase status\`: ${preview(result.stderr || result.stdout)}`
    );
  }
  const parsed = JSON.parse(result.stdout.slice(start, end + 1));
  const apiUrl = typeof parsed.API_URL === 'string' ? parsed.API_URL : '';
  const clientKey =
    typeof parsed.PUBLISHABLE_KEY === 'string' && parsed.PUBLISHABLE_KEY
      ? parsed.PUBLISHABLE_KEY
      : typeof parsed.ANON_KEY === 'string'
        ? parsed.ANON_KEY
        : '';
  if (!apiUrl || !clientKey) {
    throw new Error(
      `\`supabase status\` reported no API_URL or client key, got keys: ${Object.keys(parsed).join(', ')}`
    );
  }
  return { apiUrl, clientKey };
}

async function probe(ctx: LocalStackEvalContext): Promise<CheckResult[]> {
  const status = await readStack(ctx);
  const env = [
    `NEXT_PUBLIC_SUPABASE_URL="${status.apiUrl}"`,
    `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="${status.clientKey}"`,
  ].join(' ');

  const install = await ctx.exec('npm install --no-audit --no-fund --silent', {
    timeoutMs: 420_000,
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
      {
        name: 'the app builds',
        passed: false,
        notes: 'not run, dependencies unavailable',
      },
      ...RUNTIME_CHECKS.map((name) => notRun(name, 'dependencies unavailable')),
    ];
  }

  const build = await ctx.exec(`${env} ./node_modules/.bin/next build`, {
    timeoutMs: 420_000,
  });
  const built: CheckResult = {
    name: 'the app builds',
    passed: build.ok,
    notes: build.ok
      ? `exit ${build.exitCode}`
      : preview(build.stderr || build.stdout),
  };
  if (!build.ok) {
    return [
      installed,
      built,
      ...RUNTIME_CHECKS.map((name) => notRun(name, 'the app did not build')),
    ];
  }

  const run = randomUUID().slice(0, 8);
  const owner = `owner-${run}@example.test`;
  const intruder = `intruder-${run}@example.test`;
  const encoded = Buffer.from(PROBE_SOURCE, 'utf-8').toString('base64');
  const write = await ctx.exec(
    `mkdir -p .evals && echo ${encoded} | base64 -d > ${PROBE_PATH}`
  );
  if (!write.ok) {
    return [
      installed,
      built,
      ...RUNTIME_CHECKS.map((name) =>
        notRun(name, 'the probe could not be written')
      ),
    ];
  }

  const probeEnv = [
    env,
    `PROBE_API_URL="${status.apiUrl}"`,
    `PROBE_PUBLISHABLE_KEY="${status.clientKey}"`,
    `PROBE_OWNER="${owner}"`,
    `PROBE_INTRUDER="${intruder}"`,
    `PROBE_PASSWORD="probe-password-${run}"`,
  ].join(' ');
  const result = await ctx.exec(`${probeEnv} node ${PROBE_PATH}`, {
    timeoutMs: 240_000,
  });
  const index = result.stdout.lastIndexOf(MARKER);
  let parsed: Probe | undefined;
  if (index !== -1) {
    try {
      parsed = JSON.parse(result.stdout.slice(index + MARKER.length).trim());
    } catch {
      parsed = undefined;
    }
  }

  if (!parsed) {
    const why =
      preview(result.stderr || result.stdout) || 'the probe printed nothing';
    return [
      installed,
      built,
      ...RUNTIME_CHECKS.map((name) => notRun(name, why)),
    ];
  }

  const reason = parsed.errors.length
    ? parsed.errors.join('; ')
    : `login ${parsed.login?.status ?? '?'}, ${parsed.login?.cookieCount ?? 0} cookies`;

  const rendersViewer = parsed.real?.email === owner;
  const tamperedRenders =
    parsed.tampered?.email === intruder || parsed.tampered?.email === owner;
  const staysSignedIn = parsed.second?.email === owner;

  return [
    installed,
    built,
    {
      name: RUNTIME_CHECKS[0],
      passed: rendersViewer,
      notes: parsed.real
        ? `GET /dashboard ${parsed.real.status}, rendered ${JSON.stringify(parsed.real.email)}`
        : `no dashboard response — ${reason}`,
    },
    {
      name: RUNTIME_CHECKS[1],
      passed: rendersViewer && parsed.tampered !== null && !tamperedRenders,
      notes: parsed.tamperUnavailable
        ? `not measured, ${parsed.tamperUnavailable}`
        : parsed.tampered
          ? `GET /dashboard ${parsed.tampered.status}, rendered ${JSON.stringify(parsed.tampered.email)}`
          : `not measured — ${reason}`,
    },
    {
      name: RUNTIME_CHECKS[2],
      passed: staysSignedIn,
      notes: parsed.second
        ? `second GET /dashboard ${parsed.second.status}, rendered ${JSON.stringify(parsed.second.email)}`
        : `no second response — ${reason}`,
    },
  ];
}
