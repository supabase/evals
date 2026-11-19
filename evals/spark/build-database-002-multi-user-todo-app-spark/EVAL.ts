import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
  ToolScoringContext,
} from '@supabase-evals/core';
import type { SparkScoringContext } from '../../../experiments/spark/lib/runtime.js';
import { checkNoRawSql } from '../../../experiments/spark/lib/scoring.js';

// Spark multi-user todo app: the prompt asks the agent to finish the app's todo
// layer (app/src/todos.mjs) against an empty Spark project, so the agent also
// creates the `todos` table and its security itself (DDL through the secret key
// and /system/v1/migrations, outside app/). It never names supabase-js or RLS —
// the "uses @supabase/supabase-js" check is GATING. The scorer measures:
//   - schema: a `todos` table exists. Spark cannot introspect RLS policies, so
//     RLS is judged by behavior: the isolation checks below plus a signed-out
//     client that must not be able to read the rows;
//   - per-user isolation: the module only ever holds the publishable key, so
//     the todos each user sees and can change are decided by whether requests
//     carry that user's session. The scorer signs two users in one after the
//     other and reads the database with the secret key to see what really
//     happened to every row;
//   - no session, no access: a fresh process that never signs in must not be
//     able to list, add, change or delete anything once todos exist;
//   - the database, not the app, enforces it: a scorer-owned client signed in
//     as one user must not read, change or delete another user's todo, and
//     neither that client nor a signed-out one may insert a todo owned by
//     someone else;
//   - partial updates: renaming, ticking and unticking each leave the other
//     field alone.
// The prompt fixes only the `title` and boolean `done` columns; the rest of the
// schema is the agent's choice, so ids, titles and owners are matched on values
// the driver controls, never on column names, while the done flag is read
// straight from `row.done`. Every check gates.

const APP_DIR = 'app';
const DRIVER = 'eval-driver.mjs';
const DRIVER_MARKER = '___EVAL_DRIVER___';

const A_TODOS = ['Buy milk', 'Walk the dog'] as const;
const B_TODO = 'Plan the trip';
const HIJACKED_TITLE = 'Hijacked';
const A_RENAMED = 'Buy oat milk';
const SNEAKY_TITLE = 'Sneaky';
const FORGED_TITLE = 'Forged';

// Runs inside the sandbox, one phase per process, exactly like the app would
// use the module. The scorer checks the database between phases:
//   a — user A signs up, signs in, adds two todos and lists them
//   b — user B signs up, signs in, lists, adds a todo, then tries to change
//       and delete A's todos
//   c — A signs in again, lists, edits one todo a field at a time (rename only,
//       tick only, untick only, tick again) and deletes the other
//   d — nobody signs in: list, add, and try to change and delete A's
//       remaining todo
const DRIVER_SOURCE = `
import {
  signUp,
  signIn,
  createTodo,
  listTodos,
  updateTodo,
  deleteTodo,
} from './src/todos.mjs';

const [phase, ...args] = process.argv.slice(2);
const out = {};
const step = async (name, fn) => {
  try {
    out[name] = await fn();
  } catch (error) {
    out[name] = {
      threw: String(error instanceof Error ? error.message : error),
    };
  }
};
// Ids arrive as 's:<text>' or 'n:<number>' so integer ids keep their type.
const parseId = (value) =>
  value.startsWith('n:') ? Number(value.slice(2)) : value.slice(2);

if (phase === 'a') {
  const [email, password, first, second] = args;
  await step('signUp', () => signUp(email, password));
  await step('signIn', () => signIn(email, password));
  await step('create1', () => createTodo(first));
  await step('create2', () => createTodo(second));
  await step('list', () => listTodos());
} else if (phase === 'b') {
  const [email, password, title, rawId1, rawId2, hijacked] = args;
  const id1 = parseId(rawId1);
  const id2 = parseId(rawId2);
  await step('signUp', () => signUp(email, password));
  await step('signIn', () => signIn(email, password));
  await step('listEmpty', () => listTodos());
  await step('create', () => createTodo(title));
  await step('updateOther', () => updateTodo(id1, { title: hijacked, done: true }));
  await step('deleteOther', () => deleteTodo(id2));
  await step('list', () => listTodos());
} else if (phase === 'c') {
  const [email, password, rawId1, rawId2, renamed] = args;
  const id1 = parseId(rawId1);
  const id2 = parseId(rawId2);
  await step('signIn', () => signIn(email, password));
  await step('list', () => listTodos());
  await step('rename', () => updateTodo(id1, { title: renamed }));
  await step('listRename', () => listTodos());
  await step('tick', () => updateTodo(id1, { done: true }));
  await step('listTick', () => listTodos());
  await step('untick', () => updateTodo(id1, { done: false }));
  await step('listUntick', () => listTodos());
  await step('update', () => updateTodo(id1, { done: true }));
  await step('delete', () => deleteTodo(id2));
  await step('listAfter', () => listTodos());
} else {
  const [rawId1, title] = args;
  const id1 = parseId(rawId1);
  await step('list', () => listTodos());
  await step('create', () => createTodo(title));
  await step('update', () => updateTodo(id1, { title, done: true }));
  await step('delete', () => deleteTodo(id1));
}
console.log('${DRIVER_MARKER}' + JSON.stringify(out));
process.exit(0);
`;

