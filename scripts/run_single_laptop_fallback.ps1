<#
.SYNOPSIS
    CICADA 2026 - Single Laptop Fallback Demo
    Runs Tier 2 SaaS (8000), Next.js UI (3000), and BOTH Tier 1 Collectors (8001, 8002) on one machine.
    Use when mobile hotspot Wi-Fi drops or only one laptop available.

.DESCRIPTION
    Simulates the full 4-laptop topology on a single machine:
    - Tier 2 SaaS API:      http://localhost:8000
    - Next.js Control Plane: http://localhost:3000
    - Acme Collector (Tier 1):  http://localhost:8001  (tenant_acme_corp, ap-south-1)
    - Globex Collector (Tier 1): http://localhost:8002 (tenant_globex_ind, eu-central-1)

    The Next.js UI at /collector shows an editable Tier 1 Base URL input
    so you can switch between the two collectors' local views.
#>

param(
    [switch]$SkipBuild,
    [switch]$SkipTests,
    [string]$Tier2Port = "8000",
    [string]$WebPort = "3000",
    [string]$Tier1AcmePort = "8001",
    [string]$Tier1GlobexPort = "8002"
)

$ErrorActionPreference = "Continue"
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

# â”€â”€â”€ Prerequisites Check â”€â”€â”€
Write-Status "Checking prerequisites..."

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

# â”€â”€â”€ Virtual Environment â”€â”€â”€
if (-not (Test-Path $VENV_PATH)) {
    Write-Status "Creating Python virtual environment..."
    & $PYTHON -m venv $VENV_PATH
    Write-Success "Virtual environment created"
}

# â”€â”€â”€ Install Python Dependencies â”€â”€â”€
Write-Status "Installing Python dependencies..."
# pip self-upgrade skipped
$pipResult = & $PIP install -r (Join-Path $PROJECT_ROOT "requirements.txt") -q 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Warning "requirements.txt install had issues, falling back to individual packages..."
    @(
        "fastapi", "uvicorn[standard]", "pydantic", "pydantic-settings", "sqlalchemy",
        "httpx", "cryptography", "python-dotenv", "pytest", "pytest-asyncio", "pytest-mock", "python-multipart"
    ) | ForEach-Object { & $PIP install $_ -q }
}
Write-Success "Python dependencies installed"

# â”€â”€â”€ Install Frontend Dependencies â”€â”€â”€
$WEB_DIR = Join-Path $PROJECT_ROOT "apps\web"
if (-not (Test-Path (Join-Path $WEB_DIR "node_modules"))) {
    Write-Status "Installing frontend dependencies..."
    Push-Location $WEB_DIR
    & $NPM install
    Pop-Location
    Write-Success "Frontend dependencies installed"
}

# â”€â”€â”€ Build Frontend â”€â”€â”€
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

# â”€â”€â”€ Run Tests â”€â”€â”€
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

# â”€â”€â”€ Load Environment Variables â”€â”€â”€
if (Test-Path (Join-Path $PROJECT_ROOT ".env")) {
    Write-Status "Loading environment variables..."
    Get-Content (Join-Path $PROJECT_ROOT ".env") | ForEach-Object {
        if ($_ -match '^([^#=]+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
        }
    }
    Write-Success "Environment loaded"
}

# â”€â”€â”€ Initialize Databases â”€â”€â”€
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

# â”€â”€â”€ Start Services â”€â”€â”€
Write-Status "Starting all services on single laptop..."
$services = @()
$logDir = Join-Path $PROJECT_ROOT "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# Tier 2 SaaS
Write-Status "Starting Tier 2 SaaS on port $Tier2Port..."
$tier2Log = Join-Path $logDir "tier2_saas.log"
$tier2Process = Start-Process -FilePath $PYTHON -ArgumentList "-m", "uvicorn", "services.tier2_saas.main:app", "--host", "0.0.0.0", "--port", $Tier2Port -WorkingDirectory $PROJECT_ROOT -PassThru -RedirectStandardOutput $tier2Log -RedirectStandardError "$tier2Log.err"
$services += @{ Name = "Tier2 SaaS"; Process = $tier2Process; Port = $Tier2Port; Log = $tier2Log }
Write-Success "Tier 2 SaaS started (PID: $($tier2Process.Id))"

# Wait for Tier 2
Write-Status "Waiting for Tier 2 SaaS..."
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    try { $resp = Invoke-WebRequest -Uri "http://localhost:$Tier2Port/health" -TimeoutSec 2 -ErrorAction SilentlyContinue; if ($resp.StatusCode -eq 200) { $ready = $true; break } } catch { }
    Start-Sleep -Seconds 1
}
if (-not $ready) { Write-Error "Tier 2 SaaS failed"; Get-Content $tier2Log -Tail 20; exit 1 }
Write-Success "Tier 2 SaaS healthy"

# Acme Collector (Tier 1 on 8001)
$env:TENANT_ID = "tenant_acme_corp"
$env:COLLECTOR_ID = "col_blr_edge_01"
$env:REGION_ID = "ap-south-1"
$env:COLLECTOR_TOKEN = "collector-token-acme-2024"
$env:TENANT_SALT = "tenant_acme_corp_salt_2024"
$env:SOURCE_TIMEZONE = "Asia/Kolkata"
$env:TIER2_BASE_URL = "http://localhost:$Tier2Port"

