#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
supabase stop --workdir submodules/supabase
