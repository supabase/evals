import { randomUUID } from 'node:crypto';
import type {
  CheckResult,
  LocalStackEvalContext,
  SupabaseClient,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const PASSWORD = 'secret123';
const ROLE = 'moderator';

const STANDARD_CLAIMS = new Set([
  'iss',
  'sub',
  'aud',
  'exp',
  'iat',
  'jti',
  'nbf',
  'email',
  'phone',
  'role',
  'aal',
  'amr',
  'session_id',
  'is_anonymous',
]);

export type Probes = {
  memberClient: SupabaseClient;
  strangerClient: SupabaseClient;
  moderatorClient: SupabaseClient;
  memberId: string;
  strangerId: string;
  moderatorId: string;
  memberToken: string;
  moderatorToken: string;
  memberOwnPost: string;
  strangerPost: string;
  moderatorTargetPost: string;
  marker: string;
};

export type Setup = { probes: Probes } | { failure: string };

export async function setupProbes(ctx: LocalStackEvalContext): Promise<Setup> {
  const run = randomUUID().slice(0, 8);
  const marker = `fernwood-${run}`;

  const memberClient = await ctx.getClient();
  const strangerClient = await ctx.getClient();
  const signUpClient = await ctx.getClient();

  const member = await signUp(memberClient, `member-${run}`);
  const stranger = await signUp(strangerClient, `stranger-${run}`);
  const moderator = await signUp(signUpClient, `moderator-${run}`);
  for (const outcome of [member, stranger, moderator]) {
    if ('failure' in outcome) return outcome;
  }
  const memberUser = member as SignedUp;
  const strangerUser = stranger as SignedUp;
  const moderatorUser = moderator as SignedUp;

  const granted = await execSql(
    ctx,
    `INSERT INTO member_roles (member_id, role) VALUES ('${moderatorUser.id}', '${ROLE}') ON CONFLICT DO NOTHING;`
  );
  if (!granted.ok) {
    return { failure: `could not record the moderator: ${granted.message}` };
  }

  const roleRows = await ctx.query(
    `SELECT count(*)::int AS count FROM member_roles WHERE member_id = '${moderatorUser.id}';`
  );
  if (Number(roleRows.rows[0]?.count ?? 0) === 0) {
    return {
      failure: `member_roles has no ${ROLE} row for ${moderatorUser.id}`,
    };
  }

  const moderatorClient = await ctx.getClient();
  const { data: reauth, error: reauthError } =
    await moderatorClient.auth.signInWithPassword({
      email: moderatorUser.email,
      password: PASSWORD,
    });
  if (reauthError || !reauth.session) {
    return {
      failure: `the moderator could not sign in again: ${reauthError?.message ?? 'no session'}`,
    };
  }

  const memberSession = await memberClient.auth.getSession();
  const memberToken = memberSession.data.session?.access_token;
  if (!memberToken) {
    return { failure: 'the member has no access token' };
  }

  const posts = await seedPosts(ctx, {
    member: memberUser.id,
    stranger: strangerUser.id,
    marker,
  });
  if ('failure' in posts) return posts;

  return {
    probes: {
      memberClient,
      strangerClient,
      moderatorClient,
      memberId: memberUser.id,
      strangerId: strangerUser.id,
      moderatorId: moderatorUser.id,
      memberToken,
      moderatorToken: reauth.session.access_token,
      marker,
      ...posts.ids,
    },
  };
}

export function checkRoleReachesTheToken(probes: Probes): CheckResult {
  const moderator = findRole(decode(probes.moderatorToken));
  const member = findRole(decode(probes.memberToken));

  return {
    name: "the moderator's role travels in their token and a member's does not",
    passed: moderator !== undefined && member === undefined,
    notes:
      moderator === undefined
        ? `no claim in the moderator's token carries "${ROLE}"`
        : member === undefined
          ? `the moderator's token carries it at ${moderator}`
          : `both tokens carry it, the member's at ${member}`,
  };
}

export async function checkMemberDeletesOwnPost(
  ctx: LocalStackEvalContext,
  probes: Probes
): Promise<CheckResult> {
  const { error } = await probes.memberClient
    .from('posts')
    .delete()
    .eq('id', probes.memberOwnPost);
  const gone = await postIsGone(ctx, probes.memberOwnPost);

  return {
    name: 'a member can delete their own post',
    passed: gone,
    notes: gone ? undefined : (error?.message ?? 'the post is still there'),
  };
}

export async function checkMemberCannotDeleteAnothersPost(
  ctx: LocalStackEvalContext,
  probes: Probes
): Promise<CheckResult> {
  const { error } = await probes.memberClient
    .from('posts')
    .delete()
    .eq('id', probes.strangerPost);
  const gone = await postIsGone(ctx, probes.strangerPost);

  return {
    name: "a member cannot delete another member's post",
    passed: !gone,
    notes: gone
      ? 'a member deleted a post they did not write'
      : (error?.message ?? 'the post is still there'),
  };
}

export async function checkModeratorDeletesAnyPost(
  ctx: LocalStackEvalContext,
  probes: Probes
): Promise<CheckResult> {
  const { error } = await probes.moderatorClient
    .from('posts')
    .delete()
    .eq('id', probes.moderatorTargetPost);
  const gone = await postIsGone(ctx, probes.moderatorTargetPost);

  return {
    name: "a moderator can delete another member's post",
    passed: gone,
    notes: gone ? undefined : (error?.message ?? 'the post is still there'),
  };
}

export async function checkMemberCannotSelfPromote(
  ctx: LocalStackEvalContext,
  probes: Probes
): Promise<CheckResult> {
  await probes.memberClient
    .from('member_roles')
    .insert({ member_id: probes.memberId, role: ROLE });
  const { rows } = await ctx.query(
    `SELECT count(*)::int AS count FROM member_roles WHERE member_id = '${probes.memberId}';`
  );
  const promoted = Number(rows[0]?.count ?? 0) > 0;

  return {
    name: 'a member cannot make themselves a moderator',
    passed: !promoted,
    notes: promoted
      ? 'a member wrote their own row into member_roles'
      : 'member_roles rejected the write',
  };
}

type SignedUp = { client: SupabaseClient; id: string; email: string };

async function signUp(
  client: SupabaseClient,
  tag: string
): Promise<SignedUp | { failure: string }> {
  const email = `${tag}@example.com`;
  const { data, error } = await client.auth.signUp({
    email,
    password: PASSWORD,
  });
  if (error || !data.user?.id || !data.session) {
    return {
      failure: `${tag} could not sign up: ${error?.message ?? 'no session'}`,
    };
  }
  return { client, id: data.user.id, email };
}

async function seedPosts(
  ctx: LocalStackEvalContext,
  authors: { member: string; stranger: string; marker: string }
): Promise<
  | {
      ids: {
        memberOwnPost: string;
        strangerPost: string;
        moderatorTargetPost: string;
      };
    }
  | { failure: string }
> {
  const insert = await execSql(
    ctx,
    stripIndent`
      INSERT INTO posts (author_id, body) VALUES
        ('${authors.member}', '${authors.marker}-own'),
        ('${authors.stranger}', '${authors.marker}-stranger'),
        ('${authors.stranger}', '${authors.marker}-target')
      RETURNING id;
    `,
    { quiet: true }
  );
  const ids = insert.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line));

  if (ids.length !== 3) {
    return {
      failure: `seeded ${ids.length} posts instead of 3: ${insert.message}`,
    };
  }
  return {
    ids: {
      memberOwnPost: ids[0],
      strangerPost: ids[1],
      moderatorTargetPost: ids[2],
    },
  };
}

