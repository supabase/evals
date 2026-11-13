import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

import {
  CREDIT_BALANCE,
  checkDefinerPinsSearchPath,
  checkFunctionExists,
  loadFunctions,
  ORDER_TOTAL,
  pickArgumentName,
} from './catalog.js';
import {
  checkAnonCannotGet,
  checkCustomerCannotGetAnothers,
  checkCustomerGetsOwnFigure,
  checkLedgerStaysClosed,
  creditTarget,
  gated,
  orderTarget,
  setupWorld,
} from './probes.js';

const GUIDE_PATH = 'guides/database/functions';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const orderFunctions = await loadFunctions(ctx, ORDER_TOTAL);
    const creditFunctions = await loadFunctions(ctx, CREDIT_BALANCE);

    // Seeds happen after the agent's code exists, so a figure cannot be
    // hardcoded. Each function's data is seeded separately, so one failing
    // costs only its own checks.
    const setup = await setupWorld(ctx);
    const blocked = { blocked: 'failure' in setup ? setup.failure : '' };
    const order =
      'world' in setup
        ? orderTarget(setup.world, pickArgumentName(orderFunctions))
        : blocked;
    const credit =
      'world' in setup
        ? creditTarget(setup.world, pickArgumentName(creditFunctions))
        : blocked;

    const checks: CheckResult[] = [
      checkFunctionExists(orderFunctions, ORDER_TOTAL),
      checkFunctionExists(creditFunctions, CREDIT_BALANCE),
      checkDefinerPinsSearchPath([...orderFunctions, ...creditFunctions]),
      await gated(
        order,
        'a customer gets the right total for their own order',
        (t) =>
          checkCustomerGetsOwnFigure(
            t,
            'a customer gets the right total for their own order'
          )
      ),
      await gated(
        order,
        "a customer cannot get another customer's total",
        (t) =>
          checkCustomerCannotGetAnothers(
            t,
            "a customer cannot get another customer's total"
          )
      ),
      await gated(
        order,
        'a signed-out visitor cannot get an order total',
        (t) =>
          checkAnonCannotGet(
            t,
            'a signed-out visitor cannot get an order total'
          )
      ),
      await gated(
        credit,
        'a customer gets the right store credit balance for their own account',
        (t) =>
          checkCustomerGetsOwnFigure(
            t,
            'a customer gets the right store credit balance for their own account'
          )
      ),
      await gated(
        credit,
        "a customer cannot get another customer's store credit balance",
        (t) =>
          checkCustomerCannotGetAnothers(
            t,
            "a customer cannot get another customer's store credit balance"
          )
      ),
      await gated(
        credit,
        'a signed-out visitor cannot get a store credit balance',
        (t) =>
          checkAnonCannotGet(
            t,
            'a signed-out visitor cannot get a store credit balance'
          )
      ),
      // After every probe above, and read-only, so it never changes what they
      // saw. It stands beside the own-balance check: that one proves the
      // function reaches a ledger the customer cannot.
      'world' in setup
        ? await checkLedgerStaysClosed(setup.world)
        : {
            name: 'a customer or signed-out visitor cannot read the store credit ledger directly',
            passed: false,
            notes: `not run: ${blocked.blocked}`,
          },
      // Last: it reads the transcript, not the database.
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
