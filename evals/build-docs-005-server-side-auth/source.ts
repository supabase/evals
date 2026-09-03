import { extname } from 'node:path';
import type { CheckResult } from '@supabase-evals/core';

import { readText, walk } from './files.js';

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.js',
  '.jsx',
  '.mjs',
]);

const VERIFYING_CALL = /\.\s*auth\s*\.\s*(getClaims|getUser)\s*\(/;
const STORED_SESSION_CALL = /\.\s*auth\s*\.\s*getSession\s*\(/;
const SERVER_CLIENT_CALL = /createServerClient\s*\(/;
const DEPRECATED_HELPERS = /@supabase\/auth-helpers-nextjs/;

const COOKIE_ADAPTER = /cookies\s*:\s*\{/;
const DEPRECATED_COOKIE_METHOD = /(^|[^\w.])(get|set|remove)\s*\(\s*name\b/;

export type Sources = { file: string; text: string }[];

export function loadSources(root: string): Sources {
  return walk(root, root)
    .filter((path) => SOURCE_EXTENSIONS.has(extname(path)))
    .map((path) => ({
      file: path.slice(root.length + 1),
      text: readText(path),
    }))
    .filter((entry) => !entry.file.startsWith('.next/'));
}

function serverFiles(sources: Sources): Sources {
  return sources.filter((entry) => SERVER_CLIENT_CALL.test(entry.text));
}

export function sourceChecks(sources: Sources): CheckResult[] {
  const server = serverFiles(sources);
  const verifying = sources.filter((entry) => VERIFYING_CALL.test(entry.text));
  const storedOnly = sources.filter(
    (entry) =>
      STORED_SESSION_CALL.test(entry.text) && !VERIFYING_CALL.test(entry.text)
  );

  const adapters = server.filter((entry) => COOKIE_ADAPTER.test(entry.text));
  const deprecatedAdapters = adapters.filter((entry) =>
    DEPRECATED_COOKIE_METHOD.test(entry.text)
  );
  const helpers = sources.filter((entry) =>
    DEPRECATED_HELPERS.test(entry.text)
  );

  return [
    {
      name: 'server code verifies the token rather than trusting stored session state',
      passed: verifying.length > 0,
      notes: verifying.length
        ? `verifying call in ${verifying.map((entry) => entry.file).join(', ')}`
        : storedOnly.length
          ? `only getSession() found, in ${storedOnly.map((entry) => entry.file).join(', ')}`
          : 'no getClaims() or getUser() call in source',
    },
    {
      name: 'the cookie adapter implements only getAll and setAll',
      passed: adapters.length > 0 && deprecatedAdapters.length === 0,
      notes: adapters.length
        ? deprecatedAdapters.length
          ? `single-cookie methods in ${deprecatedAdapters.map((entry) => entry.file).join(', ')}`
          : `adapters in ${adapters.map((entry) => entry.file).join(', ')}`
        : server.length
          ? `createServerClient in ${server.map((entry) => entry.file).join(', ')} passes no cookie adapter`
          : 'no createServerClient call in source',
    },
    {
      name: 'no deprecated auth-helpers import',
      passed: helpers.length === 0,
      notes: helpers.length
        ? `imported in ${helpers.map((entry) => entry.file).join(', ')}`
        : 'no @supabase/auth-helpers-nextjs import',
    },
  ];
}
