import type { LocalStackEvalContext } from '@supabase-evals/core';

const REDACTED = '[redacted]';
const MIN_SECRET_LENGTH = 8;

const KEY_SHAPE_SOURCES = [
  String.raw`eyJ[\w-]+\.[\w-]+\.[\w-]+`,
  String.raw`sb_secret_[\w-]+`,
  String.raw`sb_publishable_[\w-]+`,
  String.raw`sbp_[\w-]+`,
];

const KEY_SHAPES = new RegExp(KEY_SHAPE_SOURCES.join('|'), 'g');

// Transcripts carry tool output as JSON strings, so a newline is a literal `\n` and a quote may be `\"`.
const NOT_ESCAPED_NEWLINE = String.raw`(?!\\[nr])`;
const QUOTED = String.raw`\\?"[^"]*"|\\?'[^']*'`;
const ASSIGNMENT_VALUE = String.raw`${QUOTED}|(?:${NOT_ESCAPED_NEWLINE}[^\s'";&|])+`;
const LINE_VALUE = String.raw`${QUOTED}|(?:${NOT_ESCAPED_NEWLINE}[^\s'"])+`;

const SECRET_KEY = String.raw`[\w.-]*(?:pass|secret|token)[\w.-]*|[\w.-]*key`;

const POSTGRES_URL_PASSWORD = new RegExp(
  String.raw`(postgres(?:ql)?:\/\/[^\s:@/'"]+:)(?:${NOT_ESCAPED_NEWLINE}[^\s'"])+@`,
  'g'
);

const SECRET_ASSIGNMENT = new RegExp(
  String.raw`\b([A-Za-z][A-Za-z0-9_]*(?:password|secret|key)|password)=(${ASSIGNMENT_VALUE})`,
  'gi'
);

const JSON_SECRET = new RegExp(
  String.raw`(\\?"(?:[^"\\]*(?:pass|secret|token)[^"\\]*|[^"\\]*key)\\?"\s*:\s*\\?")(?:[^"\\]|\\[^"])*(\\?)"`,
  'gi'
);

const YAML_SECRET = new RegExp(
  String.raw`(?<=^"?|\\n)([ \t]*(?:-[ \t]+)?(?:${SECRET_KEY}):[ \t]+)(?:${LINE_VALUE})`,
  'gim'
);

const PASSWORD_FLAG = new RegExp(
  String.raw`(--(?:db-)?password(?:=|\s+))(?:${ASSIGNMENT_VALUE})`,
  'gi'
);

const SHORT_PASSWORD_FLAG = new RegExp(
  String.raw`(\s-p(?:=|\s+))(?:${ASSIGNMENT_VALUE})`,
  'g'
);

const SEGMENT_SEPARATOR = /(\|\||&&|[;|\n])/;
const SUPABASE_COMMAND = /(?:^|[\s'"(=])supabase(?=\s)/;

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function redactKnownSecrets(
  text: string,
  knownSecrets: readonly string[]
): string {
  const known = knownSecrets
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (known.length === 0) return text;
  return text.replace(
    new RegExp([...known, ...KEY_SHAPE_SOURCES].join('|'), 'g'),
    REDACTED
  );
}

/** `-p` is the Supabase CLI's password flag but psql's port, so it is only redacted after a standalone `supabase` word in the same command segment. */
function redactShortPasswordFlags(text: string): string {
  return text
    .split(SEGMENT_SEPARATOR)
    .map((part, index) => {
      const at = index % 2 === 0 ? part.search(SUPABASE_COMMAND) : -1;
      return at === -1
        ? part
        : part.slice(0, at) +
            part.slice(at).replace(SHORT_PASSWORD_FLAG, `$1${REDACTED}`);
    })
    .join('');
}

/** Replaces the known secret values, then Postgres URL passwords, JWTs, Supabase keys, secret-named assignments, flags, JSON keys and YAML lines with `[redacted]`, leaving refs, hosts and users readable. */
export function redactSecrets(
  text: string,
  knownSecrets: readonly string[] = []
): string {
  return redactShortPasswordFlags(
    redactKnownSecrets(text, knownSecrets)
      .replace(POSTGRES_URL_PASSWORD, `$1${REDACTED}@`)
      .replace(KEY_SHAPES, REDACTED)
      .replace(JSON_SECRET, `$1${REDACTED}$2"`)
      .replace(YAML_SECRET, `$1${REDACTED}`)
      .replace(SECRET_ASSIGNMENT, `$1=${REDACTED}`)
      .replace(PASSWORD_FLAG, `$1${REDACTED}`)
  );
}

/** Lists every key value the hosted project has, or none when there is no project or the lookup fails. */
export async function readProjectKeys(
  ctx: Pick<LocalStackEvalContext, 'hostedMgmt' | 'hostedRef'>
): Promise<string[]> {
  const { hostedMgmt, hostedRef } = ctx;
  if (!hostedMgmt || hostedRef === undefined) return [];
  try {
    const res = await hostedMgmt.GET('/v1/projects/{ref}/api-keys', {
      params: { path: { ref: hostedRef } },
    });
    if (res.error || !res.data) return [];
    return res.data.flatMap(({ api_key }) => (api_key ? [api_key] : []));
  } catch {
    return [];
  }
}
