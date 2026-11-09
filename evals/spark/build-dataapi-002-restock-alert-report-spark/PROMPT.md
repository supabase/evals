---
stage: build
interface: rest
product:
  - data-api
  - database
topic:
  - sql
motivation: Spark port of the benchmark build-dataapi-002 scenario. The agent produces the alert list itself, and access control is not scored until Spark supports RLS.
---

Purchasing needs a restock alert from the provided Spark project's inventory.
Read the data through the Data API and reply with a JSON array of `{warehouse, product, quantity, reorderThreshold, supplierEmail}` for every warehouse and product combination whose quantity is strictly below the product's reorder threshold, sorted by warehouse name and then product name.
`supplierEmail` is who to email about it.
Don't change the data.
