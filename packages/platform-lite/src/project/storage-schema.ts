// Grants that @supabase/lite's storage schema omits, so the API roles reach
// policy evaluation. Applied after getStorageSchemaSql() in ProjectInstance.init().
export const STORAGE_SCHEMA_SUPPLEMENT_SQL = `
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT ALL ON storage.buckets TO anon, authenticated, service_role;
GRANT ALL ON storage.objects TO anon, authenticated, service_role;
`;
