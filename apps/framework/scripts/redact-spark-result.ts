import { readFileSync, writeFileSync } from 'node:fs';

const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const SESSION_TOKEN =
  /\\*["'](?:access_token|refresh_token|id_token)\\*["']\s*:\s*\\*["']([\w.~+/%=-]+)\\*["']/g;

function sessionTokens(value: unknown): string[] {
  if (typeof value === 'string') {
    return [...value.matchAll(JWT)]
      .map((match) => match[0])
      .concat([...value.matchAll(SESSION_TOKEN)].map((match) => match[1]));
  }
  if (Array.isArray(value)) return value.flatMap(sessionTokens);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [
      ...(['access_token', 'refresh_token', 'id_token'].includes(key) &&
      typeof item === 'string'
        ? [item]
        : []),
      ...sessionTokens(key),
      ...sessionTokens(item),
    ]);
  }
  return [];
}

function encodedSecret(secret: string): string {
  return encodeURIComponent(secret).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) {
      text = text
        .replaceAll(secret, '[REDACTED]')
        .replaceAll(encodedSecret(secret), '[REDACTED]');
    }
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        String(redact(key, secrets)),
        redact(item, secrets),
      ])
    );
  }
  return value;
}

export function sanitizeResult(
  value: unknown,
  configuredSecrets: readonly string[]
): string {
  const secrets = [...new Set([...configuredSecrets, ...sessionTokens(value)])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const payload = JSON.stringify(redact(value, secrets));
  if (
    secrets.some(
      (secret) =>
        payload.includes(secret) || payload.includes(encodedSecret(secret))
    )
  ) {
    throw new Error('Result still contains a private value');
  }
  return payload;
}

if (import.meta.main) {
  try {
    const secrets = [
      '/tmp/spark-warp-secrets.json',
      '/tmp/spark-redactions.json',
    ].flatMap((path) => {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (
        !Array.isArray(value) ||
        !value.every((item): item is string => typeof item === 'string')
      )
        throw new Error('Invalid Spark redactions');
      return value;
    });
    const path = process.argv[2];
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, sanitizeResult(value, secrets));
  } catch (error) {
    writeFileSync(
      '/tmp/spark-redaction-error.log',
      error instanceof Error
        ? (error.stack ?? error.message)
        : 'Redaction failed',
      { mode: 0o600 }
    );
    console.error(
      'Spark result redaction failed. Inspect private Sandbox logs.'
    );
    process.exitCode = 1;
  }
}
