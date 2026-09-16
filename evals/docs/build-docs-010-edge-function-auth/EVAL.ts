import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

import {
  checkCustomerCannotAskForAnother,
  checkCustomerDoesNotGetOthers,
  checkCustomerGetsOwnOrders,
  checkEndpointIsServed,
  checkSignedOutCallerGetsNothing,
  type Probes,
  setupProbes,
} from './probes.js';
import { checkStackIsRunning, readStackState } from './stack.js';

const GUIDE_PATH = 'guides/functions/auth';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const stack = await readStackState(ctx);
    const setup = stack.running
      ? await setupProbes(ctx, stack)
      : { failure: 'the agent left the local stack down' };
    const probes = 'probes' in setup ? setup.probes : undefined;
    const blocked = 'failure' in setup ? setup.failure : undefined;

    const checks: CheckResult[] = [
      checkStackIsRunning(stack),
      await gated(
        probes,
        blocked,
        'the order-history endpoint answers',
        checkEndpointIsServed
      ),
      await gated(
        probes,
        blocked,
        'a signed-in customer gets their own orders back',
        checkCustomerGetsOwnOrders
      ),
      await gated(
        probes,
        blocked,
        "a signed-in customer does not get another customer's orders",
        checkCustomerDoesNotGetOthers
      ),
      await gated(
        probes,
        blocked,
        "a customer asking for another customer's orders still gets only their own",
        checkCustomerCannotAskForAnother
      ),
      await gated(
        probes,
        blocked,
        'a caller with no session gets no orders',
        checkSignedOutCallerGetsNothing
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
          name: 'scorer evaluated who the endpoint answers with',
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
    name: 'the agent read the Securing Edge Functions guide the prompt referenced',
    passed: withContent.length > 0,
    notes:
      withContent.length > 0
        ? withContent.map((call) => call.source).join(', ')
        : calls.length > 0
          ? `reached the guide via ${calls.map((call) => call.source).join(', ')} but retrieved no page content`
          : 'no docs call reached the guide',
  };
}
