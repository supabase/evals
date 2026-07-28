import { expect, test } from 'vitest';
import {
  checksMessage,
  deployFunction,
  scorerCtx,
  withBackend,
} from '../../test-utils/scorer-test-kit.js';
import scorer from './EVAL.js';

const ORDER_TOTAL_SOURCE = `
Deno.serve(async (req) => {
  const json = (payload, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  if (!Array.isArray(body.items) || body.items.length === 0) return json({ error: "items are required" }, 400);

  let subtotal = 0;
  for (const item of body.items) {
    if (!Number.isFinite(item.unit_price_cents) || !Number.isFinite(item.quantity) || item.unit_price_cents <= 0 || item.quantity <= 0) {
      return json({ error: "invalid item" }, 400);
    }
    subtotal += item.unit_price_cents * item.quantity;
  }

  const couponDiscount = body.coupon === "WELCOME10" ? Math.min(Math.round(subtotal * 0.1), 2000) : 0;
  const enterpriseDiscount = body.customer_tier === "enterprise" ? Math.round(subtotal * 0.15) : 0;
  const discount = Math.max(couponDiscount, enterpriseDiscount);
  const taxable = subtotal - discount;
  const tax = Math.round(taxable * 0.0725);

  return json({ subtotal_cents: subtotal, discount_cents: discount, tax_cents: tax, total_cents: taxable + tax });
});
`;

test('fails before the function exists, passes once it is deployed', async () => {
  await withBackend({}, async (backend) => {
    const before = await scorer(scorerCtx(backend));
    expect(before.passed).toBe(false);
    expect(checksMessage(before)).toMatch(/function not found/i);

    await deployFunction(backend, 'order-total', ORDER_TOTAL_SOURCE, {
      verifyJwt: false,
    });

    const after = await scorer(scorerCtx(backend));
    expect(after.passed, checksMessage(after)).toBe(true);
  });
});
