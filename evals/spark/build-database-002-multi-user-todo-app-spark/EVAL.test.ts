import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  failedChecks,
  sparkScorer,
  stubSandbox,
} from '../../../experiments/spark/lib/runtime-stub.js';
import scorer from './EVAL.js';

interface TodosModule {
  /** The import line; defaults to a real supabase-js import. */
  sdkImport?: string;
  /** Ignore the signed-in user when listing (also lists to nobody signed in). */
  leakyList?: boolean;
  /** Ignore the signed-in user when updating and deleting. */
  leakyWrites?: boolean;
  /** Give todos integer ids instead of uuids. */
  integerIds?: boolean;
  /** Report done after an update without persisting it in the stored row. */
  doneNotStored?: boolean;
  /** Remember the last signed-in user on disk, so a fresh process is still signed in. */
  stickySession?: boolean;
  /** Overwrite the fields an update leaves out with defaults. */
  clobberOmitted?: boolean;
  /** Always store done as true, whatever the update says. */
  alwaysDone?: boolean;
}

/**
 * A todo module that uses the SDK client (the stub) and stands in for the
 * backend itself: users and todos live in `app/.db.json`, so they survive
 * between the driver's phases (separate processes) and the stubbed SQL endpoint
 * can read them back. Per-user isolation is done here, by remembering who signed
 * in. It exits early without the project URL and publishable key, or when it is
 * handed a secret key, so a passing run also proves the scorer sets exactly
 * those.
 */
const todosModule = (options: TodosModule = {}) => `// Todo layer
${options.sdkImport ?? "import { createClient } from '@supabase/supabase-js';"}
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
if (!process.env.SPARK_PROJECT_URL || !process.env.SPARK_PUBLISHABLE_KEY) process.exit(2);
if (process.env['SPARK_SECRET' + '_KEY']) process.exit(3);
const FILE = new URL('../.db.json', import.meta.url);
const load = () =>
  existsSync(FILE)
    ? JSON.parse(readFileSync(FILE, 'utf8'))
    : { users: [], todos: [], seq: 0 };
const save = (db) => writeFileSync(FILE, JSON.stringify(db));
const uuid = (prefix, n) => prefix + '-0000-4000-8000-' + String(n).padStart(12, '0');
const view = (todo) => ({ id: todo.id, title: todo.title, done: todo.done || !!todo.shadowDone });
const notSignedIn = { error: 'not signed in' };
const SESSION = new URL('../.session.json', import.meta.url);
let me = ${Boolean(options.stickySession)} && existsSync(SESSION)
  ? JSON.parse(readFileSync(SESSION, 'utf8'))
  : undefined;

export async function signUp(email, password) {
  const db = load();
  if (db.users.some((u) => u.email === email)) return { error: 'User already registered' };
  const user = { id: uuid('00000000', db.users.length + 1), email, password };
  db.users.push(user);
  save(db);
  return { userId: user.id };
}
export async function signIn(email, password) {
  const user = load().users.find((u) => u.email === email);
  if (!user || user.password !== password) {
    return { error: 'Invalid login credentials' };
  }
  me = user;
  if (${Boolean(options.stickySession)}) writeFileSync(SESSION, JSON.stringify(user));
  return { userId: user.id };
}
export async function createTodo(title) {
  if (!me) return notSignedIn;
  const db = load();
  const todo = { id: ${options.integerIds ? '++db.seq' : "uuid('10000000', ++db.seq)"}, user_id: me.id, title, done: false };
  db.todos.push(todo);
  save(db);
  return view(todo);
}
export async function listTodos() {
  if (!me && !${Boolean(options.leakyList)}) return notSignedIn;
  return load().todos
    .filter((t) => ${options.leakyList ? 'true' : 'me && t.user_id === me.id'})
    .map(view);
}
const owned = (db, id) =>
  db.todos.find((t) => t.id === id && (${options.leakyWrites ? 'true' : 'me && t.user_id === me.id'}));
export async function updateTodo(id, { title, done } = {}) {
  if (!me) return notSignedIn;
  const db = load();
  const todo = owned(db, id);
  if (!todo) return { error: 'todo not found' };
  if (title !== undefined || ${Boolean(options.clobberOmitted)}) todo.title = title ?? 'untitled';
  if (${Boolean(options.alwaysDone)}) todo.done = true;
  else if (done !== undefined || ${Boolean(options.clobberOmitted)}) todo.${options.doneNotStored ? 'shadowDone' : 'done'} = done ?? false;
  save(db);
  return view(todo);
}
export async function deleteTodo(id) {
  if (!me) return notSignedIn;
  const db = load();
  const todo = owned(db, id);
  if (!todo) return { error: 'todo not found' };
  db.todos = db.todos.filter((t) => t !== todo);
  save(db);
  return { id };
}
`;

