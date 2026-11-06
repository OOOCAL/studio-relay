#!/bin/bash
# Removes adobe-bridge from this Mac (server, panel, Claude Desktop entry).
set -e
DEST="$HOME/Library/Application Support/adobe-bridge"
PANEL="$HOME/Library/Application Support/Adobe/CEP/extensions/com.orkun.adobebridge"
CLAUDE_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

rm -rf "$DEST" "$PANEL"
if [ -f "$CLAUDE_CFG" ] && command -v node >/dev/null 2>&1; then
  cp "$CLAUDE_CFG" "$CLAUDE_CFG.bak-$(date +%Y%m%d%H%M%S)"
  node -e '
const fs = require("fs"); const p = process.argv[1];
const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
if (cfg.mcpServers) delete cfg.mcpServers["adobe-bridge"];
fs.writeFileSync(p, JSON.stringify(cfg, null, 2));' "$CLAUDE_CFG"
fi
command -v claude >/dev/null 2>&1 && claude mcp remove --scope user adobe-bridge >/dev/null 2>&1 || true
echo "adobe-bridge kaldırıldı / removed. (PlayerDebugMode was left on; turn it off with: defaults delete com.adobe.CSXS.12 PlayerDebugMode)"
