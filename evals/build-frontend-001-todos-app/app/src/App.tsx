import { useState } from "react";

type Todo = {
  id: string;
  body: string;
  done: boolean;
};

export default function App() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newTodo, setNewTodo] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [error, setError] = useState("");

  async function handleSignIn(event: React.FormEvent) {
    event.preventDefault();
    setError("TODO: sign in with Supabase");
  }

  async function handleAddTodo(event: React.FormEvent) {
    event.preventDefault();
    setError("TODO: insert todo with Supabase");
  }

  async function handleToggleTodo(todo: Todo) {
    setError(`TODO: update ${todo.id} with Supabase`);
  }

  return (
    <main>
      <h1>Todos</h1>

      <form onSubmit={handleSignIn}>
        <input
          data-testid="email-input"
          placeholder="Email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <input
          data-testid="password-input"
          placeholder="Password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
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
          onChange={(event) => setNewTodo(event.target.value)}
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
