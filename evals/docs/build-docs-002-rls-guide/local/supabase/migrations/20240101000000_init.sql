-- To-do app. People keep their own todos, and a list can be shared with other
-- people so everyone on it works from the same set of items.

CREATE TABLE todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per person on a list.
CREATE TABLE list_members (
  list_id uuid NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  PRIMARY KEY (list_id, user_id)
);

CREATE TABLE list_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
  author_id uuid NOT NULL,
  title text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Weather dashboard. Readings arrive from the station feed every ten minutes
-- and the dashboard shows them as they land.

CREATE TABLE weather_stations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  latitude numeric NOT NULL,
  longitude numeric NOT NULL
);

CREATE TABLE weather_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id uuid NOT NULL REFERENCES weather_stations (id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  temp_c numeric NOT NULL,
  conditions text NOT NULL
);
