create policy "Users read their own order items"
  on public.order_items for select
  to authenticated
  using (
    exists (
      select 1
        from public.orders o
       where o.id = order_items.order_id
         and o.user_id = (select auth.uid())
    )
  );
