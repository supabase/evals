#!/usr/bin/env bash
# List available experiments (experiments/*.ts): agent, model, reasoning
# effort, and whether evals main has a published row for it (vs-main compare
# mode needs one; anything else works with --no-compare or mise run ab).
set -euo pipefail
cd "$(dirname "$0")/../.."

published=$(node -e '
const { execFileSync } = require("child_process");
const s = new Set();
for (const f of ["apps/web/src/data/regression-eval-results.json", "apps/web/src/data/eval-results.json"]) {
  try { for (const r of JSON.parse(execFileSync("git", ["show", `origin/main:${f}`], { maxBuffer: 1 << 28 }))) s.add(r.experiment); }
  catch {}
}
console.log([...s].join(" "));
' 2>/dev/null || true)

printf '%-36s %-13s %-22s %-8s %s\n' EXPERIMENT AGENT MODEL EFFORT PUBLISHED
for f in experiments/*.ts; do
  name=$(basename "$f" .ts)
  agent=$(sed -n 's/.*agent: \([a-zA-Z]*\)Agent(.*/\1/p' "$f" | head -1)
  model=$(sed -n "s/.*model: \([a-z]*(\)\{0,1\}'\([^']*\)'.*/\2/p" "$f" | head -1)
  case " $published " in
    *" $name "*) pub="yes (vs-main)" ;;
    *) pub="-" ;;
  esac
  printf '%-36s %-13s %-22s %-8s %s\n' "$name" "${agent:-?}" "${model:-?}" "${effort:--}" "$pub"
done