type Step = Record<string, unknown>;
type Phase = Record<string, Step | unknown[] | undefined>;

interface Todo {
  id: string;
  title: string;
  done: boolean;
}

/** A row of the agent's `todos` table; its columns are the agent's choice. */
type Row = Record<string, unknown>;

const scorer: ToolScorer = async (ctx) => {
  const checks: CheckResult[] = [];
  try {
    const { sandbox } = ctx;
    if (!sandbox)
      return fail(
        'agent sandbox available',
        'the scorer runs the todo module in the agent sandbox, but this run had none'
      );
    const { project } = ctx as unknown as SparkScoringContext;

    // Unique suffix keeps signup emails collision-free across attempts.
    const suffix = Date.now().toString(36);
    const emailA = `todo-a-${suffix}@example.com`;
    const emailB = `todo-b-${suffix}@example.com`;
    const password = 'correct-horse-battery';

    // Be generous about a missing install step; the eval is about the todo
    // layer, not npm. A no-op when the agent already installed dependencies.
    const install = await sandbox.exec(
      `cd ${APP_DIR} && npm install --no-audit --no-fund --silent`,
      { timeoutMs: 180_000 }
    );
    if (!install.ok) {
      return fail(
        'installed app dependencies',
        install.stderr.trim() || install.stdout.trim()
      );
    }

    const written = await writeDriver(sandbox);
    if (!written.ok) {
      return fail(
        'installed the eval driver',
        written.stderr.trim() || written.stdout.trim()
      );
    }

    // Client-side code: only the publishable key is handed to the app.
    const env = {
      SPARK_PROJECT_URL: project.projectUrl,
      SPARK_PUBLISHABLE_KEY: project.publishableKey,
    };
    const failures: string[] = [];
    const runPhase = async (name: string, args: string[]) => {
      const run = await sandbox.exec(
        `cd ${APP_DIR} && node ${DRIVER} ${name} ${args.map((a) => `"${a}"`).join(' ')}`,
        { timeoutMs: 60_000, env }
      );
      const out = parseDriverOutput(run.stdout);
      if (!out)
        failures.push(`phase ${name}: ${preview(run.stderr || run.stdout)}`);
      return out;
    };

    // Ground truth from the database (the SQL endpoint bypasses RLS).
    const dbUsers = async () => {
      const { rows } = await ctx.query(
        `select u.id::text as id, u.email as email
           from auth.users u
          where u.email in ('${emailA}', '${emailB}')`
      );
      return rows as { id: string; email: string }[];
    };
    // Every row of the agent's table, whatever its columns. The project is
    // fresh, so these are all ours. An empty list when the table is missing.
    const dbTodos = async (): Promise<Row[]> => {
      try {
        const { rows } = await ctx.query('select * from public.todos');
        return rows;
      } catch {
        return [];
      }
    };

    // Schema first: it does not change while the driver runs.
    checks.push(await tableCheck(ctx));

    const a = await runPhase('a', [emailA, password, ...A_TODOS]);
    const afterA = await dbTodos();
    const idA1 = idOf(a?.create1);
    const idA2 = idOf(a?.create2);
    const argA1 = encodeId(a?.create1);
    const argA2 = encodeId(a?.create2);

    const b = await runPhase('b', [
      emailB,
      password,
      B_TODO,
      argA1,
      argA2,
      HIJACKED_TITLE,
    ]);
    const afterB = await dbTodos();

    const c = await runPhase('c', [emailA, password, argA1, argA2, A_RENAMED]);
    const afterC = await dbTodos();

    // Nobody signs in for this one: a fresh process with no session at all.
    const d = await runPhase('d', [argA1, SNEAKY_TITLE]);
    const afterD = await dbTodos();
    const users = await dbUsers();

    checks.push({
      name: 'todo module loads and the driver completes',
      passed: !!a && !!b && !!c && !!d,
      notes:
        failures.length > 0
          ? `no driver output — ${failures.join('; ')}`
          : 'driver produced a result for every phase',
    });

    const userA = users.find((user) => user.email === emailA);
    const userB = users.find((user) => user.email === emailB);
    const ownedBy = (rows: Row[], user: { id: string } | undefined) =>
      user ? rows.filter((row) => has(row, user.id)) : [];

    // User A: two todos, owned by A, listed back in full.
    const created = [step(a, 'create1'), step(a, 'create2')];
    const listA = todosOf(a?.list);
    const ownedByA = ownedBy(afterA, userA);
    checks.push({
      name: 'user A can create and list their own todos',
      passed:
        !!userA &&
        ownedByA.length === A_TODOS.length &&
        created.every(
          (todo, i) =>
            todo.title === A_TODOS[i] &&
            isDone(todo.done) === false &&
            ownedByA.some((row) => matches(row, todo.id, todo.title))
        ) &&
        sameTodos(listA, ownedByA),
      notes: `created ${JSON.stringify(created)}, list ${JSON.stringify(a?.list)}, db rows ${JSON.stringify(ownedByA)}`,
    });

    // User B: starts empty, only ever sees their own todo, which is stored
    // under B's id.
    const listBEmpty = todosOf(b?.listEmpty);
    const listB = todosOf(b?.list);
    const ownedByB = ownedBy(afterB, userB);
    checks.push({
      name: "user B sees none of user A's todos, only their own",
      passed:
        listBEmpty?.length === 0 &&
        listB?.length === 1 &&
        listB[0]?.title === B_TODO &&
        ownedByB.length === 1 &&
        !!ownedByB[0] &&
        matches(ownedByB[0], listB[0]?.id, B_TODO),
      notes: `B's first list ${JSON.stringify(b?.listEmpty)}, later list ${JSON.stringify(b?.list)}, db rows ${JSON.stringify(ownedByB)}`,
    });

    // B tries to change A's todos; the database must be untouched, and the
    // module must report it rather than throw.
    const before1 = afterA.find((row) => has(row, idA1));
    const after1 = afterB.find((row) => has(row, idA1));
    checks.push({
      name: "user B cannot update user A's todo",
      passed:
        !!before1 &&
        !!after1 &&
        JSON.stringify(after1) === JSON.stringify(before1) &&
        !step(b, 'updateOther').threw,
      notes: `db row before ${JSON.stringify(before1)}, after ${JSON.stringify(after1)}, updateTodo returned ${JSON.stringify(b?.updateOther)}`,
    });

    checks.push({
      name: "user B cannot delete user A's todo",
      passed:
        afterA.some((row) => has(row, idA2)) &&
        afterB.some((row) => has(row, idA2)) &&
        !step(b, 'deleteOther').threw,
      notes: `db row still present: ${afterB.some((row) => has(row, idA2))}, deleteTodo returned ${JSON.stringify(b?.deleteOther)}`,
    });

    // A signs back in: exactly their own two todos, as they left them.
    const listAAgain = todosOf(c?.list);
    checks.push({
      name: 'user A signs back in to the same two todos, unchanged by B',
      passed:
        !!listAAgain &&
        sameTodos(listAAgain, ownedBy(afterA, userA)) &&
        listAAgain.length === A_TODOS.length,
      notes: `A's list after signing back in: ${JSON.stringify(c?.list)}`,
    });

    // Edits and deletes by the owner actually land in the database.
    const updated = afterC.find((row) => has(row, idA1));
    const relisted = todosOf(c?.listAfter)?.find((todo) => todo.id === idA1);
    checks.push({
      name: 'updateTodo changes the title and done flag in the database',
      passed:
        !!updated &&
        matches(updated, idA1, A_RENAMED) &&
        'done' in updated &&
        isDone(updated.done) &&
        relisted?.title === A_RENAMED &&
        relisted.done &&
        !step(c, 'update').threw,
      notes: `db row ${JSON.stringify(updated)}, list after ${JSON.stringify(c?.listAfter)}, updateTodo returned ${JSON.stringify(c?.update)}`,
    });

    // Fields left out of an update stay as they are, whichever one is given.
    const doneBefore = todosOf(c?.list)?.find((item) => item.id === idA1)?.done;
    const stages: [string, string, boolean | undefined][] = [
      ['listRename', A_RENAMED, doneBefore],
      ['listTick', A_RENAMED, true],
      ['listUntick', A_RENAMED, false],
    ];
    const staged = stages.map(([key, title, done]) => {
      const todo = todosOf(c?.[key])?.find((item) => item.id === idA1);
      return { key, ok: !!todo && todo.title === title && todo.done === done };
    });
    const partialUpdates = ['rename', 'tick', 'untick'].map((key) =>
      step(c, key)
    );
    checks.push({
      name: 'updateTodo changes only the fields it is given',
      passed:
        staged.every((stage) => stage.ok) &&
        partialUpdates.every((result) => !result.threw),
      notes: `rename only, tick only, untick only left: ${JSON.stringify(staged)}, updateTodo returned ${JSON.stringify(partialUpdates)}`,
    });

    checks.push({
      name: 'deleteTodo removes only that todo from the database',
      passed:
        !afterC.some((row) => has(row, idA2)) &&
        afterC.some((row) => has(row, idA1)) &&
        ownedBy(afterC, userB).length > 0 &&
        !step(c, 'delete').threw,
      notes: `db rows after ${JSON.stringify(afterC)}, deleteTodo returned ${JSON.stringify(c?.delete)}`,
    });

    // A fresh process that never signed in must get nothing and change
    // nothing: listing is an error or empty, the writes must not throw, and
    // the database must be exactly as phase c left it.
    const listD = d?.list;
    const writesD = [step(d, 'create'), step(d, 'update'), step(d, 'delete')];
    checks.push({
      name: 'a user who has not signed in cannot list, add, change or delete todos',
      passed:
        !!d &&
        (Array.isArray(listD)
          ? listD.length === 0
          : !!listD && !listD.threw && typeof listD.error === 'string') &&
        writesD.every((result) => !result.threw) &&
        JSON.stringify(afterD) === JSON.stringify(afterC),
      notes: `list ${JSON.stringify(listD ?? null)}, create/update/delete returned ${JSON.stringify(writesD)}, db rows before ${JSON.stringify(afterC)}, after ${JSON.stringify(afterD)}`,
    });

    // The database itself, not the app, must refuse a signed-out client.
    checks.push(await anonymousReadCheck(ctx, afterC.length));

    // …and so must it refuse a signed-in user going around the app: user B's
    // own client, not the module, tries to read, change and delete A's todo.
    checks.push(
      await crossUserCheck(ctx, emailB, password, async () => ({
        before: afterD.find((row) => has(row, idA1)),
        after: (await dbTodos()).find((row) => has(row, idA1)),
      }))
    );

    // …and neither may either client plant a todo under someone else's name.
    checks.push(
      await forgedInsertCheck(
        ctx,
        emailB,
        password,
        userA?.id,
        ownedBy(afterA, userA)[0],
        async () => (await dbTodos()).filter((row) => has(row, FORGED_TITLE))
      )
    );

    // Client-side code: RLS + the publishable key are enough; the secret /
    // service-role key must not appear anywhere in the app — by name or by
    // value. The literal key is matched with -F and never echoed in notes.
    const secretScan = await sandbox.exec(
      `{ grep -rlE --exclude-dir=node_modules 'sb_secret_|SERVICE_ROLE|SPARK_SECRET_KEY' ${APP_DIR}; ` +
        (project.secretKey
          ? `grep -rlF --exclude-dir=node_modules -e '${project.secretKey}' ${APP_DIR}; `
          : '') +
        '} | sort -u || true'
    );
    checks.push({
      name: 'app code does not use the secret / service-role key',
      passed: secretScan.stdout.trim() === '',
      notes:
        secretScan.stdout.trim().replace(/\s+/g, ', ') ||
        'no secret-key references found',
    });

    // GATING: the todo layer must be built on supabase-js, even though the
    // prompt never names it…
    checks.push(await sdkUsageCheck(sandbox));

    // …and must go through it, not psql, a raw Postgres driver or Spark's SQL
    // endpoint (which would bypass the per-user session entirely).
    checks.push(await checkNoRawSql(sandbox, APP_DIR));

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    checks.push({
      name: 'scorer completed without errors',
      passed: false,
      notes: msg,
    });
    return { passed: false, checks };
  }
};

