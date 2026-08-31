import { join, relative } from 'node:path';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

import { readText, walk } from './files.js';

const LEGACY_KEY_VARS = ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY'];

export type ServerChecks = {
  noLegacyKeyVar: CheckResult;
};

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
