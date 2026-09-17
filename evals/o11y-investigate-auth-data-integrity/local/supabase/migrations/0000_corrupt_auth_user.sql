-- Broken starting state (probe: auth-data-integrity).
-- A row in auth.users has aud='' and role='' — fields GoTrue requires to be
-- 'authenticated'. This causes silent token refresh failures for this user.
INSERT INTO auth.users (
  instance_id, id, aud, role,
  email, encrypted_password,
  created_at, updated_at,
  confirmation_token, recovery_token,
  email_change_token_new, email_change,
  raw_app_meta_data, raw_user_meta_data,
  is_super_admin
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  gen_random_uuid(),
  '',   -- empty aud — GoTrue integrity violation
  '',   -- empty role — GoTrue integrity violation
  'chaos_corrupt_user@example.com',
  '',
  now(), now(),
  '', '', '', '',
  '{}', '{}',
  false
);
