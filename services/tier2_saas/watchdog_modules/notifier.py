"""
services/tier2_saas/watchdog_modules/notifier.py
Watchdog Notifier Module — Alert Silences & Incident State Lifecycle
Based on:
- observantio/watchdog notification and silencing protocol.

Provides alert suppression windows (silences) and incident state transition tracking
(OPEN -> ACKNOWLEDGED -> RESOLVED) with operator notes and audit chaining.
"""

from __future__ import annotations

import time
import uuid
from typing import Literal
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from ..auth_rbac import audit_log
from ..db import SessionLocal, IncidentRecord


router = APIRouter(prefix="/api/v1", tags=["Watchdog Notifier"])


class SilenceRule(BaseModel):
    silence_id: str
    tenant_id: str
    metric_name: str | None = None
    source_id: str | None = None
    duration_minutes: int
    created_at_utc: float
    expires_at_utc: float
    created_by: str
    reason: str


class CreateSilenceRequest(BaseModel):
    tenant_id: str
    metric_name: str | None = None
    source_id: str | None = None
    duration_minutes: int = Field(default=30, ge=1, le=1440)
    created_by: str = "operator"
    reason: str = "Scheduled maintenance or false alarm suppression"


class IncidentStateUpdateRequest(BaseModel):
    state: Literal["open", "acknowledged", "resolved"]
    operator_id: str = "operator"
    operator_note: str = ""


# In-memory silences cache
_silences: dict[str, SilenceRule] = {}


@router.post("/silences", response_model=SilenceRule)
async def create_silence(request: CreateSilenceRequest):
    """Create an alert silence window to suppress transient alarm storms."""
    now = time.time()
    sid = f"sil_{uuid.uuid4().hex[:8]}"
    rule = SilenceRule(
        silence_id=sid,
        tenant_id=request.tenant_id,
        metric_name=request.metric_name,
        source_id=request.source_id,
        duration_minutes=request.duration_minutes,
        created_at_utc=now,
        expires_at_utc=now + (request.duration_minutes * 60),
        created_by=request.created_by,
        reason=request.reason,
    )
    _silences[sid] = rule

    audit_log.append(
        tenant_id=request.tenant_id,
        user_id=request.created_by,
        role="Operator",
        action="create_silence",
        details={"silence_id": sid, "metric": request.metric_name, "duration_m": request.duration_minutes},
    )
    return rule


@router.get("/silences", response_model=list[SilenceRule])
async def list_silences(tenant_id: str | None = None):
    """List active alert silences."""
    now = time.time()
    # Filter active only
    active = [s for s in _silences.values() if s.expires_at_utc > now]
    if tenant_id:
        active = [s for s in active if s.tenant_id == tenant_id]
    return active


@router.delete("/silences/{silence_id}", response_model=dict)
async def delete_silence(silence_id: str):
    """Revoke or delete an existing silence rule."""
    if silence_id not in _silences:
        raise HTTPException(status_code=404, detail="Silence rule not found")
    removed = _silences.pop(silence_id)
    audit_log.append(
        tenant_id=removed.tenant_id,
        user_id="operator",
        role="Operator",
        action="delete_silence",
        details={"silence_id": silence_id},
    )
    return {"status": "deleted", "silence_id": silence_id}


@router.patch("/incidents/{incident_id}/state", response_model=dict)
async def update_incident_state(incident_id: str, payload: IncidentStateUpdateRequest):
    """Transition an incident lifecycle state (open, acknowledged, resolved)."""
    # Check DB
    with SessionLocal() as db:
        rec = db.query(IncidentRecord).filter(IncidentRecord.incident_id == incident_id).first()
        old_state = "unknown"
        tenant_id = "tenant_default"
        if rec:
            old_state = rec.status
            rec.status = payload.state
            tenant_id = rec.tenant_id
            db.commit()

    # Log to tamper-evident audit trail
    audit_record = audit_log.append(
        tenant_id=tenant_id,
        user_id=payload.operator_id,
        role="Operator",
        action="transition_incident_state",
        details={
            "incident_id": incident_id,
            "from_state": old_state,
            "to_state": payload.state,
            "note": payload.operator_note,
        },
    )

    return {
        "status": "updated",
        "incident_id": incident_id,
        "previous_state": old_state,
        "new_state": payload.state,
        "operator_id": payload.operator_id,
        "audit_hash": audit_record.record_hash,
    }
