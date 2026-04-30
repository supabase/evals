import type { Scorer } from "../../apps/framework/harness/types.js";

const FUNCTION_NAME = "order-total";

interface InvokeResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const invoke = async (
  ctx: Parameters<Scorer>[0],
  body: Record<string, unknown> | string | undefined,
  method = "POST"
) =>
  ctx.mgmt.backends.edgeFunctions.invoke({
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

const scorer: Scorer = async (ctx) => {
  const checks: Array<{ name: string; ok: boolean }> = [];

  try {
    const methodCheck = await invoke(ctx, undefined, "GET");
    checks.push({ name: "rejects non-POST requests", ok: methodCheck.status === 405 });

    const invalidJson = await invoke(ctx, "{");
    checks.push({ name: "rejects invalid JSON", ok: invalidJson.status === 400 });

    const invalidItem = await invoke(ctx, {
      items: [{ sku: "bad", unit_price_cents: 0, quantity: 1 }],
    });
    checks.push({ name: "rejects invalid item values", ok: invalidItem.status === 400 });

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
      name: "calculates WELCOME10 totals",
      ok:
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
      name: "chooses enterprise discount over capped coupon",
      ok:
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
      name: "caps WELCOME10 discount at 2000 cents",
      ok:
        cappedCoupon.status === 200 &&
        cappedCouponJson?.subtotal_cents === 50000 &&
        cappedCouponJson?.discount_cents === 2000 &&
        cappedCouponJson?.tax_cents === 3480 &&
        cappedCouponJson?.total_cents === 51480,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      score: checks.filter((c) => c.ok).length / 6,
      notes: [
        ...checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`),
        `FAIL scorer could not invoke ${FUNCTION_NAME}: ${msg}`,
      ].join("\n"),
    };
  }

  const passed = checks.every((c) => c.ok);
  const score = checks.filter((c) => c.ok).length / checks.length;
  return {
    passed,
    score,
    notes: checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`).join("\n"),
  };
};

export default scorer;