async function postIsGone(
  ctx: LocalStackEvalContext,
  id: string
): Promise<boolean> {
  const { rows } = await ctx.query(
    `SELECT count(*)::int AS count FROM posts WHERE id = ${id};`
  );
  return Number(rows[0]?.count ?? 0) === 0;
}

function decode(token: string): Record<string, unknown> {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function findRole(
  claims: Record<string, unknown>,
  path: string[] = []
): string | undefined {
  for (const [key, value] of Object.entries(claims)) {
    if (path.length === 0 && STANDARD_CLAIMS.has(key)) continue;
    const here = [...path, key];
    if (typeof value === 'string') {
      if (value.toLowerCase() === ROLE) return here.join('.');
      continue;
    }
    if (Array.isArray(value)) {
      if (value.some((item) => String(item).toLowerCase() === ROLE)) {
        return here.join('.');
      }
      continue;
    }
    if (value && typeof value === 'object') {
      const nested = findRole(value as Record<string, unknown>, here);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function execSql(
  ctx: LocalStackEvalContext,
  sql: string,
  options: { quiet?: boolean } = {}
): Promise<{ ok: boolean; stdout: string; message: string }> {
  const encoded = Buffer.from(sql, 'utf8').toString('base64');
  const flags = options.quiet ? '-q -A -t' : '-q';
  const result = await ctx.exec(
    stripIndent`
      DB_URL=$(supabase status -o json 2>/dev/null | node -e 'let input = ""; process.stdin.on("data", data => input += data); process.stdin.on("end", () => console.log(JSON.parse(input).DB_URL));')
      echo ${encoded} | base64 -d | psql "$DB_URL" ${flags} -v ON_ERROR_STOP=1
    `,
    { timeoutMs: 120_000 }
  );
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout ?? '',
    message: firstError(result),
  };
}

function firstError(result: { stdout?: string; stderr?: string }): string {
  const lines = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const named = lines.find((line) =>
    /^(ERROR|FATAL|DETAIL|HINT)\b/i.test(line)
  );
  return (named ?? lines[0] ?? 'no output').slice(0, 300);
}
