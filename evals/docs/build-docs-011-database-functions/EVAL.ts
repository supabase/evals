import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

import {
  checkDefinerPinsSearchPath,
  checkDesignAccountsForCaller,
  checkFunctionExists,
  loadFunctions,
  pickArgumentName,
} from './catalog.js';
import {
  checkAnonCannotGetATotal,
  checkCustomerCannotGetAnothersTotal,
  checkCustomerGetsOwnTotal,
  type Probes,
  setupProbes,
} from './probes.js';

const GUIDE_PATH = 'guides/database/functions';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const functions = await loadFunctions(ctx);
    const setup = await setupProbes(ctx, pickArgumentName(functions));
    const probes = 'probes' in setup ? setup.probes : undefined;
    const blocked = 'failure' in setup ? setup.failure : undefined;

    const checks: CheckResult[] = [
      checkFunctionExists(functions),
      checkDefinerPinsSearchPath(functions),
      checkDesignAccountsForCaller(functions),
      await gated(
        probes,
        blocked,
        'a customer gets the right total for their own order',
        checkCustomerGetsOwnTotal
      ),
      await gated(
        probes,
        blocked,
        "a customer cannot get another customer's total",
        checkCustomerCannotGetAnothersTotal
      ),
      await gated(
        probes,
        blocked,
        'a signed-out visitor cannot get an order total',
        checkAnonCannotGetATotal
      ),
      checkGuideWasRead(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated who can run the order total',
          passed: false,
          notes: message,
        },
      ],
    };
  }
};

export default scorer;

async function gated(
  probes: Probes | undefined,
  blocked: string | undefined,
  name: string,
  probe: (probes: Probes) => Promise<CheckResult>
): Promise<CheckResult> {
  if (!probes) {
    return { name, passed: false, notes: `not run: ${blocked ?? 'no probes'}` };
  }
  return probe(probes);
}

function checkGuideWasRead(ctx: LocalStackEvalContext): CheckResult {
  const calls = buildDocsResult(ctx.toolCalls).calls.filter((call) =>
    call.pages?.some((page) => page.url.includes(GUIDE_PATH))
  );
  const withContent = calls.filter((call) => call.hasContent);
  return {
    name: 'the agent read the Database Functions guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
