#!/usr/bin/env bash
# Wrapper that installs bun dependencies on first run, then starts the webhook server.
# Called by Claude Code via the mcpServers config in plugin.json.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Install dependencies if node_modules is missing
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "[notion-webhook] Installing dependencies..." >&2
  cd "$SCRIPT_DIR"
  bun install --frozen-lockfile >&2
fi

exec bun run "$SCRIPT_DIR/webhook.ts"
