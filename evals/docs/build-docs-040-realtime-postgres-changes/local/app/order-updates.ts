import type {
  RealtimePostgresChangesPayload,
  SupabaseClient,
} from '@supabase/supabase-js';

export type Order = {
  id: number;
  customer_id: string;
  item: string;
  status: 'placed' | 'packed' | 'shipped' | 'delivered';
  updated_at: string;
};

export type OrderScreen = {
  addOrder: (order: Order) => void;
  showStatusChange: (orderId: number, from: string, to: string) => void;
  removeOrder: (orderId: number) => void;
};

export async function watchMyOrders(
  supabase: SupabaseClient,
  screen: OrderScreen
) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Sign in first');

  return supabase
    .channel(`my-orders-${user.id}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'orders',
        filter: `customer_id=eq.${user.id}`,
      },
      (payload: RealtimePostgresChangesPayload<Order>) => {
        if (payload.eventType === 'INSERT') {
          screen.addOrder(payload.new);
        }
        if (payload.eventType === 'UPDATE') {
          screen.showStatusChange(
            payload.new.id,
            payload.old.status ?? '',
            payload.new.status
          );
        }
        if (payload.eventType === 'DELETE' && payload.old.id !== undefined) {
          screen.removeOrder(payload.old.id);
        }
      }
    )
    .subscribe();
}
