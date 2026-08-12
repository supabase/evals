---
stage: resolve
suite: benchmark
interface: mcp
product:
  - database
  - data-api
topic:
  - rls
  - sql
motivation: https://linear.app/supabase/issue/FDBKIN-32777/improve-rls-performance-on-tables-with-billions-of-rows-to-reduce, https://linear.app/supabase/issue/FDBKIN-25150/improve-rls-performance-by-documenting-or-automating-the-select
---

Our `documents` table has Row Level Security enabled so each signed-in user only sees their own rows. It worked fine in testing, but now that the table has grown the document list has become painfully slow — a simple "list my documents" query that should be instant now takes seconds and gets slower as the table grows, even though each user only owns a handful of rows.

We don't want to weaken the security model — users must still only ever see their own documents. Find out why the query is so slow and fix it.
