# Orders

## How orders change

Customers change their own orders from the app. The app writes to `orders`
directly through the API while the customer is signed in.

Saving the order form sends every field on the form:

```ts
await supabase
  .from('orders')
  .update({ status, delivery_note })
  .eq('id', orderId)
```

The "Cancel all open orders" button cancels every order still placed in one
request:

```ts
await supabase
  .from('orders')
  .update({ status: 'cancelled' })
  .eq('status', 'placed')
```

The warehouse moves orders along from the back office, which uses the service
key.

## Timeline

The order page shows a timeline from `order_status_history`. Each entry is one
status change: the order, the status it left, the status it moved to, and
when.
