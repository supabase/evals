/**
 * Simulated prior-conversation context blocks.
 *
 * Each context represents a realistic Claude Code session in progress —
 * file reads, bash output, error messages, partial implementations —
 * the kind of noise that fills a context window before a user asks a
 * Supabase question mid-task.
 *
 * Injected as preceding messages in the API call so the model must
 * identify relevant references with a half-full, noisy context.
 */

export type ContextMessage = { role: 'user' | 'assistant'; content: string };
export type Context = {
  name: string;
  description: string;
  messages: ContextMessage[];
};

export const contexts: Context[] = [
  // ── 1. TypeScript refactor in progress ──────────────────────────────────────
  {
    name: 'ts-refactor',
    description: 'Mid-refactor of a React/TypeScript codebase',
    messages: [
      {
        role: 'user',
        content:
          'Refactor UserProfile to use the new useUser hook and remove the direct service calls.',
      },
      {
        role: 'assistant',
        content: `I'll refactor it. Reading the current file first.

\`\`\`typescript
// src/components/UserProfile.tsx (current)
import React, { useState, useEffect } from 'react';
import { UserService } from '../services/user';
import type { User } from '../types';

interface Props { userId: string; onUpdate?: (u: User) => void; }

export const UserProfile: React.FC<Props> = ({ userId, onUpdate }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    UserService.getById(userId)
      .then(setUser)
      .catch(() => setError('Failed to load'))
      .finally(() => setLoading(false));
  }, [userId]);

  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} />;
  return <div className="profile">{user?.name}</div>;
};
\`\`\`

Refactored to use \`useUser\`:

\`\`\`typescript
// src/components/UserProfile.tsx (refactored)
import React from 'react';
import { useUser } from '../hooks/useUser';

interface Props { userId: string; onUpdate?: (u: User) => void; }

export const UserProfile: React.FC<Props> = ({ userId }) => {
  const { user, loading, error } = useUser(userId);
  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error.message} />;
  return <div className="profile">{user?.name}</div>;
};
\`\`\``,
      },
      {
        role: 'user',
        content:
          "Getting TS errors: Property 'avatar_url' does not exist on type 'User'. Also 'created_at' is missing.",
      },
      {
        role: 'assistant',
        content: `The \`User\` type is out of sync with the DB schema. Update \`src/types/index.ts\`:

\`\`\`typescript
export type User = {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;   // was missing
  created_at: string;           // was missing
  updated_at: string;
};
\`\`\`

And the mock in tests:
\`\`\`typescript
const mockUser: User = {
  id: 'user-123',
  email: 'test@example.com',
  name: 'Test User',
  avatar_url: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};
\`\`\``,
      },
      {
        role: 'user',
        content:
          'Tests pass now. Can you also update the API route to validate the request body properly?',
      },
      {
        role: 'assistant',
        content: `Here's the updated route with Zod validation:

\`\`\`typescript
// src/app/api/users/[id]/route.ts
import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';

const UpdateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  avatar_url: z.string().url().nullable().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const parsed = UpdateUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  // update user in db...
}
\`\`\`

The validation rejects unknown fields and enforces types at the API boundary.`,
      },
    ],
  },

  // ── 2. Debugging a broken CI pipeline ────────────────────────────────────────
  {
    name: 'ci-debug',
    description: 'Debugging failing CI — test timeouts and env var issues',
    messages: [
      {
        role: 'user',
        content: `CI is failing on the integration tests. Here's the output:

\`\`\`
FAIL src/__tests__/integration/auth.test.ts
  ● AuthService › login › should return JWT on valid credentials

    Timeout - Async callback was not invoked within the 5000 ms timeout specified by jest.setTimeout.

      at node_modules/jest-jasmine2/build/jasmine/Env.js:275:51

  ● AuthService › login › should reject invalid password

    expect(received).rejects.toThrow()

    Received promise resolved instead of rejecting

FAIL src/__tests__/integration/users.test.ts (12.4 s)
  ● 3 tests failed
\`\`\``,
      },
      {
        role: 'assistant',
        content: `Two separate issues:

1. **Timeout** — the test is calling a real endpoint or waiting on a real DB. Check that \`TEST_DATABASE_URL\` points to a test DB and the connection isn't timing out:

\`\`\`bash
$ echo $TEST_DATABASE_URL
# should be: postgresql://localhost:5432/myapp_test
\`\`\`

2. **Invalid password not rejected** — looks like \`bcrypt.compare\` might be getting the wrong hash. Check:

\`\`\`typescript
// AuthService.login (likely culprit)
const valid = await bcrypt.compare(password, user.password_hash);
//                                            ^^^ ensure this is the hash, not plaintext
\`\`\`

Add a \`jest.setTimeout(15000)\` at the top of the integration test file while you investigate the DB connection speed.`,
      },
      {
        role: 'user',
        content:
          'TEST_DATABASE_URL was pointing to prod. Fixed. Now 47 tests pass but 3 still fail — all related to token expiry.',
      },
      {
        role: 'assistant',
        content: `Token expiry tests fail when system clock drift differs between where the token is signed and verified. Freeze time in tests:

\`\`\`typescript
import { jest } from '@jest/globals';

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2024-06-01T00:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

it('rejects expired token', async () => {
  const token = sign({ userId: '123' }, SECRET, { expiresIn: '1h' });
  jest.advanceTimersByTime(2 * 60 * 60 * 1000); // +2 hours
  await expect(verify(token)).rejects.toThrow('jwt expired');
});
\`\`\`

This makes expiry deterministic regardless of when the test runs.`,
      },
      {
        role: 'user',
        content:
          "All 50 tests passing now. Let's move on — I need to optimize some database stuff.",
      },
      { role: 'assistant', content: 'Sure, what are you working on?' },
    ],
  },

  // ── 3. Large file read + partial implementation ───────────────────────────────
  {
    name: 'file-read-noise',
    description:
      'Agent just read several large files and is mid-implementation',
    messages: [
      {
        role: 'user',
        content:
          'Read the main entry point and the config so you understand the project structure.',
      },
      {
        role: 'assistant',
        content: `Read \`src/index.ts\` (187 lines):

\`\`\`typescript
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/logger';
import { authRouter } from './routes/auth';
import { usersRouter } from './routes/users';
import { postsRouter } from './routes/posts';
import { commentsRouter } from './routes/comments';
import { db } from './db';
import { config } from './config';

const app = express();

app.use(helmet());
app.use(cors({ origin: config.allowedOrigins, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(requestLogger);
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/posts', postsRouter);
app.use('/api/comments', commentsRouter);
app.use(errorHandler);

const start = async () => {
  await db.connect();
  app.listen(config.port, () => {
    console.log(\`Server running on port \${config.port}\`);
  });
};

start().catch(console.error);
\`\`\`

Read \`src/config.ts\` (64 lines):

\`\`\`typescript
import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string(),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
  REDIS_URL: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const env = ConfigSchema.parse(process.env);

export const config = {
  env: env.NODE_ENV,
  port: env.PORT,
  db: { url: env.DATABASE_URL },
  jwt: { secret: env.JWT_SECRET, expiresIn: env.JWT_EXPIRES_IN },
  allowedOrigins: env.ALLOWED_ORIGINS.split(','),
  redis: env.REDIS_URL,
  logLevel: env.LOG_LEVEL,
};
\`\`\``,
      },
      {
        role: 'user',
        content:
          "Now read the posts router — I think there's an N+1 query in there.",
      },
      {
        role: 'assistant',
        content: `Read \`src/routes/posts.ts\` (143 lines). Found it — line 67:

\`\`\`typescript
// ❌ N+1: fetches author for every post individually
router.get('/', async (req, res) => {
  const posts = await db.query('SELECT * FROM posts ORDER BY created_at DESC LIMIT 20');
  const withAuthors = await Promise.all(
    posts.rows.map(async (post) => {
      const author = await db.query('SELECT id, name, avatar_url FROM users WHERE id = $1', [post.user_id]);
      return { ...post, author: author.rows[0] };
    })
  );
  res.json(withAuthors);
});
\`\`\`

For 20 posts that's 21 queries. Fix with a JOIN:

\`\`\`typescript
// ✅ Single query
router.get('/', async (req, res) => {
  const result = await db.query(\`
    SELECT p.*, u.id as author_id, u.name as author_name, u.avatar_url as author_avatar
    FROM posts p
    JOIN users u ON u.id = p.user_id
    ORDER BY p.created_at DESC
    LIMIT 20
  \`);
  res.json(result.rows.map(row => ({
    ...row,
    author: { id: row.author_id, name: row.author_name, avatar_url: row.author_avatar }
  })));
});
\`\`\``,
      },
      {
        role: 'user',
        content:
          'Good catch. Now I need your help with something in the database layer.',
      },
      { role: 'assistant', content: 'What do you need?' },
    ],
  },

  // ── 4. Mixed noise — Slack export, bash output, errors ───────────────────────
  {
    name: 'mixed-noise',
    description:
      'Scattered context: bash output, stack traces, unrelated discussion',
    messages: [
      {
        role: 'user',
        content: `Here's the output from the deploy:

\`\`\`
$ pnpm build
▶ Compiling TypeScript...
  src/utils/cache.ts(34,12): error TS2322: Type 'undefined' is not assignable to type 'string'
  src/utils/cache.ts(89,5): error TS2339: Property 'ttl' does not exist on type 'CacheOptions'

▶ Build failed (2 errors)
\`\`\``,
      },
      {
        role: 'assistant',
        content: `Two type errors in \`cache.ts\`. Fix:

\`\`\`typescript
// Line 34: add undefined to the return type or provide a fallback
function getCacheKey(prefix: string, id: string | undefined): string {
  return \`\${prefix}:\${id ?? 'global'}\`; // was: id (could be undefined)
}

// Line 89: add ttl to CacheOptions type
interface CacheOptions {
  ttl?: number;   // add this
  namespace?: string;
}
\`\`\``,
      },
      {
        role: 'user',
        content: `Build passes. But now there's a runtime error in prod:

\`\`\`
UnhandledPromiseRejection: Error: connect ECONNREFUSED 127.0.0.1:6379
    at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1141:16)
\`\`\``,
      },
      {
        role: 'assistant',
        content: `Redis is refusing connections — likely not running in the prod environment. Two options:

1. **Start Redis** or point \`REDIS_URL\` to your managed instance (Upstash, Redis Cloud, etc.)
2. **Make Redis optional** — fall back to in-memory if \`REDIS_URL\` is absent:

\`\`\`typescript
const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : null;

async function getCached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!redis) return fn(); // graceful fallback
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);
  const result = await fn();
  await redis.setex(key, 300, JSON.stringify(result));
  return result;
}
\`\`\``,
      },
      {
        role: 'user',
        content:
          'Perfect. Okay different topic — can you help me with the database schema?',
      },
      { role: 'assistant', content: 'Of course, what are you working on?' },
    ],
  },
];

/** Pick a random context, or a specific one by name */
export function pickContext(name?: string): Context {
  if (name) {
    const found = contexts.find((c) => c.name === name);
    if (!found)
      throw new Error(
        `Unknown context: "${name}". Available: ${contexts.map((c) => c.name).join(', ')}`
      );
    return found;
  }
  return contexts[Math.floor(Math.random() * contexts.length)];
}
