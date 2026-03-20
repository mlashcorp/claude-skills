#!/usr/bin/env bash
# Setup script for notion-autotrader plugin.
# Installs bun and cloudflared, and validates required env vars.
# Run this once after installing the plugin.

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✔${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC}  $1"; }
fail() { echo -e "${RED}✘${NC} $1"; }

echo ""
echo "notion-autotrader setup"
echo "========================"
echo ""

# --- Bun ---
if command -v bun &>/dev/null; then
  ok "bun $(bun --version) is installed"
else
  warn "bun not found — installing..."
  curl -fsSL https://bun.sh/install | bash
  # Reload PATH
  export PATH="$HOME/.bun/bin:$PATH"
  ok "bun installed — restart your shell or run: source ~/.bashrc"
fi

# --- cloudflared ---
if command -v cloudflared &>/dev/null; then
  ok "cloudflared $(cloudflared --version 2>&1 | head -1) is installed"
else
  warn "cloudflared not found — installing..."
  OS="$(uname -s)"
  ARCH="$(uname -m)"
  if [[ "$OS" == "Linux" ]]; then
    if [[ "$ARCH" == "x86_64" ]]; then
      curl -L "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb" -o /tmp/cloudflared.deb
      sudo dpkg -i /tmp/cloudflared.deb
    elif [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
      curl -L "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb" -o /tmp/cloudflared.deb
      sudo dpkg -i /tmp/cloudflared.deb
    else
      fail "Unsupported Linux architecture: $ARCH. Install cloudflared manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    fi
  elif [[ "$OS" == "Darwin" ]]; then
    if command -v brew &>/dev/null; then
      brew install cloudflare/cloudflare/cloudflared
    else
      fail "Homebrew not found. Install cloudflared manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
      exit 1
    fi
  else
    fail "Unsupported OS: $OS. Install cloudflared manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    exit 1
  fi
  ok "cloudflared installed"
fi

# --- Install bun dependencies ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo ""
echo "Installing webhook server dependencies..."
cd "$SCRIPT_DIR"
bun install --frozen-lockfile
ok "Dependencies installed"

# --- Environment variables ---
echo ""
echo "Environment variable check:"
if [ -n "$NOTION_WEBHOOK_SECRET" ]; then
  ok "NOTION_WEBHOOK_SECRET is set"
else
  fail "NOTION_WEBHOOK_SECRET is not set"
  echo "   Add to ~/.bashrc:  export NOTION_WEBHOOK_SECRET=\"your-webhook-signing-secret\""
fi

if [ -n "$NOTION_FILTER_TOKEN" ]; then
  ok "NOTION_FILTER_TOKEN is set"
else
  fail "NOTION_FILTER_TOKEN is not set"
  echo "   Add to ~/.bashrc:  export NOTION_FILTER_TOKEN=\"your-notion-integration-secret\""
fi

if [ -n "$CLAUDE_PROJECTS_ROOT" ]; then
  ok "CLAUDE_PROJECTS_ROOT is set to: $CLAUDE_PROJECTS_ROOT"
else
  warn "CLAUDE_PROJECTS_ROOT is not set — defaulting to ~/projects"
  echo "   Add to ~/.bashrc:  export CLAUDE_PROJECTS_ROOT=\"/path/to/your/projects\""
fi

# --- Managed settings check ---
echo ""
MANAGED_SETTINGS="/etc/claude-code/managed-settings.json"
if [ -f "$MANAGED_SETTINGS" ] && grep -q '"channelsEnabled".*true' "$MANAGED_SETTINGS" 2>/dev/null; then
  ok "channelsEnabled: true found in managed settings"
else
  fail "channelsEnabled not found in $MANAGED_SETTINGS"
  echo "   Claude Code channels must be enabled by an admin:"
  echo "   sudo bash -c 'cat > /etc/claude-code/managed-settings.json <<EOF"
  echo "   {\"channelsEnabled\": true}"
  echo "   EOF'"
fi

echo ""
echo "========================"
echo "Next steps:"
echo "  1. Fix any ✘ items above"
echo "  2. Start a Cloudflare tunnel: cloudflared tunnel --url http://localhost:8788"
echo "  3. Add the tunnel URL as a Notion webhook endpoint"
echo "  4. Launch Claude: claude --channels"
echo "  5. See docs/SETUP.md for the full guide"
echo ""
