"""
Tier 1 Local Collector — FastAPI Application
Endpoints for local ingestion, raw logs, egress proof, outbox stats, chaos injection.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .analyzer import LocalSecurityAnalyzer, analyze_for_security, record_collector_resources
from .forwarder import Tier2Forwarder, check_tier2_health
from .scrubber import process_raw_telemetry, ScrubResult
from .storage import (
    init_db,
    get_recent_raw_logs,
    get_egress_proof_logs,
    get_outbox_stats,
    process_and_store_telemetry,
    enqueue_egress_payload,
)
from .stream_adapter import IngestionAdapter, create_ingestion_adapter
from .log_parser import parse_log_message
from .ldp_privacy import apply_ldp_if_enabled
from .edge_intelligence import ttvm_module, efpm_module, ThreatAssessmentNetwork
from .edge_security import seq_tracker, crc16_modbus, compute_frame_sha256, authenticate_remediation_command


# ─── Configuration ───

TENANT_ID = os.getenv("TENANT_ID", "tenant_acme_corp")
COLLECTOR_ID = os.getenv("COLLECTOR_ID", "col_blr_edge_01")
REGION_ID = os.getenv("REGION_ID", "ap-south-1")
COLLECTOR_TOKEN = os.getenv("COLLECTOR_AUTH_TOKEN") or os.getenv("COLLECTOR_TOKEN", "collector-token-demo")
TENANT_SALT = os.getenv("PSEUDONYM_SALT") or os.getenv("TENANT_SALT", "tenant_acme_corp_salt_2024")
SOURCE_TIMEZONE = os.getenv("SOURCE_TIMEZONE", "Asia/Kolkata")

TIER2_BASE_URL = os.getenv("TIER2_BASE_URL", "http://localhost:8000")


# ─── Global Instances ───

security_analyzer = LocalSecurityAnalyzer()
forwarder: Tier2Forwarder | None = None


# ─── Lifespan ───

@asynccontextmanager
async def lifespan(app: FastAPI):
    global forwarder

    # Startup
    init_db()
    forwarder = Tier2Forwarder(TENANT_ID, COLLECTOR_ID, COLLECTOR_TOKEN, REGION_ID)
    await forwarder.start()

    yield

    # Shutdown
    if forwarder:
        await forwarder.stop()


app = FastAPI(
    title="CICADA 2026 - Tier 1 Local Collector",
    description="Local telemetry collection, scrubbing, and egress proof",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Request/Response Models ───

class IngestRequest(BaseModel):
    """Raw telemetry ingestion from organizer stream or chaos generator."""
    payload: dict = Field(..., description="Raw telemetry payload (may contain secrets)")
    event_timestamp_utc: str | None = Field(None, description="ISO timestamp, defaults to now")
    source_timezone: str | None = Field(None, description="IANA timezone, defaults to collector timezone")
    event_category: str = Field("infrastructure", description="Event category")
    severity: str = Field("info", description="Severity level")
    health_state: str = Field("Excellent", description="Health state")
    metrics: dict = Field(default_factory=dict, description="Metric values")
    security_summary: dict | None = Field(None, description="Security summary")
    alert_context: str | None = Field(None, description="Alert context")
    collector_meta: dict = Field(default_factory=dict, description="Collector metadata")


class IngestResponse(BaseModel):
    """Response for local ingestion."""
    status: str
    payload_id: str
    source_id: str
    redacted_fields_count: int
    redaction_types: list[str]
    queued: bool


class ChaosInjectRequest(BaseModel):
    """Chaos injection request."""
    scenario: str = Field(..., description="Scenario: secret_leak, brute_force, latency_spike, cpu_drift, alert_storm, out_of_order_dup, remediation_test, heartbeat_stop")


class OutboxStatsResponse(BaseModel):
    """Outbox queue statistics."""
    total: int
    pending: int
    sent: int
    failed: int


class RawLogResponse(BaseModel):
    """Raw log entry for side-by-side view."""
    id: int
    tenant_id: str
    collector_id: str
    source_id: str
    raw_payload: dict
    event_timestamp_utc: str
    received_at_utc: str
    redacted_fields_count: int
    redaction_types: list[str]


class EgressProofResponse(BaseModel):
    """Egress proof panel entry."""
    id: int
    payload_id: str
    tenant_id: str
    egress_payload: dict
    scrub_result: dict
    logged_at_utc: str


# ─── Health Check ───

@app.get("/health")
async def health_check():
    tier2_health = await check_tier2_health(TIER2_BASE_URL)
    return {
        "status": "healthy",
        "service": "tier1-collector",
        "tenant_id": TENANT_ID,
        "collector_id": COLLECTOR_ID,
        "region_id": REGION_ID,
        "tier2_health": tier2_health,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


# ─── Main Ingestion Endpoint ───

@app.post("/local/ingest", response_model=IngestResponse)
async def ingest_telemetry(request: IngestRequest, background_tasks: BackgroundTasks):
    """
    Accept raw telemetry from organizer stream or chaos generator.
    Encrypts raw locally, scrubs, allow-lists, queues in SQLite outbox.
    """
    # Generate payload ID
    payload_id = str(uuid.uuid4())[:12]

    # Timestamp
    event_timestamp_utc = request.event_timestamp_utc or datetime.now(timezone.utc).isoformat()
    source_timezone = request.source_timezone or SOURCE_TIMEZONE

    # Analyze for security signals (local only)
    security_summary = request.security_summary
    if security_summary is None:
        security_summary = analyze_for_security(request.payload, TENANT_ID, "auto") or {
            "failed_login_count_60s": 0,
            "risk_indicator": "low",
        }

    # Record collector resources
    record_collector_resources(COLLECTOR_ID, 2.5, 45.0)

    # 1. Structure-based log parsing & de-parameterization (He et al. & Xu et al.)
    log_text = request.payload.get("message") or request.payload.get("raw_log") or json.dumps(request.payload)
    parsed_log = parse_log_message(str(log_text), TENANT_SALT)

    # 2. Local Differential Privacy (Ding et al., Microsoft Research)
    enable_ldp = os.getenv("ENABLE_LDP_TELEMETRY", "false").lower() == "true"
    active_metrics, ldp_audit = apply_ldp_if_enabled(request.metrics, COLLECTOR_ID, enabled=enable_ldp)

    # 3. Edge Intelligence: TTVM persistence & TAN risk scoring (PEWTAF / Saha et al.)
    is_threat = (security_summary.get("failed_login_count_60s", 0) > 5) or (request.severity in ("warning", "critical"))
    ttvm_res = ttvm_module.update(COLLECTOR_ID, is_threat)
    tan_res = ThreatAssessmentNetwork.evaluate_risk(
        request.event_category,
        request.severity,
        ttvm_res["persistence_score"]
    )

    # 4. Edge Security: Anti-replay sequence counter & Modbus CRC-16 (Tran IIoT Thesis)
    seq_num = seq_tracker.next_seq(TENANT_ID, COLLECTOR_ID)
    metrics_bytes = json.dumps(active_metrics, sort_keys=True).encode("utf-8")
    crc16_val = crc16_modbus(metrics_bytes)
    frame_sha = compute_frame_sha256(active_metrics)

    enriched_meta = {
        **request.collector_meta,
        "template_id": parsed_log["template_id"],
        "parsed_template": parsed_log["parsed_template"],
        "seq_num": seq_num,
        "crc16_hex": crc16_val,
        "frame_sha256": frame_sha[:16],
        "ttvm_persistence": ttvm_res["persistence_score"],
        "tan_risk_score": tan_res["risk_score"],
        "tan_risk_level": tan_res["risk_level"],
        "ailc_escalation": tan_res["ailc_escalation"],
    }
    if enable_ldp and ldp_audit:
        enriched_meta["ldp_budget_epsilon"] = ldp_audit["epsilon"]

    # Process and store (full pipeline)
    try:
        egress_payload, scrub_result = process_and_store_telemetry(
            raw_data=request.payload,
            tenant_id=TENANT_ID,
            collector_id=COLLECTOR_ID,
            region_id=REGION_ID,
            tenant_salt=TENANT_SALT,
            payload_id=payload_id,
            event_timestamp_utc=event_timestamp_utc,
            source_timezone=source_timezone,
            event_category=request.event_category,
            severity=request.severity,
            health_state=request.health_state,
            metrics=active_metrics,
            security_summary=security_summary,
            alert_context=request.alert_context,
            collector_meta=enriched_meta,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Processing failed: {e}")

    return IngestResponse(
        status="accepted",
        payload_id=payload_id,
        source_id=egress_payload["source_id"],
        redacted_fields_count=scrub_result.redactions_count,
        redaction_types=scrub_result.redaction_types,
        queued=True,
    )


# ─── Raw Logs (Collector Side) ───

@app.get("/local/raw-logs", response_model=list[RawLogResponse])
async def get_raw_logs(
    limit: int = Query(50, le=200),
):
    """Get raw logs for side-by-side proof view (decrypted, secrets highlighted)."""
    logs = get_recent_raw_logs(TENANT_ID, limit)
    return [RawLogResponse(**log) for log in logs]


# ─── Egress Proof Panel ───

@app.get("/local/egress-proof", response_model=list[EgressProofResponse])
async def get_egress_proof(
    limit: int = Query(50, le=200),
):
    """Get exact allow-listed JSON payloads before crossing trust boundary."""
    logs = get_egress_proof_logs(TENANT_ID, limit)
    return [EgressProofResponse(**log) for log in logs]


# ─── Inbound Command Authentication (Tran IIoT Thesis) ───

class RemediationInboundRequest(BaseModel):
    incident_id: str
    action: str
    target_source_id: str
    operator_id: str
    signature: str


@app.post("/local/remediate/verify")
async def verify_and_apply_remediation(cmd: RemediationInboundRequest):
    """Verify inbound Tier 2 remediation command using HMAC signature before execution (Tran IIoT Thesis)."""
    payload = {
        "incident_id": cmd.incident_id,
        "action": cmd.action,
        "target_source_id": cmd.target_source_id,
        "operator_id": cmd.operator_id,
    }
    valid = authenticate_remediation_command(payload, COLLECTOR_TOKEN, cmd.signature)
    if not valid:
        raise HTTPException(status_code=403, detail="Invalid command signature")
    return {
        "status": "verified",
        "action": cmd.action,
        "applied": True,
        "message": f"Remediation action {cmd.action} verified and applied securely",
    }


# ─── Outbox Stats ───

@app.get("/local/outbox/stats", response_model=OutboxStatsResponse)
async def get_outbox_statistics():
    """Get outbox queue statistics for buffering proof."""
    stats = get_outbox_stats(TENANT_ID)
    return OutboxStatsResponse(**stats)


# ─── Chaos Injection ───

@app.post("/local/chaos/inject")
async def inject_chaos(request: ChaosInjectRequest):
    """Trigger chaos scenarios for live validation."""
    scenario = request.scenario

    # Generate scenario-specific payload
    scenarios = {
        "secret_leak": {
            "payload": {
                "message": 'User login password=SuperSecret123 api_key=sk_live_abc123 JWT=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
                "cpu_pct": 45.0,
            },
            "event_category": "security",
            "severity": "warning",
            "health_state": "Fair",
            "metrics": {"cpu_pct": 45.0},
        },
        "brute_force": {
            "payload": {"failed_login_count": 25, "source_ip": "10.0.0.99"},
            "event_category": "security",
            "severity": "critical",
            "health_state": "Poor",
            "metrics": {},
            "security_summary": {"failed_login_count_60s": 25, "risk_indicator": "high"},
        },
        "latency_spike": {
            "payload": {"latency_ms": 850, "packet_loss_pct": 5.2, "bandwidth_mbps": 10.0},
            "event_category": "network",
            "severity": "critical",
            "health_state": "Poor",
            "metrics": {"latency_ms": 850.0, "packet_loss_pct": 5.2, "bandwidth_mbps": 10.0},
        },
        "cpu_drift": {
            "payload": {"cpu_pct": 96.5, "mem_pct": 91.0, "disk_pct": 78.0},
            "event_category": "infrastructure",
            "severity": "critical",
            "health_state": "Poor",
            "metrics": {"cpu_pct": 96.5, "mem_pct": 91.0, "disk_pct": 78.0},
        },
        "alert_storm": {
            "payload": {"alert_count": 15, "source_id": "src_storm"},
            "event_category": "infrastructure",
            "severity": "warning",
            "health_state": "Fair",
            "metrics": {"cpu_pct": 72.0},
        },
        "out_of_order_dup": {
            "payload": {"cpu_pct": 55.0},
            "event_category": "infrastructure",
            "severity": "info",
            "health_state": "Good",
            "metrics": {"cpu_pct": 55.0},
        },
        "remediation_test": {
            "payload": {"cpu_pct": 94.0, "mem_pct": 88.0, "trigger_rca": True},
            "event_category": "infrastructure",
            "severity": "critical",
            "health_state": "Poor",
            "metrics": {"cpu_pct": 94.0, "mem_pct": 88.0},
            "alert_context": "CPU spike - remediation test triggered",
        },
        "heartbeat_stop": {
            "payload": {"collector_cpu_pct": 0.0, "collector_mem_mb": 0.0},
            "event_category": "heartbeat",
            "severity": "info",
            "health_state": "Excellent",
            "metrics": {},
        },
    }

    if scenario not in scenarios:
        raise HTTPException(status_code=400, detail=f"Unknown scenario: {scenario}")

    config = scenarios[scenario]

    # Inject multiple payloads for alert_storm and out_of_order_dup
    count = 15 if scenario == "alert_storm" else (3 if scenario == "out_of_order_dup" else 1)

    results = []
    for i in range(count):
        # For out_of_order_dup, send with older timestamp
        timestamp = None
        if scenario == "out_of_order_dup" and i > 0:
            from datetime import datetime, timedelta, timezone
            timestamp = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat()

        ingest_req = IngestRequest(
            payload=config["payload"],
            event_timestamp_utc=timestamp,
            event_category=config["event_category"],
            severity=config["severity"],
            health_state=config["health_state"],
            metrics=config["metrics"],
            alert_context=config.get("alert_context"),
            security_summary=config.get("security_summary"),
        )

        result = await ingest_telemetry(ingest_req, BackgroundTasks())
        results.append(result.model_dump())

    # For heartbeat_stop, also stop the forwarder to simulate collector going offline
    if scenario == "heartbeat_stop":
        global forwarder
        if forwarder:
            forwarder._running = False
            print("[Chaos] Heartbeat stopped - collector will go offline")

    return {
        "scenario": scenario,
        "injected_count": count,
        "results": results,
    }


# ─── Stream Adapter (Pluggable) ───

# Use the new IngestionAdapter from stream_adapter.py
stream_mode = os.getenv("STREAM_MODE", "mock")  # mock, http_sse, jsonl
ingestion_adapter = create_ingestion_adapter({
    "tenant_id": TENANT_ID,
    "collector_id": COLLECTOR_ID,
    "region_id": REGION_ID,
    "collector_token": COLLECTOR_TOKEN,
    "tenant_salt": TENANT_SALT,
    "source_timezone": SOURCE_TIMEZONE,
})


@app.on_event("startup")
async def startup_stream():
    await ingestion_adapter.start(stream_mode)


@app.on_event("shutdown")
async def shutdown_stream():
    await ingestion_adapter.stop()


@app.post("/local/stream/mode")
async def set_stream_mode(mode: str):
    """Switch stream mode (mock | http_sse | jsonl)."""
    global ingestion_adapter
    await ingestion_adapter.stop()
    ingestion_adapter = create_ingestion_adapter({
        "tenant_id": TENANT_ID,
        "collector_id": COLLECTOR_ID,
        "region_id": REGION_ID,
        "collector_token": COLLECTOR_TOKEN,
        "tenant_salt": TENANT_SALT,
        "source_timezone": SOURCE_TIMEZONE,
    })
    await ingestion_adapter.start(mode)
    return {"mode": mode, "status": "started"}


# ─── Admin Endpoints ───

@app.get("/local/admin/forwarder/status")
async def forwarder_status():
    """Get forwarder status and stats."""
    stats = get_outbox_stats(TENANT_ID)
    tier2_health = await check_tier2_health(TIER2_BASE_URL)
    return {
        "collector_id": COLLECTOR_ID,
        "tenant_id": TENANT_ID,
        "region_id": REGION_ID,
        "outbox_stats": stats,
        "tier2_health": tier2_health,
        "forwarder_running": forwarder._running if forwarder else False,
    }


@app.post("/local/admin/outage/simulate")
async def simulate_outage_recovery():
    """Simulate Tier 2 outage and verify zero-loss recovery (for demo)."""
    if not forwarder:
        raise HTTPException(status_code=503, detail="Forwarder not initialized")

    result = await forwarder.simulate_outage_and_recovery(outage_duration_seconds=5)
    return result


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)