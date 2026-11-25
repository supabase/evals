import type { Client } from './lib/supabase';

export async function placeOrder(
  db: Client,
  bookId: number,
  quantity: number,
  giftNote?: string
) {
  const { data, error } = await db
    .from('orders')
    .insert({ book_id: bookId, quantity, gift_note: giftNote ?? null })
    .select('id, placed_at')
    .single();
  if (error) throw error;
  return { orderId: data.id, placedAt: new Date(data.placed_at) };
}
