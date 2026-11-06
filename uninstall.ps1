# Removes adobe-bridge from this PC (server, panel, Claude Desktop entry).
$ErrorActionPreference = "SilentlyContinue"
Remove-Item (Join-Path $env:APPDATA "adobe-bridge") -Recurse -Force
Remove-Item (Join-Path $env:APPDATA "Adobe\CEP\extensions\com.orkun.adobebridge") -Recurse -Force
$cfg = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
if ((Test-Path $cfg) -and (Get-Command node)) {
  Copy-Item $cfg "$cfg.bak-$(Get-Date -Format yyyyMMddHHmmss)"
  node -e "const fs=require('fs');const p=process.argv[1];const c=JSON.parse(fs.readFileSync(p,'utf8'));if(c.mcpServers)delete c.mcpServers['adobe-bridge'];fs.writeFileSync(p,JSON.stringify(c,null,2));" $cfg
}
Write-Host "adobe-bridge removed."
