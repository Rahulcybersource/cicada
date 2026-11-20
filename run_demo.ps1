<#
.SYNOPSIS
    CICADA 2026 - Complete Demo Launcher
    Starts Tier 1 Collector (port 8001), Tier 2 SaaS (port 8000), and Next.js UI (port 3000)

.DESCRIPTION
    This script launches all three services for the CICADA 2026 hackathon demo.
    It verifies prerequisites, sets up environment, and starts services in order.

.NOTES
    Author: CICADA 2026 Team
    Date: 2026-11-20
#>

param(
    [switch]$SkipBuild,
    [switch]$SkipTests,
    [string]$Tier1Port = "8001",
    [string]$Tier2Port = "8000",
    [string]$WebPort = "3000"
)

# ─── Configuration ───
$ErrorActionPreference = "Stop"
$PROJECT_ROOT = Split-Path -Parent $MyInvocation.MyCommand.Definition
$VENV_PATH = Join-Path $PROJECT_ROOT ".venv"
$PYTHON = if (Test-Path "$VENV_PATH\Scripts\python.exe") { "$VENV_PATH\Scripts\python.exe" } else { "python" }
$PIP = if (Test-Path "$VENV_PATH\Scripts\pip.exe") { "$VENV_PATH\Scripts\pip.exe" } else { "pip" }
$NPM = "npm"

# Colors
$GREEN = [ConsoleColor]::Green
$YELLOW = [ConsoleColor]::Yellow
$RED = [ConsoleColor]::Red
$CYAN = [ConsoleColor]::Cyan
$RESET = [ConsoleColor]::Gray

function Write-Status($message, $color = $CYAN) {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $message" -ForegroundColor $color
}

function Write-Success($message) { Write-Status $message $GREEN }
function Write-Warning($message) { Write-Status $message $YELLOW }
function Write-Error($message) { Write-Status $message $RED }

# ─── Prerequisites Check ───
Write-Status "Checking prerequisites..."

# Check Python
try {
    $pyVersion = & $PYTHON --version
    Write-Success "Python: $pyVersion"
} catch {
    Write-Error "Python not found. Please install Python 3.11+"
    exit 1
}

# Check Node.js
try {
    $nodeVersion = & node --version
    Write-Success "Node.js: $nodeVersion"
} catch {
    Write-Error "Node.js not found. Please install Node.js 20+"
    exit 1
}

# Check npm
try {
    $npmVersion = & $NPM --version
    Write-Success "npm: $npmVersion"
} catch {
    Write-Error "npm not found"
    exit 1
}

# ─── Virtual Environment ───
if (-not (Test-Path $VENV_PATH)) {
    Write-Status "Creating Python virtual environment..."
    & $PYTHON -m venv $VENV_PATH
    Write-Success "Virtual environment created"
}

# ─── Install Python Dependencies ───
Write-Status "Installing Python dependencies..."
& $PIP install --upgrade pip -q
& $PIP install -r requirements.txt -q 2>$null || @(
    "fastapi",
    "uvicorn[standard]",
    "pydantic",
    "pydantic-settings",
    "sqlalchemy",
    "httpx",
    "cryptography",
    "python-dotenv",
    "pytest",
    "pytest-asyncio",
    "pytest-mock",
    "python-multipart"
) | ForEach-Object { & $PIP install $_ -q }
Write-Success "Python dependencies installed"

# ─── Install Frontend Dependencies ───
if (-not (Test-Path (Join-Path $PROJECT_ROOT "apps\web\node_modules"))) {
    Write-Status "Installing frontend dependencies..."
    Push-Location (Join-Path $PROJECT_ROOT "apps\web")
    & $NPM install
    Pop-Location
    Write-Success "Frontend dependencies installed"
}

# ─── Build Frontend ───
if (-not $SkipBuild) {
    Write-Status "Building Next.js frontend..."
    Push-Location (Join-Path $PROJECT_ROOT "apps\web")
    & $NPM run build
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Frontend build failed"
        exit 1
    }
    Pop-Location
    Write-Success "Frontend built successfully"
}

# ─── Run Tests ───
if (-not $SkipTests) {
    Write-Status "Running test suites..."
    Push-Location $PROJECT_ROOT
    $env:PYTHONPATH = "."
    & $PYTHON -m pytest tests/test_phase1_redaction.py tests/test_hybrid_aiops.py -v --tb=short
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Tests failed"
        exit 1
    }
    Pop-Location
    Write-Success "All tests passed"
}

# ─── Load Environment Variables ───
if (Test-Path (Join-Path $PROJECT_ROOT ".env")) {
    Write-Status "Loading environment variables..."
    Get-Content (Join-Path $PROJECT_ROOT ".env") | ForEach-Object {
        if ($_ -match '^([^#=]+)=(.*)$') {
            $env:$matches[1] = $matches[2]
        }
    }
    Write-Success "Environment loaded"
}

# ─── Initialize Databases ───
Write-Status "Initializing databases..."
& $PYTHON -c "
import sys
sys.path.insert(0, '.')
from services.tier1_collector.storage import init_db as init_tier1
from services.tier2_saas.db import init_db as init_tier2
init_tier1()
init_tier2()
print('Databases initialized')
"
Write-Success "Databases initialized"

# ─── Start Services ───
Write-Status "Starting services..."

