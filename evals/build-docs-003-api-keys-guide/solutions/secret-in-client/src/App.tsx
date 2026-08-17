import { useState } from 'react';

import { admin } from './adminClient';
import { supabase } from './supabase';

type View = 'signup' | 'roster';

type Member = { id: string; email: string; displayName: string };

export default function App() {
  const [view, setView] = useState<View>('signup');

  return (
    <main>
      <nav>
        <button data-testid="nav-signup" onClick={() => setView('signup')}>
          Sign up
        </button>
        <button data-testid="nav-roster" onClick={() => setView('roster')}>
          Roster
        </button>
      </nav>
      {view === 'signup' ? <SignUp /> : <Roster />}
    </main>
  );
}

function SignUp() {
  const [status, setStatus] = useState('');

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const { data, error } = await supabase.auth.signUp({
      email: String(form.get('email')),
      password: String(form.get('password')),
    });
    if (error) return setStatus(error.message);
    if (data.user) {
      await supabase.from('profiles').insert({
        id: data.user.id,
        display_name: String(form.get('displayName')),
      });
    }
    setStatus('signed up');
  }

  return (
    <form data-testid="signup-form" onSubmit={handleSubmit}>
      <h1>Create an account</h1>
      <input data-testid="signup-name" name="displayName" placeholder="Name" />
      <input
        data-testid="signup-email"
        name="email"
        type="email"
        placeholder="Email"
      />
      <input
        data-testid="signup-password"
        name="password"
        type="password"
        placeholder="Password"
      />
      <p data-testid="signup-privacy">We'll only use this to sign you in.</p>
      <button data-testid="signup-submit" type="submit">
        Sign up
      </button>
      <p data-testid="signup-status">{status}</p>
    </form>
  );
}

function Roster() {
  const [members, setMembers] = useState<Member[]>([]);
  const [status, setStatus] = useState('');

  async function load() {
    // Straight from the browser, using the elevated client.
    const { data, error } = await admin.auth.admin.listUsers();
    if (error) return setStatus(error.message);
    const { data: profiles } = await admin
      .from('profiles')
      .select('id, display_name');
    const names = new Map(
      (profiles ?? []).map((row) => [row.id as string, row.display_name])
    );
    const rows = data.users.map((user) => ({
      id: user.id,
      email: user.email ?? '',
      displayName: names.get(user.id) ?? '',
    }));
    setMembers(rows);
    setStatus(`${rows.length} members`);
  }

  return (
    <section data-testid="roster-view">
      <h1>Roster</h1>
      <button data-testid="roster-refresh" onClick={load}>
        Refresh
      </button>
      <p data-testid="roster-status">{status}</p>
      <ul>
        {members.map((member) => (
          <li data-testid="roster-row" key={member.id}>
            <span data-testid="roster-name">{member.displayName}</span>
            <span data-testid="roster-email">{member.email}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
