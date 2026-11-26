# Outgoing mail

Every email Kestrel Books sends goes through the outbox, the `public.outbox`
table. The mail worker picks up each row where `sent_at` is empty, sends it, and
fills in `sent_at`.

The worker sends exactly what the row says:

- `to_email` is the address it goes to.
- `subject` is the subject line.
- `html` is the whole body of the email.

The worker knows nothing about accounts or why an email exists, so a row has to
be the finished email, buttons and all.

The worker connects to the database as `postgres`.
