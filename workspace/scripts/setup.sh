#!/usr/bin/env bash
# Clone + wire the repos needed for the skills loop, install deps, print status.
# Idempotent: existing clones are left alone (pull them yourself).
set -euo pipefail

cd "$(dirname "$0")/.."
source scripts/patches-lib.sh

EVALS_REMOTE="${EVALS_REMOTE:-$(repo_remote evals)}"

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

# --- .env ---
if [ -f .env ]; then
  log ".env already exists — leaving it."
else
  cp .env.example .env
  log "Created .env from .env.example — fill in your API keys."
fi

# --- clone evals (with agent-skills submodule) ---
if [ -e evals/.git ]; then
  log "evals/ already cloned — skipping."
else
  log "Cloning evals (with agent-skills submodule)…"
  git clone --recurse-submodules "$EVALS_REMOTE" evals
fi

# Self-heal: ensure the agent-skills submodule is present even if evals was
# cloned earlier without --recurse-submodules (or a clone was interrupted).
log "Syncing submodules…"
git -C evals submodule update --init --recursive

# --- share one .env with evals ---
ln -sfn ../.env evals/.env
log "Symlinked .env → evals/.env"

# --- install deps ---
log "Installing evals deps (pnpm install)…"
( cd evals && pnpm install )

# --- enabler plumbing: marker commits + pre-push guards (idempotent) ---
scripts/apply-patches.sh

log "Setup done."
echo
scripts/status.sh
