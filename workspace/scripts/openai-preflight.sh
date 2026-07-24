#!/usr/bin/env bash
# Fail fast if OPENAI_API_KEY can't run embeddings, with a message specific to
# the failure kind (credential vs quota vs service vs network) so a transient
# outage doesn't send you into a needless key replacement. One ~1-token call,
# effectively free. Reads OPENAI_API_KEY from the environment. Used by
# docs-seed.sh and docs-index.sh.
set -euo pipefail
: "${OPENAI_API_KEY:?OPENAI_API_KEY is required}"

code=$(curl -s -o /dev/null -w '%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  https://api.openai.com/v1/embeddings \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"text-embedding-ada-002","input":"preflight"}') || code="000"

case "$code" in
  200) ;;
  401|403)
    echo "ERROR: OpenAI rejected the key (HTTP $code) — truncated / invalid / wrong scope." >&2
    echo 'Re-add the full key (hidden prompt, truncation-safe, any shell):' >&2
    echo '  mise run store-key OPENAI_API_KEY' >&2
    exit 1 ;;
  429)
    echo "ERROR: OpenAI rate/quota limit (HTTP 429) — key is valid but rate-limited or out of quota. Retry later / check billing." >&2
    exit 1 ;;
  5??)
    echo "ERROR: OpenAI service error (HTTP $code) — transient, retry shortly. The key is not necessarily bad." >&2
    exit 1 ;;
  000)
    echo "ERROR: could not reach api.openai.com (network / DNS / timeout). Check connectivity; the key is not necessarily bad." >&2
    exit 1 ;;
  *)
    echo "ERROR: unexpected OpenAI response (HTTP $code)." >&2
    exit 1 ;;
esac
