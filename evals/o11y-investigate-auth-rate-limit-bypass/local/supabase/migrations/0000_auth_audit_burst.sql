-- Starting state (probe: auth-rate-limit-bypass).
-- Seeded auth.audit_log_entries with a burst of failed login attempts from
-- the same IP range to simulate a brute-force attack pattern.
DO $$
DECLARE i int;
BEGIN
  FOR i IN 1..50 LOOP
    INSERT INTO auth.audit_log_entries (id, payload, created_at, ip_address)
    VALUES (
      gen_random_uuid(),
      jsonb_build_object(
        'action', 'login',
        'actor_via_sso', false,
        'log_type', 'account',
        'traits', jsonb_build_object('provider', 'email'),
        'error', 'Invalid login credentials'
      ),
      now() - (random() * interval '10 minutes'),
      '203.0.113.' || (floor(random()*10)+1)::text
    );
  END LOOP;
END $$;
