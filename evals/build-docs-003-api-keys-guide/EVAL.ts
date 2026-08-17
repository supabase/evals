import type { CheckResult, LocalStackScorer } from '@supabase-evals/core';

import {
  checkEmailsHiddenFromClients,
  checkRoster,
  setupFixtures,
} from './access.js';
import { checkBundle } from './bundle.js';
import { readStatus } from './status.js';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const status = await readStatus(ctx);

    // Build and scan first. The probes sign users up, and nothing they write
    // should be in scope when the bundle is read.
    const bundle = await checkBundle(ctx, status);

    const setup = await setupFixtures(ctx);
    const access: CheckResult[] =
      'failure' in setup
        ? [setup.failure]
        : [
            await checkRoster(status, setup.fixtures),
            await checkEmailsHiddenFromClients(ctx, setup.fixtures),
          ];

    const checks: CheckResult[] = [...bundle, ...access];

    return {
      passed: checks.every((check) => check.passed),
      checks,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated API key placement',
          passed: false,
          notes: message,
        },
      ],
    };
  }
};

export default scorer;
