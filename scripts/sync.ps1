# Copies plugin files between a vault install and this repo.
#   .\scripts\sync.ps1            vault -> repo (default; the vault is where it is edited and tested)
#   .\scripts\sync.ps1 -ToVault   repo -> vault
param(
  [switch]$ToVault,
  [string]$Vault = "C:\Users\1430507\OneDrive - Danaher\Documents\Obsidian\WurkObsAi\.obsidian\plugins\live-graph"
)
$repo = Split-Path -Parent $PSScriptRoot
foreach ($f in "main.js", "manifest.json", "styles.css") {
  if ($ToVault) { Copy-Item "$repo\$f" "$Vault\$f" -Force } else { Copy-Item "$Vault\$f" "$repo\$f" -Force }
  "$f copied"
}
