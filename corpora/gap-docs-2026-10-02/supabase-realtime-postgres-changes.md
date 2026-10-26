# Troubleshoot missing Postgres Changes events

Use this guide when a Supabase Realtime channel reaches `SUBSCRIBED` but a database change does not reach its `postgres_changes` callback. A connected channel confirms the connection; it does not confirm that every table is configured for change delivery or that the subscribing client can see a row.

## Prerequisites

- Access to the Supabase project and the database used by the application.
- Permission to inspect the publication and, if needed, change its table membership. Apply database changes through the project's normal migration or SQL review process.
- The application's Supabase client credentials and the schema, table, event type, and any filter used by the subscription.
- A safe test row or test environment for an end-to-end insert.

Names in the examples are illustrative. Replace `public.orders`, the channel name, and test data with values from the application.

## 1. Check whether the exact table is published

Postgres Changes only streams tables included in the `supabase_realtime` publication. Membership is table-specific. A different table already producing events does not establish that the target table is included.

Inspect the publication:

```sql
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by schemaname, tablename;
```

Confirm there is a row whose `schemaname` and `tablename` match the subscription's schema and table. For example, a subscription to `public.orders` needs the `public` / `orders` row.

If the publication exists and the target table is absent, add only that table. Adapt the schema and table identifier:

```sql
alter publication supabase_realtime add table public.orders;
```

Do not drop and recreate the publication to enable one table; that can remove other tables' configured membership. If the table is already listed, do not add it again. You can also enable the table through **Database → Publications** in the Supabase dashboard.

Creating a database table and enabling it for Realtime are separate steps. Repeat the catalog query after the change and confirm the intended schema/table pair appears.

## 2. Check the client subscription target

Compare the subscription to the actual database object. The schema, table name, event, and filter must all match the write being tested. For a table named `orders` in the `public` schema, an adaptable INSERT listener is:

```js
const channel = supabase
  .channel('orders-inserts')
  .on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'orders',
    },
    (payload) => {
      console.log('Received inserted order:', payload.new)
    }
  )
  .subscribe((status, err) => {
    console.log('Realtime status:', status)
    if (err) console.error('Realtime subscription error:', err)
  })
```

If the real table is in another schema, set that schema explicitly. If the listener includes a filter, temporarily remove it in a controlled test to determine whether the filter excludes the test row; restore the intended filter after checking.

## 3. Verify event delivery independently

Use a second client or browser session running the same application credentials and role as the affected subscriber. Start the listener and wait for `SUBSCRIBED`. Then create one identifiable test row through the normal application path or a controlled database insert, and confirm the callback receives its `new` record.

A useful verification record includes:

1. The publication query shows the target schema and table.
2. The listener is configured for that schema, table, event, and intended filter.
3. The listener was active before the test insert.
4. The callback receives the test row's identifier.
5. A normal query using the subscriber's own client can select that row.

Do not use only a successful status callback as proof that database events are available.

## 4. If publication membership is correct but events are still missing

Check whether the subscriber's role can read the changed row. Postgres Changes applies row-level security visibility for the subscribing client. With that same client and credentials, query the test row:

```js
const { data, error } = await supabase
  .from('orders')
  .select('*')
  .eq('id', testOrderId)

console.log({ data, error })
```

An empty result can mean the applicable SELECT policy does not allow that client to see the row. Review the policy and the intended access rules; change policy only if that access is correct for the product. Do not disable RLS merely to make events appear.

Then recheck the exact schema, table, event, and filter, and inspect the subscription status and full error callback. If these checks pass but events remain absent, inspect the project's Realtime logs and confirm the test write reached the same database project the client connects to.

## Cleanup

Remove test rows if appropriate for the environment. Retain the publication entry when the application is intended to stream that table; if it was added only for a temporary experiment, remove it through the project's normal reviewed database change process.
