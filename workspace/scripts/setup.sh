#!/usr/bin/env bash
# Install deps, init submodules (agent-skills + mcp), apply patches, wire
# .env, print status. Idempotent: safe to re-run any time.
set -euo pipefail

cd "$(dirname "$0")/../.."

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }

# --- required tooling ---
for bin in git pnpm; do
  command -v "$bin" >/dev/null || { warn "missing required tool: $bin"; exit 1; }
done
if command -v docker >/dev/null; then
  docker info >/dev/null 2>&1 || warn "docker installed but not running — start it before sandbox-runtime evals."
else
  warn "docker not found — sandbox-runtime evals need it (tools-mode evals don't)."
fi

# --- deps ---
if [ -d node_modules ]; then
  log "node_modules present — skipping install."
else
  log "Installing deps (corepack + pnpm install)…"
  corepack enable >/dev/null 2>&1 || true
  pnpm install
fi

# --- submodules: agent-skills + mcp (supabase clone stays opt-in) ---
log "Syncing submodules (agent-skills, mcp)…"
git submodule update --init submodules/agent-skills submodules/mcp

# --- enabler plumbing: marker commits + pre-push guards (idempotent) ---
workspace/scripts/apply-patches.sh

# --- .env ---
if [ -f .env ]; then
  log ".env already exists — leaving it."
else
  cp .env.example .env
  log "Created .env from .env.example — fill in your API keys."
fi
if [ "$(uname -s)" = Darwin ]; then
  log "Tip: store keys in the keychain instead of .env — mise run store-key <KEY>"
fi

log "Setup done. (Docs loop is optional and heavy — see: mise run clone-docs)"
echo
workspace/scripts/status.sh
