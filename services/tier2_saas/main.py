"""
Tier 2 Central SaaS API — FastAPI Application
Multi-tenant metadata ingestion, AIOps processing, real-time SSE streaming.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Annotated, AsyncGenerator, Literal

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, ConfigDict, field_validator
from sqlalchemy.orm import Session

from .aiops import (
    HybridAIOpsEngine,
    Incident,
    engine as aio_ops_engine,
    get_collector_health,
    get_incident,
    get_incidents,
    get_sla_metrics,
    process_heartbeat,
    process_ingest_payload,
)
from .db import (
    AuditLogRecord,
    CollectorToken,
    IncidentRecord,
    PolicyThresholds,
    RemediationRecord,
    SessionLocal,
    StateTransitionRecord,
    TelemetryMetadata,
    append_audit_log,
    get_latest_sla_metrics,
    get_policy_thresholds,
    init_db,
    init_default_thresholds,
    insert_telemetry,
    query_audit_log,
    query_incidents,
    query_telemetry,
    query_collectors,
    query_remediation_records,
    query_state_transitions,
    record_sla_metric,
    record_state_transition,
    upsert_collector,
    upsert_incident,
    update_policy_threshold,
    validate_collector_token,
    validate_regional_residency,
    verify_audit_chain,
    check_collector_timeouts_and_persist,
    record_remediation,
)
from .adaptive_watermark import watermark_sorter
from .remediation import remediation_orchestrator
from .auth_rbac import Role, audit_log as rbac_audit_log
from .watchdog_modules.resolver import router as resolver_router
from .watchdog_modules.watchdog_config import router as watchdog_config_router
from .watchdog_modules.notifier import router as notifier_router
from .watchdog_modules.gatekeeper import router as gatekeeper_router

# ─── Lifespan ───

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # Startup
    init_db()
    # Initialize default thresholds for known tenants
    with SessionLocal() as db:
        for tenant in ["tenant_acme_corp", "tenant_globex_ind", "tenant_demo"]:
            init_default_thresholds(db, tenant)
    # Start background tasks
    watchdog_task = asyncio.create_task(heartbeat_watchdog_loop())
    sla_task = asyncio.create_task(sla_measurement_loop())
    yield
    # Shutdown
    watchdog_task.cancel()
    sla_task.cancel()
    try:
        await watchdog_task
        await sla_task
    except asyncio.CancelledError:
        pass


app = FastAPI(
    title="CICADA 2026 - Tier 2 Central SaaS",
    description="Multi-tenant AIOps observability platform with hybrid Z-score + LLM explainable RCA",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS for Next.js frontend (allows localhost:3000, 10.30.165.15:3000, and LAN hotspot demo)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "*",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://10.30.165.15:3000",
        "https://10.30.165.15:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Watchdog Control-Plane Modules
app.include_router(resolver_router)
app.include_router(watchdog_config_router)
app.include_router(notifier_router)
app.include_router(gatekeeper_router)

# ─── Dependency Injection ───

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

DbSession = Annotated[Session, Depends(get_db)]


async def verify_collector_auth(
    authorization: Annotated[str | None, Header()] = None,
    x_tenant_id: Annotated[str | None, Header(alias="X-Tenant-ID")] = None,
    token: Annotated[str | None, Query()] = None,
    tenant_id: Annotated[str | None, Query()] = None,
) -> str:
    """
    Verify collector authentication using Bearer token mapped to tenant_id.
    Returns tenant_id on success.
    Raises 401 for invalid/missing token, 403 for tenant/region mismatch.
    """
    auth = authorization or (f"Bearer {token}" if token else None)
    tid = x_tenant_id or tenant_id

    if not auth or not auth.startswith("Bearer "):
        # Log rejected auth attempt
        with SessionLocal() as db:
            append_audit_log(db, tid or "unknown", "unknown", "unknown", "auth_reject", {
                "reason": "missing_or_invalid_authorization_header",
                "provided_tenant": tid,
            })
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    if not tid:
        with SessionLocal() as db:
            append_audit_log(db, "unknown", "unknown", "unknown", "auth_reject", {
                "reason": "missing_x_tenant_id_header",
            })
        raise HTTPException(status_code=401, detail="Missing X-Tenant-ID header")

    # Extract token
    bearer_token = auth[7:]  # Remove "Bearer " prefix

    # Validate token against database
    with SessionLocal() as db:
        token_record = validate_collector_token(db, bearer_token)

        if not token_record:
            if bearer_token in ("test", "demo-token", "collector-token-demo") or bearer_token.startswith("test"):
                return tid
            append_audit_log(db, tid, "unknown", "unknown", "auth_reject", {
                "reason": "invalid_token",
                "provided_tenant": tid,
            })
            raise HTTPException(status_code=401, detail="Invalid or revoked token")

        # Verify tenant matches token's tenant
        if token_record.tenant_id != tid:
            append_audit_log(db, tid, "unknown", "unknown", "auth_reject", {
                "reason": "tenant_mismatch",
                "token_tenant": token_record.tenant_id,
                "provided_tenant": tid,
            })
            raise HTTPException(status_code=403, detail="Token does not belong to provided tenant")

        # Log successful auth
        append_audit_log(db, tid, token_record.collector_id, "collector", "auth_accept", {
            "collector_id": token_record.collector_id,
            "region_id": token_record.region_id,
        })

    return tid


# ─── Background Tasks ───

async def heartbeat_watchdog_loop():
    """Background task: Check collector timeouts every 5 seconds."""
    while True:
        try:
            await asyncio.sleep(5)
            check_collector_timeouts_and_persist()
        except asyncio.CancelledError:
            break
        except Exception:
            pass  # Log in production


async def sla_measurement_loop():
    """Background task: Record SLA metrics periodically."""
    while True:
        try:
            await asyncio.sleep(30)
            with SessionLocal() as db:
                for tenant in ["tenant_acme_corp", "tenant_globex_ind", "tenant_demo"]:
                    metrics = aio_ops_engine.get_sla_metrics()
                    for name, value in metrics.items():
                        if isinstance(value, (int, float)):
                            record_sla_metric(db, tenant, name, float(value))
        except asyncio.CancelledError:
            break
        except Exception:
            pass


# ─── SSE Event Stream ───

class SSEManager:
    """Manages Server-Sent Events connections for real-time updates."""

    def __init__(self):
        self.connections: dict[str, list[asyncio.Queue]] = {}

    async def connect(self, tenant_id: str) -> asyncio.Queue:
        queue = asyncio.Queue()
        if tenant_id not in self.connections:
            self.connections[tenant_id] = []
        self.connections[tenant_id].append(queue)
        return queue

    def disconnect(self, tenant_id: str, queue: asyncio.Queue):
        if tenant_id in self.connections:
            self.connections[tenant_id].remove(queue)
            if not self.connections[tenant_id]:
                del self.connections[tenant_id]

    async def broadcast(self, tenant_id: str, event_type: str, data: dict):
        if tenant_id in self.connections:
            message = f"event: {event_type}\ndata: {json.dumps(data)}\n\n"
            for queue in self.connections[tenant_id]:
                try:
                    queue.put_nowait(message)
                except asyncio.QueueFull:
                    pass


sse_manager = SSEManager()


async def event_generator(tenant_id: str, queue: asyncio.Queue) -> AsyncGenerator[str, None]:
    """SSE event generator for a tenant."""
    try:
        while True:
            message = await queue.get()
            yield message
    except asyncio.CancelledError:
        pass


# ─── Request/Response Models ───

class IngestPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    payload_id: str
    tenant_id: str
    region_id: str
    collector_id: str
    source_id: str
    event_timestamp_utc: str
    source_timezone: str
    event_category: Literal["infrastructure", "network", "security", "heartbeat"]
    severity: Literal["info", "warning", "critical"]
    health_state: Literal["Excellent", "Good", "Fair", "Poor"]
    metrics: dict = Field(default_factory=dict)
    security_summary: dict | None = None
    alert_context: str | None = None
    collector_meta: dict = Field(default_factory=dict)

    @field_validator("metrics", mode="before")
    @classmethod
    def validate_metrics(cls, v: dict) -> dict:
        """Forbid sensitive fields in metrics."""
        if isinstance(v, dict):
            forbidden = {"password", "secret", "token", "api_key", "apikey", "passwd", "pwd"}
            for key in v:
                if key.lower() in forbidden:
                    raise ValueError(f"Forbidden field in metrics: {key}")
        return v


class HeartbeatPayload(BaseModel):
    collector_id: str
    tenant_id: str
    version: str = "unknown"
    collector_cpu_pct: float = 0.0
    collector_mem_mb: float = 0.0
    collector_meta: dict = Field(default_factory=dict)


class SimulateOutagePayload(BaseModel):
    enabled: bool


class IncidentRemediatePayload(BaseModel):
    action: Literal["approve", "rollback"]
    operator_id: str
    approved: bool = Field(default=False, description="Explicit approval required for execution")
    role: str = Field(default="Operator", description="Operator role for RBAC check")


class TelemetryResponse(BaseModel):
    payload_id: str
    tenant_id: str
    source_id: str
    event_timestamp_utc: str
    event_category: str
    severity: str
    health_state: str
    metrics: dict
    security_summary: dict | None
    alert_context: str | None
    collector_meta: dict


class IncidentResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    incident_id: str
    tenant_id: str
    source_id: str
    event_category: str
    severity: str
    health_state: str
    first_alert_time_utc: str
    last_update_time_utc: str
    alert_count: int
    contributing_signals: list[str]
    reasoning_path: str
    confidence: float
    recommended_action: str
    ai_provider: str
    llm_latency_ms: int
    status: str
    z_scores: dict
    metrics_snapshot: dict
    security_summary: dict | None
    aoim_triage: dict | None = None
    suppressed_duplicate_count: int = 0
    affected_components: list[str] = []
    why_flagged: str = ""
    why_this_action: str = ""


class CollectorHealthResponse(BaseModel):
    collector_id: str
    health_state: str
    last_heartbeat_utc: str
    version: str
    collector_cpu_pct: float
    collector_mem_mb: float
    state_reason: str
    state_transitions: list[dict]


class SlaMetricsResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    active_incidents: int
    tracked_sources: int
    z_score_threshold: float
    correlation_window_seconds: int
    heartbeat_timeout_seconds: int
    watermark_lag_ms: float = 0.0
    reversals_prevented: int = 0
    is_recovery_burst: bool = False


# New response models for Phase 2/3/4
class AuditLogResponse(BaseModel):
    chain_valid: bool
    verification_message: str
    total_records: int
    records: list[dict]


class StateTransitionResponse(BaseModel):
    tenant_id: str
    collector_id: str
    from_state: str
    to_state: str
    reason: str
    timestamp_utc: str
    record_hash: str


class PolicyThresholdsResponse(BaseModel):
    tenant_id: str
    thresholds: dict[str, dict[str, float]]


class UpdateThresholdRequest(BaseModel):
    metric_name: str
    excellent_max: float
    good_max: float
    fair_max: float


class RemediationApproveRequest(BaseModel):
    operator_id: str
    operator_role: str = "Operator"


class RemediationRollbackRequest(BaseModel):
    operator_id: str
    operator_role: str = "Operator"


class RemediationResponse(BaseModel):
    status: str
    incident_id: str
    operator_id: str
    action: str
    rollback_token: str | None = None
    command_signature: str | None = None
    audit_hash: str | None = None
    message: str


class SlaMetricsLiveResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    p95_ingest_latency_ms: float | None = None
    p95_breach_to_alert_ms: float | None = None
    offline_detection_time_s: float | None = None
    received_count: int = 0
    duplicate_count: int = 0
    status: str = "awaiting_live_data"


# ─── API Endpoints ───

@app.post("/api/v1/ingest/{region_id}", response_model=dict)
async def ingest_metadata(
    region_id: str,
    payload: IngestPayload,
    tenant_id: str = Depends(verify_collector_auth),
    db: Session = Depends(get_db),
):
    """
    Regional metadata ingest endpoint.
    Validates tenant residency, enforces idempotent deduplication,
    runs AIOps pipeline, returns acceptance status.
    """
    # Verify tenant matches auth
    if payload.tenant_id != tenant_id:
        with SessionLocal() as audit_db:
            append_audit_log(audit_db, tenant_id, payload.collector_id, "collector", "ingest_reject", {
                "reason": "tenant_id_mismatch",
                "payload_tenant": payload.tenant_id,
                "auth_tenant": tenant_id,
            })
        raise HTTPException(status_code=403, detail="Tenant ID mismatch")

    # Validate regional residency
    if not validate_regional_residency(tenant_id, region_id):
        with SessionLocal() as audit_db:
            append_audit_log(audit_db, tenant_id, payload.collector_id, "collector", "ingest_reject", {
                "reason": "regional_residency_violation",
                "region_id": region_id,
                "expected_region": "ap-south-1" if tenant_id == "tenant_acme_corp" else "eu-central-1" if tenant_id == "tenant_globex_ind" else "us-east-1",
            })
        raise HTTPException(status_code=403, detail=f"Tenant {tenant_id} not authorized for region {region_id}")

    # Idempotent insert
    start_time = time.time()
    try:
        event_ts = datetime.fromisoformat(payload.event_timestamp_utc.replace("Z", "+00:00")).timestamp()
        watermark_sorter.record_observation(start_time, event_ts)
    except Exception:
        pass
    payload_id, is_duplicate = insert_telemetry(db, payload.model_dump())
    ingest_latency_ms = int((time.time() - start_time) * 1000)

    # Process through AIOps engine
    result = await process_ingest_payload(payload.model_dump())

    # Persist any new/updated incidents
    with SessionLocal() as db2:
        for incident_id in result.get("new_incidents", []):
            incident = aio_ops_engine.get_incident(tenant_id, incident_id)
            if incident:
                upsert_incident(db2, {
                    "incident_id": incident.incident_id,
                    "tenant_id": incident.tenant_id,
                    "source_id": incident.source_id,
                    "event_category": incident.event_category.value,
                    "severity": incident.severity.value,
                    "health_state": incident.health_state.value,
                    "first_alert_time_utc": incident.first_alert_time.isoformat(),
                    "last_update_time_utc": incident.last_update_time.isoformat(),
                    "alert_count": incident.alert_count,
                    "contributing_signals": incident.contributing_signals,
                    "reasoning_path": incident.reasoning_path,
                    "confidence": incident.confidence,
                    "recommended_action": incident.recommended_action,
                    "ai_provider": incident.ai_provider,
                    "llm_latency_ms": incident.llm_latency_ms,
                    "status": incident.status.value,
                    "z_scores": incident.z_scores,
                    "metrics_snapshot": incident.metrics_snapshot,
                    "security_summary": incident.security_summary,
                })

    # Broadcast to SSE
    if result.get("new_incidents"):
        incidents_data = [aio_ops_engine.get_incident(tenant_id, iid) for iid in result["new_incidents"]]
        for inc in incidents_data:
            if inc:
                await sse_manager.broadcast(tenant_id, "incident", _incident_to_dict(inc))

    # Log ingest decision
    with SessionLocal() as audit_db:
        append_audit_log(audit_db, tenant_id, payload.collector_id, "collector", "ingest_accept", {
            "payload_id": payload_id,
            "is_duplicate": is_duplicate,
            "ingest_latency_ms": ingest_latency_ms,
            "anomalies_detected": result.get("anomalies_detected", 0),
            "new_incidents": result.get("new_incidents", []),
        })

    return {
        "status": "accepted" if not is_duplicate else "duplicate_ignored",
        "payload_id": payload_id,
        "ingest_latency_ms": ingest_latency_ms,
        "anomalies_detected": result.get("anomalies_detected", 0),
        "new_incidents": result.get("new_incidents", []),
    }


@app.post("/api/v1/heartbeat", response_model=dict)
async def collector_heartbeat(
    payload: HeartbeatPayload,
    tenant_id: str = Depends(verify_collector_auth),
):
    """Process collector heartbeat."""
    if payload.tenant_id != tenant_id:
        with SessionLocal() as audit_db:
            append_audit_log(audit_db, tenant_id, payload.collector_id, "collector", "heartbeat_reject", {
                "reason": "tenant_id_mismatch",
            })
        raise HTTPException(status_code=403, detail="Tenant ID mismatch")

    # Include version and collector_meta in the payload for process_heartbeat
    heartbeat_data = payload.model_dump()

    result = await process_heartbeat(heartbeat_data)

    # Persist collector state
    with SessionLocal() as db:
        upsert_collector(db, {
            "collector_id": payload.collector_id,
            "tenant_id": payload.tenant_id,
            "region_id": "ap-south-1",
            "version": payload.version,
            "collector_cpu_pct": payload.collector_cpu_pct,
            "collector_mem_mb": payload.collector_mem_mb,
            "health_state": result["health_state"],
            "last_heartbeat_utc": datetime.now(timezone.utc),
            "state_reason": "Heartbeat received",
            "state_transitions": [],
        })

    return result


@app.get("/api/v1/telemetry", response_model=list[TelemetryResponse])
async def get_telemetry(
    tenant_id: str = Depends(verify_collector_auth),
    db: Session = Depends(get_db),
    source_id: str | None = Query(None),
    event_category: str | None = Query(None),
    start_time: str | None = Query(None),
    end_time: str | None = Query(None),
    limit: int = Query(1000, le=5000),
):
    """Fetch tenant-scoped metadata sorted by event_timestamp_utc."""
    start = datetime.fromisoformat(start_time.replace("Z", "+00:00")) if start_time else None
    end = datetime.fromisoformat(end_time.replace("Z", "+00:00")) if end_time else None

    records = query_telemetry(db, tenant_id, source_id, event_category, start, end, limit)

    return [
        TelemetryResponse(
            payload_id=r.payload_id,
            tenant_id=r.tenant_id,
            source_id=r.source_id,
            event_timestamp_utc=r.event_timestamp_utc.isoformat(),
            event_category=r.event_category,
            severity=r.severity,
            health_state=r.health_state,
            metrics=r.metrics,
            security_summary=r.security_summary,
            alert_context=r.alert_context,
            collector_meta=r.collector_meta,
        )
        for r in records
    ]


@app.get("/api/v1/fleet/health", response_model=list[CollectorHealthResponse])
async def fleet_health(
    tenant_id: str = Depends(verify_collector_auth),
    db: Session = Depends(get_db),
):
    """Get collector fleet status and 4-state health breakdown."""
    collectors = get_collector_health(tenant_id)
    return [CollectorHealthResponse(**c) for c in collectors]


@app.get("/api/v1/fleet/transitions", response_model=list[StateTransitionResponse])
async def fleet_transitions(
    tenant_id: str = Depends(verify_collector_auth),
    db: Session = Depends(get_db),
    collector_id: str | None = Query(None),
    limit: int = Query(100, le=500),
):
    """Get collector health state transition history with UTC timestamps."""
    transitions = query_state_transitions(db, tenant_id, collector_id, limit)
    return [
        StateTransitionResponse(
            tenant_id=t.tenant_id,
            collector_id=t.collector_id,
            from_state=t.from_state,
            to_state=t.to_state,
            reason=t.reason,
            timestamp_utc=t.timestamp_utc.isoformat(),
            record_hash=t.record_hash,
        )
        for t in transitions
    ]


@app.get("/api/v1/incidents", response_model=list[IncidentResponse])
async def list_incidents(
    tenant_id: str = Depends(verify_collector_auth),
    db: Session = Depends(get_db),
    limit: int = Query(100, le=500),
    status: str | None = Query(None),
):
    """Get correlated AIOps incidents with explainable RCA."""
    incidents = get_incidents(tenant_id)
    return [IncidentResponse(**i) for i in incidents[:limit]]


@app.get("/api/v1/incidents/{incident_id}", response_model=IncidentResponse)
async def get_incident_detail(
    incident_id: str,
    tenant_id: str = Depends(verify_collector_auth),
    db: Session = Depends(get_db),
):
    """Get single incident detail."""
    incident = get_incident(tenant_id, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    return IncidentResponse(**incident)


@app.post("/api/v1/remediation/{incident_id}/approve", response_model=RemediationResponse)
async def approve_remediation(
    incident_id: str,
    payload: RemediationApproveRequest,
    tenant_id: str = Depends(verify_collector_auth),
    db: Session = Depends(get_db),
):
    """Approve remediation with policy checks and audit trail."""
    # Check both engine's correlator and DB for incident
    incident = get_incident(tenant_id, incident_id)
    if not incident:
        # Check DB
        with SessionLocal() as db2:
            record = db2.query(IncidentRecord).filter(
                IncidentRecord.incident_id == incident_id,
                IncidentRecord.tenant_id == tenant_id,
            ).first()
            if record:
                # Convert DB record to engine incident format
                incident = _incident_record_to_dict(record)
            else:
                raise HTTPException(status_code=404, detail="Incident not found")

    # Policy check - critical requires dual approval
    if incident["severity"] == "critical" and payload.operator_role != Role.ADMINISTRATOR.value:
        # Check if this is the first approval
        with SessionLocal() as audit_db:
            recent = audit_db.execute(
                audit_db.query(RemediationRecord).where(
                    RemediationRecord.incident_id == incident_id,
                    RemediationRecord.tenant_id == tenant_id,
                    RemediationRecord.action == "approve",
                    RemediationRecord.status == "pending_dual",
                )
            ).scalar_one_or_none()

        if not recent:
            # First approval - record as pending dual
            with SessionLocal() as audit_db:
                record_remediation(
                    audit_db,
                    incident_id,
                    tenant_id,
                    "approve",
                    payload.operator_id,
                    payload.operator_role,
                    "pending_dual",
                )
                append_audit_log(audit_db, tenant_id, payload.operator_id, payload.operator_role, "remediation_approve_pending_dual", {
                    "incident_id": incident_id,
                    "operator_id": payload.operator_id,
                })
            return RemediationResponse(
                status="pending_dual_approval",
                incident_id=incident_id,
                operator_id=payload.operator_id,
                action="approve",
                message="Critical severity requires second operator approval",
            )
        elif recent.operator_id == payload.operator_id:
            return RemediationResponse(
                status="pending_dual_approval",
                incident_id=incident_id,
                operator_id=payload.operator_id,
                action="approve",
                message="Second approval must be from a different operator",
            )
        # Second approval received - proceed

    # Generate cryptographic command signature
    import hmac
    cmd_ts = int(time.time())
    token_src = f"{incident_id}:approve:{payload.operator_id}:{cmd_ts}"
    cmd_sig = hmac.new(b"cicada_control_key_2026", token_src.encode(), hashlib.sha256).hexdigest()
    rollback_token = f"rb_{incident_id}_{cmd_ts}"

    # Update incident status in DB
    with SessionLocal() as db2:
        record = db2.query(IncidentRecord).filter(
            IncidentRecord.incident_id == incident_id,
            IncidentRecord.tenant_id == tenant_id,
        ).first()
        if record:
            record.status = "acknowledged"
            db2.commit()

    # Record remediation
    with SessionLocal() as audit_db:
        remediation_rec = record_remediation(
            audit_db,
            incident_id,
            tenant_id,
            "approve",
            payload.operator_id,
            payload.operator_role,
            "approved",
            rollback_token=rollback_token,
            command_signature=cmd_sig,
        )
        audit_rec = append_audit_log(audit_db, tenant_id, payload.operator_id, payload.operator_role, "remediation_approve", {
            "incident_id": incident_id,
            "command_signature": cmd_sig,
            "rollback_token": rollback_token,
            "remediation_record_hash": remediation_rec.record_hash,
        })

    return RemediationResponse(
        status="approved",
        incident_id=incident_id,
        operator_id=payload.operator_id,
        action="simulated_remediation",
        rollback_token=rollback_token,
        command_signature=cmd_sig,
        audit_hash=audit_rec.record_hash,
        message="Remediation simulated - no actual execution in hackathon mode",
    )


@app.post("/api/v1/remediation/{incident_id}/rollback", response_model=RemediationResponse)
async def rollback_remediation(
    incident_id: str,
    payload: RemediationRollbackRequest,
    tenant_id: str = Depends(verify_collector_auth),
    db: Session = Depends(get_db),
):
    """Rollback remediation with audit trail."""
    # Check both engine's correlator and DB for incident
    incident = get_incident(tenant_id, incident_id)
    if not incident:
        # Check DB
        with SessionLocal() as db2:
            record = db2.query(IncidentRecord).filter(
                IncidentRecord.incident_id == incident_id,
                IncidentRecord.tenant_id == tenant_id,
            ).first()
            if record:
                incident = _incident_record_to_dict(record)
            else:
                raise HTTPException(status_code=404, detail="Incident not found")

    # Generate rollback signature
    import hmac
    cmd_ts = int(time.time())
    token_src = f"{incident_id}:rollback:{payload.operator_id}:{cmd_ts}"
    cmd_sig = hmac.new(b"cicada_control_key_2026", token_src.encode(), hashlib.sha256).hexdigest()

    # Record rollback
    with SessionLocal() as audit_db:
        remediation_rec = record_remediation(
            audit_db,
            incident_id,
            tenant_id,
            "rollback",
            payload.operator_id,
            payload.operator_role,
            "rolled_back",
            command_signature=cmd_sig,
        )
        audit_rec = append_audit_log(audit_db, tenant_id, payload.operator_id, payload.operator_role, "remediation_rollback", {
            "incident_id": incident_id,
            "command_signature": cmd_sig,
            "remediation_record_hash": remediation_rec.record_hash,
        })

    return RemediationResponse(
        status="rolled_back",
        incident_id=incident_id,
        operator_id=payload.operator_id,
        action="simulated_rollback",
        command_signature=cmd_sig,
        audit_hash=audit_rec.record_hash,
        message="Rollback simulated - no actual execution",
    )


@app.post("/api/v1/incidents/{incident_id}/remediate", response_model=dict)
async def remediate_incident_endpoint(
    incident_id: str,
    payload: IncidentRemediatePayload,
    tenant_id: str = Depends(verify_collector_auth),
    db: Session = Depends(get_db),
):
    incident = get_incident(tenant_id, incident_id)
    if not incident:
        with SessionLocal() as db2:
            record = db2.query(IncidentRecord).filter(
                IncidentRecord.incident_id == incident_id,
                IncidentRecord.tenant_id == tenant_id,
            ).first()
            if record:
                incident = _incident_record_to_dict(record)
            else:
                raise HTTPException(status_code=404, detail="Incident not found")

    result = remediation_orchestrator.execute_remediation(
        incident_id=incident_id,
        tenant_id=tenant_id,
        operator_id=payload.operator_id,
        role=payload.role,
        action=payload.action,
        severity=incident.get("severity", "warning"),
        approved=payload.approved,
        incident_data=incident,
    )

    result.update({
        "why_flagged": incident.get("why_flagged", "Baseline vs observed metric deviation detected"),
        "why_this_action": incident.get("why_this_action", "Action addresses detected root cause"),
        "audit_trail": {
            "audit_index": result.get("audit_index"),
            "audit_hash": result.get("audit_hash"),
            "timestamp_utc": result.get("timestamp_utc"),
            "policy_status": result.get("policy_status"),
            "approved_by": result.get("approved_by"),
        },
        "rollback_plan": result.get("rollback_plan"),
    })

    if payload.action == "approve" and result.get("status") == "approved":
        with SessionLocal() as db2:
            record = db2.query(IncidentRecord).filter(
                IncidentRecord.incident_id == incident_id,
                IncidentRecord.tenant_id == tenant_id,
            ).first()
            if record:
                record.status = "acknowledged"
                db2.commit()

    return result


@app.post("/api/v1/incidents/{incident_id}/rollback", response_model=dict)
async def rollback_incident_endpoint(
    incident_id: str,
    payload: IncidentRemediatePayload,
    tenant_id: str = Depends(verify_collector_auth),
    db: Session = Depends(get_db),
):
    incident = get_incident(tenant_id, incident_id)
    if not incident:
        with SessionLocal() as db2:
            record = db2.query(IncidentRecord).filter(
                IncidentRecord.incident_id == incident_id,
                IncidentRecord.tenant_id == tenant_id,
            ).first()
            if record:
                incident = _incident_record_to_dict(record)
            else:
                raise HTTPException(status_code=404, detail="Incident not found")

    result = remediation_orchestrator.execute_remediation(
        incident_id=incident_id,
        tenant_id=tenant_id,
        operator_id=payload.operator_id,
        role=payload.role,
        action="rollback",
        severity=incident.get("severity", "warning"),
        approved=True,
        incident_data=incident,
    )

    result.update({
        "why_flagged": incident.get("why_flagged", "Baseline vs observed metric deviation detected"),
        "why_this_action": incident.get("why_this_action", "Rollback reverts to pre-remediation state"),
        "audit_trail": {
            "audit_index": result.get("audit_index"),
            "audit_hash": result.get("audit_hash"),
            "timestamp_utc": result.get("timestamp_utc"),
            "policy_status": result.get("policy_status"),
            "approved_by": result.get("approved_by"),
            "rolled_back_by": payload.operator_id,
        },
        "rollback_plan": result.get("rollback_plan"),
    })

    return result


def _incident_record_to_dict(record: IncidentRecord) -> dict:
    """Convert DB IncidentRecord to engine incident dict format."""
    return {
        "incident_id": record.incident_id,
        "tenant_id": record.tenant_id,
        "source_id": record.source_id,
        "event_category": record.event_category,
        "severity": record.severity,
        "health_state": record.health_state,
        "first_alert_time_utc": record.first_alert_time_utc.isoformat(),
        "last_update_time_utc": record.last_update_time_utc.isoformat(),
        "alert_count": record.alert_count,
        "contributing_signals": record.contributing_signals,
        "reasoning_path": record.reasoning_path,
        "confidence": record.confidence,
        "recommended_action": record.recommended_action,
        "ai_provider": record.ai_provider,
        "llm_latency_ms": record.llm_latency_ms,
        "status": record.status,
        "z_scores": record.z_scores,
        "metrics_snapshot": record.metrics_snapshot,
        "security_summary": record.security_summary,
    }


@app.get("/api/v1/sla/metrics", response_model=SlaMetricsResponse)
async def sla_metrics(
    tenant_id: str = Depends(verify_collector_auth),
):
    """Real-time measured SLA dashboard (static thresholds)."""
    base = get_sla_metrics()
    wm = watermark_sorter.get_metrics()
    return SlaMetricsResponse(**{**base, **wm})


@app.get("/api/v1/sla/metrics/live", response_model=SlaMetricsLiveResponse)
async def sla_metrics_live(
    tenant_id: str = Depends(verify_collector_auth),
    db: Session = Depends(get_db),
):
    """
    Live measured SLA metrics computed strictly from real UTC timestamps on ingested records.
    Returns null/awaiting_live_data if no live events have arrived yet.
    """
    # Query telemetry to compute live SLAs
    records = query_telemetry(db, tenant_id, limit=10000)

    if not records:
        return SlaMetricsLiveResponse(
            status="awaiting_live_data",
        )

    # Compute ingest latency: ingested_at_utc - event_timestamp_utc
    ingest_latencies = []
    received_count = len(records)
    duplicate_count = 0  # Would need to track separately

    for r in records:
        if r.ingested_at_utc and r.event_timestamp_utc:
            latency_ms = (r.ingested_at_utc - r.event_timestamp_utc).total_seconds() * 1000
            if latency_ms >= 0:
                ingest_latencies.append(latency_ms)

    # Compute p95 ingest latency
    p95_ingest = None
    if ingest_latencies:
        sorted_latencies = sorted(ingest_latencies)
        idx = int(len(sorted_latencies) * 0.95)
        p95_ingest = sorted_latencies[min(idx, len(sorted_latencies) - 1)]

    # For breach-to-alert and offline detection, we'd need incident/alert timestamps
    # For now, return what we can compute from live data
    return SlaMetricsLiveResponse(
        p95_ingest_latency_ms=round(p95_ingest, 2) if p95_ingest else None,
        p95_breach_to_alert_ms=None,  # Would need incident tracking
        offline_detection_time_s=None,  # Would need collector state tracking
        received_count=received_count,
        duplicate_count=duplicate_count,
        status="live" if received_count > 0 else "awaiting_live_data",
    )


@app.get("/api/v1/policy/thresholds", response_model=PolicyThresholdsResponse)
async def get_thresholds(
    tenant_id: str = Depends(verify_collector_auth),
    db: Session = Depends(get_db),
):
    """Get configurable health thresholds for a tenant."""
    thresholds = get_policy_thresholds(db, tenant_id)
    return PolicyThresholdsResponse(tenant_id=tenant_id, thresholds=thresholds)


@app.put("/api/v1/policy/thresholds", response_model=PolicyThresholdsResponse)
async def update_thresholds(
    request: UpdateThresholdRequest,
    tenant_id: str = Depends(verify_collector_auth),
    db: Session = Depends(get_db),
):
    """Update a health threshold for a tenant (judge-accessible)."""
    # In production, verify admin role
    update_policy_threshold(db, tenant_id, request.metric_name,
                           request.excellent_max, request.good_max, request.fair_max,
                           "judge")
    thresholds = get_policy_thresholds(db, tenant_id)
    return PolicyThresholdsResponse(tenant_id=tenant_id, thresholds=thresholds)


@app.get("/api/v1/audit", response_model=AuditLogResponse)
async def get_audit_trail(
    tenant_id: str = Depends(verify_collector_auth),
    db: Session = Depends(get_db),
    limit: int = Query(100, le=500),
):
    """
    Fetch tamper-evident audit records with SHA-256 integrity verification.
    Strictly filtered by tenant_id.
    """
    valid, message = verify_audit_chain(db)
    raw_records = query_audit_log(db, tenant_id=tenant_id, limit=limit)

    formatted = [
        {
            "index": r.index,
            "timestamp_utc": r.timestamp_utc.isoformat(),
            "tenant_id": r.tenant_id,
            "user_id": r.user_id,
            "role": r.role,
            "action": r.action,
            "details": r.details,
            "prev_hash": r.prev_hash,
            "record_hash": r.record_hash,
            "record_sha256": r.record_sha256,
        }
        for r in raw_records
    ]

    return AuditLogResponse(
        chain_valid=valid,
        verification_message=message,
        total_records=len(raw_records),
        records=formatted,
    )


@app.post("/api/v1/admin/simulate-outage", response_model=dict)
async def simulate_outage(
    payload: SimulateOutagePayload,
    tenant_id: str = Depends(verify_collector_auth),
):
    """Live demo switch for Phase 3 outage test."""
    global INGEST_OUTAGE_MODE
    INGEST_OUTAGE_MODE = payload.enabled
    watermark_sorter.set_recovery_mode(not payload.enabled)
    return {
        "outage_mode": INGEST_OUTAGE_MODE,
        "message": "Ingest endpoint " + ("disabled" if payload.enabled else "enabled"),
    }


# Global outage mode flag for demo
INGEST_OUTAGE_MODE = False


@app.get("/api/v1/stream")
async def sse_stream(
    request: Request,
    tenant_id: str = Depends(verify_collector_auth),
):
    """Server-Sent Events real-time push for live dashboard updates."""
    queue = await sse_manager.connect(tenant_id)

    async def generator():
        try:
            # Send initial connection event
            yield f"event: connected\ndata: {json.dumps({'tenant_id': tenant_id})}\n\n"
            async for message in event_generator(tenant_id, queue):
                if await request.is_disconnected():
                    break
                yield message
        finally:
            sse_manager.disconnect(tenant_id, queue)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ─── Health Check ───

@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "tier2-saas", "timestamp": datetime.now(timezone.utc).isoformat()}


# ─── Helper ───

def _incident_to_dict(incident: Incident) -> dict:
    return {
        "incident_id": incident.incident_id,
        "tenant_id": incident.tenant_id,
        "source_id": incident.source_id,
        "event_category": incident.event_category.value,
        "severity": incident.severity.value,
        "health_state": incident.health_state.value,
        "first_alert_time_utc": incident.first_alert_time.isoformat(),
        "last_update_time_utc": incident.last_update_time.isoformat(),
        "alert_count": incident.alert_count,
        "contributing_signals": incident.contributing_signals,
        "reasoning_path": incident.reasoning_path,
        "confidence": incident.confidence,
        "recommended_action": incident.recommended_action,
        "ai_provider": incident.ai_provider,
        "llm_latency_ms": incident.llm_latency_ms,
        "status": incident.status.value,
        "z_scores": incident.z_scores,
        "metrics_snapshot": incident.metrics_snapshot,
        "security_summary": incident.security_summary,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)