export default scorer;

function writeDriver(sandbox: NonNullable<ToolEvalContext['sandbox']>) {
  const encoded = Buffer.from(DRIVER_SOURCE, 'utf-8').toString('base64');
  return sandbox.exec(`echo ${encoded} | base64 -d > ${APP_DIR}/${DRIVER}`);
}

function parseDriverOutput(stdout: string): Phase | undefined {
  const line = stdout
    .split('\n')
    .find((candidate) => candidate.includes(DRIVER_MARKER));
  if (!line) return undefined;
  try {
    return JSON.parse(
      line.slice(line.indexOf(DRIVER_MARKER) + DRIVER_MARKER.length)
    );
  } catch {
    return undefined;
  }
}

/** One driver step's result as an object (empty when it was never recorded or is a list). */
function step(phase: Phase | undefined, name: string): Step {
  const value = phase?.[name];
  return value && !Array.isArray(value) ? value : {};
}

/** The id a todo result carries: Spark schemas may use uuids or integers. */
const idOf = (value: unknown) => {
  const id = (value as Step | undefined)?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : '';
};

/** The id as a driver argument that keeps its type (see `parseId`). */
const encodeId = (value: unknown) => {
  const id = (value as Step | undefined)?.id;
  return typeof id === 'number' ? `n:${id}` : `s:${idOf(value)}`;
};

