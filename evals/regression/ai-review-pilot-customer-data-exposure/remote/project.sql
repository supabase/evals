CREATE TABLE customer_payment_methods (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL,
  card_brand text NOT NULL,
  last_four text NOT NULL,
  billing_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO customer_payment_methods (id, customer_id, card_brand, last_four, billing_email)
VALUES
  ('00000000-0000-0000-0000-000000000101', '10000000-0000-0000-0000-000000000001', 'visa', '4242', 'ada@example.com'),
  ('00000000-0000-0000-0000-000000000102', '10000000-0000-0000-0000-000000000002', 'mastercard', '4444', 'grace@example.com');

GRANT SELECT ON customer_payment_methods TO anon;

CREATE TABLE billing_events (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL,
  event_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO billing_events (id, customer_id, event_type)
VALUES
  ('00000000-0000-0000-0000-000000000201', '10000000-0000-0000-0000-000000000001', 'invoice_paid'),
  ('00000000-0000-0000-0000-000000000202', '10000000-0000-0000-0000-000000000002', 'subscription_renewed');
