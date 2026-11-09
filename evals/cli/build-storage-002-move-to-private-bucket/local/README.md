# Ledgerly

Invoicing for freelancers. Create invoices, send them to customers and see what is still unpaid.

## Storage

All files live in one bucket, `media`.

- Avatars are stored at `avatars/<handle>.svg` and load by public URL (see `src/lib/avatars.ts`).
- Customer invoices sit under `invoices/`.
