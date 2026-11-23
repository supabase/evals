import { randomUUID } from 'node:crypto';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

type Ctx = Pick<LocalStackEvalContext, 'exec' | 'query'>;
export type Step = { ok: boolean; message: string };

export const CHECK = {
  starts: 'the local stack starts with the project settings',
  short: 'a password shorter than 12 characters is refused',
  characters: 'a password missing a kind of character is refused',
  accepted: 'passwords that meet the policy are accepted',
} as const;

export type Case = { label: string; password: string };

// Every refused password breaks exactly one rule, so a project that enforces
// only one of the two cannot pass both checks. The short ones carry every kind
// of character. The others are 15 characters long.
export const TOO_SHORT: Case[] = [
  { label: '11 characters, every kind', password: 'Gx7!pLq2Rm4' },
  { label: '8 characters, every kind', password: 'P@ssw0rd' },
];

export const MISSING_A_KIND: Case[] = [
  { label: 'no symbol', password: 'Tomato2Basil88x' },
  { label: 'no digit', password: 'Tomato!Basil!xz' },
  { label: 'no uppercase letter', password: 'tomato2basil!xz' },
  { label: 'no lowercase letter', password: 'TOMATO2BASIL!XZ' },
];

// The first is the shortest the policy allows, so a minimum of 13 or more
// refuses it. The others use different symbols.
export const MEETS_POLICY: Case[] = [
  { label: '12 characters, the shortest allowed', password: 'Gx7!pLq2Rm4v' },
  { label: '16 characters, symbols - and !', password: 'Tr3llis-Mango!42' },
  { label: '16 characters, symbols ? and #', password: 'n0Pickle?Rain#77' },
];

export type Outcome = {
  label: string;
  email: string;
  status: number;
  code: string;
  // The reasons Auth gives when it calls the password weak.
  reasons: string[];
  // Whether the user exists afterwards, read as the superuser.
  exists: boolean;
};

export type Probe = Step & { outcomes: Record<string, Outcome> };

/**
 * Auth reads its settings when its container is created, so restart the stack
 * to score what the project says rather than what was running. The sandbox
 * shim adds the eval's service excludes to `start`. Never throws.
 */
