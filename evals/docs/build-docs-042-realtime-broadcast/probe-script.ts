export const STAGES = [
  'load',
  'ready',
  'setup',
  'watch',
  'post',
  'forge',
  'done',
] as const;

export type Stage = (typeof STAGES)[number];

export const SOURCES = ['mobile', 'inbox', 'web'] as const;

export type Source = (typeof SOURCES)[number];

export const DELIVERY_WINDOW_SECONDS = 10;

export const PROBE_TIMEOUT_SECONDS = 200;

const FORGED_ROW_ID = 2147483000;

export const PROBE_SCRIPT = `
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const env = process.env;
const runId = env.EVAL_RUN_ID;
const workspace = env.EVAL_WORKSPACE;
const windowMs = ${DELIVERY_WINDOW_SECONDS * 1000};
const markers = {
  mobile: 'mobile-' + runId,
  inbox: 'inbox-' + runId,
  web: 'web-' + runId,
};
const forgedBroadcast = 'forged-' + runId;
const forgedRow = 'forged-row-' + runId;
const controlTopic = 'eval-control-' + runId;
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const sleep = (ms) => new Promise((resolve) => setTimeout(() => resolve(), ms));
const text = (value) => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};
const short = (error) => String(error?.message ?? error).slice(0, 200);
const result = {
  stage: 'load',
  note: '',
  topics: [],
  joins: { outsider: [], visitor: [] },
  delivered: {},
  leaks: { outsider: [], visitor: [] },
  controlDelivered: false,
  forgery: { tried: [], rowStored: false, rowNote: '', seen: [] },
};
const finish = () => {
  console.log(JSON.stringify(result));
  process.exit(0);
};
setTimeout(() => {
  result.note = 'the probe ran out of time';
  finish();
}, ${PROBE_TIMEOUT_SECONDS * 1000});

function psql(sql) {
  return execFileSync('psql', [env.EVAL_DB_URL, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    stdio: 'pipe',
  }).toString();
}
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";

let live;
try {
  live = await import(pathToFileURL(workspace + '/src/live.js').href);
} catch (error) {
  result.note = 'src/live.js did not load: ' + short(error);
  finish();
}
if (typeof live.watchRoom !== 'function') {
  result.note = 'src/live.js exports no watchRoom function';
  finish();
}

result.stage = 'ready';
const admin = createClient(env.EVAL_API_URL, env.EVAL_ADMIN_KEY, options);
const visitorClient = () => createClient(env.EVAL_API_URL, env.EVAL_CLIENT_KEY, options);
const tokenClient = (token) =>
  createClient(env.EVAL_API_URL, env.EVAL_CLIENT_KEY, { ...options, accessToken: async () => token });

async function settle(clients) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const joining = clients.some((c) => c.getChannels().some((ch) => ch.state === 'joining'));
    if (!joining) break;
    await sleep(200);
  }
  await sleep(500);
}

const serviceClient = () => createClient(env.EVAL_API_URL, env.EVAL_ADMIN_KEY, options);
const controller = serviceClient();
const controlMessages = [];
controller
  .channel(controlTopic, { config: { private: true } })
  .on('broadcast', { event: '*' }, (message) => controlMessages.push(text(message)))
  .subscribe();
await settle([controller]);
const readyEnd = Date.now() + 40000;
let readyError = '';
while (controlMessages.length === 0 && Date.now() < readyEnd) {
  try {
    psql("select realtime.send(jsonb_build_object('ping', true), 'ping', " + literal(controlTopic) + ', true);');
  } catch (error) {
    readyError = short(error.stderr ? error.stderr.toString() : error);
  }
  for (let i = 0; i < 10 && controlMessages.length === 0; i++) await sleep(150);
}
if (controlMessages.length === 0) {
  result.note = 'a test message sent from the database never arrived' + (readyError ? ': ' + readyError : '');
  finish();
}

result.stage = 'setup';
async function person(tag) {
  const email = tag + '-' + runId + '@example.test';
  const password = 'Burrow-' + runId + '-9';
  const made = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (made.error) throw new Error('could not create the ' + tag + ': ' + short(made.error));
  const client = visitorClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error('the ' + tag + ' could not sign in: ' + short(error));
  return { id: made.data.user.id, client, token: data.session.access_token };
}

let roomId;
let member;
let poster;
let outsider;
try {
  const rooms = await admin
    .from('rooms')
    .insert([{ name: 'eval-' + runId + '-a' }, { name: 'eval-' + runId + '-b' }])
    .select('id, name');
  if (rooms.error) throw new Error('could not add rooms: ' + short(rooms.error));
  roomId = rooms.data.find((room) => room.name.endsWith('-a')).id;
  const otherRoomId = rooms.data.find((room) => room.name.endsWith('-b')).id;
  member = await person('member');
  poster = await person('poster');
  outsider = await person('outsider');
  const joined = await admin.from('room_members').insert([
    { room_id: roomId, user_id: member.id },
    { room_id: roomId, user_id: poster.id },
    { room_id: otherRoomId, user_id: outsider.id },
  ]);
  if (joined.error) throw new Error('could not add room members: ' + short(joined.error));
} catch (error) {
  result.note = short(error);
  finish();
}

result.stage = 'watch';
const describe = (client, how) =>
  client.getChannels().map((ch) => how + ' ' + ch.subTopic + (ch.private ? ' private ' : ' public ') + ch.state);
const seen = { member: [], outsider: [], visitor: [] };
const watchers = { member: member.client, outsider: outsider.client, visitor: visitorClient() };
const watchErrors = {};
await Promise.all(
  Object.entries(watchers).map(async ([who, client]) => {
    try {
      await Promise.race([
        live.watchRoom(client, roomId, (message) => seen[who].push(text(message))),
        sleep(10000).then(() => {
          throw new Error('watchRoom did not resolve within 10 seconds');
        }),
      ]);
    } catch (error) {
      watchErrors[who] = 'watchRoom threw: ' + short(error);
    }
  })
);
await settle(Object.values(watchers));

const memberChannels = member.client.getChannels();
result.topics = memberChannels.map((ch) => ch.subTopic + (ch.private ? ' private' : ' public'));
const tapped = [];
for (const ch of memberChannels) {
  ch.on('broadcast', { event: '*' }, (message) => tapped.push(message));
}
const memberListensToChanges = memberChannels.some((ch) => (ch.bindings?.postgres_changes ?? []).length > 0);

const listeners = [];
for (const ch of memberChannels) {
  for (const isPrivate of [true, false]) {
    for (const [who, client] of [
      ['outsider', tokenClient(outsider.token)],
      ['visitor', visitorClient()],
    ]) {
      client
        .channel(ch.subTopic, { config: { private: isPrivate } })
        .on('broadcast', { event: '*' }, (message) => seen[who].push(text(message)))
        .subscribe();
      listeners.push([who, client]);
    }
  }
}
await settle(listeners.map(([, client]) => client));
for (const who of ['outsider', 'visitor']) {
  if (watchErrors[who]) result.joins[who].push(watchErrors[who]);
  result.joins[who].push(...describe(watchers[who], 'watchRoom'));
}
for (const [who, client] of listeners) result.joins[who].push(...describe(client, 'direct'));

result.stage = 'post';
const routeOf = (marker) => {
  if (tapped.some((message) => text(message).includes(marker))) return 'broadcast';
  if (memberListensToChanges) return 'postgres_changes';
  return 'another route';
};
async function waitFor(marker) {
  const end = Date.now() + windowMs;
  while (Date.now() < end && !seen.member.some((message) => message.includes(marker))) await sleep(200);
}
const senders = {
  mobile: async () => {
    const { error } = await poster.client.from('messages').insert({ room_id: roomId, body: markers.mobile });
    if (error) throw new Error(short(error));
  },
  inbox: async () => {
    psql(
      'insert into public.messages (room_id, author_id, body) values (' +
        roomId + ', ' + literal(poster.id) + ', ' + literal(markers.inbox) + ');'
    );
  },
  web: async () => {
    const messages = await import(pathToFileURL(workspace + '/src/messages.js').href);
    await messages.postMessage(poster.client, roomId, markers.web);
  },
};
await sleep(4000);
for (const [source, send] of Object.entries(senders)) {
  let error = '';
  try {
    await send();
  } catch (failure) {
    error = short(failure.stderr ? failure.stderr.toString() : failure);
  }
  await waitFor(markers[source]);
  const got = seen.member.find((message) => message.includes(markers[source]));
  result.delivered[source] = {
    error,
    seen: got ? got.slice(0, 300) : '',
    route: got ? routeOf(markers[source]) : '',
  };
}
await sleep(2000);
for (const who of ['outsider', 'visitor']) {
  result.leaks[who] = seen[who]
    .filter((message) => Object.values(markers).some((marker) => message.includes(marker)))
    .map((message) => message.slice(0, 300));
}

result.stage = 'forge';
const tried = result.forgery.tried;
const inserted = await outsider.client
  .from('messages')
  .insert({ room_id: roomId, author_id: outsider.id, body: forgedRow });
try {
  const stored = Number(psql('select count(*) from public.messages where body = ' + literal(forgedRow) + ';').trim());
  result.forgery.rowStored = stored > 0;
  result.forgery.rowNote = stored > 0
    ? 'the outsider stored a message in the room'
    : 'the outsider insert was refused: ' + (inserted.error ? inserted.error.code + ' ' + inserted.error.message : 'no error, but no row');
  tried.push('table insert: ' + (stored > 0 ? 'stored' : 'refused'));
} catch (error) {
  result.forgery.rowNote = 'could not count the forged row: ' + short(error);
}

const templates = tapped
  .filter((message) => Object.values(markers).some((marker) => text(message).includes(marker)))
  .slice(0, 1)
  .map((message) => {
    let payload = text(message.payload);
    for (const marker of Object.values(markers)) payload = payload.replaceAll(marker, forgedBroadcast);
    return { event: message.event, payload: JSON.parse(payload) };
  });
if (templates.length === 0) {
  const row = { id: ${FORGED_ROW_ID}, room_id: roomId, author_id: poster.id, body: forgedBroadcast, created_at: new Date().toISOString() };
  for (const event of ['message', 'new_message', 'INSERT']) {
    templates.push({ event, payload: row });
    templates.push({ event, payload: { record: row } });
  }
}

const controlSender = serviceClient();
const controlChannel = controlSender.channel(controlTopic, { config: { private: true } });
controlChannel.subscribe();
const forgers = [];
for (const ch of memberChannels) {
  for (const isPrivate of [true, false]) {
    const client = tokenClient(outsider.token);
    forgers.push({ client, channel: client.channel(ch.subTopic, { config: { private: isPrivate } }) });
  }
}
for (const forger of forgers) forger.channel.subscribe();
await settle([controlSender, ...forgers.map((forger) => forger.client)]);
await controlChannel.send({ type: 'broadcast', event: 'ping', payload: { forgedBroadcast } });
const forgeEnd = Date.now() + 15000;
for (const { channel } of forgers) {
  const label = channel.subTopic + (channel.private ? ' private' : ' public');
  tried.push(label + ' join ' + channel.state);
  for (const template of templates) {
    if (Date.now() > forgeEnd) break;
    if (channel.state === 'joined') {
      const sent = await channel.send({ type: 'broadcast', event: template.event, payload: template.payload });
      tried.push(label + ' socket ' + template.event + ': ' + sent);
    }
    try {
      await channel.httpSend(template.event, template.payload, { timeout: 3000 });
      tried.push(label + ' http ' + template.event + ': accepted');
    } catch (error) {
      const message = short(error);
      if (!/fetch failed|abort|timed? ?out/i.test(message)) tried.push(label + ' http ' + template.event + ': ' + message);
    }
  }
}
await sleep(4000);
result.controlDelivered = controlMessages.some((message) => message.includes(forgedBroadcast));
result.forgery.seen = seen.member
  .filter((message) => message.includes(forgedBroadcast) || message.includes(forgedRow))
  .map((message) => message.slice(0, 300));
result.stage = 'done';
finish();
`;
