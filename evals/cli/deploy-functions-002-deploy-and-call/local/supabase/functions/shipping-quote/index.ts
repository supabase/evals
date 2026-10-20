import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

// Flat-rate shipping: a base charge per destination plus a charge per started kilogram.
const RATES: Record<
  string,
  { currency: string; baseCents: number; perKgCents: number }
> = {
  IE: { currency: 'EUR', baseCents: 450, perKgCents: 120 },
  GB: { currency: 'GBP', baseCents: 395, perKgCents: 110 },
  US: { currency: 'USD', baseCents: 799, perKgCents: 95 },
};

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
  let input: { country?: unknown; weightKg?: unknown };
  try {
    input = await req.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }
  const country =
    typeof input.country === 'string' ? input.country.toUpperCase() : '';
  const rate = RATES[country];
  if (!rate) {
    return json(
      { error: `We don't ship to ${country || 'that country'}` },
      400
    );
  }
  const weightKg = Number(input.weightKg);
  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    return json({ error: 'weightKg must be a positive number' }, 400);
  }
  const quoteCents = rate.baseCents + Math.ceil(weightKg) * rate.perKgCents;
  return json({
    country,
    weightKg,
    quoteCents,
    currency: rate.currency,
  });
});
