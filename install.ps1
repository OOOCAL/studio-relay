# studio-relay installer for Windows. Run from the unzipped folder in PowerShell:
#   powershell -ExecutionPolicy Bypass -File install.ps1
# (If you installed the .mcpb file in Claude Desktop you do not need this script.)
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dest = Join-Path $env:APPDATA "studio-relay"
$CepDir = Join-Path $env:APPDATA "Adobe\CEP\extensions"
$ClaudeCfg = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"

Write-Host "== studio-relay installation =="

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host "Node.js not found. Install the LTS from https://nodejs.org and run this again."; exit 1 }
$major = [int](& $node -p "process.versions.node.split('.')[0]")
if ($major -lt 18) { Write-Host "Node.js 18+ required."; exit 1 }
$npm = Join-Path (Split-Path $node) "npm.cmd"
Write-Host "Node: $node"

# server (+ a copy of the panel, so the server can keep it up to date)
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item "$Here\server.js","$Here\package.json" $Dest -Force
if (Test-Path "$Here\package-lock.json") { Copy-Item "$Here\package-lock.json" $Dest -Force }
if (Test-Path "$Dest\cep") { Remove-Item "$Dest\cep" -Recurse -Force }
Copy-Item "$Here\cep" "$Dest\cep" -Recurse
Push-Location $Dest; & $npm install --omit=dev --no-audit --no-fund --silent; Pop-Location
Write-Host "Server: $Dest"

# CEP panel
New-Item -ItemType Directory -Force -Path $CepDir | Out-Null
$panel = Join-Path $CepDir "com.orkun.studiorelay"
if (Test-Path $panel) { Remove-Item $panel -Recurse -Force }
$legacy = Join-Path $CepDir "com.orkun.adobebridge"   # old name
if (Test-Path $legacy) { Remove-Item $legacy -Recurse -Force }
Copy-Item "$Here\cep\com.orkun.studiorelay" $panel -Recurse
Write-Host "Panel: $panel"

# allow unsigned panels
foreach ($v in 9..15) { reg add "HKCU\Software\Adobe\CSXS.$v" /v PlayerDebugMode /t REG_SZ /d 1 /f | Out-Null }
Write-Host "PlayerDebugMode = 1"

# Claude Desktop config (merged; backup written)
New-Item -ItemType Directory -Force -Path (Split-Path $ClaudeCfg) | Out-Null
if (Test-Path $ClaudeCfg) { Copy-Item $ClaudeCfg "$ClaudeCfg.bak-$(Get-Date -Format yyyyMMddHHmmss)" }
& $node -e @'
const fs = require("fs");
const [cfgPath, node, server] = process.argv.slice(1);
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch {}
cfg.mcpServers = cfg.mcpServers || {};
delete cfg.mcpServers["adobe-bridge"]; // old name
cfg.mcpServers["studio-relay"] = { command: node, args: [server] };
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
'@ $ClaudeCfg $node (Join-Path $Dest "server.js")
Write-Host "Claude Desktop: $ClaudeCfg"

Write-Host ""
Write-Host "Done:"
Write-Host "  1. Quit Claude completely (tray icon > Quit) and reopen it."
Write-Host "  2. Restart your Adobe apps."
Write-Host "  3. Window > Extensions > Studio Relay: green dot = connected."
