import { createHmac, randomUUID } from 'node:crypto';
import type {
  CheckResult,
  LocalStackEvalContext,
  SupabaseClient,
} from '@supabase-evals/core';
import { execSql } from '../lib/exec-sql.js';
import type { Step } from '../lib/local-stack.js';

export const CHECK = {
  stackStarts: 'the local stack restarts on the project settings',
  codesAllowed: 'the project lets people turn on an authenticator-app code',
  plainReads: 'someone without a code reads their journal with a password',
  plainWrites:
    'someone without a code adds, changes and removes journal rows with a password',
  halfway:
    'someone who gave up setting up a code reads their journal with a password',
  skippedReads:
    'a person with a code who has not typed it cannot read their journal',
  skippedWrites:
    'a person with a code who has not typed it cannot add, change or remove anything',
  typedReads: 'a person who typed their code reads their journal',
  typedWrites:
    'a person who typed their code adds, changes and removes journal rows',
  staleDevice:
    'a device signed in before the code was turned on is locked once it is on',
} as const;

const PASSWORD = 'Dayline-pass-9';
const STEP_SECONDS = 30;
const TABLES = [
  { table: 'entries', column: 'body' },
  { table: 'habits', column: 'name' },
] as const;

type Ctx = Pick<LocalStackEvalContext, 'exec' | 'query' | 'getClient'>;
type Person = { client: SupabaseClient; id: string; email: string };
type Outcome<T> = ({ ok: true } & T) | { ok: false; message: string };
type ApiError = { code?: string; message: string };
type ReadError = { table: string; code: string; message: string };

export type Signed = Outcome<{ person: Person }>;

export type World = {
  marker: string;
  plain: Person;
  halfway: Signed;
  enrolled: Outcome<{
    person: Person;
    factorId: string;
    secret: string;
    earlierDevice: SupabaseClient;
    earlierDeviceRead: string[];
  }>;
};

export type Setup = { ok: true; world: World } | { ok: false; message: string };

export function notRun(name: string, reason: string): CheckResult {
  return { name, passed: false, notes: `not run: ${reason}` };
}

export function checkStackStarts(started: Step): CheckResult {
  return {
    name: CHECK.stackStarts,
    passed: started.ok,
    notes: started.ok ? 'supabase start exited 0' : started.message,
  };
}

export async function probeCodes(ctx: Ctx): Promise<Outcome<object>> {
  const made = await signUp(
    ctx,
    `dayline-${randomUUID().slice(0, 8)}-probe@example.test`
  );
  if (!made.ok) return made;
  const { data, error } = await made.person.client.auth.mfa.enroll({
    factorType: 'totp',
  });
  if (error || !data) {
    return {
      ok: false,
      message: `could not start setting up a code: ${error?.message ?? 'no factor returned'}`,
    };
  }
  return typeCode(made.person.client, data.id, data.totp.secret);
}

export function checkCodesAllowed(codes: Outcome<object>): CheckResult {
  return {
    name: CHECK.codesAllowed,
    passed: codes.ok,
    notes: codes.ok
      ? 'on the project settings, a person set up a code and typed it'
      : `${codes.message}; the scorer turned codes on to run the other checks`,
  };
}

export async function setupWorld(ctx: Ctx): Promise<Setup> {
  const marker = `dayline-${randomUUID().slice(0, 8)}`;

  const plain = await signUp(ctx, `${marker}-plain@example.test`);
  if (!plain.ok) return plain;
  const plainRows = await seedRows(ctx, plain.person.id, `${marker}-plain`);
  if (!plainRows.ok) return plainRows;

  return {
    ok: true,
    world: {
      marker,
      plain: plain.person,
      halfway: await setupHalfway(ctx, marker),
      enrolled: await setupEnrolled(ctx, marker),
    },
  };
}

async function setupHalfway(ctx: Ctx, marker: string): Promise<Signed> {
  const made = await signUp(ctx, `${marker}-halfway@example.test`);
  if (!made.ok) return made;
  const seeded = await seedRows(ctx, made.person.id, `${marker}-halfway`);
  if (!seeded.ok) return seeded;
  const { error } = await made.person.client.auth.mfa.enroll({
    factorType: 'totp',
  });
  if (error) {
    return {
      ok: false,
      message: `could not start setting up a code: ${error.message}`,
    };
  }
  return { ok: true, person: made.person };
}

