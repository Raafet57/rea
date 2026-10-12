#!/usr/bin/env bash
# Start the REA connector and (optionally) a Cloudflare tunnel so Claude can reach it.
#
#   ./connector/start.sh            # bridge + quick tunnel (random trycloudflare.com URL)
#   ./connector/start.sh --local    # bridge only, on 127.0.0.1
#   CLOUDFLARE_TUNNEL=rea ./connector/start.sh   # bridge + your named tunnel
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN_FILE="${REA_CONNECTOR_TOKEN_FILE:-$HOME/.config/rea-connector/token}"
PORT="${REA_CONNECTOR_PORT:-8787}"
export REA_CONNECTOR_PORT="$PORT"

# Reuse one token across restarts so the Claude connector keeps working.
if [[ -z "${REA_CONNECTOR_TOKEN:-}" ]]; then
  if [[ ! -s "$TOKEN_FILE" ]]; then
    mkdir -p "$(dirname "$TOKEN_FILE")"
    (umask 077 && openssl rand -hex 32 > "$TOKEN_FILE")
    echo "Generated a new connector token in $TOKEN_FILE"
  fi
  REA_CONNECTOR_TOKEN="$(cat "$TOKEN_FILE")"
fi
export REA_CONNECTOR_TOKEN

# Build REA from this checkout if needed; otherwise the bridge falls back to npx.
if [[ -f "$HERE/../package.json" && ! -f "$HERE/../dist/main.js" && -z "${REA_COMMAND:-}" ]]; then
  echo "Building REA (first run)…"
  (cd "$HERE/.." && npm ci && npm run build:cached)
fi

node "$HERE/rea-connector.mjs" &
BRIDGE_PID=$!
# Stop the bridge and tunnel together when this script exits.
trap 'trap - EXIT INT TERM; kill 0 2>/dev/null' EXIT INT TERM
sleep 1

cat <<EOF

────────────────────────────────────────────────────────────
 REA connector running on http://127.0.0.1:$PORT/mcp
 Header for Claude →  Authorization: Bearer $REA_CONNECTOR_TOKEN
────────────────────────────────────────────────────────────
EOF

if [[ "${1:-}" == "--local" ]]; then
  wait $BRIDGE_PID
  exit
fi

if ! command -v cloudflared >/dev/null; then
  echo "cloudflared not found. Install it (brew install cloudflared) or expose port $PORT another way."
  wait $BRIDGE_PID
  exit
fi

if [[ -n "${CLOUDFLARE_TUNNEL:-}" ]]; then
  cloudflared tunnel run --url "http://127.0.0.1:$PORT" "$CLOUDFLARE_TUNNEL" &
  echo " Named tunnel '$CLOUDFLARE_TUNNEL' started. Connector URL: https://<your-hostname>/mcp"
else
  echo " Starting quick tunnel — the public URL appears below (append /mcp)."
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" 2>&1 \
    | grep --line-buffered -oE 'https://[a-z0-9-]+\.trycloudflare\.com' \
    | sed -u 's#$#/mcp   ← paste this as the connector URL#' &
fi

wait $BRIDGE_PID