export async function restartStack(ctx: Pick<Ctx, 'exec'>): Promise<Step> {
  try {
    const result = await ctx.exec(
      'supabase stop >/dev/null 2>&1; supabase start 2>&1',
      { timeoutMs: 300_000 }
    );
    return result.exitCode === 0
      ? { ok: true, message: '' }
      : { ok: false, message: errorLine(result.stdout ?? '') };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

// Signs each password up the way any client could, with the publishable key and
// no app in between, and reports what Auth said. Runs inside the sandbox.
export const SCRIPT = `
const api = process.env.P_API;
const key = process.env.P_KEY;
const cases = JSON.parse(process.env.P_CASES);
const out = [];
for (const c of cases) {
  const res = await fetch(api + '/auth/v1/signup', {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: c.email, password: c.password }),
  });
  const body = await res.json().catch(() => ({}));
  out.push({
    id: c.id,
    status: res.status,
    code: String(body.error_code ?? body.code ?? ''),
    reasons: body.weak_password?.reasons ?? [],
    msg: String(body.msg ?? body.message ?? '').slice(0, 120),
  });
}
console.log(JSON.stringify({ out }));
`;

export async function probeSignups(ctx: Ctx, started: Step): Promise<Probe> {
  if (!started.ok) {
    return { ...started, outcomes: {} };
  }
  try {
    const { apiUrl, clientKey } = await readStack(ctx);
    const marker = `pw${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const cases = [...TOO_SHORT, ...MISSING_A_KIND, ...MEETS_POLICY].map(
      (c, i) => ({
        id: c.label,
        email: `${marker}-${i}@example.com`,
        password: c.password,
      })
    );
    const env = [
      `P_API='${apiUrl}'`,
      `P_KEY='${clientKey}'`,
      `P_CASES='${JSON.stringify(cases)}'`,
    ].join(' ');
    const script = Buffer.from(SCRIPT, 'utf8').toString('base64');
    const result = await ctx.exec(
      `${env} node --input-type=module -e "$(echo ${script} | base64 -d)"`,
      { timeoutMs: 120_000 }
    );
    const line = (result.stdout ?? '').trim().split('\n').at(-1) ?? '';
    const parsed = JSON.parse(line.startsWith('{') ? line : '{}') as {
      out?: {
        id: string;
        status: number;
        code: string;
        reasons: string[];
        msg: string;
      }[];
    };
    if (!parsed.out) {
      return {
        ok: false,
        message: errorLine(`${result.stderr}\n${result.stdout}`),
        outcomes: {},
      };
    }

    // The user's presence is what settles a sign-up, not the status it
    // returned.
    const { rows } = await ctx.query(
      `SELECT email FROM auth.users WHERE email LIKE '${marker}-%';`
    );
    const present = new Set(rows.map((row) => String(row.email)));
    const outcomes: Record<string, Outcome> = {};
    for (const entry of parsed.out) {
      const email = cases.find((c) => c.id === entry.id)?.email ?? '';
      outcomes[entry.id] = {
        label: entry.id,
        email,
        status: entry.status,
        code: entry.code || entry.msg,
        reasons: entry.reasons,
        exists: present.has(email),
      };
    }
    return { ok: true, message: '', outcomes };
  } catch (error) {
    return { ok: false, message: messageOf(error), outcomes: {} };
  }
}

export function checkStackStarts(started: Step): CheckResult {
  return {
    name: CHECK.starts,
    passed: started.ok,
    notes: started.ok ? 'supabase start exited 0' : started.message,
  };
}

export const checkShortRefused = (probe: Probe) =>
  checkRefused(CHECK.short, TOO_SHORT, probe);

export const checkCharactersRefused = (probe: Probe) =>
  checkRefused(CHECK.characters, MISSING_A_KIND, probe);

// Pairs with both refusals: a project that turns every sign-up away passes
// them and fails this.
export function checkPolicyAccepted(probe: Probe): CheckResult {
  if (!probe.ok) {
    return blocked(CHECK.accepted, probe);
  }
  const problems: string[] = [];
  for (const { label } of MEETS_POLICY) {
    const outcome = probe.outcomes[label];
    if (outcome?.exists) {
      continue;
    }
    problems.push(
      outcome === undefined
        ? `${label}: no answer`
        : outcome.code === WEAK
          ? `${label}: refused as weak (${outcome.reasons.join(', ') || 'no reason given'})`
          : `${label}: could not measure, Auth said ${describe(outcome)}`
    );
  }
  return problems.length === 0
    ? {
        name: CHECK.accepted,
        passed: true,
        notes: `all ${MEETS_POLICY.length} signed up`,
      }
    : { name: CHECK.accepted, passed: false, notes: problems.join('; ') };
}

const WEAK = 'weak_password';

function checkRefused(name: string, cases: Case[], probe: Probe): CheckResult {
  if (!probe.ok) {
    return blocked(name, probe);
  }
  const letIn: string[] = [];
  const unmeasured: string[] = [];
  for (const { label } of cases) {
    const outcome = probe.outcomes[label];
    if (outcome === undefined) {
      unmeasured.push(`${label}: no answer`);
    } else if (outcome.exists) {
      letIn.push(label);
    } else if (outcome.code !== WEAK) {
      // Nothing was created, but not because the password was weak. A rate
      // limit or a rejected email says nothing about the policy.
      unmeasured.push(`${label}: Auth said ${describe(outcome)}`);
    }
  }
  if (letIn.length > 0) {
    return {
      name,
      passed: false,
      notes: `signed up anyway: ${letIn.join('; ')}`,
    };
  }
  return unmeasured.length > 0
    ? {
        name,
        passed: false,
        notes: `could not measure: ${unmeasured.join('; ')}`,
      }
    : { name, passed: true, notes: `all ${cases.length} refused as weak` };
}

function describe(outcome: Outcome): string {
  return `${outcome.status} ${outcome.code || 'no code'}`;
}

// `ctx.stackStatus()` wants the secret key too; this needs the api url and one
// client key, under whichever name the CLI reports it.
async function readStack(
  ctx: Pick<Ctx, 'exec'>
): Promise<{ apiUrl: string; clientKey: string }> {
  const result = await ctx.exec('supabase status -o json 2>/dev/null');
  const out = result.stdout ?? '';
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(`could not read supabase status: ${errorLine(out)}`);
  }
  const parsed = JSON.parse(out.slice(start, end + 1));
  const apiUrl = typeof parsed.API_URL === 'string' ? parsed.API_URL : '';
  const clientKey =
    typeof parsed.PUBLISHABLE_KEY === 'string' && parsed.PUBLISHABLE_KEY
      ? parsed.PUBLISHABLE_KEY
      : typeof parsed.ANON_KEY === 'string'
        ? parsed.ANON_KEY
        : '';
  if (!apiUrl || !clientKey) {
    throw new Error(
      `supabase status had no API_URL or client key, got: ${Object.keys(parsed).join(', ')}`
    );
  }
  return { apiUrl, clientKey };
}

function errorLine(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines.find((l) => /error|failed/i.test(l)) ?? lines.at(-1);
  return (line ?? 'no output').slice(0, 300);
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function blocked(name: string, step: Step): CheckResult {
  return { name, passed: false, notes: `not run: ${step.message}` };
}