$services = @()
$logDir = Join-Path $PROJECT_ROOT "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# Tier 2 SaaS (starts first - Tier 1 depends on it)
Write-Status "Starting Tier 2 SaaS on port $Tier2Port..."
$tier2Log = Join-Path $logDir "tier2_saas.log"
$tier2Process = Start-Process -FilePath $PYTHON -ArgumentList "-m", "uvicorn", "services.tier2_saas.main:app", "--host", "0.0.0.0", "--port", $Tier2Port -WorkingDirectory $PROJECT_ROOT -PassThru -RedirectStandardOutput $tier2Log -RedirectStandardError $tier2Log
$services += @{ Name = "Tier2 SaaS"; Process = $tier2Process; Port = $Tier2Port; Log = $tier2Log }
Write-Success "Tier 2 SaaS started (PID: $($tier2Process.Id))"

# Wait for Tier 2 to be ready
Write-Status "Waiting for Tier 2 SaaS to be ready..."
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$Tier2Port/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
}
if (-not $ready) {
    Write-Error "Tier 2 SaaS failed to start. Check logs at $tier2Log"
    Get-Content $tier2Log -Tail 20
    exit 1
}
Write-Success "Tier 2 SaaS is healthy"

# Tier 1 Collector
Write-Status "Starting Tier 1 Collector on port $Tier1Port..."
$tier1Log = Join-Path $logDir "tier1_collector.log"
$tier1Process = Start-Process -FilePath $PYTHON -ArgumentList "-m", "uvicorn", "services.tier1_collector.main:app", "--host", "0.0.0.0", "--port", $Tier1Port -WorkingDirectory $PROJECT_ROOT -PassThru -RedirectStandardOutput $tier1Log -RedirectStandardError $tier1Log
$services += @{ Name = "Tier1 Collector"; Process = $tier1Process; Port = $Tier1Port; Log = $tier1Log }
Write-Success "Tier 1 Collector started (PID: $($tier1Process.Id))"

# Wait for Tier 1 to be ready
Write-Status "Waiting for Tier 1 Collector to be ready..."
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$Tier1Port/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
}
if (-not $ready) {
    Write-Error "Tier 1 Collector failed to start. Check logs at $tier1Log"
    Get-Content $tier1Log -Tail 20
    exit 1
}
Write-Success "Tier 1 Collector is healthy"

# Next.js Frontend
Write-Status "Starting Next.js UI on port $WebPort..."
$webLog = Join-Path $logDir "web_ui.log"
Push-Location (Join-Path $PROJECT_ROOT "apps\web")
$webProcess = Start-Process -FilePath $NPM -ArgumentList "run", "dev" -WorkingDirectory (Join-Path $PROJECT_ROOT "apps\web") -PassThru -RedirectStandardOutput $webLog -RedirectStandardError $webLog
Pop-Location
$services += @{ Name = "Next.js UI"; Process = $webProcess; Port = $WebPort; Log = $webLog }
Write-Success "Next.js UI started (PID: $($webProcess.Id))"

# Wait for Next.js to be ready
Write-Status "Waiting for Next.js UI to be ready..."
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$WebPort" -TimeoutSec 3 -ErrorAction SilentlyContinue
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
}
if (-not $ready) {
    Write-Warning "Next.js UI may still be compiling. Check logs at $webLog"
}

# ─── Summary ───
Write-Status ""
Write-Success "═══════════════════════════════════════════"
Write-Success "  CICADA 2026 DEMO READY"
Write-Success "═══════════════════════════════════════════"
Write-Status ""
Write-Status "Services:"
foreach ($svc in $services) {
    Write-Status "  $($svc.Name): http://localhost:$($svc.Port)  (PID: $($svc.Process.Id), Log: $($svc.Log))"
}
Write-Status ""
Write-Status "Key Endpoints:"
Write-Status "  Tier 2 API:     http://localhost:$Tier2Port/api/v1/"
Write-Status "  Tier 1 API:     http://localhost:$Tier1Port/local/"
Write-Status "  Control Plane:  http://localhost:$WebPort"
Write-Status ""
Write-Status "Demo Controls (in Control Plane):"
Write-Status "  • Tenant Switcher: tenant_acme_corp / tenant_globex_ind"
Write-Status "  • Outage Toggle:   Simulates Tier 2 outage, proves buffering"
Write-Status "  • Chaos Injection: Secret leak, brute force, latency spike, etc."
Write-Status "  • Egress Proof:    Side-by-side raw vs redacted view"
Write-Status ""
Write-Status "Press Ctrl+C to stop all services..."
Write-Status ""

# ─── Wait for Shutdown ───
try {
    while ($true) {
        Start-Sleep -Seconds 5
        # Check if any process died
        foreach ($svc in $services) {
            if ($svc.Process.HasExited) {
                Write-Error "$($svc.Name) process exited unexpectedly (Exit code: $($svc.Process.ExitCode))"
                Get-Content $svc.Log -Tail 30
                throw "Service failed"
            }
        }
    }
} catch {
    Write-Status "Shutting down services..."
    foreach ($svc in $services) {
        if (-not $svc.Process.HasExited) {
            Stop-Process -Id $svc.Process.Id -Force -ErrorAction SilentlyContinue
            Write-Status "Stopped $($svc.Name)"
        }
    }
    Write-Success "All services stopped"
}