#!/usr/bin/env bash
# Self-test for status.sh's Next/Ready diagnosis. Runs the WORKING-TREE script
# against synthetic workspace states in a temp dir (never touches this one).
# USER=nobody forces keychain misses so results don't depend on real keys.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="$PWD"

pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1 (want[$3] got[$2])"; fi; }

run_case() { # $1 = label, $2 = state-builder function; output -> /tmp/status_case.out
  local tmp; tmp="$(mktemp -d /tmp/eval-ws-status-XXXXXX)"
  mkdir -p "$tmp/scripts" "$tmp/bin"
  cp "$SRC/scripts/status.sh" "$SRC/scripts/patches-lib.sh" "$SRC/scripts/manifest.mjs" "$tmp/scripts/"
  cp "$SRC/manifest.json" "$SRC/.env.example" "$tmp/"
  # OS-deterministic: default to Darwin regardless of host; a case may overwrite bin/uname.
  printf '#!/bin/sh\necho Darwin\n' > "$tmp/bin/uname"; chmod +x "$tmp/bin/uname"
  ( cd "$tmp" && "$2" )
  ( cd "$tmp" && USER=nobody PATH="$PWD/bin:$PATH" bash scripts/status.sh 2>/dev/null ) > /tmp/status_case.out
  rm -rf "$tmp"
}
has() { grep -qF -- "$1" /tmp/status_case.out && echo y || echo n; }

# --- fresh clone: nothing set up ---
state_fresh() { :; }
run_case fresh state_fresh
ck "fresh: suggests setup"        "$(has 'mise run setup')" y
ck "fresh: suggests required keys" "$(has 'mise run store-key OPENAI_API_KEY')" y
ck "fresh: not Ready"             "$(has 'Ready.')" n

# --- partial: evals cloned, submodule + evals/.env missing (interrupted setup) ---
state_partial_submodule() { mkdir -p evals/.git; cp .env.example .env; }
run_case partial-submodule state_partial_submodule
ck "partial submodule: suggests setup" "$(has 'mise run setup')" y
ck "partial submodule: not Ready"      "$(has 'Ready.')" n

# --- partial: clone + submodule fine, evals/.env symlink missing ---
state_partial_env() { mkdir -p evals/.git evals/submodules/agent-skills/.git; cp .env.example .env; }
run_case partial-env state_partial_env
ck "partial env: suggests setup" "$(has 'mise run setup')" y
ck "partial env: not Ready"      "$(has 'Ready.')" n

# --- complete workspace, only keys missing: setup NOT suggested, keys are ---
state_keys_only() { mkdir -p evals/.git evals/submodules/agent-skills/.git; cp .env.example .env; ln -s ../.env evals/.env; }
run_case keys-only state_keys_only
ck "keys-only: no setup suggestion" "$(has 'mise run setup')" n
ck "keys-only: suggests keys"       "$(has 'mise run store-key ANTHROPIC_API_KEY')" y
ck "keys-only: not Ready"           "$(has 'Ready.')" n

# --- non-Darwin: same complete-but-keyless state; keys must route to .env, never store-key ---
state_linux_keys() { state_keys_only; printf '#!/bin/sh\necho Linux\n' > bin/uname; }
run_case linux-keys state_linux_keys
ck "linux: no store-key suggestion" "$(has 'mise run store-key')" n
ck "linux: routes keys to .env"     "$(has 'add ANTHROPIC_API_KEY=')" y
ck "linux: not Ready"               "$(has 'Ready.')" n

echo "status.test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
