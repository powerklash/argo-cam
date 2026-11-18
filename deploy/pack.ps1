# Crea dist\cam-app.tar.gz con il codice dell'app (senza dati, binari, node_modules).
#   powershell -File deploy\pack.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$out = Join-Path $dist 'cam-app.tar.gz'
if (Test-Path $out) { Remove-Item $out }

Push-Location $root
try {
  $items = @('server.js', 'package.json', 'package-lock.json', 'README.md', 'lib', 'public', 'tools', 'deploy')
  tar -czf $out --exclude=node_modules --exclude=*.log --exclude=dist @items
  if ($LASTEXITCODE -ne 0) { throw 'tar non è riuscito' }
} finally { Pop-Location }

$size = [math]::Round((Get-Item $out).Length / 1KB)
"Creato $out ($size KB)"
