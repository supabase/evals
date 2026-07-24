import '@testing-library/jest-dom/vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import App from '../src/App';

declare global {
  // eslint-disable-next-line no-var
  var __SUPABASE_EVALS_CLIENT__: any;
}

afterEach(() => {
  cleanup();
});

describe('authenticated todos frontend', () => {
  it('signs in, creates a todo, and marks it done', async () => {
    const client = globalThis.__SUPABASE_EVALS_CLIENT__;
    await client.auth.signUp({
      email: 'frontend-a@example.com',
      password: 'secret123',
    });

    render(<App />);

    fireEvent.change(screen.getByTestId('email-input'), {
      target: { value: 'frontend-a@example.com' },
    });
    fireEvent.change(screen.getByTestId('password-input'), {
      target: { value: 'secret123' },
    });
    fireEvent.click(screen.getByTestId('sign-in-button'));

    await waitFor(() =>
      expect(screen.getByTestId('signed-in')).toBeInTheDocument()
    );

    fireEvent.change(screen.getByTestId('todo-input'), {
      target: { value: 'Ship project evals' },
    });
    fireEvent.click(screen.getByTestId('add-button'));

    await waitFor(() =>
      expect(screen.getByText('Ship project evals')).toBeInTheDocument()
    );

    const checkbox = screen.getByTestId('todo-checkbox-Ship project evals');
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(
        screen.getByTestId('todo-checkbox-Ship project evals')
      ).toBeChecked()
    );

    const { data } = await client
      .from('todos')
      .select('body,done')
      .eq('body', 'Ship project evals');
    expect(data).toEqual([{ body: 'Ship project evals', done: true }]);
  });

  it("does not show another user's todos", async () => {
    const client = globalThis.__SUPABASE_EVALS_CLIENT__;
    const { data: userA } = await client.auth.signUp({
      email: 'frontend-owner@example.com',
      password: 'secret123',
    });
    await client
      .from('todos')
      .insert({ user_id: userA.user.id, body: 'Owner private todo' });
    await client.auth.signUp({
      email: 'frontend-b@example.com',
      password: 'secret123',
    });

    render(<App />);

    fireEvent.change(screen.getByTestId('email-input'), {
      target: { value: 'frontend-b@example.com' },
    });
    fireEvent.change(screen.getByTestId('password-input'), {
      target: { value: 'secret123' },
    });
    fireEvent.click(screen.getByTestId('sign-in-button'));

    await waitFor(() =>
      expect(screen.getByTestId('signed-in')).toBeInTheDocument()
    );
    expect(screen.queryByText('Owner private todo')).not.toBeInTheDocument();
  });
});
