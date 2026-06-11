---
stage: build
product:
  - functions
topic:
  - edge-functions
  - api
---

# Order Total Edge Function

Create a Supabase Edge Function named `order-total`.

The function should accept only `POST` requests with a JSON body:

```json
{
  "items": [
    { "sku": "basic-plan", "unit_price_cents": 1200, "quantity": 2 }
  ],
  "customer_tier": "standard",
  "coupon": "WELCOME10"
}
```

Implement this behavior:

1. Return `405` for non-`POST` requests.
2. Return `400` with a JSON error if the body is invalid JSON, if `items` is
   missing or empty, or if any item has a non-positive `unit_price_cents` or
   `quantity`.
3. Calculate `subtotal_cents` as the sum of `unit_price_cents * quantity`.
4. Apply the best single discount:
   - Coupon `WELCOME10`: 10% off subtotal, capped at 2000 cents.
   - `customer_tier: "enterprise"`: 15% off subtotal.
   - Discounts do not stack; use whichever discount is larger.
5. Calculate `tax_cents` as 7.25% of the post-discount amount, rounded to the
   nearest cent.
6. Return `200` JSON with `subtotal_cents`, `discount_cents`, `tax_cents`, and
   `total_cents`.

Deploy the function with slug `order-total`. The deployed source should be a
single `index.ts` file.
