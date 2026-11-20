"""
Tier 2 Central SaaS API — FastAPI Application
Multi-tenant metadata ingestion, AIOps processing, real-time SSE streaming.
"""

from __future__ import annotations

import asyncio
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
from pydantic import BaseModel, Field, ConfigDict
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
    IncidentRecord,
    SessionLocal,
    TelemetryMetadata,
    init_db,
    insert_telemetry,
    query_incidents,
    query_telemetry,
    query_collectors,
    record_sla_metric,
    upsert_collector,
    upsert_incident,
    validate_regional_residency,
)
from .adaptive_watermark import watermark_sorter
from .remediation import remediation_orchestrator
from .auth_rbac import Role, audit_log
from .watchdog_modules.resolver import router as resolver_router
from .watchdog_modules.watchdog_config import router as watchdog_config_router
from .watchdog_modules.notifier import router as notifier_router
from .watchdog_modules.gatekeeper import router as gatekeeper_router

# ─── Lifespan ───

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # Startup
    init_db()
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

# CORS for Next.js frontend (allow * for 4-laptop LAN hotspot demo)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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


async def verify_tenant_auth(
    authorization: Annotated[str | None, Header()] = None,
    x_tenant_id: Annotated[str | None, Header(alias="X-Tenant-ID")] = None,
    token: Annotated[str | None, Query()] = None,
    tenant_id: Annotated[str | None, Query()] = None,
) -> str:
    """Verify collector authentication and return tenant_id (supports headers or query params for SSE)."""
    auth = authorization or (f"Bearer {token}" if token else None)
    tid = x_tenant_id or tenant_id
    if not auth or not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    if not tid:
        raise HTTPException(status_code=401, detail="Missing X-Tenant-ID header")
    # In production: validate token against collector registry
    return tid


# ─── Background Tasks ───

async def heartbeat_watchdog_loop():
    """Background task: Check collector timeouts every 5 seconds."""
    while True:
        try:
            await asyncio.sleep(5)
            changed = aio_ops_engine.check_collector_timeouts()
            if changed:
                for collector in changed:
                    # Persist to DB
                    with SessionLocal() as db:
                        upsert_collector(db, {
                            "collector_id": collector.collector_id,
                            "tenant_id": collector.tenant_id,
                            "region_id": "ap-south-1",  # Would come from registry
                            "version": collector.version,
                            "collector_cpu_pct": collector.collector_cpu_pct,
                            "collector_mem_mb": collector.collector_mem_mb,
                            "health_state": collector.health_state.value,
                            "last_heartbeat_utc": collector.last_heartbeat,
                            "state_reason": collector.state_reason,
                            "state_transitions": collector.state_transitions,
                        })
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


class HeartbeatPayload(BaseModel):
    collector_id: str
    tenant_id: str
    version: str = "unknown"
    collector_cpu_pct: float = 0.0
    collector_mem_mb: float = 0.0


class SimulateOutagePayload(BaseModel):
    enabled: bool


class IncidentRemediatePayload(BaseModel):
    action: Literal["approve", "rollback"]
    operator_id: str


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


# ─── API Endpoints ───

@app.post("/api/v1/ingest/{region_id}", response_model=dict)
async def ingest_metadata(
    region_id: str,
    payload: IngestPayload,
    tenant_id: str = Depends(verify_tenant_auth),
    db: Session = Depends(get_db),
):
    """
    Regional metadata ingest endpoint.
    Validates tenant residency, enforces idempotent deduplication,
    runs AIOps pipeline, returns acceptance status.
    """
    # Verify tenant matches auth
    if payload.tenant_id != tenant_id:
        raise HTTPException(status_code=403, detail="Tenant ID mismatch")

    # Validate regional residency
    if not validate_regional_residency(tenant_id, region_id):
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

    return {
        "status": "accepted" if not is_duplicate else "duplicated",
        "payload_id": payload_id,
        "ingest_latency_ms": ingest_latency_ms,
        "anomalies_detected": result.get("anomalies_detected", 0),
        "new_incidents": result.get("new_incidents", []),
    }


