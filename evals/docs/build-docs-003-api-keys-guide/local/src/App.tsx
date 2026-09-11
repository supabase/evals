import { useState } from 'react';

// Two screens. The sign-up screen creates an account. The roster screen lists
// everyone who has signed up, with the email address they used.
//
// Neither screen talks to Supabase yet. The markup and the data-testid
// attributes below are what the rest of the team builds against, so keep them
// as they are and hook them up.

type View = 'signup' | 'roster';

type Member = {
  id: string;
  email: string;
  displayName: string;
};

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
    // TODO: create the account, then store the display name on the profile row.
    setStatus('not wired up yet');
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
    // TODO: load everyone who has signed up, with the email they signed up
    // with, and render one row each.
    //
    // The rest of the team is building against `GET /functions/v1/roster`
    // returning `{ members: [{ id, email, displayName }] }`, so put the lookup
    // there and have this screen read it.
    setMembers([]);
    setStatus('not wired up yet');
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
