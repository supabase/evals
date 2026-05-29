import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from "@supabase-evals/core";

const FUNCTION_NAME = "order-total";

interface InvokeResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const invoke = async (
  ctx: ToolEvalContext,
  body: Record<string, unknown> | string | undefined,
  method = "POST"
) =>
  ctx.invokeFunction({
    name: FUNCTION_NAME,
    method,
    body,
  }) as Promise<InvokeResult>;

const parseJson = (result: InvokeResult) => {
  try {
    return JSON.parse(result.body) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

const scorer: ToolScorer = async (ctx) => {
  const checks: CheckResult[] = [];

  try {
    const methodCheck = await invoke(ctx, undefined, "GET");
    checks.push({
      type: "deterministic",
      name: "rejects non-POST requests",
      passed: methodCheck.status === 405,
    });

    const invalidJson = await invoke(ctx, "{");
    checks.push({
      type: "deterministic",
      name: "rejects invalid JSON",
      passed: invalidJson.status === 400,
    });

    const invalidItem = await invoke(ctx, {
      items: [{ sku: "bad", unit_price_cents: 0, quantity: 1 }],
    });
    checks.push({
      type: "deterministic",
      name: "rejects invalid item values",
      passed: invalidItem.status === 400,
    });

    const welcome = await invoke(ctx, {
      items: [
        { sku: "basic-plan", unit_price_cents: 1200, quantity: 2 },
        { sku: "addon", unit_price_cents: 350, quantity: 3 },
      ],
      customer_tier: "standard",
      coupon: "WELCOME10",
    });
    const welcomeJson = parseJson(welcome);
    checks.push({
      type: "deterministic",
      name: "calculates WELCOME10 totals",
      passed:
        welcome.status === 200 &&
        welcomeJson?.subtotal_cents === 3450 &&
        welcomeJson?.discount_cents === 345 &&
        welcomeJson?.tax_cents === 225 &&
        welcomeJson?.total_cents === 3330,
    });

    const enterprise = await invoke(ctx, {
      items: [{ sku: "enterprise-seat", unit_price_cents: 5000, quantity: 5 }],
      customer_tier: "enterprise",
      coupon: "WELCOME10",
    });
    const enterpriseJson = parseJson(enterprise);
    checks.push({
      type: "deterministic",
      name: "chooses enterprise discount over capped coupon",
      passed:
        enterprise.status === 200 &&
        enterpriseJson?.subtotal_cents === 25000 &&
        enterpriseJson?.discount_cents === 3750 &&
        enterpriseJson?.tax_cents === 1541 &&
        enterpriseJson?.total_cents === 22791,
    });

    const cappedCoupon = await invoke(ctx, {
      items: [{ sku: "annual-plan", unit_price_cents: 50000, quantity: 1 }],
      customer_tier: "standard",
      coupon: "WELCOME10",
    });
    const cappedCouponJson = parseJson(cappedCoupon);
    checks.push({
      type: "deterministic",
      name: "caps WELCOME10 discount at 2000 cents",
      passed:
        cappedCoupon.status === 200 &&
        cappedCouponJson?.subtotal_cents === 50000 &&
        cappedCouponJson?.discount_cents === 2000 &&
        cappedCouponJson?.tax_cents === 3480 &&
        cappedCouponJson?.total_cents === 51480,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    checks.push({
      type: "deterministic",
      name: `scorer could invoke ${FUNCTION_NAME}`,
      passed: false,
      notes: msg,
    });
    return {
      passed: false,
      checks,
    };
  }

  const passed = checks.every((check) => check.passed);
  return {
    passed,
    checks,
  };
};

export default scorer;