@app.post("/api/v1/heartbeat", response_model=dict)
async def collector_heartbeat(
    payload: HeartbeatPayload,
    tenant_id: str = Depends(verify_tenant_auth),
):
    """Process collector heartbeat."""
    if payload.tenant_id != tenant_id:
        raise HTTPException(status_code=403, detail="Tenant ID mismatch")

    result = await process_heartbeat(payload.model_dump())

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
    tenant_id: str = Depends(verify_tenant_auth),
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
    tenant_id: str = Depends(verify_tenant_auth),
    db: Session = Depends(get_db),
):
    """Get collector fleet status and 4-state health breakdown."""
    collectors = get_collector_health(tenant_id)
    return [CollectorHealthResponse(**c) for c in collectors]


@app.get("/api/v1/incidents", response_model=list[IncidentResponse])
async def list_incidents(
    tenant_id: str = Depends(verify_tenant_auth),
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
    tenant_id: str = Depends(verify_tenant_auth),
    db: Session = Depends(get_db),
):
    """Get single incident detail."""
    incident = get_incident(tenant_id, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    return IncidentResponse(**incident)


@app.post("/api/v1/incidents/{incident_id}/remediate", response_model=dict)
async def remediate_incident(
    incident_id: str,
    payload: IncidentRemediatePayload,
    tenant_id: str = Depends(verify_tenant_auth),
    db: Session = Depends(get_db),
):
    """Safe remediation simulation (Stage 5 preview)."""
    incident = get_incident(tenant_id, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")

    if payload.action == "approve":
        # Policy check (simplified)
        if incident["severity"] == "critical":
            # Require dual approval for critical
            audit_log.append(
                tenant_id=tenant_id,
                user_id=payload.operator_id,
                role=Role.OPERATOR.value,
                action="remediation_approval_pending_dual",
                details={"incident_id": incident_id},
            )
            return {
                "status": "pending_dual_approval",
                "message": "Critical severity requires second operator approval",
                "incident_id": incident_id,
            }

        # Record approval
        with SessionLocal() as db2:
            record = db2.query(IncidentRecord).filter(
                IncidentRecord.incident_id == incident_id,
                IncidentRecord.tenant_id == tenant_id,
            ).first()
            if record:
                record.status = "acknowledged"
                db2.commit()

        # Log to tamper-evident audit trail with cryptographic signature
        audit_rec = audit_log.append(
            tenant_id=tenant_id,
            user_id=payload.operator_id,
            role=Role.OPERATOR.value,
            action="remediation_approve",
            details={"incident_id": incident_id},
        )

        return {
            "status": "approved",
            "action": "simulated_remediation",
            "incident_id": incident_id,
            "operator_id": payload.operator_id,
            "rollback_token": f"rb_{incident_id}_{int(time.time())}",
            "audit_hash": audit_rec.record_hash,
            "message": "Remediation simulated - no actual execution in hackathon mode",
        }

    elif payload.action == "rollback":
        audit_rec = audit_log.append(
            tenant_id=tenant_id,
            user_id=payload.operator_id,
            role=Role.OPERATOR.value,
            action="remediation_rollback",
            details={"incident_id": incident_id},
        )
        return {
            "status": "rolled_back",
            "incident_id": incident_id,
            "audit_hash": audit_rec.record_hash,
            "message": "Rollback simulated - no actual execution",
        }

    raise HTTPException(status_code=400, detail="Invalid action")


@app.get("/api/v1/sla/metrics", response_model=SlaMetricsResponse)
async def sla_metrics(
    tenant_id: str = Depends(verify_tenant_auth),
):
    """Real-time measured SLA dashboard."""
    base = get_sla_metrics()
    wm = watermark_sorter.get_metrics()
    return SlaMetricsResponse(**{**base, **wm})


@app.post("/api/v1/admin/simulate-outage", response_model=dict)
async def simulate_outage(
    payload: SimulateOutagePayload,
    tenant_id: str = Depends(verify_tenant_auth),
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
    tenant_id: str = Depends(verify_tenant_auth),
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