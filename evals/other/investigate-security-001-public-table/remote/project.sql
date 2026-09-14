CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL
);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "self read" ON users FOR SELECT TO authenticated
  USING (id = auth.uid());

-- Planted issue: granted to anon, no RLS, no policies.
CREATE TABLE customer_payment_methods (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  card_last4 text NOT NULL,
  stripe_customer_id text NOT NULL
);
GRANT SELECT ON customer_payment_methods TO anon;

CREATE TABLE notes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  body text
);
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "self read" ON notes FOR SELECT TO authenticated
  USING (user_id = auth.uid());