/** Spark may hand booleans back as true/false or 0/1. */
const isDone = (value: unknown) =>
  value === true || value === 1 || value === '1' || value === 't';

/** A list result as todos, or undefined when it was not a list of objects. */
function todosOf(value: unknown): Todo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => ({
    id: String(item?.id),
    title: String(item?.title),
    done: isDone(item?.done),
  }));
}

/** Some column of the row holds this value (ids, titles, user ids). */
const has = (row: Row, value: unknown) =>
  (typeof value === 'string' || typeof value === 'number') &&
  String(value) !== '' &&
  Object.values(row).some((cell) => String(cell) === String(value));

/** The row is the todo with this id and title, whatever the columns are called. */
const matches = (row: Row, id: unknown, title: unknown) =>
  has(row, id) && has(row, title);

/** Same todos (id, title and done flag), ignoring order. */
function sameTodos(list: Todo[] | undefined, rows: Row[]): boolean {
  if (!list || list.length !== rows.length) return false;
  return rows.every((row) =>
    list.some(
      (todo) =>
        matches(row, todo.id, todo.title) &&
        'done' in row &&
        isDone(row.done) === todo.done
    )
  );
}

/** The agent created a `todos` table (pragma_table_info, which Spark supports). */
async function tableCheck(ctx: ToolScoringContext): Promise<CheckResult> {
  let columns: string[] = [];
  try {
    const { rows } = await ctx.query(
      "select name from pragma_table_info('todos')"
    );
    columns = rows.map((row) => String(row.name));
  } catch {
    // Reported as a failed check below.
  }
  return {
    name: 'agent created a `todos` table in public',
    passed: columns.length > 0,
    notes:
      columns.length > 0
        ? `columns: ${columns.join(', ')}`
        : 'no todos table found',
  };
}