async function setupEnrolled(
  ctx: Ctx,
  marker: string
): Promise<World['enrolled']> {
  const made = await signUp(ctx, `${marker}-coded@example.test`);
  if (!made.ok) return made;
  const { person } = made;
  const seeded = await seedRows(ctx, person.id, `${marker}-coded`);
  if (!seeded.ok) return seeded;

  const earlier = await signIn(ctx, person.email);
  if (!earlier.ok) return earlier;
  const earlierRead = await readMarkers(earlier.client, `${marker}-coded`);

  const { data, error } = await person.client.auth.mfa.enroll({
    factorType: 'totp',
  });
  if (error || !data) {
    return {
      ok: false,
      message: `could not start setting up a code: ${error?.message ?? 'no factor returned'}`,
    };
  }
  const secret = data.totp.secret;
  const verified = await typeCode(person.client, data.id, secret);
  if (!verified.ok) return verified;

  const { rows } = await ctx.query(
    `select status::text as status from auth.mfa_factors where id = '${data.id}'`
  );
  if (rows[0]?.status !== 'verified') {
    return {
      ok: false,
      message: `the code was accepted but the factor is ${String(rows[0]?.status ?? 'missing')}`,
    };
  }
  const level = await levelOf(person.client);
  if (level.current !== 'aal2') {
    return {
      ok: false,
      message: `typing the first code left the session at ${level.current}`,
    };
  }

  return {
    ok: true,
    person,
    factorId: data.id,
    secret,
    earlierDevice: earlier.client,
    earlierDeviceRead: earlierRead.found,
  };
}

export async function checkPlainReads(world: World): Promise<CheckResult> {
  return readsOwn(
    CHECK.plainReads,
    world.plain.client,
    `${world.marker}-plain`
  );
}

export async function checkPlainWrites(
  ctx: Ctx,
  world: World
): Promise<CheckResult> {
  return writesOwn(
    ctx,
    CHECK.plainWrites,
    world.plain,
    `${world.marker}-plain-new`
  );
}

export async function checkHalfway(world: World): Promise<CheckResult> {
  if (!world.halfway.ok) return notRun(CHECK.halfway, world.halfway.message);
  return readsOwn(
    CHECK.halfway,
    world.halfway.person.client,
    `${world.marker}-halfway`
  );
}

export async function checkSkippedReads(
  ctx: Ctx,
  world: World
): Promise<CheckResult> {
  const { enrolled } = world;
  if (!enrolled.ok) return notRun(CHECK.skippedReads, enrolled.message);
  const skipped = await signIn(ctx, enrolled.person.email);
  if (!skipped.ok) {
    return { name: CHECK.skippedReads, passed: false, notes: skipped.message };
  }
  const level = await levelOf(skipped.client);
  if (level.current !== 'aal1' || level.next !== 'aal2') {
    return {
      name: CHECK.skippedReads,
      passed: false,
      notes: `could not measure: signing in with a password gave ${level.current}, next ${level.next}`,
    };
  }
  return readsNothing(
    CHECK.skippedReads,
    skipped.client,
    `${world.marker}-coded`
  );
}

export async function checkStaleDevice(world: World): Promise<CheckResult> {
  const { enrolled } = world;
  if (!enrolled.ok) return notRun(CHECK.staleDevice, enrolled.message);
  const before = enrolled.earlierDeviceRead;
  if (before.length < TABLES.length) {
    return {
      name: CHECK.staleDevice,
      passed: false,
      notes: `could not measure: before the code was turned on, the device got back ${before.length > 0 ? `only ${before.join(', ')}` : 'nothing'}`,
    };
  }
  return readsNothing(
    CHECK.staleDevice,
    enrolled.earlierDevice,
    `${world.marker}-coded`
  );
}

export async function signInWithCode(ctx: Ctx, world: World): Promise<Signed> {
  const { enrolled } = world;
  if (!enrolled.ok) return { ok: false, message: enrolled.message };
  const signedIn = await signIn(ctx, enrolled.person.email);
  if (!signedIn.ok) return signedIn;
  const verified = await typeCode(
    signedIn.client,
    enrolled.factorId,
    enrolled.secret
  );
  if (!verified.ok) return verified;
  const level = await levelOf(signedIn.client);
  if (level.current !== 'aal2') {
    return {
      ok: false,
      message: `typing the code at sign-in left the session at ${level.current}`,
    };
  }
  return {
    ok: true,
    person: { ...enrolled.person, client: signedIn.client },
  };
}

