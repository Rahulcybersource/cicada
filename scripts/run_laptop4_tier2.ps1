<#
.SYNOPSIS
    CICADA 2026 - Laptop 4: Tier 2 Central SaaS + Next.js UI
    Starts Tier 2 FastAPI (port 8000) and Next.js (port 3000)
    Prints Laptop 4's local IPv4 address for Laptops 1-3 to connect.

.DESCRIPTION
    This is the central SaaS laptop running the multi-tenant AIOps platform.
    Laptop 1 (Operator): Opens http://<LAPTOP4_IP>:3000/aiops
    Laptop 2 (Acme Collector): Runs run_laptop2_tier1_acme.ps1 -Tier2Ip <LAPTOP4_IP>
    Laptop 3 (Globex Collector): Runs run_laptop3_tier1_globex.ps1 -Tier2Ip <LAPTOP4_IP>

.NOTES
    Run as Administrator for binding to 0.0.0.0 on all interfaces.
#>

param(
    [switch]$SkipBuild,
    [switch]$SkipTests,
    [string]$Tier2Port = "8000",
    [string]$WebPort = "3000"
)

$ErrorActionPreference = "Stop"
$PROJECT_ROOT = Split-Path -Parent $MyInvocation.MyCommand.Definition
$PROJECT_ROOT = Join-Path $PROJECT_ROOT ".."
$VENV_PATH = Join-Path $PROJECT_ROOT ".venv"
$PYTHON = if (Test-Path "$VENV_PATH\Scripts\python.exe") { "$VENV_PATH\Scripts\python.exe" } else { "python" }
$PIP = if (Test-Path "$VENV_PATH\Scripts\pip.exe") { "$VENV_PATH\Scripts\pip.exe" } else { "pip" }
$NPM = "npm"

$GREEN = [ConsoleColor]::Green
$YELLOW = [ConsoleColor]::Yellow
$RED = [ConsoleColor]::Red
$CYAN = [ConsoleColor]::Cyan
$MAGENTA = [ConsoleColor]::Magenta

function Write-Status($message, $color = $CYAN) {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $message" -ForegroundColor $color
}
function Write-Success($message) { Write-Status $message $GREEN }
function Write-Warning($message) { Write-Status $message $YELLOW }
function Write-Error($message) { Write-Status $message $RED }
function Write-Info($message) { Write-Status $message $MAGENTA }

# ─── Get Local IPv4 Address ───
function Get-LocalIPv4 {
    $ips = Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" }
    if ($ips.Count -gt 0) {
        return $ips[0].IPAddress
    }
    return "127.0.0.1"
}

$LOCAL_IP = Get-LocalIPv4

# ─── Prerequisites Check ───
Write-Status "Checking prerequisites..." $CYAN

try {
    $pyVersion = & $PYTHON --version
    Write-Success "Python: $pyVersion"
} catch {
    Write-Error "Python not found. Please install Python 3.11+"
    exit 1
}

try {
    $nodeVersion = & node --version
    Write-Success "Node.js: $nodeVersion"
} catch {
    Write-Error "Node.js not found. Please install Node.js 20+"
    exit 1
}

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
& $PIP install -r (Join-Path $PROJECT_ROOT "requirements.txt") -q 2>$null || @(
    "fastapi", "uvicorn[standard]", "pydantic", "pydantic-settings", "sqlalchemy",
    "httpx", "cryptography", "python-dotenv", "pytest", "pytest-asyncio", "pytest-mock", "python-multipart"
) | ForEach-Object { & $PIP install $_ -q }
Write-Success "Python dependencies installed"

# ─── Install Frontend Dependencies ───
$WEB_DIR = Join-Path $PROJECT_ROOT "apps\web"
if (-not (Test-Path (Join-Path $WEB_DIR "node_modules"))) {
    Write-Status "Installing frontend dependencies..."
    Push-Location $WEB_DIR
    & $NPM install
    Pop-Location
    Write-Success "Frontend dependencies installed"
}

# ─── Build Frontend ───
if (-not $SkipBuild) {
    Write-Status "Building Next.js frontend..."
    Push-Location $WEB_DIR
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

# Tier 2 SaaS
Write-Status "Starting Tier 2 SaaS on port $Tier2Port (0.0.0.0)..."
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

# Next.js Frontend
Write-Status "Starting Next.js UI on port $WebPort (0.0.0.0)..."
$webLog = Join-Path $logDir "web_ui.log"
Push-Location $WEB_DIR
$webProcess = Start-Process -FilePath $NPM -ArgumentList "run", "dev", "--", "-H", "0.0.0.0", "-p", $WebPort -WorkingDirectory $WEB_DIR -PassThru -RedirectStandardOutput $webLog -RedirectStandardError $webLog
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
Write-Success "═══════════════════════════════════════════════════════"
Write-Success "  CICADA 2026 - LAPTOP 4: TIER 2 CENTRAL SAAS + UI"
Write-Success "═══════════════════════════════════════════════════════"
Write-Status ""
Write-Info "Laptop 4 IPv4 Address: $LOCAL_IP"
Write-Status ""
Write-Status "Services Running on THIS Machine:"
Write-Status "  Tier 2 SaaS API:  http://0.0.0.0:$Tier2Port  (accessible at http://$LOCAL_IP:$Tier2Port)"
Write-Status "  Next.js UI:       http://0.0.0.0:$WebPort  (accessible at http://$LOCAL_IP:$WebPort)"
Write-Status ""
Write-Info "Laptop 1 (Operator) URL:     http://$LOCAL_IP:$WebPort/aiops"
Write-Info "Laptop 2 (Acme Collector):   Run: .\scripts\run_laptop2_tier1_acme.ps1 -Tier2Ip $LOCAL_IP"
Write-Info "Laptop 3 (Globex Collector): Run: .\scripts\run_laptop3_tier1_globex.ps1 -Tier2Ip $LOCAL_IP"
Write-Status ""
Write-Status "Key Endpoints:"
Write-Status "  Tier 2 API:     http://$LOCAL_IP:$Tier2Port/api/v1/"
Write-Status "  Control Plane:  http://$LOCAL_IP:$WebPort"
Write-Status "  /saas           Multi-tenant SaaS view (tenant switcher, fleet health, outage toggle)"
Write-Status "  /aiops          AIOps Command (live SSE, incidents, RCA, remediation)"
Write-Status "  /collector      Local Collector view (raw logs, egress proof, chaos injector)"
Write-Status "  /proof          Judge Side-by-Side view (Tier 1 raw vs Tier 2 redacted)"
Write-Status ""
Write-Status "Press Ctrl+C to stop all services..."
Write-Status ""

# ─── Wait for Shutdown ───
try {
    while ($true) {
        Start-Sleep -Seconds 5
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