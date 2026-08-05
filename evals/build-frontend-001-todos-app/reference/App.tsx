/**
 * Reference solution for this eval, used by the harness's own test to prove
 * `viteBuild` + `vitestRun` can build and pass a known-good workspace. It is
 * NOT part of `local/` (that is the agent's starting point, and shipping this
 * would hand over the answer) and it is never copied into a sandbox.
 *
 * It must keep satisfying the withheld tests in `../tests/`, which drive it by
 * `data-testid`.
 */
import { useState } from 'react';
import { createClient } from '@supabase/supabase-js';

type Todo = { id: string; body: string; done: boolean };

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

export default function App() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newTodo, setNewTodo] = useState('');
  const [signedIn, setSignedIn] = useState(false);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [error, setError] = useState('');

  async function loadTodos() {
    const { data, error } = await supabase
      .from('todos')
      .select('id,body,done')
      .order('created_at', { ascending: true });
    if (error) throw error;
    setTodos(data ?? []);
  }

  async function handleSignIn(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      setError(error.message);
      return;
    }
    setSignedIn(true);
    await loadTodos();
  }

  async function handleAddTodo(event: React.FormEvent) {
    event.preventDefault();
    const body = newTodo.trim();
    if (!body) return;
    setError('');
    const { data, error } = await supabase
      .from('todos')
      .insert({ body })
      .select('id,body,done')
      .single();
    if (error) {
      setError(error.message);
      return;
    }
    setTodos((current) => [...current, data]);
    setNewTodo('');
  }

  async function handleToggleTodo(todo: Todo) {
    setError('');
    const { data, error } = await supabase
      .from('todos')
      .update({ done: !todo.done })
      .eq('id', todo.id)
      .select('id,body,done')
      .single();
    if (error) {
      setError(error.message);
      return;
    }
    setTodos((current) =>
      current.map((item) => (item.id === todo.id ? data : item))
    );
  }

  return (
    <main>
      <h1>Todos</h1>
      <form onSubmit={handleSignIn}>
        <input
          data-testid="email-input"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          data-testid="password-input"
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button data-testid="sign-in-button" type="submit">
          Sign in
        </button>
      </form>
      {signedIn ? <p data-testid="signed-in">Signed in</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <form onSubmit={handleAddTodo}>
        <input
          data-testid="todo-input"
          placeholder="New todo"
          value={newTodo}
          onChange={(e) => setNewTodo(e.target.value)}
        />
        <button data-testid="add-button" type="submit">
          Add
        </button>
      </form>
      <ul data-testid="todo-list">
        {todos.map((todo) => (
          <li key={todo.id}>
            <label>
              <input
                data-testid={`todo-checkbox-${todo.body}`}
                type="checkbox"
                checked={todo.done}
                onChange={() => void handleToggleTodo(todo)}
              />
              {todo.body}
            </label>
          </li>
        ))}
      </ul>
    </main>
  );
}
