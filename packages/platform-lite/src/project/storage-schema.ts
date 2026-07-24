// Supplements @supabase/lite's getStorageSchemaSql() — which creates the
// storage.buckets and storage.objects tables — with the pieces a real Supabase
// project ships that lite's base schema omits:
//   - a default for storage.objects.id, so INSERTs that don't supply an id work
//     (lite declares the column without a default);
//   - storage.foldername(), which path-scoped RLS policies use;
//   - RLS enabled with no policies, how a real project ships;
//   - grants so the API roles reach policy evaluation instead of failing on
//     table permissions.
// Applied right after getStorageSchemaSql() in ProjectInstance.init().
export const STORAGE_SCHEMA_SUPPLEMENT_SQL = `
ALTER TABLE storage.objects ALTER COLUMN id SET DEFAULT gen_random_uuid();

CREATE FUNCTION storage.foldername(name text) RETURNS text[]
    LANGUAGE plpgsql
    AS $$
DECLARE
_parts text[];
BEGIN
	select string_to_array(name, '/') into _parts;
	return _parts[1:array_length(_parts,1)-1];
END
$$;

ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT ALL ON storage.buckets TO anon, authenticated, service_role;
GRANT ALL ON storage.objects TO anon, authenticated, service_role;
`;
