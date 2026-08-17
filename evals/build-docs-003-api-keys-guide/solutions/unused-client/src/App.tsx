import { useState } from 'react';

import { supabase } from './supabase';

// The flaw: the publishable key reaches the bundle but the sign-up form never
// calls Supabase, so the client is present and unused.

type View = 'signup' | 'roster';

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
    // The client is real and the key ships, but the form never creates the
    // account. Referenced here so the module is not tree-shaken away.
    await supabase.auth.getSession();
    // The flaw: the client exists and the publishable key ships, but nothing
    // ever calls signUp. The form collects details and drops them.
    setStatus('thanks, we will be in touch');
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
  return (
    <section data-testid="roster-view">
      <h1>Roster</h1>
      <p data-testid="roster-status">not wired up yet</p>
    </section>
  );
}
