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
  clientC: SupabaseClient;
  anonClient: SupabaseClient;
  userAId: string;
  userBId: string;
  userCId: string;
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
  const clientC = await ctx.getClient();
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
  const { data: authC, error: authCError } = await clientC.auth.signUp({
    email: `rls-guide-c-${run}@example.com`,
    password: PASSWORD,
  });

  if (
    authAError ||
    authBError ||
    authCError ||
    !authA.user?.id ||
    !authA.session ||
    !authB.user?.id ||
    !authB.session ||
    !authC.user?.id ||
    !authC.session
  ) {
    return {
      failure: {
        name: 'created auth sessions',
        passed: false,
        notes:
          authAError?.message ??
          authBError?.message ??
          authCError?.message ??
          'missing session',
      },
    };
  }

  const fixtures: Fixtures = {
    clientA,
    clientB,
    clientC,
    anonClient,
    userAId: authA.user.id,
    userBId: authB.user.id,
    userCId: authC.user.id,
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

  const seed = await execSql(
    ctx,
    stripIndent`
      BEGIN;

      INSERT INTO todos (user_id, title) VALUES
        ('${fixtures.userAId}', '${fixtures.todoA}'),
        ('${fixtures.userAId}', '${fixtures.todoAEdit}'),
        ('${fixtures.userAId}', '${fixtures.todoADelete}'),
        ('${fixtures.userBId}', '${fixtures.todoB}');

      INSERT INTO lists (id, owner_id, name)
        VALUES ('${fixtures.listId}', '${fixtures.userAId}', '${fixtures.listName}');
      INSERT INTO list_members (list_id, user_id)
        SELECT v.list_id, v.user_id
        FROM (VALUES
          ('${fixtures.listId}'::uuid, '${fixtures.userAId}'::uuid),
          ('${fixtures.listId}'::uuid, '${fixtures.userCId}'::uuid)
        ) AS v(list_id, user_id)
        WHERE NOT EXISTS (
          SELECT 1 FROM list_members m
          WHERE m.list_id = v.list_id AND m.user_id = v.user_id
        );
      INSERT INTO list_items (list_id, author_id, title)
        VALUES ('${fixtures.listId}', '${fixtures.userAId}', '${fixtures.listItem}');

      INSERT INTO weather_stations (id, name, latitude, longitude)
        VALUES ('${fixtures.stationId}', '${fixtures.stationName}', 47.6, -122.3);
      INSERT INTO weather_readings (id, station_id, temp_c, conditions)
        VALUES ('${fixtures.readingId}', '${fixtures.stationId}', 12.5, 'seeded');

      COMMIT;
    `
  );

  if (!seed.ok) {
    return {
      failure: {
        name: 'seeded the fixture rows',
        passed: false,
        notes: seed.message,
      },
    };
  }

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
  const hijacked = `todo-b-hijacked-${run}`;

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
    .update({ title: hijacked })
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
      '${created}', '${forged}', '${edited}', '${hijacked}'
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
      passed: present(f.todoB) && !present(hijacked),
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

const ESCALATION_CLAIMS = {
  admin: true,
  is_admin: true,
  role: 'admin',
  user_role: 'admin',
  roles: ['admin'],
  claims_admin: true,
};

// user_metadata is writable by the user it belongs to, so a policy that trusts
// a claim from it hands every user admin over everyone else's rows. Neither
// fixture user has metadata by default, which makes such a policy look correct.
export async function checkMetadataEscalation(
  f: Fixtures
): Promise<CheckResult> {
  const name =
    'a user cannot widen their own access by editing their user metadata';
  const update = await f.clientB.auth.updateUser({ data: ESCALATION_CLAIMS });
  if (update.error) {
    return { name, passed: false, notes: describeError(update.error) };
  }

  const refresh = await f.clientB.auth.refreshSession();
  const token = refresh.data.session?.access_token;
  const carried = token ? metadataOf(token) : undefined;
  if (refresh.error || carried?.admin !== true) {
    return {
      name,
      passed: false,
      notes: refresh.error
        ? `session refresh failed: ${describeError(refresh.error)}`
        : 'the self-assigned claims never reached the access token',
    };
  }

  const todos = await f.clientB.from('todos').select('title');
  const lists = await f.clientB.from('lists').select('name');
  const items = await f.clientB.from('list_items').select('title');
  const members = await f.clientB.from('list_members').select('*');

  const todoTitles = titlesOf(todos.data);
  // An empty result would otherwise look like a policy that blocked everything.
  const readWorked = !todos.error && todoTitles.includes(f.todoB);
  const leaked = [
    ...todoTitles
      .filter((title) => title !== f.todoB)
      .map((t) => `todos: ${t}`),
    ...namesOf(lists.data).map((n) => `lists: ${n}`),
    ...titlesOf(items.data).map((t) => `list_items: ${t}`),
    ...(members.data ?? []).map(() => 'list_members: a membership row'),
  ];

  return {
    name,
    passed: readWorked && leaked.length === 0,
    notes: readWorked
      ? leaked.length === 0
        ? undefined
        : `self-assigned admin exposed: ${leaked.join(', ')}`
      : todos.error
        ? describeError(todos.error)
        : "the probe could not re-read the user's own todo",
  };
}

function metadataOf(accessToken: string): Record<string, unknown> | undefined {
  const payload = accessToken.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return claims.user_metadata as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function checkSharedListAccess(
  ctx: LocalStackEvalContext,
  f: Fixtures
): Promise<CheckResult[]> {
  const run = randomUUID().slice(0, 8);
  const created = `item-created-${run}`;
  const createdEdit = `item-created-edit-${run}`;
  const memberEdited = `item-member-edited-${run}`;
  const hijacked = `outsider-hijacked-${run}`;

  // Member probes run as userC, who is on the list but neither its owner nor
  // the author of any item, so an owner-only or author-only policy set cannot
  // satisfy them.
  const memberLists = await f.clientC.from('lists').select('name');
  const memberItems = await f.clientC.from('list_items').select('title');
  const memberMembership = await f.clientC.from('list_members').select('*');
  const outsiderLists = await f.clientB.from('lists').select('name');
  const outsiderItems = await f.clientB.from('list_items').select('title');
  const anonLists = await f.anonClient.from('lists').select('name');
  const anonItems = await f.anonClient.from('list_items').select('title');
  const anonMembership = await f.anonClient.from('list_members').select('*');

  const memberInsert = await f.clientC.from('list_items').insert([
    { list_id: f.listId, author_id: f.userCId, title: created },
    { list_id: f.listId, author_id: f.userCId, title: createdEdit },
  ]);
  const memberUpdate = await f.clientC
    .from('list_items')
    .update({ title: memberEdited })
    .eq('title', createdEdit);

  const outsiderItemUpdate = await f.clientB
    .from('list_items')
    .update({ title: hijacked })
    .eq('title', f.listItem);
  const outsiderItemDelete = await f.clientB
    .from('list_items')
    .delete()
    .eq('title', f.listItem);
  const outsiderListUpdate = await f.clientB
    .from('lists')
    .update({ name: hijacked })
    .eq('id', f.listId);

  const { rows } = await ctx.query(stripIndent`
    SELECT title FROM list_items
    WHERE title IN (
      '${created}', '${createdEdit}', '${memberEdited}', '${f.listItem}',
      '${hijacked}'
    )
  `);
  const { rows: listRows } = await ctx.query(stripIndent`
    SELECT name FROM lists WHERE id = '${f.listId}'
  `);
  const itemTitles = rows.map((row) => String(row.title));
  const listIntact = listRows[0]?.name === f.listName;

  const recursive = [
    memberLists.error,
    memberItems.error,
    memberMembership.error,
    outsiderLists.error,
    outsiderItems.error,
    anonLists.error,
    anonItems.error,
    anonMembership.error,
    memberInsert.error,
    memberUpdate.error,
    outsiderItemUpdate.error,
    outsiderItemDelete.error,
    outsiderListUpdate.error,
  ].filter((error) => error?.code === RECURSION);

  return [
    {
      name: 'a member who does not own the list still reads it',
      passed:
        !memberLists.error && namesOf(memberLists.data).includes(f.listName),
      notes: memberLists.error
        ? describeError(memberLists.error)
        : `names: ${namesOf(memberLists.data).join(', ')}`,
    },
    {
      name: "a member who authored nothing still reads the list's items",
      passed:
        !memberItems.error && titlesOf(memberItems.data).includes(f.listItem),
      notes: memberItems.error
        ? describeError(memberItems.error)
        : `titles: ${titlesOf(memberItems.data).join(', ')}`,
    },
    {
      name: 'a member who does not own the list adds an item and the row lands',
      passed: !memberInsert.error && itemTitles.includes(created),
      notes: memberInsert.error
        ? describeError(memberInsert.error)
        : itemTitles.includes(created)
          ? undefined
          : 'insert reported success but no row was written',
    },
    {
      name: 'a member who does not own the list edits an item and the row changes',
      passed:
        !memberUpdate.error &&
        itemTitles.includes(memberEdited) &&
        !itemTitles.includes(createdEdit),
      notes: memberUpdate.error
        ? describeError(memberUpdate.error)
        : itemTitles.includes(memberEdited)
          ? undefined
          : 'update raised nothing but the row was never changed',
    },
    {
      name: 'a non-member cannot modify or delete a list item',
      passed: itemTitles.includes(f.listItem) && !itemTitles.includes(hijacked),
      notes: itemTitles.includes(f.listItem)
        ? undefined
        : "the outsider's write removed or renamed the seeded item",
    },
    {
      name: 'a non-member cannot rename the list',
      passed: listIntact,
      notes: listIntact ? undefined : `list is now: ${listRows[0]?.name}`,
    },
    {
      name: 'signed-out visitors cannot read the membership table',
      passed: anonMembership.error
        ? anonMembership.error.code === FORBIDDEN
        : (anonMembership.data?.length ?? 0) === 0,
      notes: anonMembership.error
        ? describeError(anonMembership.error)
        : `${anonMembership.data?.length ?? 0} rows`,
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
    {
      name: 'the weather feed fixture survived both write attempts',
      passed: !anonWrites.restoreError && !authedWrites.restoreError,
      notes:
        [anonWrites.restoreError, authedWrites.restoreError]
          .filter(Boolean)
          .join('; ') || undefined,
    },
  ];
}

type FeedWriteAttempt = {
  insertError: QueryError;
  rowSurvived: boolean;
  rowUnchanged: boolean;
  nothingInjected: boolean;
  restoreError: string;
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

  const restore = await execSql(
    ctx,
    stripIndent`
      BEGIN;

      DELETE FROM weather_readings WHERE conditions = '${marker}';

      UPDATE weather_readings
        SET temp_c = 12.5, conditions = 'seeded'
        WHERE id = '${f.readingId}';

      INSERT INTO weather_readings (id, station_id, temp_c, conditions)
        SELECT '${f.readingId}', '${f.stationId}', 12.5, 'seeded'
        WHERE NOT EXISTS (
          SELECT 1 FROM weather_readings WHERE id = '${f.readingId}'
        );

      COMMIT;
    `
  );

  return {
    insertError: insert.error,
    rowSurvived: Boolean(seeded),
    rowUnchanged: seeded?.conditions === 'seeded',
    nothingInjected: !rows.some((row) => row.conditions === marker),
    restoreError: restore.ok ? '' : restore.message,
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
): Promise<{ ok: boolean; message: string }> {
  const encoded = Buffer.from(sql, 'utf8').toString('base64');
  const result = await ctx.exec(
    stripIndent`
      DB_URL=$(supabase status -o json | node -e 'let input = ""; process.stdin.on("data", data => input += data); process.stdin.on("end", () => console.log(JSON.parse(input).DB_URL));')
      echo ${encoded} | base64 -d | psql "$DB_URL" -v ON_ERROR_STOP=1
    `
  );

  return {
    ok: result.ok,
    message: result.ok ? '' : result.stderr || result.stdout,
  };
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
