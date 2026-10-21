import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

type ReceiptRequest = {
  email?: unknown;
  orderId?: unknown;
  totalCents?: unknown;
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
  const { email, orderId, totalCents }: ReceiptRequest = await req
    .json()
    .catch(() => ({}));
  if (typeof email !== 'string' || typeof orderId !== 'string') {
    return json({ error: 'email and orderId are required' }, 400);
  }
  const total = (Number(totalCents ?? 0) / 100).toFixed(2);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Shopfront <orders@shopfront.example>',
      to: email,
      subject: `Your receipt for order ${orderId}`,
      text: `Thanks for your order ${orderId}. Total paid: ${total}`,
    }),
  });
  return json({ sent: res.ok }, res.ok ? 200 : 502);
});
