import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

// Checkout calls this with the signed-in shopper's session token before it shows the order total.
type Promo = { percentOff?: number; centsOff?: number; minCartCents?: number };

const PROMOS = new Map<string, Promo>([
  ['WELCOME10', { percentOff: 10 }],
  ['FREESHIP', { centsOff: 495, minCartCents: 3000 }],
  ['LOYAL15', { percentOff: 15, minCartCents: 4000 }],
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'Send a POST with a JSON body' }, 405);
  }
  let input: { code?: unknown; cartCents?: unknown };
  try {
    input = await req.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }
  const cartCents = Number(input.cartCents);
  if (!Number.isInteger(cartCents) || cartCents <= 0) {
    return json({ error: 'cartCents must be a positive whole number' }, 400);
  }
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  const promo = PROMOS.get(code);
  if (!promo) {
    return json({
      valid: false,
      reason: `${code || 'That'} isn't a code we recognise`,
    });
  }
  if (promo.minCartCents !== undefined && cartCents < promo.minCartCents) {
    return json({
      valid: false,
      reason: `${code} needs a cart of at least ${promo.minCartCents} cents`,
    });
  }
  const discountCents =
    promo.percentOff !== undefined
      ? Math.round((cartCents * promo.percentOff) / 100)
      : Math.min(promo.centsOff ?? 0, cartCents);
  return json({
    valid: true,
    code,
    discountCents,
    totalCents: cartCents - discountCents,
  });
});
