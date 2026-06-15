---
stage: investigate
suite: benchmark
product:
  - realtime
  - database
topic:
  - sdk
motivation: AI-819, REAL-577
---

# Debug Realtime publication

Our dispatch dashboard shows incoming orders as they happen. The courier
location feed on the same page updates live without problems, but new orders
only show up after a page refresh.

The dashboard uses supabase-js to subscribe to INSERT events on the `orders`
table through postgres_changes, the same way it subscribes to courier
locations. The channel's status callback logs SUBSCRIBED and there are no
errors in the browser console.

Figure out why no order events ever arrive and fix it.
