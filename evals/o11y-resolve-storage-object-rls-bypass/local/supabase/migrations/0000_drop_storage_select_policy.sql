-- Broken starting state (probe: storage-object-rls-bypass).
-- Drop all SELECT policies on storage.objects so any caller can read any object.
-- storage.objects already has RLS enabled by default in Supabase.
DROP POLICY IF EXISTS "objects_auth_select" ON storage.objects;
DROP POLICY IF EXISTS "public_assets_owner_only" ON storage.objects;
DROP POLICY IF EXISTS "Give users access to own folder" ON storage.objects;
