# Deploy VibePin backend to Ubuntu VPS from Windows.
#
# Setup (one time):
#   copy deploy.env.example to deploy.env
#   fill VPS_PASSWORD (and adjust VPS_HOST if needed)
#
# Run:
#   cd backend\scripts
#   .\deploy_from_windows.ps1
#
# Paths are resolved from this script location (no hardcoded Chinese paths).

param(
    [string]$ServerIP,
    [string]$User,
    [string]$DeployRoot,
    [string]$BackendLocal = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"

function Read-DeployEnv {
    param([string]$Path)
    $vars = @{}
    if (-not (Test-Path $Path)) { return $vars }
    Get-Content $Path -Encoding UTF8 | ForEach-Object {
        # UTF8 with BOM handled by PowerShell; values may be quoted
        $line = $_.Trim()
        if ($line -eq "" -or $line.StartsWith("#")) { return }
        $idx = $line.IndexOf("=")
        if ($idx -lt 1) { return }
        $key = $line.Substring(0, $idx).Trim()
        $val = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
        $vars[$key] = $val
    }
    return $vars
}

$deployEnvPath = Join-Path $BackendLocal "deploy.env"
$cfg = Read-DeployEnv $deployEnvPath

if (-not $ServerIP) { $ServerIP = $cfg["VPS_HOST"] }
if (-not $User)     { $User     = $cfg["VPS_USER"] }
if (-not $DeployRoot) { $DeployRoot = $cfg["VPS_DEPLOY_ROOT"] }
$VpsPort     = if ($cfg["VPS_PORT"]) { $cfg["VPS_PORT"] } else { "22" }
$VpsPassword = $cfg["VPS_PASSWORD"]
$VpsLabel    = $cfg["VPS_LABEL"]

if (-not $ServerIP) { throw "Set VPS_HOST in deploy.env or pass -ServerIP" }
if (-not $User)     { $User = "root" }
if (-not $DeployRoot) { $DeployRoot = "/opt/vibepin" }

$RemoteBackend = "$DeployRoot/backend"

Write-Host "== VibePin VPS deploy ==" -ForegroundColor Cyan
if ($VpsLabel) { Write-Host "Server: $VpsLabel" }
Write-Host "Target: ${User}@${ServerIP}:${VpsPort} -> $RemoteBackend"
Write-Host "Backend (local): $BackendLocal"
Write-Host ""

if (-not (Test-Path (Join-Path $BackendLocal "run_worker.py"))) {
    throw "Backend not found at: $BackendLocal"
}
if (-not (Test-Path (Join-Path $BackendLocal ".env"))) {
    throw "Missing backend\.env — copy from .env.example and set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY"
}
if (-not (Test-Path $deployEnvPath)) {
    throw "Missing deploy.env — copy deploy.env.example to deploy.env and set VPS_PASSWORD"
}

function Ensure-PoshSSH {
    if (-not (Get-Module -ListAvailable -Name Posh-SSH)) {
        Write-Host "Installing Posh-SSH (one-time, for password deploy)..." -ForegroundColor Yellow
        Install-Module Posh-SSH -Scope CurrentUser -Force -AllowClobber
    }
    Import-Module Posh-SSH -ErrorAction Stop
}

function Get-VpsCredential {
    if (-not $VpsPassword) {
        throw "VPS_PASSWORD is empty in deploy.env — add your root password there"
    }
    $sec = ConvertTo-SecureString $VpsPassword -AsPlainText -Force
    return New-Object System.Management.Automation.PSCredential($User, $sec)
}

function Invoke-Vps {
    param([string]$Command)
    $cred = Get-VpsCredential
    $session = New-SSHSession -ComputerName $ServerIP -Port ([int]$VpsPort) -Credential $cred -AcceptKey -ConnectionTimeout 30
    try {
        $r = Invoke-SSHCommand -SessionId $session.SessionId -Command $Command -TimeOut 600
        if ($r.ExitStatus -ne 0) {
            throw "Remote command failed ($($r.ExitStatus)): $($r.Error)"
        }
        return $r.Output
    } finally {
        Remove-SSHSession -SessionId $session.SessionId | Out-Null
    }
}

function Send-BackendFiles {
    $cred = Get-VpsCredential
    $staging = Join-Path $env:TEMP "vibepin-backend-upload"
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    New-Item -ItemType Directory -Path $staging | Out-Null

    $exclude = @(".venv", "venv", "__pycache__", "logs", ".git")
    Get-ChildItem $BackendLocal | Where-Object {
        $_.Name -notin $exclude -and $_.Name -ne "deploy.env"
    } | ForEach-Object {
        Copy-Item $_.FullName -Destination $staging -Recurse -Force
    }
    Copy-Item (Join-Path $BackendLocal ".env") -Destination $staging -Force
    Copy-Item (Join-Path $BackendLocal "deploy.env.example") -Destination $staging -Force

    Write-Host "Uploading backend to VPS..." -ForegroundColor Cyan
    $bundleName = Split-Path $staging -Leaf
    Invoke-Vps "mkdir -p $DeployRoot && rm -rf $RemoteBackend"
    Set-SCPItem -ComputerName $ServerIP -Port ([int]$VpsPort) -Credential $cred -Path $staging -Destination $DeployRoot -Recurse -AcceptKey
    Invoke-Vps "mv $DeployRoot/$bundleName $RemoteBackend && mkdir -p $RemoteBackend/logs"
    Remove-Item $staging -Recurse -Force
}

Ensure-PoshSSH
Send-BackendFiles

Write-Host "Running bootstrap + smoke on VPS..." -ForegroundColor Cyan
Invoke-Vps "export DEPLOY_ROOT='$DeployRoot' && cd $RemoteBackend && chmod +x scripts/*.sh && bash scripts/deploy_vps.sh"

Write-Host ""
Write-Host "Deploy finished. Next on VPS (or re-run deploy after edits):" -ForegroundColor Green
Write-Host "  python run_worker.py --job trends"
Write-Host "  python run_worker.py --job crawl --limit-keywords 20"
Write-Host "  python run_worker.py --job stl-score"
Write-Host "  python scripts/check_pipeline_status.py"
Write-Host "  bash scripts/install_cron_daily.sh"
