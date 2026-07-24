#!/usr/bin/env bash
# Store an API key in the macOS keychain (item eval-workspace:<KEY>), reading the
# value with a hidden prompt. Run via `mise run store-key <KEY>` — the bash
# shebang makes it work no matter the caller's shell (zsh's `read -p` differs).
#
# Why not the interactive `security -w` prompt: it silently truncates pasted
# input at 128 chars, producing invalid keys. Reading into a variable and
# passing it as an argument is immune, and the value never reaches shell
# history or stdout.
set -euo pipefail

KEY="${1:-}"
case "$KEY" in
  ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY) ;;
  *) echo "usage: mise run store-key <ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY>" >&2; exit 2 ;;
esac

if [ "$(uname -s)" != Darwin ]; then
  echo "store-key uses the macOS keychain — not available on this platform." >&2
  echo "Add ${KEY}=<value> to the git-ignored .env instead (see README \"Credentials\")." >&2
  exit 2
fi

read -rsp "$KEY (input hidden): " value; echo
[ -n "$value" ] || { echo "empty value — nothing stored" >&2; exit 1; }
len=${#value}
security add-generic-password -U -a "$USER" -s "eval-workspace:$KEY" -w "$value"
unset value
echo "stored eval-workspace:$KEY ($len chars)"
