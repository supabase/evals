#!/usr/bin/env bash
# Regenerate source.dump from source.sql.
# Run from anywhere; output lands in local/source.dump next to this script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="supabase-evals-fixture-$$"

docker run --rm --name "$CONTAINER" \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -d postgres:17.6

cleanup() { docker stop "$CONTAINER" > /dev/null 2>&1 || true; }
trap cleanup EXIT

echo "Waiting for Postgres to be ready..."
until docker exec "$CONTAINER" pg_isready -U postgres -q; do sleep 1; done

docker exec -i "$CONTAINER" psql -U postgres postgres < "$SCRIPT_DIR/source.sql"

docker exec "$CONTAINER" pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  -U postgres \
  postgres > "$SCRIPT_DIR/local/source.dump"

echo "Generated: $SCRIPT_DIR/local/source.dump"
