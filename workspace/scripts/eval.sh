#!/usr/bin/env bash
# Run evals with the workspace env applied. All args pass through to `pnpm eval`.
# API keys come from the macOS keychain if present (see README), else the repo-root .env.
# e.g. workspace/scripts/eval.sh --eval investigate-auth-001 --experiment claude-code-sonnet-5
set -euo pipefail
cd "$(dirname "$0")/../.."

[ -e .env ] || { echo ".env missing — run: mise run setup" >&2; exit 1; }
source workspace/scripts/load-keys.sh
pnpm eval "$@"
