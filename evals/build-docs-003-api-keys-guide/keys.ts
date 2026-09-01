import type { LocalStackStatus } from '@supabase-evals/core';

const SECRET_KEY_PREFIX = /sb_secret_[A-Za-z0-9_-]+/;
const JWT = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

export function findSecrets(text: string, status: LocalStackStatus): string[] {
  const hits: string[] = [];

  if (SECRET_KEY_PREFIX.test(text)) hits.push('sb_secret_ key');
  if (status.secretKey && text.includes(status.secretKey)) {
    hits.push("the stack's secret key");
  }

  for (const token of text.match(JWT) ?? []) {
    if (roleOf(token) === 'service_role') {
      hits.push('a service_role JWT');
      break;
    }
  }

  return [...new Set(hits)];
}

function roleOf(jwt: string): string | undefined {
  try {
    const payload = jwt.split('.')[1];
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const role = (JSON.parse(json) as { role?: unknown }).role;
    return typeof role === 'string' ? role : undefined;
  } catch {
    return undefined;
  }
}