/**
 * Behavioral RLS check that needs no introspection: a client with only the
 * publishable key and no session (the anon role) must read no todos through the
 * Data API, an error counting as nothing, while the table holds rows.
 */
async function anonymousReadCheck(
  ctx: ToolScoringContext,
  rowCount: number
): Promise<CheckResult> {
  const name = 'a signed-out client cannot read todos through the Data API';
  if (rowCount === 0)
    return {
      name,
      passed: false,
      notes: 'the todos table holds no rows to protect, so nothing was tested',
    };
  const { data, error } = await ctx.getClient().from('todos').select('*');
  const visible = Array.isArray(data) ? data.length : 0;
  return {
    name,
    passed: visible === 0,
    notes: error
      ? `request refused: ${error.message}`
      : `${visible} of ${rowCount} rows visible without a session`,
  };
}

/**
 * RLS must hold for signed-in users too, whatever the app does: a scorer-owned
 * client signed in as user B reads, renames and deletes user A's remaining todo
 * (found by its title, a column the prompt fixes) straight through the Data API.
 * A's row must stay invisible to B and unchanged in the database.
 */
async function crossUserCheck(
  ctx: ToolScoringContext,
  email: string,
  password: string,
  rowAfterAttack: () => Promise<{ before?: Row; after?: Row }>
): Promise<CheckResult> {
  const name =
    "a signed-in user cannot read, change or delete another user's todo through the Data API";
  const client = ctx.getClient();
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError)
    return {
      name,
      passed: false,
      notes: `could not sign user B in directly: ${signInError.message}`,
    };
  const { data } = await client.from('todos').select('*');
  const seen = (Array.isArray(data) ? (data as Row[]) : []).filter((row) =>
    has(row, A_RENAMED)
  );
  await client
    .from('todos')
    .update({ title: HIJACKED_TITLE })
    .eq('title', A_RENAMED);
  await client.from('todos').delete().eq('title', A_RENAMED);
  const { before, after } = await rowAfterAttack();
  return {
    name,
    passed:
      seen.length === 0 &&
      !!before &&
      !!after &&
      JSON.stringify(after) === JSON.stringify(before),
    notes: `B read ${seen.length} of A's rows directly, db row before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`,
  };
}

