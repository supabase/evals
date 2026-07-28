import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { resolvePackageBin, viteBuild, vitestRun } from './project-runner.js';
import { ROOT } from './scorer-test-kit.js';

const FRONTEND_EVAL = 'evals/build-frontend-001-todos-app';

const GOOD_FRONTEND_APP = `
import { useState } from "react";
import { createClient } from "@supabase/supabase-js";

type Todo = { id: string; body: string; done: boolean };

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

export default function App() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newTodo, setNewTodo] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [error, setError] = useState("");

  async function loadTodos() {
    const { data, error } = await supabase.from("todos").select("id,body,done").order("created_at", { ascending: true });
    if (error) throw error;
    setTodos(data ?? []);
  }

  async function handleSignIn(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { setError(error.message); return; }
    setSignedIn(true);
    await loadTodos();
  }

  async function handleAddTodo(event: React.FormEvent) {
    event.preventDefault();
    const body = newTodo.trim();
    if (!body) return;
    setError("");
    const { data, error } = await supabase.from("todos").insert({ body }).select("id,body,done").single();
    if (error) { setError(error.message); return; }
    setTodos((current) => [...current, data]);
    setNewTodo("");
  }

  async function handleToggleTodo(todo: Todo) {
    setError("");
    const { data, error } = await supabase.from("todos").update({ done: !todo.done }).eq("id", todo.id).select("id,body,done").single();
    if (error) { setError(error.message); return; }
    setTodos((current) => current.map((item) => (item.id === todo.id ? data : item)));
  }

  return (
    <main>
      <h1>Todos</h1>
      <form onSubmit={handleSignIn}>
        <input data-testid="email-input" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input data-testid="password-input" placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button data-testid="sign-in-button" type="submit">Sign in</button>
      </form>
      {signedIn ? <p data-testid="signed-in">Signed in</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <form onSubmit={handleAddTodo}>
        <input data-testid="todo-input" placeholder="New todo" value={newTodo} onChange={(e) => setNewTodo(e.target.value)} />
        <button data-testid="add-button" type="submit">Add</button>
      </form>
      <ul data-testid="todo-list">
        {todos.map((todo) => (
          <li key={todo.id}>
            <label>
              <input data-testid={\`todo-checkbox-\${todo.body}\`} type="checkbox" checked={todo.done} onChange={() => void handleToggleTodo(todo)} />
              {todo.body}
            </label>
          </li>
        ))}
      </ul>
    </main>
  );
}
`;

// Regression guard for AI-975: pnpm's isolated layout has no hoisted
// `<repo>/node_modules/<pkg>`, so a repo-root path missed every time and the
// bin never even launched.
test.each([
  ['vite', 'bin/vite.js'],
  ['vitest', 'vitest.mjs'],
])('resolves the %s binary that actually exists on disk', (pkg, entry) => {
  const resolved = resolvePackageBin(pkg, entry);

  expect(existsSync(resolved), `${pkg} bin missing at ${resolved}`).toBe(true);
});

// AI-975, second layer: the workspace's own `vite.config.ts` imports `vite`,
// and vite compiles that config into `<repo>/node_modules/.vite-temp/`, so
// resolution anchors at the repo root. The scored workspace lives under
// `results/` and can only walk up to the repo root too. That is the documented
// contract (README, and the `copyToHost` doc comment: score with repo-root
// vite/vitest so the toolchain need not exist in the sandbox), so the root
// manifest owns the frontend toolchain. This fixture copies `local/` with no
// `node_modules`, exactly as that contract assumes.
test('builds and tests a known-good frontend workspace', async () => {
  const workspace = join(
    ROOT,
    'results',
    '_smoke',
    'build-frontend-001-todos-app'
  );
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(dirname(workspace), { recursive: true });
  cpSync(join(ROOT, FRONTEND_EVAL, 'local'), workspace, {
    recursive: true,
    filter: (src) => !src.endsWith('/EVAL.ts'),
  });
  cpSync(join(ROOT, FRONTEND_EVAL, 'tests'), join(workspace, 'tests'), {
    recursive: true,
  });
  writeFileSync(
    join(workspace, '.env.local'),
    [
      'VITE_SUPABASE_URL=http://supabase-evals.local',
      'VITE_SUPABASE_ANON_KEY=supabase-evals-anon-key',
      '',
    ].join('\n')
  );
  writeFileSync(join(workspace, 'src', 'App.tsx'), GOOD_FRONTEND_APP);

  const build = await viteBuild(workspace);
  expect(build.ok, build.stderr || build.stdout).toBe(true);

  const vitest = await vitestRun(workspace);
  expect(vitest.ok, vitest.stderr || vitest.stdout).toBe(true);
});
