<#
.SYNOPSIS
    CICADA 2026 - Laptop 3: Tier 1 Local Collector for tenant_globex_ind (eu-central-1)
    Connects to Laptop 4's Tier 2 SaaS for metadata egress.

.DESCRIPTION
    Runs the local collector on port 8001 with:
    - TENANT_ID=tenant_globex_ind
    - REGION_ID=eu-central-1
    - COLLECTOR_ID=col_fra_edge_02
    - TIER2_BASE_URL=http://<Tier2Ip>:8000

.NOTES
    Run after Laptop 4 is up. Pass -Tier2Ip with Laptop 4's IPv4 address.
    Example: .\scripts\run_laptop3_tier1_globex.ps1 -Tier2Ip 192.168.1.50
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$Tier2Ip,

    [switch]$SkipTests,
    [string]$Tier1Port = "8001"
)

$ErrorActionPreference = "Continue"
$PROJECT_ROOT = Split-Path -Parent $MyInvocation.MyCommand.Definition
$PROJECT_ROOT = Join-Path $PROJECT_ROOT ".."
$VENV_PATH = Join-Path $PROJECT_ROOT ".venv"
$PYTHON = if (Test-Path "$VENV_PATH\Scripts\python.exe") { "$VENV_PATH\Scripts\python.exe" } else { "python" }
$PIP = if (Test-Path "$VENV_PATH\Scripts\pip.exe") { "$VENV_PATH\Scripts\pip.exe" } else { "pip" }

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

# â”€â”€â”€ Configuration â”€â”€â”€
$TENANT_ID = "tenant_globex_ind"
$COLLECTOR_ID = "col_fra_edge_02"
$REGION_ID = "eu-central-1"
$COLLECTOR_TOKEN = "collector-token-globex-2024"
$TENANT_SALT = "tenant_globex_ind_salt_2024"
$SOURCE_TIMEZONE = "Europe/Berlin"
$TIER2_BASE_URL = "http://$Tier2Ip:8000"

Write-Success "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•"
Write-Success "  CICADA 2026 - LAPTOP 3: TIER 1 COLLECTOR (GLOBEX)"
Write-Success "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•"
Write-Info "Tenant:       $TENANT_ID"
Write-Info "Region:       $REGION_ID (Frankfurt)"
Write-Info "Collector:    $COLLECTOR_ID"
Write-Info "Tier 2 SaaS:  $TIER2_BASE_URL"
Write-Info "Local Port:   $Tier1Port"
Write-Status ""

# â”€â”€â”€ Prerequisites Check â”€â”€â”€
Write-Status "Checking prerequisites..."

try {
    $pyVersion = & $PYTHON --version
    Write-Success "Python: $pyVersion"
} catch {
    Write-Error "Python not found. Please install Python 3.11+"
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

# â”€â”€â”€ Set Environment Variables â”€â”€â”€
$env:TENANT_ID = $TENANT_ID
$env:COLLECTOR_ID = $COLLECTOR_ID
$env:REGION_ID = $REGION_ID
$env:COLLECTOR_TOKEN = $COLLECTOR_TOKEN
$env:TENANT_SALT = $TENANT_SALT
$env:SOURCE_TIMEZONE = $SOURCE_TIMEZONE
$env:TIER2_BASE_URL = $TIER2_BASE_URL

Write-Success "Environment configured for $TENANT_ID"

# â”€â”€â”€ Initialize Tier 1 Database â”€â”€â”€
Write-Status "Initializing Tier 1 database..."
& $PYTHON -c "
import sys
sys.path.insert(0, '.')
from services.tier1_collector.storage import init_db as init_tier1
init_tier1()
print('Tier 1 database initialized')
"
Write-Success "Tier 1 database initialized"

# â”€â”€â”€ Start Tier 1 Collector â”€â”€â”€
Write-Status "Starting Tier 1 Collector on port $Tier1Port (0.0.0.0)..."
$logDir = Join-Path $PROJECT_ROOT "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$tier1Log = Join-Path $logDir "tier1_collector_globex.log"
$tier1Process = Start-Process -FilePath $PYTHON -ArgumentList "-m", "uvicorn", "services.tier1_collector.main:app", "--host", "0.0.0.0", "--port", $Tier1Port -WorkingDirectory $PROJECT_ROOT -PassThru -RedirectStandardOutput $tier1Log -RedirectStandardError "$tier1Log.err"
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

# Verify Tier 2 connectivity
Write-Status "Verifying Tier 2 connectivity..."
try {
    $resp = Invoke-WebRequest -Uri "$TIER2_BASE_URL/health" -TimeoutSec 5 -ErrorAction SilentlyContinue
    if ($resp.StatusCode -eq 200) {
        Write-Success "Tier 2 SaaS reachable at $TIER2_BASE_URL"
    } else {
        Write-Warning "Tier 2 SaaS returned status $($resp.StatusCode)"
    }
} catch {
    Write-Warning "Could not reach Tier 2 SaaS at $TIER2_BASE_URL (will retry via forwarder)"
}

# â”€â”€â”€ Summary â”€â”€â”€
Write-Status ""
Write-Success "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•"
Write-Success "  LAPTOP 3 READY - TIER 1 COLLECTOR (GLOBEX)"
Write-Success "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•"
Write-Status ""
Write-Status "Local Collector API: http://0.0.0.0:$Tier1Port (accessible at http://localhost:$Tier1Port)"
Write-Status ""
Write-Status "Key Endpoints:"
Write-Status "  /local/ingest           Accept raw telemetry from organizer stream"
Write-Status "  /local/raw-logs         Raw logs (secrets highlighted - LOCAL ONLY)"
Write-Status "  /local/egress-proof     Exact allow-listed JSON crossing trust boundary"
Write-Status "  /local/outbox/stats     SQLite WAL outbox: PENDING vs SENT counters"
Write-Status "  /local/chaos/inject     8 scenarios: secret_leak, brute_force, latency_spike, cpu_drift, alert_storm, out_of_order_dup, remediation_test, heartbeat_stop"
Write-Status "  /local/stream/mode      Switch: mock | http_sse | jsonl"
Write-Status "  /local/admin/outage/simulate  Simulate Tier 2 outage + zero-loss recovery"
Write-Status ""
Write-Status "Forwarder: Auto-starts, buffers to SQLite, exponential backoff retry"
Write-Status "Egress Proof: Side-by-side raw (secrets) vs redacted (zero secrets)"
Write-Status ""
Write-Status "Press Ctrl+C to stop..."
Write-Status ""

# â”€â”€â”€ Wait for Shutdown â”€â”€â”€
try {
    while ($true) {
        Start-Sleep -Seconds 5
        if ($tier1Process.HasExited) {
            Write-Error "Tier 1 Collector process exited unexpectedly (Exit code: $($tier1Process.ExitCode))"
            Get-Content $tier1Log -Tail 30
            throw "Service failed"
        }
    }
} catch {
    Write-Status "Shutting down Tier 1 Collector..."
    if (-not $tier1Process.HasExited) {
        Stop-Process -Id $tier1Process.Id -Force -ErrorAction SilentlyContinue
        Write-Status "Stopped Tier 1 Collector"
    }
    Write-Success "Tier 1 Collector stopped"
}

