-- Broken starting state (probe: storage-public-bucket).
-- 'public-assets' bucket is public=true with no download policy; any
-- unauthenticated user can read all objects.
INSERT INTO storage.buckets (id, name, public)
VALUES ('public-assets', 'public-assets', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS "public_assets_owner_only" ON storage.objects;
