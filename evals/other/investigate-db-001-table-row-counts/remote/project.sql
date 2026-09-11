CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  total_cents int NOT NULL
);

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  kind text NOT NULL
);

INSERT INTO users (email)
SELECT 'user-' || n || '@example.com'
FROM generate_series(1, 12) AS n;

INSERT INTO orders (user_id, total_cents)
SELECT '00000000-0000-0000-0000-000000000001'::uuid, 1000 + n
FROM generate_series(1, 87) AS n;

INSERT INTO events (user_id, kind)
SELECT '00000000-0000-0000-0000-000000000001'::uuid, 'page_view'
FROM generate_series(1, 453) AS n;
