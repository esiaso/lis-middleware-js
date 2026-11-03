<#
  Install or upgrade the LIMS middleware from an extracted release bundle (11 §3).
  Run in an elevated PowerShell from the bundle folder:
    .\scripts\install.ps1 -Instruments e411-01,c111-01
  It registers services but does NOT start them, and never touches the database.

  Needs WinSW v2 (x64) as service\WinSW-x64.exe in the bundle. It is not built
  here; the release builder copies it in with --winsw, after its checksum has
  been checked against the WinSW release page.
  STATUS: written against the design; not yet run on a Windows server.
#>
[CmdletBinding()]
param(
  [string[]]$Instruments = @(),
  [string]$Prefix = "$env:ProgramFiles\LIMS Middleware",
  [string]$Data = "$env:ProgramData\LIMS Middleware"
)
$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Error "install: $msg"; exit 1 }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'run as administrator' }

$bundle = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
foreach ($id in $Instruments) { if ($id -notmatch '^[a-z0-9][a-z0-9-]{2,39}$') { Fail "invalid instrument id '$id'" } }

Write-Host 'Checking the bundle against SHA256SUMS...'
$bad = @()
foreach ($line in Get-Content (Join-Path $bundle 'SHA256SUMS')) {
  if ($line -notmatch '^([0-9a-f]{64}) [ *](.+)$') { $bad += "unreadable line"; continue }
  $file = Join-Path $bundle ($Matches[2] -replace '/', '\')
  if (-not (Test-Path -LiteralPath $file)) { $bad += "$($Matches[2]) missing"; continue }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLower() -ne $Matches[1]) { $bad += "$($Matches[2]) changed" }
}
if ($bad.Count) { Fail "checksum mismatch, do not install this copy: $($bad[0..4] -join '; ')" }

$winsw = Join-Path $bundle 'service\WinSW-x64.exe'
if (-not (Test-Path $winsw)) { Fail 'service\WinSW-x64.exe is missing from the bundle' }

$version = (Get-Content (Join-Path $bundle 'manifest.json') -Raw | ConvertFrom-Json).version
$target = Join-Path $Prefix $version
Write-Host "Installing version $version to $target"
New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
if ($bundle -ne $target) {
  if (Test-Path $target) { Fail "$target already exists; remove it first if you mean to reinstall the same version" }
  Copy-Item -Recurse -Path $bundle -Destination $target
}

foreach ($d in 'config', 'logs', 'archive', 'secrets') { New-Item -ItemType Directory -Force -Path (Join-Path $Data $d) | Out-Null }
$cfg = Join-Path $Data 'config\lims.env.example'
Copy-Item -Force (Join-Path $target 'config\lims.env.example') $cfg

# Services, each under its own virtual account (NT SERVICE\<id>).
$services = @('lims-web', 'lims-jobs') + ($Instruments | ForEach-Object { "lims-analyzer-$_" })
$svcDir = Join-Path $target 'service'
$template = Get-Content (Join-Path $svcDir 'lims-analyzer.xml.template') -Raw
foreach ($id in $Instruments) { Set-Content -Encoding UTF8 -Path (Join-Path $svcDir "lims-analyzer-$id.xml") -Value ($template -replace '__INSTRUMENT__', $id) }

# "current" points at the new version only after it is fully in place.
$current = Join-Path $Prefix 'current'
if (Test-Path $current) { (Get-Item $current).Delete() }
New-Item -ItemType Junction -Path $current -Target $target | Out-Null
$currentSvc = Join-Path $current 'service'

foreach ($svc in $services) {
  Copy-Item -Force $winsw (Join-Path $svcDir "$svc.exe")
  $exe = Join-Path $currentSvc "$svc.exe"
  if (Get-Service -Name $svc -ErrorAction SilentlyContinue) {
    Write-Host "$svc already registered; it now runs from $current"
  } else {
    & $exe install | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail "could not register $svc" }
  }
  & sc.exe config $svc obj= "NT SERVICE\$svc" | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "could not set the account for $svc" }
}

# Logs writable by the services; secrets readable by the services and administrators only.
foreach ($svc in $services) {
  & icacls (Join-Path $Data 'logs') /grant "NT SERVICE\${svc}:(OI)(CI)M" | Out-Null
  & icacls (Join-Path $Data 'secrets') /grant "NT SERVICE\${svc}:(OI)(CI)R" | Out-Null
}
& icacls (Join-Path $Data 'secrets') /inheritance:r /grant 'BUILTIN\Administrators:(OI)(CI)F' 'NT AUTHORITY\SYSTEM:(OI)(CI)F' | Out-Null

Write-Host @"

Installed $version. Nothing was started. Next (11 §3 steps 3 to 8):
  1. Put the database URL in $Data\secrets\database_url
  2. $current\bin\lims.cmd db migrate
  3. $current\bin\lims-web.cmd create-user <username> "<display name>" admin < password-file   (first install only)
  4. $current\bin\lims.cmd verify --out "$Data\logs"
  5. Start-Service lims-jobs, lims-web, then each lims-analyzer-<id>
On an upgrade, stop the services before step 2 and start them after step 4 (11 §9).
"@
