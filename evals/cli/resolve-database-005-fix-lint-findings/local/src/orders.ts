import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

export async function listMyOrders() {
  const { data, error } = await supabase
    .from('orders')
    .select(
      'id, status, updated_at, order_items(product, quantity, unit_price)'
    )
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function orderTotal(orderId: number) {
  const { data, error } = await supabase.rpc('order_total', {
    p_order_id: orderId,
  });
  if (error) throw error;
  return data as number;
}
