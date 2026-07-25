#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
source workspace/scripts/docs-profile.sh
supabase stop --workdir "$CONTENT_WORKDIR"
