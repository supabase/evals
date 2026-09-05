-- Starting state (probe: security-fkey-to-auth-unique / Splinter lint 0021).
-- A table references auth.users(email) — a unique non-PK column — instead of
-- auth.users(id). This FK cannot be restored by pg_upgrade during a major
-- version upgrade, making zero-downtime upgrades impossible.
-- HARNESS NOTE: platform-lite's auth.users schema differs from production.
-- Using public.app_users to replicate the exact pattern.
CREATE TABLE public.app_users (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL
);

INSERT INTO public.app_users (id, email)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'alice@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'bob@example.com');

-- The broken FK: references email (unique non-PK) instead of id (PK).
-- On a real project this would be: REFERENCES auth.users(email)
CREATE TABLE public.user_refs (
  id           bigserial PRIMARY KEY,
  user_email   text UNIQUE REFERENCES public.app_users(email)
);

INSERT INTO public.user_refs (user_email)
VALUES ('alice@example.com'), ('bob@example.com');
