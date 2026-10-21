# Builds dist\live-galaxy-<version>.zip containing the three plugin files (never data.json).
$repo = Split-Path -Parent $PSScriptRoot
$ver = (Get-Content "$repo\manifest.json" -Raw | ConvertFrom-Json).version
$dist = "$repo\dist"
New-Item -ItemType Directory -Force $dist | Out-Null
$zip = "$dist\live-galaxy-$ver.zip"
Remove-Item $zip -ErrorAction SilentlyContinue
Compress-Archive -Path "$repo\main.js", "$repo\manifest.json", "$repo\styles.css" -DestinationPath $zip
"Built $zip"
