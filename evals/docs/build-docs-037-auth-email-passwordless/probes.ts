import { createHash, randomBytes } from 'node:crypto';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import {
  messageOf,
  readStack,
  runScript,
  type Step,
} from '../lib/local-stack.js';

type Ctx = Pick<LocalStackEvalContext, 'exec' | 'query'>;
type Mail = { subject: string; html: string; text: string };
type Who = 'returning' | 'firstTime';
type Person = {
  label: string;
  email: string;
  status: number;
  mail: Mail | null;
  hashes: string[];
  code: string | null;
  codeVisible: boolean;
  candidates: string[];
  links: string[];
  signedIn: boolean;
  verifyNote: string;
};
type Probe = Step & Record<Who, Person>;

const STARTS = 'the local stack starts with the project settings';
const CHECK: Record<Who, { code: string; link: string; signsIn: string }> = {
  returning: {
    code: "a returning person's email carries a 6-digit code",
    link: "a returning person's email carries no sign-in link",
    signsIn: 'the code signs a returning person in',
  },
  firstTime: {
    code: "a first-time person's email carries a 6-digit code",
    link: "a first-time person's email carries no sign-in link",
    signsIn: 'the code signs a first-time person in',
  },
};

const SEND = `
const { P_API: api, P_ANON: anon, P_ADMIN: admin, P_MAILPIT: mailpit, P_RETURNING: returning, P_FIRST: first } = process.env;
const json = (key) => ({ apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function inbox(address) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const list = await fetch(mailpit + '/api/v1/messages').then((r) => r.json()).catch(() => ({}));
    const found = (list.messages || []).find((m) => (m.To || []).some((t) => t.Address === address));
    if (found) {
      const full = await fetch(mailpit + '/api/v1/message/' + found.ID).then((r) => r.json());
      return { subject: full.Subject || '', html: full.HTML || '', text: full.Text || '' };
    }
    await sleep(500);
  }
  return null;
}
async function send(email) {
  const res = await fetch(api + '/auth/v1/otp', {
    method: 'POST',
    headers: json(anon),
    body: JSON.stringify({ email, create_user: true, data: {} }),
  });
  return res.status;
}
const created = await fetch(api + '/auth/v1/admin/users', {
  method: 'POST',
  headers: json(admin),
  body: JSON.stringify({ email: returning, email_confirm: true }),
});
const out = { created: created.status, returningStatus: 0, returningMail: null, firstStatus: 0, firstMail: null };
if (created.ok) {
  out.returningStatus = await send(returning);
  out.returningMail = await inbox(returning);
}
out.firstStatus = await send(first);
out.firstMail = await inbox(first);
console.log(JSON.stringify(out));
`;

const VERIFY = `
const { P_API: api, P_ANON: anon, P_TRIES: tries } = process.env;
const out = {};
for (const [key, email, code] of JSON.parse(tries)) {
  if (!code) continue;
  const res = await fetch(api + '/auth/v1/verify', {
    method: 'POST',
    headers: { apikey: anon, Authorization: 'Bearer ' + anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, token: code, type: 'email' }),
  });
  const body = await res.json().catch(() => ({}));
  out[key] = body.access_token
    ? { signedIn: true, note: 'code ' + code + ' returned a session' }
    : { signedIn: false, note: 'code ' + code + ' returned ' + res.status + ' ' + (body.error_code || body.msg || body.error || '') };
}
console.log(JSON.stringify(out));
`;

export async function probeSignIn(ctx: Ctx, started: Step): Promise<Probe> {
  const run = [...randomBytes(8)]
    .map((byte) => String.fromCharCode(97 + (byte % 26)))
    .join('');
  const blank = (label: string, email: string): Person => ({
    label,
    email,
    status: 0,
    mail: null,
    hashes: [],
    code: null,
    codeVisible: false,
    candidates: [],
    links: [],
    signedIn: false,
    verifyNote: '',
  });
  const addresses: Probe = {
    ok: false,
    message: '',
    returning: blank('returning', `back-${run}@example.test`),
    firstTime: blank('first-time', `hello-${run}@example.test`),
  };
  if (!started.ok) return { ...addresses, message: started.message };
  try {
    const stack = await readStack(ctx);
    const mailpit = await readMailpit(ctx);
    const sent = (await runScript(ctx, SEND, {
      P_API: stack.apiUrl,
      P_ANON: stack.clientKey,
      P_ADMIN: stack.adminKey,
      P_MAILPIT: mailpit,
      P_RETURNING: addresses.returning.email,
      P_FIRST: addresses.firstTime.email,
    })) as {
      created: number;
      returningStatus: number;
      returningMail: Mail | null;
      firstStatus: number;
      firstMail: Mail | null;
    };
    if (sent.created < 200 || sent.created >= 300) {
      return {
        ...addresses,
        message: `the scorer could not create the returning person: ${sent.created}`,
      };
    }
    const returning = await readMail(
      ctx,
      addresses.returning,
      sent.returningStatus,
      sent.returningMail
    );
    const firstTime = await readMail(
      ctx,
      addresses.firstTime,
      sent.firstStatus,
      sent.firstMail
    );
    const verified = (await runScript(ctx, VERIFY, {
      P_API: stack.apiUrl,
      P_ANON: stack.clientKey,
      P_TRIES: JSON.stringify([
        ['returning', returning.email, returning.code],
        ['firstTime', firstTime.email, firstTime.code],
      ]),
    })) as Partial<Record<Who, { signedIn: boolean; note: string }>>;
    return {
      ok: true,
      message: '',
      returning: { ...returning, ...signIn(verified.returning) },
      firstTime: { ...firstTime, ...signIn(verified.firstTime) },
    };
  } catch (error) {
    return { ...addresses, message: messageOf(error) };
  }
}

