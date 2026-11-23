# Kettle & Crumb

Online orders for the bakery.

- Production runs exactly what is in `supabase/migrations/`. Every merge to `main` deploys it, and the
  database there already holds every order customers have placed since we launched.
- Teammates pull `main` and rebuild their local database from these files.
- The checkout in the storefront repo already sends a `delivery_option` (`standard` or `express`)
  with every order, so that is the name the column needs to have.