/**
 * RLS must also guard inserts: a signed-out client and a client signed in as
 * user B each try to add a todo owned by user A. The prompt leaves the schema
 * to the agent, so the attempt is a copy of one of A's own rows (so any other
 * required column is filled in) minus its id, with the title and done flag
 * fixed and the owner column, found as the one holding A's id, set to A.
 * Neither row may land in the database.
 */
async function forgedInsertCheck(
  ctx: ToolScoringContext,
  email: string,
  password: string,
  ownerId: string | undefined,
  template: Row | undefined,
  forgedRows: () => Promise<Row[]>
): Promise<CheckResult> {
  const name =
    'a client cannot insert a todo owned by another user through the Data API';
  const ownerColumn = Object.keys(template ?? {}).find(
    (column) => String(template?.[column]) === ownerId
  );
  if (!template || !ownerId || !ownerColumn)
    return {
      name,
      passed: false,
      notes: "could not tell which column holds a todo's owner",
    };
  const id = idOfRow(template);
  const forged = {
    ...Object.fromEntries(
      Object.entries(template).filter(
        ([column, value]) => column !== 'id' && String(value) !== id
      )
    ),
    title: FORGED_TITLE,
    done: false,
    [ownerColumn]: ownerId,
  };
  await ctx.getClient().from('todos').insert(forged);
  const signedOut = (await forgedRows()).length;
  const client = ctx.getClient();
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError)
    return {
      name,
      passed: false,
      notes: `could not sign user B in directly: ${signInError.message}`,
    };
  await client.from('todos').insert(forged);
  const landed = await forgedRows();
  return {
    name,
    passed: landed.length === 0,
    notes: `forged rows after a signed-out insert: ${signedOut}, after user B's insert: ${landed.length} (owner column \`${ownerColumn}\`)`,
  };
}

/**
 * GATING: some app code file must genuinely import @supabase/supabase-js —
 * the specifier must be closed by a matching quote (so `-not-real` doesn't
 * match) and sit on a `from`/`require(`/`import(` line that isn't commented
 * out. Multi-line named imports still match: the closing `} from '…'` line
 * always carries `from` alongside the specifier.
 */
async function sdkUsageCheck(
  sandbox: NonNullable<ToolEvalContext['sandbox']>
): Promise<CheckResult> {
  const NAME = 'implementation uses @supabase/supabase-js';
  const scan = await sandbox.exec(
    `grep -rnE --exclude-dir=node_modules --include='*.mjs' --include='*.js' --include='*.cjs' --include='*.ts' ` +
      `"(from|require\\(|import\\()\\s*['\\"](npm:)?@supabase/supabase-js['\\"]" ${APP_DIR} ` +
      `| grep -vE ':[0-9]+:\\s*(//|\\*)' || true`
  );
  const files = [
    ...new Set(
      scan.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.slice(0, line.indexOf(':')))
    ),
  ];
  return {
    name: NAME,
    passed: files.length > 0,
    notes:
      files.length > 0
        ? `imports found in: ${files.join(', ')}`
        : 'no @supabase/supabase-js import found — this eval requires the SDK',
  };
}

/** The row's id: its `id` column, else empty. */
const idOfRow = (row: Row) => String(row.id ?? '');

function preview(body: string): string {
  return body.replace(/\s+/g, ' ').slice(0, 160);
}

function fail(
  name: string,
  notes: string
): { passed: false; checks: CheckResult[] } {
  return { passed: false, checks: [{ name, passed: false, notes }] };
}