async function score(
  options: {
    module?: string;
    /** Whether the agent created the `todos` table. */
    table?: boolean;
    /** Whether the database enforces RLS against signed-out clients. */
    rls?: boolean;
    /** Whether the stored table lacks the `done` column. */
    noDoneColumn?: boolean;
    /** Whether the policies let any signed-in user read and change every row. */
    authenticatedLeak?: boolean;
    /** Whether the policies let anyone insert a todo owned by anybody. */
    insertLeak?: boolean;
  } = {}
) {
  const sandbox = stubSandbox({
    'app/src/todos.mjs': options.module ?? todosModule(),
  });
  // The SQL endpoint answers the scorer's ground-truth queries from the module's
  // own store: the todos (every column, as `select *`), the users, and the
  // `todos` table's columns. The signed-out Data API read sees the rows only
  // when RLS is not protecting them.
  const db = () => {
    const file = join(sandbox.workspace ?? '', 'app/.db.json');
    return existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf8'))
      : { users: [], todos: [], seq: 0 };
  };
  const storedTodos = () =>
    db().todos.map(({ done: _done, ...row }: Record<string, unknown>) =>
      options.noDoneColumn ? row : { ...row, done: _done }
    );
  return failedChecks(
    await sparkScorer(
      scorer,
      (url, init) => {
        // Direct sign-in by the scorer: the token names the user.
        if (url.pathname === '/auth/v1/token') {
          const { email } = JSON.parse(String(init?.body));
          return Response.json({
            access_token: `user:${email}`,
            token_type: 'bearer',
            expires_in: 3600,
            refresh_token: 'refresh',
            user: { id: email, email },
          });
        }
        if (url.pathname === '/rest/v1/todos') {
          const auth = new Headers(init?.headers).get('authorization') ?? '';
          const email = auth.startsWith('Bearer user:')
            ? auth.slice('Bearer user:'.length)
            : undefined;
          const user = db().users.find(
            (u: { email: string }) => u.email === email
          );
          const visible = (todo: { user_id: string }) =>
            options.authenticatedLeak || todo.user_id === user?.id;
          const method = init?.method ?? 'GET';
          if (method === 'GET')
            return Response.json(
              user
                ? db().todos.filter(visible)
                : options.rls === false
                  ? db().todos
                  : []
            );
          if (method === 'POST') {
            const rows = [JSON.parse(String(init?.body))].flat();
            if (
              !options.insertLeak &&
              !rows.every((row) => row.user_id === user?.id)
            )
              return Response.json(
                { message: 'violates row-level security' },
                { status: 403 }
              );
            const store = db();
            for (const row of rows)
              store.todos.push({ id: 900 + store.todos.length, ...row });
            writeFileSync(
              join(sandbox.workspace ?? '', 'app/.db.json'),
              JSON.stringify(store)
            );
            return new Response(null, { status: 201 });
          }
          // PATCH / DELETE filtered by `title=eq.<title>`, on the rows the caller can see.
          const title = url.searchParams.get('title')?.replace(/^eq\./, '');
          const file = join(sandbox.workspace ?? '', 'app/.db.json');
          const store = db();
          const hit = (todo: { user_id: string; title: string }) =>
            !!user && visible(todo) && todo.title === title;
          if (method === 'PATCH')
            store.todos = store.todos.map((todo: { title: string }) =>
              hit(todo as never)
                ? { ...todo, ...JSON.parse(String(init?.body)) }
                : todo
            );
          else if (method === 'DELETE')
            store.todos = store.todos.filter((todo: never) => !hit(todo));
          writeFileSync(file, JSON.stringify(store));
          return new Response(null, { status: 204 });
        }
        if (url.pathname !== '/database/query') return Response.json([]);
        const { query } = JSON.parse(String(init?.body));
        if (String(query).includes('pragma_table_info'))
          return Response.json(
            options.table === false
              ? []
              : ['id', 'user_id', 'title', 'done']
                  .filter((name) => !(options.noDoneColumn && name === 'done'))
                  .map((name) => ({ name }))
          );
        return Response.json(
          String(query).includes('public.todos') ? storedTodos() : db().users
        );
      },
      { sandbox }
    )
  );
}

