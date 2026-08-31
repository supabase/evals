import { join, relative } from 'node:path';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

import { readText, walk } from './files.js';

/**
 * The slots the Edge Function runtime fills with a legacy key. Reading one is
 * how a legacy credential ends up authenticating the server even when nothing
 * was written down in the repo.
 */
const LEGACY_KEY_VARS = ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY'];

export type ServerChecks = {
  noLegacyKeyVar: CheckResult;
};

/**
 * Static, and named for that. It proves the server source references no legacy
 * key variable, which is the only observable difference between the two key
 * formats: both map to the same Postgres role, so no probe can tell them apart
 * once the request has arrived.
 */
export function checkServer(ctx: LocalStackEvalContext): ServerChecks {
  const name = 'server reads no legacy key variable';
  const root = ctx.hostWorkspace;
  const functionsRoot = join(root, 'supabase', 'functions');
  const files = walk(functionsRoot, functionsRoot);

  if (files.length === 0) {
    return {
      noLegacyKeyVar: {
        name,
        passed: false,
        notes:
          'no server code under supabase/functions, so nothing proves the claim',
      },
    };
  }

  const offenders: string[] = [];
  for (const file of files) {
    const text = readText(file);
    const hits = LEGACY_KEY_VARS.filter((variable) => text.includes(variable));
    if (hits.length) {
      offenders.push(`${relative(root, file)}: ${hits.join(', ')}`);
    }
  }

  return {
    noLegacyKeyVar: {
      name,
      passed: offenders.length === 0,
      notes: offenders.length ? offenders.join('; ') : undefined,
    },
  };
}
