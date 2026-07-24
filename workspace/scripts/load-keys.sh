#!/usr/bin/env bash
# Export API keys from the macOS login keychain into the calling shell, so eval
# runs use them without a plaintext copy in .env. Keys not in the keychain are
# skipped; .env stays the fallback. Exported env beats node's --env-file, so a
# keychain value takes precedence when both exist.
#
# Usage:      source scripts/load-keys.sh          (the eval recipes do this)
#   Running it directly is harmless — it only exports into its own child shell
#   and prints nothing, so secrets never reach stdout/scrollback.
# Add a key:  mise run store-key ANTHROPIC_API_KEY   (hidden prompt; never the bare
#   interactive `security -w` — it truncates pasted input at 128 chars)
# Check one:  security find-generic-password -a "$USER" -s eval-workspace:OPENAI_API_KEY >/dev/null && echo present

for key in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY; do
  if value=$(security find-generic-password -a "$USER" -s "eval-workspace:$key" -w 2>/dev/null); then
    export "$key=$value"
  fi
done
