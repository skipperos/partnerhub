$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (!(Test-Path 'server\.env')) { throw 'Missing server\.env. Run .\prepare-local.ps1, then fill in environment variables.' }
node --env-file=server/.env --watch server/src/index.js