export async function checkTypedReads(
  typedSignIn: Signed,
  world: World
): Promise<CheckResult> {
  if (!typedSignIn.ok) return notRun(CHECK.typedReads, typedSignIn.message);
  return readsOwn(
    CHECK.typedReads,
    typedSignIn.person.client,
    `${world.marker}-coded`
  );
}

export async function checkTypedWrites(
  ctx: Ctx,
  typedSignIn: Signed,
  world: World
): Promise<CheckResult> {
  if (!typedSignIn.ok) return notRun(CHECK.typedWrites, typedSignIn.message);
  return writesOwn(
    ctx,
    CHECK.typedWrites,
    typedSignIn.person,
    `${world.marker}-coded-new`
  );
}

export async function checkSkippedWrites(
  ctx: Ctx,
  world: World
): Promise<CheckResult> {
  const { enrolled } = world;
  if (!enrolled.ok) return notRun(CHECK.skippedWrites, enrolled.message);
  const skipped = await signIn(ctx, enrolled.person.email);
  if (!skipped.ok) {
    return { name: CHECK.skippedWrites, passed: false, notes: skipped.message };
  }
  const { id } = enrolled.person;
  const seeded = `${world.marker}-coded`;
  const added = `${world.marker}-skipped`;
  const changed = `${world.marker}-changed`;
  const problems: string[] = [];
  const refusals: string[] = [];

  for (const { table, column } of TABLES) {
    const { error: insertError } = await skipped.client
      .from(table)
      .insert({ user_id: id, [column]: added });
    if ((await countWhere(ctx, table, column, added)) > 0) {
      problems.push(`added to ${table}`);
    } else if (insertError?.code) {
      refusals.push(`${table} insert ${insertError.code}`);
    }

    await skipped.client
      .from(table)
      .update({ [column]: changed })
      .eq(column, seeded);
    if ((await countWhere(ctx, table, column, changed)) > 0) {
      problems.push(`changed a row in ${table}`);
      continue;
    }

    await skipped.client.from(table).delete().eq(column, seeded);
    if ((await countWhere(ctx, table, column, seeded)) === 0) {
      problems.push(`removed a row from ${table}`);
    }
  }

  return {
    name: CHECK.skippedWrites,
    passed: problems.length === 0,
    notes:
      problems.length > 0
        ? problems.join('; ')
        : `entries and habits are unchanged${refusals.length > 0 ? ` (${refusals.join(', ')})` : ''}`,
  };
}

async function readsOwn(
  name: string,
  client: SupabaseClient,
  value: string
): Promise<CheckResult> {
  const read = await readMarkers(client, value);
  const missing = TABLES.map(({ table }) => table).filter(
    (table) => !read.found.includes(table)
  );
  return {
    name,
    passed: missing.length === 0,
    notes:
      missing.length === 0
        ? 'got their entry and habit back'
        : `no row back from ${missing.join(', ')}${read.errors.length > 0 ? `: ${describe(read.errors)}` : ''}`,
  };
}

async function readsNothing(
  name: string,
  client: SupabaseClient,
  value: string
): Promise<CheckResult> {
  const read = await readMarkers(client, value);
  if (read.found.length > 0) {
    return {
      name,
      passed: false,
      notes: `read their rows from ${read.found.join(', ')}`,
    };
  }
  return {
    name,
    passed: true,
    notes:
      read.errors.length > 0
        ? `refused: ${describe(read.errors)}`
        : 'entries and habits came back empty',
  };
}

async function readMarkers(
  client: SupabaseClient,
  value: string
): Promise<{ found: string[]; errors: ReadError[] }> {
  const found: string[] = [];
  const errors: ReadError[] = [];
  for (const { table, column } of TABLES) {
    const { data, error } = await client
      .from(table)
      .select(column)
      .eq(column, value);
    if (error) {
      errors.push({ table, code: error.code ?? '', message: error.message });
    } else if ((data ?? []).length > 0) {
      found.push(table);
    }
  }
  return { found, errors };
}

