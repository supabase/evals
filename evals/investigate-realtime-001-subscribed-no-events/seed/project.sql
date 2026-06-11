CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_name text NOT NULL,
  status text NOT NULL DEFAULT 'new',
  total numeric(10,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE courier_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  courier_id uuid NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_locations ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON orders TO authenticated;
GRANT SELECT, INSERT ON courier_locations TO authenticated;

CREATE POLICY "staff can read orders"
ON orders
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "staff can create orders"
ON orders
FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "staff can read courier locations"
ON courier_locations
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "couriers can report locations"
ON courier_locations
FOR INSERT
TO authenticated
WITH CHECK (true);

-- Bug: the dashboard subscribes to postgres_changes on orders and reaches
-- SUBSCRIBED, but orders was never added to the supabase_realtime
-- publication, so no INSERT events are ever delivered. The courier feed
-- works because its table is in the publication.
CREATE PUBLICATION supabase_realtime FOR TABLE courier_locations;

INSERT INTO orders (customer_name, status, total) VALUES
  ('Ada Fields', 'delivered', 24.50),
  ('Tom Okafor', 'preparing', 18.00);

INSERT INTO courier_locations (courier_id, lat, lng) VALUES
  ('11111111-1111-1111-1111-111111111111', 52.370216, 4.895168),
  ('11111111-1111-1111-1111-111111111111', 52.371500, 4.897000);
