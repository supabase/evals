// Pushes a paid order to the warehouse. The warehouse feed is fetched once per
// invocation and every order line is matched against it by SKU.
//
// NOTE: a line whose SKU is missing from the feed is logged and skipped so a
// single bad SKU never fails the whole checkout — the caller still gets a 200.

type OrderLine = { sku: string; qty: number };
type Order = { id: string; lines: OrderLine[] };

const WAREHOUSE_URL = Deno.env.get('WAREHOUSE_URL')!;
const WAREHOUSE_TOKEN = Deno.env.get('WAREHOUSE_TOKEN')!;

async function loadWarehouseFeed(): Promise<Set<string>> {
  const res = await fetch(`${WAREHOUSE_URL}/feed`, {
    headers: { authorization: `Bearer ${WAREHOUSE_TOKEN}` },
  });
  const feed: { sku: string }[] = await res.json();
  return new Set(feed.map((item) => item.sku));
}

Deno.serve(async (req) => {
  const order: Order = await req.json();
  const feed = await loadWarehouseFeed();

  const shippable = order.lines.filter((line) => feed.has(line.sku));
  const missing = order.lines.filter((line) => !feed.has(line.sku));

  for (const line of missing) {
    console.error(
      `[order-sync] warehouse sync failed for order ${order.id}: SKU ${line.sku} is not in the warehouse feed (skipping line)`
    );
  }

  if (shippable.length > 0) {
    await fetch(`${WAREHOUSE_URL}/orders`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${WAREHOUSE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: order.id, lines: shippable }),
    });
    console.log(
      `[order-sync] synced order ${order.id} (${shippable.length} line(s))`
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      synced: shippable.length,
      skipped: missing.length,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
});