Write-Status "Starting Acme Collector on port $Tier1AcmePort..."
$acmeLog = Join-Path $logDir "tier1_acme.log"
$acmeProcess = Start-Process -FilePath $PYTHON -ArgumentList "-m", "uvicorn", "services.tier1_collector.main:app", "--host", "0.0.0.0", "--port", $Tier1AcmePort -WorkingDirectory $PROJECT_ROOT -PassThru -RedirectStandardOutput $acmeLog -RedirectStandardError "$acmeLog.err"
$services += @{ Name = "Acme Collector"; Process = $acmeProcess; Port = $Tier1AcmePort; Log = $acmeLog }
Write-Success "Acme Collector started (PID: $($acmeProcess.Id))"

# Globex Collector (Tier 1 on 8002)
$env:TENANT_ID = "tenant_globex_ind"
$env:COLLECTOR_ID = "col_fra_edge_02"
$env:REGION_ID = "eu-central-1"
$env:COLLECTOR_TOKEN = "collector-token-globex-2024"
$env:TENANT_SALT = "tenant_globex_ind_salt_2024"
$env:SOURCE_TIMEZONE = "Europe/Berlin"
$env:TIER2_BASE_URL = "http://localhost:$Tier2Port"

Write-Status "Starting Globex Collector on port $Tier1GlobexPort..."
$globexLog = Join-Path $logDir "tier1_globex.log"
$globexProcess = Start-Process -FilePath $PYTHON -ArgumentList "-m", "uvicorn", "services.tier1_collector.main:app", "--host", "0.0.0.0", "--port", $Tier1GlobexPort -WorkingDirectory $PROJECT_ROOT -PassThru -RedirectStandardOutput $globexLog -RedirectStandardError "$globexLog.err"
$services += @{ Name = "Globex Collector"; Process = $globexProcess; Port = $Tier1GlobexPort; Log = $globexLog }
Write-Success "Globex Collector started (PID: $($globexProcess.Id))"

# Wait for both collectors
Write-Status "Waiting for collectors..."
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
    $acmeReady = $false
    $globexReady = $false
    try { $resp = Invoke-WebRequest -Uri "http://localhost:$Tier1AcmePort/health" -TimeoutSec 2 -ErrorAction SilentlyContinue; if ($resp.StatusCode -eq 200) { $acmeReady = $true } } catch { }
    try { $resp = Invoke-WebRequest -Uri "http://localhost:$Tier1GlobexPort/health" -TimeoutSec 2 -ErrorAction SilentlyContinue; if ($resp.StatusCode -eq 200) { $globexReady = $true } } catch { }
    if ($acmeReady -and $globexReady) { $ready = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $ready) { Write-Error "Collectors failed"; Get-Content $acmeLog -Tail 10; Get-Content $globexLog -Tail 10; exit 1 }
Write-Success "Both collectors healthy"

# Next.js Frontend
Write-Status "Starting Next.js UI on port $WebPort..."
$webLog = Join-Path $logDir "web_ui.log"
Push-Location $WEB_DIR
$webProcess = Start-Process -FilePath $NPM -ArgumentList "run", "dev", "--", "-H", "0.0.0.0", "-p", $WebPort -WorkingDirectory $WEB_DIR -PassThru -RedirectStandardOutput $webLog -RedirectStandardError "$webLog.err"
Pop-Location
$services += @{ Name = "Next.js UI"; Process = $webProcess; Port = $WebPort; Log = $webLog }
Write-Success "Next.js UI started (PID: $($webProcess.Id))"

# Wait for Next.js
Write-Status "Waiting for Next.js..."
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    try { $resp = Invoke-WebRequest -Uri "http://localhost:$WebPort" -TimeoutSec 3 -ErrorAction SilentlyContinue; if ($resp.StatusCode -eq 200) { $ready = $true; break } } catch { }
    Start-Sleep -Seconds 1
}
if (-not $ready) { Write-Warning "Next.js may still be compiling. Check $webLog" }

# â”€â”€â”€ Summary â”€â”€â”€
Write-Status ""
Write-Success "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•"
Write-Success "  CICADA 2026 - SINGLE LAPTOP FALLBACK DEMO READY"
Write-Success "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•"
Write-Status ""
Write-Status "All Services on THIS Machine:"
Write-Status "  Tier 2 SaaS API:      http://localhost:$Tier2Port"
Write-Status "  Next.js Control Plane: http://localhost:$WebPort"
Write-Status "  Acme Collector (8001): http://localhost:$Tier1AcmePort  (tenant_acme_corp / ap-south-1)"
Write-Status "  Globex Collector (8002): http://localhost:$Tier1GlobexPort (tenant_globex_ind / eu-central-1)"
Write-Status ""
Write-Info "Control Plane Routes:"
Write-Info "  /saas       - Multi-tenant SaaS view (switch tenant, fleet, outage)"
Write-Info "  /aiops      - AIOps Command (live SSE, incidents, RCA, remediation)"
Write-Info "  /collector  - Local Collector view (switch between 8001/8002 in UI)"
Write-Info "  /proof      - Judge Side-by-Side (Tier 1 raw vs Tier 2 redacted)"
Write-Status ""
Write-Status "Press Ctrl+C to stop all services..."
Write-Status ""

# â”€â”€â”€ Wait for Shutdown â”€â”€â”€
try {
    while ($true) {
        Start-Sleep -Seconds 5
        foreach ($svc in $services) {
            if ($svc.Process.HasExited) {
                Write-Error "$($svc.Name) exited (code: $($svc.Process.ExitCode))"
                Get-Content $svc.Log -Tail 30
                throw "Service failed"
            }
        }
    }
} catch {
    Write-Status "Shutting down all services..."
    foreach ($svc in $services) {
        if (-not $svc.Process.HasExited) {
            Stop-Process -Id $svc.Process.Id -Force -ErrorAction SilentlyContinue
            Write-Status "Stopped $($svc.Name)"
        }
    }
    Write-Success "All services stopped"
}

