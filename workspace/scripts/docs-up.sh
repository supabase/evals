#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
supabase start --workdir supabase \
  -x realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor

# Upstream page migrations grant service_role only Dxt (no CRUD). The new secret
# key authenticates as service_role and bypasses RLS but NOT SQL GRANTs, so the
# embedder (service_role) can't write the content tables. Grant CRUD locally
# (idempotent; native psql is absent on this host, so run it in the db container).
docker exec supabase_db_eval-workspace-content psql -U postgres -d postgres -q -c \
  "GRANT ALL ON public.page, public.page_section TO service_role; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role; GRANT SELECT ON public.page, public.page_section TO anon, authenticated;"
