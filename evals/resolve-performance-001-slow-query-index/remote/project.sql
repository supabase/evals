CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

INSERT INTO accounts (name)
SELECT 'account-' || n
FROM generate_series(1, 20) AS n;

INSERT INTO events (user_id, kind, payload, created_at)
SELECT
  ('00000000-0000-0000-0000-' || lpad((((n - 1) % 50) + 1)::text, 12, '0'))::uuid,
  CASE WHEN n % 5 = 0 THEN 'checkout' ELSE 'page_view' END,
  jsonb_build_object('seq', n),
  '2026-04-28T10:00:00Z'::timestamptz - (n || ' seconds')::interval
FROM generate_series(1, 5000) AS n;
