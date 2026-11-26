export const PROBE_SOURCE = String.raw`
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const input = JSON.parse(Buffer.from(process.env.PROBE_INPUT, 'base64').toString('utf8'));
const mode = process.argv[2];
const BUCKET = 'notes';
const out = (value) => console.log(JSON.stringify(value));
const messageOf = (error) => String(error?.message ?? error).slice(0, 200);
const failure = (error) => ({
  ok: false,
  code: error?.name ?? 'Error',
  status: error?.$metadata?.httpStatusCode,
  message: messageOf(error),
});

async function sdkFor(dir) {
  const require = createRequire(join(dir, 'probe.js'));
  const mod = await import(pathToFileURL(require.resolve('@aws-sdk/client-s3')).href);
  return mod.ListObjectsV2Command ? mod : mod.default;
}

async function agentClient(dir, factory, ...args) {
  const mod = await import(pathToFileURL(join(dir, 'storage.js')).href);
  if (typeof mod[factory] !== 'function') {
    throw new Error(factory + ' is not exported from storage.js');
  }
  const client = await mod[factory](...args);
  if (!client || typeof client.send !== 'function') {
    throw new Error(factory + ' did not return an S3 client');
  }
  return client;
}

async function list(client, s3, prefix) {
  try {
    const keys = [];
    let token;
    let pages = 0;
    do {
      const page = await client.send(
        new s3.ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token })
      );
      for (const object of page.Contents ?? []) keys.push(object.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
      pages += 1;
    } while (token && pages < 50);
    return { ok: true, keys };
  } catch (error) {
    return failure(error);
  }
}

async function read(client, s3, key) {
  try {
    const { Body } = await client.send(new s3.GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return { ok: true, body: await Body.transformToString() };
  } catch (error) {
    return failure(error);
  }
}

async function put(client, s3, key, body) {
  try {
    await client.send(
      new s3.PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: 'text/markdown' })
    );
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

async function admin() {
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(input.apiUrl, input.adminKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function setup() {
  const { createClient } = await import('@supabase/supabase-js');
  const users = {};
  for (const who of ['owner', 'other']) {
    const client = createClient(input.apiUrl, input.clientKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.auth.signUp({
      email: who + '-' + input.run + '@example.test',
      password: input.password,
    });
    if (error || !data.session) {
      return out({ ok: false, message: 'could not sign up a user: ' + (error?.message ?? 'no session') });
    }
    users[who] = { id: data.user.id, token: data.session.access_token };
  }
  const notes = {
    mine: users.owner.id + '/' + input.run + '-mine.md',
    fresh: users.owner.id + '/' + input.run + '-fresh.md',
    theirs: users.other.id + '/' + input.run + '-theirs.md',
    planted: users.other.id + '/' + input.run + '-planted.md',
  };
  const storage = (await admin()).storage.from(BUCKET);
  for (const [key, body] of [
    [notes.mine, input.texts.mine],
    [notes.theirs, input.texts.theirs],
  ]) {
    const { error } = await storage.upload(key, body, { contentType: 'text/markdown' });
    if (error) return out({ ok: false, message: 'could not add ' + key + ': ' + error.message });
  }
  out({ ok: true, users, notes });
}

async function backup() {
  const dir = process.cwd();
  let client;
  try {
    client = await agentClient(dir, 'createBackupClient');
  } catch (error) {
    return out({ ok: false, message: messageOf(error) });
  }
  const s3 = await sdkFor(dir);
  out({
    ok: true,
    listing: await list(client, s3, undefined),
    mine: await read(client, s3, input.notes.mine),
    theirs: await read(client, s3, input.notes.theirs),
  });
}

async function desktop() {
  const dir = process.cwd();
  let client;
  try {
    client = await agentClient(dir, 'createStorageClient', input.users.owner.token);
  } catch (error) {
    return out({ ok: false, message: messageOf(error) });
  }
  const s3 = await sdkFor(dir);
  const result = { ok: true };
  result.listOwn = await list(client, s3, input.users.owner.id + '/');
  result.readOwn = await read(client, s3, input.notes.mine);
  result.upload = await put(client, s3, input.notes.fresh, input.texts.fresh);
  result.resync = await put(client, s3, input.notes.mine, input.texts.again);
  result.listOther = await list(client, s3, input.users.other.id + '/');
  result.listAll = await list(client, s3, undefined);
  result.readOther = await read(client, s3, input.notes.theirs);
  result.writeOther = await put(client, s3, input.notes.theirs, input.texts.tampered);
  result.plantOther = await put(client, s3, input.notes.planted, input.texts.planted);
  out(result);
}

async function verify() {
  const storage = (await admin()).storage.from(BUCKET);
  const bodies = {};
  for (const [name, key] of Object.entries(input.notes)) {
    const { data, error } = await storage.download(key);
    bodies[name] = error ? null : await data.text();
  }
  out({ ok: true, bodies });
}

const modes = { setup, backup, desktop, verify };
try {
  await modes[mode]();
} catch (error) {
  out({ ok: false, message: messageOf(error) });
}
`;
