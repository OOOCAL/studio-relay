#!/bin/bash
# adobe-bridge installer for macOS. Run from the unzipped folder:  bash install.sh
# (If you installed the .mcpb file in Claude Desktop you do not need this script.)
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/adobe-bridge"
CEP_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
CLAUDE_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

echo "== adobe-bridge kurulumu / installation =="

# 1) Node.js 18+
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do [ -x "$p" ] && NODE="$p" && break; done
fi
if [ -z "$NODE" ]; then
  echo "Node.js bulunamadı / not found. Install the LTS from https://nodejs.org and run this again."
  exit 1
fi
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 18 ]; then echo "Node.js 18+ gerekli / required (found $("$NODE" -v))."; exit 1; fi
NPM="$(dirname "$NODE")/npm"
echo "Node: $NODE ($("$NODE" -v))"

# 2) server (+ a copy of the panel, so the server can keep it up to date)
mkdir -p "$DEST"
cp "$HERE/server.js" "$HERE/package.json" "$DEST/"
[ -f "$HERE/package-lock.json" ] && cp "$HERE/package-lock.json" "$DEST/"
rm -rf "$DEST/cep" && cp -R "$HERE/cep" "$DEST/cep"
(cd "$DEST" && "$NPM" install --omit=dev --no-audit --no-fund --silent)
echo "Sunucu / server: $DEST"

# 3) CEP panel (one extension for AE, Premiere, Photoshop, Illustrator, InDesign, Audition)
mkdir -p "$CEP_DIR"
rm -rf "$CEP_DIR/com.orkun.adobebridge"
cp -R "$HERE/cep/com.orkun.adobebridge" "$CEP_DIR/"
echo "Panel: $CEP_DIR/com.orkun.adobebridge"

# 4) allow unsigned panels (CEP debug mode)
for v in 9 10 11 12 13 14 15; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done
echo "PlayerDebugMode = 1"

# 5) Claude Desktop config (merged; other servers are kept, a backup is written)
mkdir -p "$(dirname "$CLAUDE_CFG")"
[ -f "$CLAUDE_CFG" ] && cp "$CLAUDE_CFG" "$CLAUDE_CFG.bak-$(date +%Y%m%d%H%M%S)"
"$NODE" -e '
const fs = require("fs");
const [cfgPath, node, server] = process.argv.slice(1);
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch {}
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers["adobe-bridge"] = { command: node, args: [server] };
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
' "$CLAUDE_CFG" "$NODE" "$DEST/server.js"
echo "Claude Desktop: $CLAUDE_CFG"

# 6) Claude Code (optional)
if command -v claude >/dev/null 2>&1; then
  claude mcp add --scope user adobe-bridge -- "$NODE" "$DEST/server.js" 2>/dev/null && echo "Claude Code: eklendi / added" || true
fi

cat <<EOF

Tamam / Done:
  1. Claude'u tamamen kapatıp aç (Cmd+Q)  ·  Quit and reopen Claude (Cmd+Q).
  2. Adobe programlarını yeniden başlat  ·  Restart your Adobe apps.
  3. Window > Extensions > Adobe Bridge (Claude): yeşil nokta = bağlı  ·  green dot = connected.
EOF
