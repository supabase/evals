import { randomUUID } from 'node:crypto';
import type {
  CheckResult,
  LocalStackEvalContext,
  SupabaseClient,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const PASSWORD = 'secret123';
const RECURSION = '42P17';
const FORBIDDEN = '42501';

export type Fixtures = {
  clientA: SupabaseClient;
  clientB: SupabaseClient;
  anonClient: SupabaseClient;
  userAId: string;
  userBId: string;
  todoA: string;
  todoAEdit: string;
  todoADelete: string;
  todoB: string;
  listId: string;
  listName: string;
  listItem: string;
  stationId: string;
  stationName: string;
  readingId: string;
};

type QueryError = { code?: string; message: string } | null;

export async function setupFixtures(
  ctx: LocalStackEvalContext
): Promise<{ fixtures: Fixtures } | { failure: CheckResult }> {
  const clientA = await ctx.getClient();
  const clientB = await ctx.getClient();
  const anonClient = await ctx.getClient();
  const run = randomUUID().slice(0, 8);

  const { data: authA, error: authAError } = await clientA.auth.signUp({
    email: `rls-guide-a-${run}@example.com`,
    password: PASSWORD,
  });
  const { data: authB, error: authBError } = await clientB.auth.signUp({
    email: `rls-guide-b-${run}@example.com`,
    password: PASSWORD,
  });

  if (
    authAError ||
    authBError ||
    !authA.user?.id ||
    !authA.session ||
    !authB.user?.id ||
    !authB.session
  ) {
    return {
      failure: {
        name: 'created auth sessions',
        passed: false,
        notes: authAError?.message ?? authBError?.message ?? 'missing session',
      },
    };
  }

  const fixtures: Fixtures = {
    clientA,
    clientB,
    anonClient,
    userAId: authA.user.id,
    userBId: authB.user.id,
    todoA: `todo-a-${run}`,
    todoAEdit: `todo-a-edit-${run}`,
    todoADelete: `todo-a-delete-${run}`,
    todoB: `todo-b-${run}`,
    listId: randomUUID(),
    listName: `list-${run}`,
    listItem: `item-${run}`,
    stationId: randomUUID(),
    stationName: `station-${run}`,
    readingId: randomUUID(),
  };

  await execSql(
    ctx,
    stripIndent`
      INSERT INTO todos (user_id, title) VALUES
        ('${fixtures.userAId}', '${fixtures.todoA}'),
        ('${fixtures.userAId}', '${fixtures.todoAEdit}'),
        ('${fixtures.userAId}', '${fixtures.todoADelete}'),
        ('${fixtures.userBId}', '${fixtures.todoB}');

      INSERT INTO lists (id, owner_id, name)
        VALUES ('${fixtures.listId}', '${fixtures.userAId}', '${fixtures.listName}');
      INSERT INTO list_members (list_id, user_id)
        VALUES ('${fixtures.listId}', '${fixtures.userAId}');
      INSERT INTO list_items (list_id, author_id, title)
        VALUES ('${fixtures.listId}', '${fixtures.userAId}', '${fixtures.listItem}');

      INSERT INTO weather_stations (id, name, latitude, longitude)
        VALUES ('${fixtures.stationId}', '${fixtures.stationName}', 47.6, -122.3);
      INSERT INTO weather_readings (id, station_id, temp_c, conditions)
        VALUES ('${fixtures.readingId}', '${fixtures.stationId}', 12.5, 'seeded');
    `
  );

  return { fixtures };
}

export async function checkTodoVisibility(f: Fixtures): Promise<CheckResult[]> {
  const a = await f.clientA.from('todos').select('title');
  const b = await f.clientB.from('todos').select('title');
  const anon = await f.anonClient.from('todos').select('title');

  const aTitles = titlesOf(a.data);
  const bTitles = titlesOf(b.data);

  return [
    {
      name: 'a signed-in user reads their own todos',
      passed: !a.error && aTitles.includes(f.todoA),
      notes: a.error ? describeError(a.error) : `titles: ${aTitles.join(', ')}`,
    },
    {
      name: "a signed-in user cannot read another user's todos",
      passed: !a.error && !aTitles.includes(f.todoB),
      notes: a.error ? describeError(a.error) : undefined,
    },
    {
      name: "the second user reads their own todos and not the first user's",
      passed:
        !b.error && bTitles.includes(f.todoB) && !bTitles.includes(f.todoA),
      notes: b.error ? describeError(b.error) : `titles: ${bTitles.join(', ')}`,
    },
    {
      name: 'signed-out visitors read no todos',
      passed: anon.error
        ? anon.error.code === FORBIDDEN
        : (anon.data?.length ?? 0) === 0,
      notes: anon.error
        ? describeError(anon.error)
        : `${anon.data?.length ?? 0} rows`,
    },
  ];
}

export async function checkTodoWrites(
  ctx: LocalStackEvalContext,
  f: Fixtures
): Promise<CheckResult[]> {
  const run = randomUUID().slice(0, 8);
  const created = `todo-a-created-${run}`;
  const forged = `todo-a-forged-${run}`;
  const edited = `todo-a-edited-${run}`;

  const ownInsert = await f.clientA
    .from('todos')
    .insert({ user_id: f.userAId, title: created });
  const forgedInsert = await f.clientA
    .from('todos')
    .insert({ user_id: f.userBId, title: forged });

  const ownUpdate = await f.clientA
    .from('todos')
    .update({ title: edited })
    .eq('title', f.todoAEdit);
  await f.clientA
    .from('todos')
    .update({ title: 'hijacked' })
    .eq('title', f.todoB);
  await f.clientA
    .from('todos')
    .update({ user_id: f.userBId })
    .eq('title', f.todoA);

  const ownDelete = await f.clientA
    .from('todos')
    .delete()
    .eq('title', f.todoADelete);
  await f.clientA.from('todos').delete().eq('title', f.todoB);

  const { rows } = await ctx.query(stripIndent`
    SELECT title, user_id::text AS user_id
    FROM todos
    WHERE title IN (
      '${f.todoA}', '${f.todoAEdit}', '${f.todoADelete}', '${f.todoB}',
      '${created}', '${forged}', '${edited}', 'hijacked'
    )
  `);
  const present = (title: string) => rows.some((row) => row.title === title);
  const ownedBy = (title: string, userId: string) =>
    rows.some((row) => row.title === title && row.user_id === userId);

  return [
    {
      name: 'a signed-in user creates a todo of their own',
      passed: !ownInsert.error && present(created),
      notes: ownInsert.error
        ? describeError(ownInsert.error)
        : present(created)
          ? undefined
          : 'insert reported success but no row was written',
    },
    {
      name: 'a signed-in user cannot create a todo owned by someone else',
      passed: Boolean(forgedInsert.error) && !present(forged),
      notes: forgedInsert.error
        ? describeError(forgedInsert.error)
        : 'insert with a forged user_id succeeded',
    },
    {
      name: 'a signed-in user updates their own todo and the row changes',
      passed: !ownUpdate.error && present(edited) && !present(f.todoAEdit),
      notes: ownUpdate.error
        ? describeError(ownUpdate.error)
        : present(edited)
          ? undefined
          : 'update raised nothing but the row was never changed',
    },
    {
      name: "a signed-in user cannot modify another user's todo",
      passed: present(f.todoB) && !present('hijacked'),
      notes: present(f.todoB) ? undefined : `rows now: ${JSON.stringify(rows)}`,
    },
    {
      name: 'a signed-in user cannot hand their own todo to another user',
      passed: ownedBy(f.todoA, f.userAId),
      notes: ownedBy(f.todoA, f.userAId)
        ? undefined
        : `rows now: ${JSON.stringify(rows)}`,
    },
    {
      name: 'a signed-in user deletes their own todo and the row is gone',
      passed: !ownDelete.error && !present(f.todoADelete),
      notes: ownDelete.error
        ? describeError(ownDelete.error)
        : present(f.todoADelete)
          ? 'delete raised nothing but the row survived'
          : undefined,
    },
    {
      name: "a signed-in user cannot delete another user's todo",
      passed: present(f.todoB),
      notes: present(f.todoB) ? undefined : "the other user's todo was deleted",
    },
  ];
}

export async function checkSharedListAccess(
  ctx: LocalStackEvalContext,
  f: Fixtures
): Promise<CheckResult[]> {
  const created = `item-created-${randomUUID().slice(0, 8)}`;

  const memberLists = await f.clientA.from('lists').select('name');
  const memberItems = await f.clientA.from('list_items').select('title');
  const memberMembership = await f.clientA.from('list_members').select('*');
  const outsiderLists = await f.clientB.from('lists').select('name');
  const outsiderItems = await f.clientB.from('list_items').select('title');
  const anonLists = await f.anonClient.from('lists').select('name');
  const anonItems = await f.anonClient.from('list_items').select('title');

  const memberInsert = await f.clientA
    .from('list_items')
    .insert({ list_id: f.listId, author_id: f.userAId, title: created });

  const { rows } = await ctx.query(stripIndent`
    SELECT title FROM list_items WHERE title = '${created}'
  `);

  const recursive = [
    memberLists.error,
    memberItems.error,
    memberMembership.error,
    outsiderLists.error,
    outsiderItems.error,
    anonLists.error,
    anonItems.error,
    memberInsert.error,
  ].filter((error) => error?.code === RECURSION);

  return [
    {
      name: 'a list member reads the list they are on',
      passed:
        !memberLists.error && namesOf(memberLists.data).includes(f.listName),
      notes: memberLists.error
        ? describeError(memberLists.error)
        : `names: ${namesOf(memberLists.data).join(', ')}`,
    },
    {
      name: 'a list member reads the items on that list',
      passed:
        !memberItems.error && titlesOf(memberItems.data).includes(f.listItem),
      notes: memberItems.error
        ? describeError(memberItems.error)
        : `titles: ${titlesOf(memberItems.data).join(', ')}`,
    },
    {
      name: 'a list member adds an item and the row lands',
      passed: !memberInsert.error && rows.length > 0,
      notes: memberInsert.error
        ? describeError(memberInsert.error)
        : rows.length > 0
          ? undefined
          : 'insert reported success but no row was written',
    },
    {
      name: 'a non-member reads neither the list nor its items',
      passed:
        (outsiderLists.error
          ? outsiderLists.error.code === FORBIDDEN
          : !namesOf(outsiderLists.data).includes(f.listName)) &&
        (outsiderItems.error
          ? outsiderItems.error.code === FORBIDDEN
          : !titlesOf(outsiderItems.data).includes(f.listItem)),
      notes: [
        outsiderLists.error
          ? `lists: ${describeError(outsiderLists.error)}`
          : `lists: ${namesOf(outsiderLists.data).join(', ')}`,
        outsiderItems.error
          ? `items: ${describeError(outsiderItems.error)}`
          : `items: ${titlesOf(outsiderItems.data).join(', ')}`,
      ].join('; '),
    },
    {
      name: 'signed-out visitors read neither lists nor list items',
      passed:
        (anonLists.error
          ? anonLists.error.code === FORBIDDEN
          : (anonLists.data?.length ?? 0) === 0) &&
        (anonItems.error
          ? anonItems.error.code === FORBIDDEN
          : (anonItems.data?.length ?? 0) === 0),
      notes: [
        anonLists.error
          ? `lists: ${describeError(anonLists.error)}`
          : `lists: ${anonLists.data?.length ?? 0} rows`,
        anonItems.error
          ? `items: ${describeError(anonItems.error)}`
          : `items: ${anonItems.data?.length ?? 0} rows`,
      ].join('; '),
    },
    {
      name: 'no membership policy recurses into itself',
      passed: recursive.length === 0,
      notes:
        recursive.length === 0
          ? undefined
          : `${RECURSION}: ${recursive[0]?.message}`,
    },
  ];
}

export async function checkWeatherFeed(
  ctx: LocalStackEvalContext,
  f: Fixtures
): Promise<CheckResult[]> {
  const anonStations = await f.anonClient
    .from('weather_stations')
    .select('name');
  const anonReadings = await f.anonClient
    .from('weather_readings')
    .select('conditions');
  const authedStations = await f.clientA
    .from('weather_stations')
    .select('name');
  const authedReadings = await f.clientA
    .from('weather_readings')
    .select('conditions');

  const anonWrites = await attemptFeedWrites(ctx, f.anonClient, f, 'anon');
  const authedWrites = await attemptFeedWrites(ctx, f.clientA, f, 'authed');

  return [
    {
      name: 'signed-out visitors read the weather feed',
      passed:
        !anonStations.error &&
        !anonReadings.error &&
        namesOf(anonStations.data).includes(f.stationName) &&
        (anonReadings.data?.length ?? 0) > 0,
      notes: [
        anonStations.error
          ? `stations: ${describeError(anonStations.error)}`
          : `stations: ${anonStations.data?.length ?? 0} rows`,
        anonReadings.error
          ? `readings: ${describeError(anonReadings.error)}`
          : `readings: ${anonReadings.data?.length ?? 0} rows`,
      ].join('; '),
    },
    {
      name: 'signed-in users read the weather feed',
      passed:
        !authedStations.error &&
        !authedReadings.error &&
        namesOf(authedStations.data).includes(f.stationName) &&
        (authedReadings.data?.length ?? 0) > 0,
      notes: [
        authedStations.error
          ? `stations: ${describeError(authedStations.error)}`
          : `stations: ${authedStations.data?.length ?? 0} rows`,
        authedReadings.error
          ? `readings: ${describeError(authedReadings.error)}`
          : `readings: ${authedReadings.data?.length ?? 0} rows`,
      ].join('; '),
    },
    {
      name: 'signed-out visitors cannot write to the weather feed',
      passed: isBlocked(anonWrites),
      notes: describeFeedWrites(anonWrites),
    },
    {
      name: 'signed-in users cannot write to the weather feed',
      passed: isBlocked(authedWrites),
      notes: describeFeedWrites(authedWrites),
    },
  ];
}

type FeedWriteAttempt = {
  insertError: QueryError;
  rowSurvived: boolean;
  rowUnchanged: boolean;
  nothingInjected: boolean;
};

// Each role's attempt is scored against its own snapshot, and the seeded
// reading is restored afterwards, so one role's leak cannot fail the other's
// check.
async function attemptFeedWrites(
  ctx: LocalStackEvalContext,
  client: SupabaseClient,
  f: Fixtures,
  label: string
): Promise<FeedWriteAttempt> {
  const marker = `${label}-${randomUUID().slice(0, 8)}`;
  const insert = await client
    .from('weather_readings')
    .insert({ station_id: f.stationId, temp_c: 99, conditions: marker });
  await client
    .from('weather_readings')
    .update({ conditions: marker })
    .eq('id', f.readingId);
  await client.from('weather_readings').delete().eq('id', f.readingId);

  const { rows } = await ctx.query(stripIndent`
    SELECT id::text AS id, conditions
    FROM weather_readings
    WHERE id = '${f.readingId}' OR conditions = '${marker}'
  `);
  const seeded = rows.find((row) => row.id === f.readingId);

  await execSql(
    ctx,
    stripIndent`
      DELETE FROM weather_readings WHERE conditions = '${marker}';
      INSERT INTO weather_readings (id, station_id, temp_c, conditions)
        VALUES ('${f.readingId}', '${f.stationId}', 12.5, 'seeded')
        ON CONFLICT (id) DO UPDATE SET temp_c = 12.5, conditions = 'seeded';
    `
  );

  return {
    insertError: insert.error,
    rowSurvived: Boolean(seeded),
    rowUnchanged: seeded?.conditions === 'seeded',
    nothingInjected: !rows.some((row) => row.conditions === marker),
  };
}

function isBlocked(attempt: FeedWriteAttempt): boolean {
  return (
    Boolean(attempt.insertError) &&
    attempt.rowSurvived &&
    attempt.rowUnchanged &&
    attempt.nothingInjected
  );
}

function describeFeedWrites(attempt: FeedWriteAttempt): string {
  return [
    attempt.insertError
      ? `insert ${describeError(attempt.insertError)}`
      : 'insert succeeded',
    attempt.rowSurvived ? 'reading survived delete' : 'reading was deleted',
    attempt.rowUnchanged ? 'reading unchanged' : 'reading was updated',
    attempt.nothingInjected ? 'no row injected' : 'a row was injected',
  ].join('; ');
}

/** Runs non-SELECT SQL against the local stack database as the superuser. */
export async function execSql(
  ctx: LocalStackEvalContext,
  sql: string
): Promise<void> {
  const encoded = Buffer.from(sql, 'utf8').toString('base64');
  const result = await ctx.exec(
    stripIndent`
      DB_URL=$(supabase status -o json | node -e 'let input = ""; process.stdin.on("data", data => input += data); process.stdin.on("end", () => console.log(JSON.parse(input).DB_URL));')
      echo ${encoded} | base64 -d | psql "$DB_URL" -v ON_ERROR_STOP=1
    `
  );

  if (!result.ok) {
    throw new Error(`SQL execution failed: ${result.stderr || result.stdout}`);
  }
}

function titlesOf(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data.map((row) => String((row as { title?: unknown }).title ?? ''));
}

function namesOf(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data.map((row) => String((row as { name?: unknown }).name ?? ''));
}

function describeError(error: { code?: string; message: string }): string {
  return error.code ? `error ${error.code}: ${error.message}` : error.message;
}