function describe(errors: ReadError[]): string {
  return errors
    .map((error) => `${error.table}: ${error.code} ${error.message}`.trim())
    .join('; ');
}

async function writesOwn(
  ctx: Ctx,
  name: string,
  person: Person,
  value: string
): Promise<CheckResult> {
  const problems: string[] = [];
  const changed = `${value}-changed`;
  for (const { table, column } of TABLES) {
    const { error: addError } = await person.client
      .from(table)
      .insert({ user_id: person.id, [column]: value });
    if ((await countWhere(ctx, table, column, value, person.id)) !== 1) {
      problems.push(`could not add to ${table}${said(addError)}`);
      continue;
    }
    const { error: changeError } = await person.client
      .from(table)
      .update({ [column]: changed })
      .eq(column, value);
    if ((await countWhere(ctx, table, column, changed, person.id)) !== 1) {
      problems.push(`could not change a row in ${table}${said(changeError)}`);
      continue;
    }
    const { error: removeError } = await person.client
      .from(table)
      .delete()
      .eq(column, changed);
    if ((await countWhere(ctx, table, column, changed, person.id)) !== 0) {
      problems.push(`could not remove a row from ${table}${said(removeError)}`);
    }
  }
  return {
    name,
    passed: problems.length === 0,
    notes:
      problems.length === 0
        ? 'added, changed and removed a row in entries and habits'
        : problems.join('; '),
  };
}

function said(error: ApiError | null): string {
  return error ? ` (${error.code ?? ''} ${error.message})` : '';
}

async function signUp(ctx: Ctx, email: string): Promise<Signed> {
  const client = await ctx.getClient();
  const { data, error } = await client.auth.signUp({
    email,
    password: PASSWORD,
  });
  if (error || !data.user || !data.session) {
    return {
      ok: false,
      message: `could not sign up ${email}: ${error?.message ?? 'no session'}`,
    };
  }
  return { ok: true, person: { client, id: data.user.id, email } };
}

async function signIn(
  ctx: Ctx,
  email: string
): Promise<Outcome<{ client: SupabaseClient }>> {
  const client = await ctx.getClient();
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (error || !data.session) {
    return {
      ok: false,
      message: `could not sign in ${email}: ${error?.message ?? 'no session'}`,
    };
  }
  return { ok: true, client };
}

async function seedRows(
  ctx: Ctx,
  userId: string,
  value: string
): Promise<Outcome<object>> {
  const result = await execSql(
    ctx,
    `insert into public.entries (user_id, body) values ('${userId}', '${value}');
     insert into public.habits (user_id, name) values ('${userId}', '${value}');`
  );
  return result.ok
    ? { ok: true }
    : { ok: false, message: `could not add rows: ${result.message}` };
}

async function countWhere(
  ctx: Ctx,
  table: string,
  column: string,
  value: string,
  userId?: string
): Promise<number> {
  const owner = userId ? ` and user_id = '${userId}'` : '';
  const { rows } = await ctx.query(
    `select count(*)::int as count from public.${table} where ${column} = '${value}'${owner}`
  );
  return Number(rows[0]?.count ?? 0);
}

async function levelOf(
  client: SupabaseClient
): Promise<{ current: string; next: string }> {
  const { data } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  return {
    current: String(data?.currentLevel ?? 'none'),
    next: String(data?.nextLevel ?? 'none'),
  };
}

async function typeCode(
  client: SupabaseClient,
  factorId: string,
  secret: string
): Promise<Outcome<object>> {
  let last = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await waitForNextStep();
    const { error } = await client.auth.mfa.challengeAndVerify({
      factorId,
      code: totp(secret),
    });
    if (!error) return { ok: true };
    last = error.message;
  }
  return { ok: false, message: `the code was refused: ${last}` };
}

function waitForNextStep(): Promise<void> {
  const intoStep = (Date.now() / 1000) % STEP_SECONDS;
  const wait = (STEP_SECONDS - intoStep + 1) * 1000;
  return new Promise((resolve) => {
    setTimeout((): void => resolve(), wait);
  });
}

function totp(secret: string): string {
  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32(secret)).update(message).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const value = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, '0');
}

function base32(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