function signIn(result: { signedIn: boolean; note: string } | undefined) {
  return {
    signedIn: result?.signedIn ?? false,
    verifyNote: result?.note ?? '',
  };
}

async function readMail(
  ctx: Ctx,
  person: Person,
  status: number,
  mail: Mail | null
): Promise<Person> {
  if (!mail) return { ...person, status };
  const hashes = await tokenHashes(ctx, person.email);
  const everything = `${mail.subject}\n${decode(mail.html)}\n${decode(mail.text)}`;
  const candidates = sixDigitRuns(everything);
  const code =
    candidates.find((run) =>
      hashes.includes(
        createHash('sha224')
          .update(person.email + run)
          .digest('hex')
      )
    ) ?? null;
  const codeVisible = code !== null && visible(mail).includes(code);
  const links = urls(mail).filter(
    (url) =>
      url.includes('/auth/v1/verify') ||
      hashes.some((hash) => url.includes(hash)) ||
      (code !== null && url.includes(code))
  );
  return {
    ...person,
    status,
    mail,
    hashes,
    code,
    codeVisible,
    candidates,
    links,
  };
}

async function tokenHashes(ctx: Ctx, email: string): Promise<string[]> {
  try {
    const { rows } = await ctx.query(
      `select token_hash as hash from auth.one_time_tokens where relates_to = '${email}'
       union all
       select confirmation_token from auth.users where email = '${email}'
       union all
       select recovery_token from auth.users where email = '${email}'`
    );
    return unique(
      rows
        .map((row) => String(row.hash ?? '').replace(/^pkce_/, ''))
        .filter((hash) => hash.length >= 16)
    );
  } catch {
    return [];
  }
}

function sixDigitRuns(text: string): string[] {
  return unique(
    [...text.matchAll(/(?<!\d)\d{6}(?!\d)/g)].map((match) => match[0])
  );
}

function visible(mail: Mail): string {
  const withoutUrls = (text: string) => text.replace(/\S*:\/\/\S*/g, ' ');
  return [
    mail.subject,
    withoutUrls(plain(mail.html)),
    withoutUrls(decode(mail.text)),
  ].join('\n');
}

function urls(mail: Mail): string[] {
  const html = decode(mail.html);
  const hrefs = [
    ...html.matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi),
  ].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
  const bare = [
    ...`${html}\n${decode(mail.text)}`.matchAll(/\S*:\/\/[^\s"'<>)]+/g),
  ].map((match) => match[0]);
  return unique([...hrefs, ...bare]);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function decode(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCharCode(parseInt(n, 16))
    )
    .replace(/&amp;/g, '&');
}

function plain(html: string): string {
  return decode(
    html
      .replace(/<head[\s\S]*?<\/head>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

async function readMailpit(ctx: Ctx): Promise<string> {
  const result = await ctx.exec('supabase status -o json 2>/dev/null');
  const out = result.stdout ?? '';
  const parsed = JSON.parse(
    out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)
  );
  return parsed.MAILPIT_URL || parsed.INBUCKET_URL || 'http://127.0.0.1:54324';
}

export function checkStackStarts(started: Step): CheckResult {
  return {
    name: STARTS,
    passed: started.ok,
    notes: started.ok ? 'supabase start exited 0' : started.message,
  };
}

export function checkCode(probe: Probe, who: Who): CheckResult {
  const name = CHECK[who].code;
  const person = probe[who];
  if (!probe.ok) return blocked(name, probe);
  if (!person.mail) return noMail(name, person);
  const subject = `"${person.mail.subject}"`;
  if (person.hashes.length === 0) {
    return {
      name,
      passed: false,
      notes: `${subject} arrived, but Auth holds no code for ${person.email} to compare it with`,
    };
  }
  if (person.code === null) {
    const found =
      person.candidates.length > 0
        ? `, its 6-digit runs ${person.candidates.slice(0, 5).join(', ')} are not the code Auth issued`
        : '';
    return {
      name,
      passed: false,
      notes: `${subject} carries no 6-digit code${found}: ${plain(person.mail.html).slice(0, 160)}`,
    };
  }
  return {
    name,
    passed: person.codeVisible,
    notes: person.codeVisible
      ? `${subject} carries ${person.code}`
      : `${subject} carries ${person.code} only inside a link`,
  };
}

export function checkNoLink(probe: Probe, who: Who): CheckResult {
  const name = CHECK[who].link;
  const person = probe[who];
  if (!probe.ok) return blocked(name, probe);
  if (!person.mail) return noMail(name, person);
  return {
    name,
    passed: person.links.length === 0,
    notes:
      person.links.length === 0
        ? `"${person.mail.subject}" has no link that carries the sign-in`
        : `"${person.mail.subject}" links to ${person.links[0]?.slice(0, 160)}`,
  };
}

export function checkSignsIn(probe: Probe, who: Who): CheckResult {
  const name = CHECK[who].signsIn;
  const person = probe[who];
  if (!probe.ok) return blocked(name, probe);
  if (!person.mail) return noMail(name, person);
  return {
    name,
    passed: person.signedIn,
    notes: person.verifyNote || 'no run in the email is the code Auth issued',
  };
}

function noMail(name: string, person: Person): CheckResult {
  return {
    name,
    passed: false,
    notes: `no email reached the ${person.label} person within 20s, the request returned ${person.status}`,
  };
}

function blocked(name: string, step: Step): CheckResult {
  return { name, passed: false, notes: `not run: ${step.message}` };
}
