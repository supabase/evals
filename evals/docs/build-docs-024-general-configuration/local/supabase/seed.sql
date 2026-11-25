-- Accounts from the beta sign-up page, as they are in production, with the
-- local password fernhill-beta for everyone.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  email_change_token_current, phone_change_token, reauthentication_token
)
select
  '00000000-0000-0000-0000-000000000000', a.id, 'authenticated', 'authenticated',
  a.email, extensions.crypt('fernhill-beta', extensions.gen_salt('bf')),
  a.confirmed_at, '{"provider":"email","providers":["email"]}', '{}',
  a.created_at, a.created_at, '', '', '', '', '', '', ''
from (values
  ('6d1f4b0a-1c3e-4f6a-9b2d-0a1b2c3d4e01'::uuid, 'maia.tane@example.com', '2026-09-02 09:14+00'::timestamptz, '2026-09-02 09:12+00'::timestamptz),
  ('6d1f4b0a-1c3e-4f6a-9b2d-0a1b2c3d4e02', 'oscar.lindqvist@example.com', '2026-09-03 18:40+00', '2026-09-03 18:31+00'),
  ('6d1f4b0a-1c3e-4f6a-9b2d-0a1b2c3d4e03', 'priya.raman@example.com', null, '2026-09-05 07:02+00'),
  ('6d1f4b0a-1c3e-4f6a-9b2d-0a1b2c3d4e04', 'tomas.herrera@example.com', null, '2026-09-11 20:47+00'),
  ('6d1f4b0a-1c3e-4f6a-9b2d-0a1b2c3d4e05', 'cheap.seeds.deals@example.net', null, '2026-09-19 03:15+00'),
  ('6d1f4b0a-1c3e-4f6a-9b2d-0a1b2c3d4e06', 'j.wright.88@example.org', null, '2026-10-02 12:26+00')
) as a (id, email, confirmed_at, created_at);

insert into auth.identities (
  id, user_id, provider_id, provider, identity_data, created_at, updated_at
)
select
  gen_random_uuid(), u.id, u.id::text, 'email',
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', false),
  u.created_at, u.created_at
from auth.users u;

insert into public.plots (bed, holder) values
  ('North 3', '6d1f4b0a-1c3e-4f6a-9b2d-0a1b2c3d4e01'),
  ('North 4', '6d1f4b0a-1c3e-4f6a-9b2d-0a1b2c3d4e02'),
  ('Orchard 1', '6d1f4b0a-1c3e-4f6a-9b2d-0a1b2c3d4e03'),
  ('Glasshouse 2', '6d1f4b0a-1c3e-4f6a-9b2d-0a1b2c3d4e04');
