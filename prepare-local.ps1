$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (!(Test-Path 'server\.env')) { Copy-Item 'server\.env.example' 'server\.env' }
if (!(Test-Path 'web\.env')) { Copy-Item 'web\.env.example' 'web\.env' }
Write-Host 'Environment templates are ready. Edit server\.env and web\.env before starting.' -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) { throw 'npm install failed. Check Node 20+ and network access.' }
Write-Host 'Dependencies installed.' -ForegroundColor Green
Write-Host 'Open two windows. Run .\start-server-local.ps1 in one and npm run dev:web in the other.'
