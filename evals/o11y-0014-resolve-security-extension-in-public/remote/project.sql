-- Starting state (probe: health-extension-in-public / Splinter lint 0014).
-- pg_trgm is installed in the public schema, exposing its similarity() and
-- other functions to the Data API and any role with USAGE on public.
-- HARNESS NOTE: PGlite cannot install pg_trgm; the schema structure is seeded
-- and the eval scores on the agent's diagnostic report via judge.
CREATE SCHEMA IF NOT EXISTS extensions;

-- Simulate the functions that pg_trgm would expose in public schema.
CREATE OR REPLACE FUNCTION public.similarity(text, text)
  RETURNS float4 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT 0.0::float4;
$$;

CREATE OR REPLACE FUNCTION public.show_trgm(text)
  RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT '{}'::text[];
$$;

-- Fake pg_extension row to simulate pg_trgm installed in public.
-- This allows the agent to see the extension "installed" in public.
CREATE TABLE IF NOT EXISTS public.extension_info (
  extname text,
  extschema text,
  extversion text
);

INSERT INTO public.extension_info (extname, extschema, extversion)
VALUES ('pg_trgm', 'public', '1.6');
