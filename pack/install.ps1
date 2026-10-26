#Requires -Version 7
param(
  [Parameter(Mandatory = $true)][string]$TeamWorkspace,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 20+ is required on PATH.' }
$major = [int](((& node --version) -replace '^v', '').Split('.')[0])
if ($major -lt 20) { throw "Node.js 20+ is required (found $major)." }
$arguments = @("$PSScriptRoot/scripts/install.mjs", '--team-workspace', $TeamWorkspace)
if ($Force) { $arguments += '--force' }
& node @arguments
exit $LASTEXITCODE
