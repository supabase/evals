---
stage: build
interface: cli
sdk: flutter
product:
  - data-api
  - database
  - auth
topic:
  - sdk
services:
  - gotrue
  - kong
  - postgrest
projectRunning: true
motivation: >-
  Relationship embedding is the query-builder surface users trip on most
  (supabase/postgrest-js#609, supabase/postgrest-js#611,
  supabase/supabase-js#1639), and the most-used supabase-js surface had no
  dedicated eval coverage.
---

We need the sales report in our staff dashboard working. The Flutter app is in
`app/`, and `app/lib/sales_report.dart` has the spec in a comment. Staff sign in
with their email and password, and the dashboard shows a summary of what each
customer has ordered.

The data lives in the Supabase project in `supabase/` (already running
locally). Finish the data layer and make sure signed-in staff see the right
numbers.
