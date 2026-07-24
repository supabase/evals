#!/usr/bin/env bash
# Self-test for status.sh's Next/Ready diagnosis. Runs the WORKING-TREE script
# against synthetic workspace states in a temp dir (never touches this one).
# USER=nobody forces keychain misses so results don't depend on real keys.
set -euo pipefail
cd "$(dirname "$0")/../.."
SRC="$PWD"

pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1 (want[$3] got[$2])"; fi; }

run_case() { # $1 = label, $2 = state-builder function; output -> /tmp/status_case.out
  local tmp; tmp="$(mktemp -d /tmp/eval-ws-status-XXXXXX)"
  mkdir -p "$tmp/workspace/scripts" "$tmp/bin"
  cp "$SRC/workspace/scripts/status.sh" "$SRC/workspace/scripts/patches-lib.sh" "$SRC/workspace/scripts/manifest.mjs" "$tmp/workspace/scripts/"
  cp "$SRC/workspace/manifest.json" "$tmp/workspace/"
  cp "$SRC/.env.example" "$tmp/"
  # This checkout IS the host repo in real usage — fake the marker so the
  # host row never misreports "not cloned" while a case exercises other gaps.
  mkdir -p "$tmp/.git"
  # OS-deterministic: default to Darwin regardless of host; a case may overwrite bin/uname.
  printf '#!/bin/sh\necho Darwin\n' > "$tmp/bin/uname"; chmod +x "$tmp/bin/uname"
  ( cd "$tmp" && "$2" )
  ( cd "$tmp" && USER=nobody PATH="$PWD/bin:$PATH" bash workspace/scripts/status.sh 2>/dev/null ) > /tmp/status_case.out
  rm -rf "$tmp"
}
has() { grep -qF -- "$1" /tmp/status_case.out && echo y || echo n; }

# --- fresh: nothing set up ---
state_fresh() { :; }
run_case fresh state_fresh
ck "fresh: suggests pnpm install"   "$(has 'pnpm install')" y
ck "fresh: suggests submodule init" "$(has 'submodule update --init')" y
ck "fresh: suggests required keys"  "$(has 'mise run store-key OPENAI_API_KEY')" y
ck "fresh: not Ready"               "$(has 'Ready. Try:')" n

# --- deps installed, submodules not yet initialized ---
state_deps_only() { mkdir -p node_modules; cp .env.example .env; }
run_case deps-only state_deps_only
ck "deps-only: no pnpm-install suggestion" "$(has 'pnpm install')" n
ck "deps-only: suggests submodule init"    "$(has 'submodule update --init')" y
ck "deps-only: not Ready"                  "$(has 'Ready. Try:')" n

# --- submodules initialized (markers/hooks still missing), env missing ---
state_submodules_init() { mkdir -p node_modules submodules/agent-skills/.git submodules/mcp/.git; }
run_case submodules-init state_submodules_init
ck "submodules-init: no pnpm-install suggestion"    "$(has 'pnpm install')" n
ck "submodules-init: no submodule-init suggestion"  "$(has 'submodule update --init')" n
ck "submodules-init: suggests required keys"        "$(has 'mise run store-key ANTHROPIC_API_KEY')" y
ck "submodules-init: not Ready"                     "$(has 'Ready. Try:')" n
# supabase was never cloned in this state — its absence must stay informational,
# never surfacing an action item (there is no clone-docs step in the bootstrap order).
ck "submodules-init: supabase absence isn't an action item" "$(has 'clone-docs')" n

# --- complete workspace state (deps + submodules + env), only plumbing/keys stay open ---
state_keys_only() { mkdir -p node_modules submodules/agent-skills/.git submodules/mcp/.git; cp .env.example .env; }
run_case keys-only state_keys_only
ck "keys-only: no pnpm-install suggestion"   "$(has 'pnpm install')" n
ck "keys-only: no submodule-init suggestion" "$(has 'submodule update --init')" n
ck "keys-only: suggests keys"                "$(has 'mise run store-key ANTHROPIC_API_KEY')" y
ck "keys-only: not Ready"                    "$(has 'Ready. Try:')" n

# --- non-Darwin: same complete-but-keyless state; keys must route to .env, never store-key ---
state_linux_keys() { state_keys_only; printf '#!/bin/sh\necho Linux\n' > bin/uname; }
run_case linux-keys state_linux_keys
ck "linux: no store-key suggestion" "$(has 'mise run store-key')" n
ck "linux: routes keys to .env"     "$(has 'add ANTHROPIC_API_KEY=')" y
ck "linux: not Ready"               "$(has 'Ready. Try:')" n

echo "status.test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
