// Todo layer for the app. The rest of the app calls these functions; wire them
// up to our Spark project (the one provided to you). Connection settings come
// from the environment: SPARK_PROJECT_URL and SPARK_PUBLISHABLE_KEY.
//
// This module is used from client-side code, so it must only ever hold the
// publishable (client) key.
//
// Each todo is `{ id, title, done }`. Failures (bad input, nobody signed in, a
// todo that is missing or belongs to someone else) resolve to
// `{ error: string }`; none of these functions should throw for them.

// Create an account. Resolves to `{ userId }`.
export async function signUp(email, password) {
  throw new Error('TODO: implement signUp');
}

// Sign in and remember the session. Resolves to `{ userId }`.
export async function signIn(email, password) {
  throw new Error('TODO: implement signIn');
}

// Add a todo (not done) to the signed-in user's list. Resolves to the todo.
export async function createTodo(title) {
  throw new Error('TODO: implement createTodo');
}

// The signed-in user's todos, oldest first, as an array.
export async function listTodos() {
  throw new Error('TODO: implement listTodos');
}

// Change the title and/or done flag of one of the user's todos; fields left
// out stay as they are. Resolves to the updated todo.
export async function updateTodo(id, { title, done } = {}) {
  throw new Error('TODO: implement updateTodo');
}

// Delete one of the user's todos. Resolves to `{ id }`.
export async function deleteTodo(id) {
  throw new Error('TODO: implement deleteTodo');
}
