---
stage: build
interface: rest
product:
  - data-api
  - database
topic:
  - sql
motivation: Spark port of the benchmark build-dataapi-001 scenario. The report is produced by the agent directly, and access control is not scored until Spark supports RLS.
---

We need the nightly sales report from the provided Spark project's order history.
Read the data through the Data API and reply with a JSON array of `{customer, orderCount, totalCents, topProduct}` for each customer with at least one order, sorted by name.
`totalCents` is what they spent in cents, and `topProduct` is the product they bought the most units of (alphabetically first on a tie).
Don't change the data.