const NOT_SIGNED_IN_CHECK =
  'a user who has not signed in cannot list, add, change or delete todos';
const ISOLATION_CHECKS = [
  "user B sees none of user A's todos, only their own",
  "user B cannot update user A's todo",
  "user B cannot delete user A's todo",
  'user A signs back in to the same two todos, unchanged by B',
  NOT_SIGNED_IN_CHECK,
];
const ANON_CHECK = 'a signed-out client cannot read todos through the Data API';
const CROSS_USER_CHECK =
  "a signed-in user cannot read, change or delete another user's todo through the Data API";
const PARTIAL_UPDATE_CHECK = 'updateTodo changes only the fields it is given';
const INSERT_CHECK =
  'a client cannot insert a todo owned by another user through the Data API';
const SDK_CHECK = 'implementation uses @supabase/supabase-js';

describe('multi-user todo app scorer', () => {
  it('passes every check for an SDK todo module that isolates users', async () => {
    expect(await score()).toEqual([]);
  });

  it('passes for a schema with integer ids', async () => {
    expect(await score({ module: todosModule({ integerIds: true }) })).toEqual(
      []
    );
  });

  it('fails the isolation checks when users share one list', async () => {
    expect(
      await score({
        module: todosModule({ leakyList: true, leakyWrites: true }),
      })
    ).toEqual(ISOLATION_CHECKS);
  });

  it('fails the not-signed-in check when a fresh process is still signed in as the last user', async () => {
    expect(
      await score({ module: todosModule({ stickySession: true }) })
    ).toEqual([NOT_SIGNED_IN_CHECK, CROSS_USER_CHECK]); // the sneaky writes removed A's todo, so nothing is left to protect
  });

  it('fails the update check when done is reported but not stored in the database', async () => {
    expect(
      await score({ module: todosModule({ doneNotStored: true }) })
    ).toEqual(['updateTodo changes the title and done flag in the database']);
  });

  it('fails every check comparing rows with listed todos when the stored table has no done column', async () => {
    expect(await score({ noDoneColumn: true })).toEqual([
      'user A can create and list their own todos',
      'user A signs back in to the same two todos, unchanged by B',
      'updateTodo changes the title and done flag in the database',
    ]);
  });

  it('fails the signed-out read check and isolation when the agent forgot RLS and the app leaks', async () => {
    expect(
      await score({
        rls: false,
        module: todosModule({ leakyList: true, leakyWrites: true }),
      })
    ).toEqual([...ISOLATION_CHECKS, ANON_CHECK]);
  });

  it('fails only the signed-out read check when the database still serves rows', async () => {
    expect(await score({ rls: false })).toEqual([ANON_CHECK]);
  });

  it("fails only the direct cross-user check when policies let signed-in users touch each other's rows", async () => {
    expect(await score({ authenticatedLeak: true })).toEqual([
      CROSS_USER_CHECK,
    ]);
  });

  it('fails only the insert check when policies let a client insert rows for someone else', async () => {
    expect(await score({ insertLeak: true })).toEqual([INSERT_CHECK]);
  });

  it('fails the partial update check when an update overwrites the fields it leaves out', async () => {
    expect(
      await score({ module: todosModule({ clobberOmitted: true }) })
    ).toContain(PARTIAL_UPDATE_CHECK);
  });

  it('fails the partial update check when done is always stored as true', async () => {
    expect(await score({ module: todosModule({ alwaysDone: true }) })).toEqual([
      PARTIAL_UPDATE_CHECK,
    ]);
  });

  it('requires a real @supabase/supabase-js import', async () => {
    for (const sdkImport of [
      `const client = {};`,
      `// import { createClient } from '@supabase/supabase-js';`,
    ])
      expect(await score({ module: todosModule({ sdkImport }) })).toEqual([
        SDK_CHECK,
      ]);
  });

  it('fails the first check when the module does not load', async () => {
    const failed = await score({
      module: `import { createClient } from '@supabase/supabase-js';\nthrow new Error('TODO: implement todos');\n`,
    });
    expect(failed).toContain('todo module loads and the driver completes');
    expect(failed).not.toContain(SDK_CHECK);
  });
});
