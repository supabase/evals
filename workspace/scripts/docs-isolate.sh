#!/usr/bin/env bash
# Give THIS worktree its own docs stack (project id + port block + docs-api
# port) so docs runs in parallel sessions never share a DB or API.
#
# usage: workspace/scripts/docs-isolate.sh [slot]   # slot 1-9; default: allocate
#
# Slot allocation goes through a machine-shared registry
# (~/.local/state/eval-workspace/docs-slots.json) under an atomic mkdir lock,
# keyed by canonical worktree path — two sessions isolating concurrently can
# never pick the same slot (a docker-only scan would race: the container
# appears at docs-up, not at isolate). Re-running returns your existing slot;
# entries for deleted worktrees are pruned on allocation.
#
# Writes an UNTRACKED overlay workdir (workspace/.docs-stack, git-ignored):
# a rewritten config.toml plus symlinks to the submodule's migrations/seed/
# functions/buckets. No tracked file in any clone is touched — your in-flight
# work stays byte-for-byte untouched. Every docs script picks the overlay up
# automatically (docs-profile.sh). Symlinks track the submodule live, so
# patch/content updates flow through without regeneration.
#
# After isolating, seed this stack for free from a sibling's warm index:
#   mise run docs-up && workspace/scripts/docs-copy-index.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

src=submodules/supabase/supabase
[ -f "$src/config.toml" ] || { echo "no docs submodule config at $src — run: mise run clone-docs" >&2; exit 1; }

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/eval-workspace"
REG="$STATE_DIR/docs-slots.json"
LOCK="$STATE_DIR/docs-slots.lock"
mkdir -p "$STATE_DIR"

# atomic mkdir lock (no flock on stock macOS); stale after 60s = crashed holder
for _i in $(seq 1 60); do
  mkdir "$LOCK" 2>/dev/null && break
  [ "$_i" = 60 ] && { echo "slot registry locked for 60s ($LOCK) — remove it if no other isolate is running" >&2; exit 1; }
  sleep 1
done
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

slot=$(WANT="${1:-}" REG="$REG" WT="$(pwd -P)" node -e '
const fs = require("fs");
const { WANT, REG, WT } = process.env;
let reg = {};
try { reg = JSON.parse(fs.readFileSync(REG, "utf8")); } catch {}
// prune slots whose worktree no longer exists
for (const [s, p] of Object.entries(reg)) if (!fs.existsSync(p)) delete reg[s];
const mine = Object.entries(reg).find(([, p]) => p === WT)?.[0];
let slot;
if (WANT) {
  if (!/^[1-9]$/.test(WANT)) { console.error("slot must be 1-9 (slot 0 = the primary worktree default)"); process.exit(2); }
  if (reg[WANT] && reg[WANT] !== WT) { console.error(`slot ${WANT} is taken by ${reg[WANT]}`); process.exit(1); }
  if (mine && mine !== WANT) delete reg[mine];
  slot = WANT;
} else if (mine) {
  slot = mine;
} else {
  slot = [1,2,3,4,5,6,7,8,9].find((s) => !reg[s]);
  if (!slot) { console.error("all 9 slots taken: " + JSON.stringify(reg, null, 1)); process.exit(1); }
}
reg[slot] = WT;
fs.writeFileSync(REG, JSON.stringify(reg, null, 1) + "\n");
console.log(String(slot));
')

ov=workspace/.docs-stack/supabase
mkdir -p "$ov"
for f in buckets functions migrations seed.sql; do
  ln -sfn "../../../submodules/supabase/supabase/$f" "$ov/$f"
done

SLOT="$slot" node -e '
const fs = require("fs");
const slot = Number(process.env.SLOT);
let t = fs.readFileSync(process.argv[1], "utf8");
t = t.replace(/^project_id = ".*"$/m, `project_id = "eval-workspace-content-${slot}"`);
t = t.replace(/^port = 55[0-9]([0-9][0-9])$/gm, (_, tail) => `port = ${55300 + 100 * slot + Number(tail)}`);
fs.writeFileSync(process.argv[2], t);
' "$src/config.toml" "$ov/config.toml"

source workspace/scripts/docs-profile.sh
echo "isolated (slot $slot): workdir=$CONTENT_WORKDIR project_id=$CONTENT_PROJECT_ID api=$CONTENT_API_PORT docs-api=$DOCS_API_PORT"
echo "next: mise run docs-up && workspace/scripts/docs-copy-index.sh   # free seed from a sibling stack"
