"""
services/tier2_saas/watchdog_modules/gatekeeper.py
Watchdog Gatekeeper Module — Tamper-Evident Audit & Security Logs
Based on:
- observantio/watchdog gatekeeper / audit architecture.

Exposes verified cryptographic audit logs for compliance, proving chain continuity
and non-repudiation of all remediation actions, silences, and state changes.
"""

from __future__ import annotations

from typing import Any
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from ..auth_rbac import audit_log


router = APIRouter(prefix="/api/v1/audit", tags=["Watchdog Gatekeeper"])


class AuditLogResponse(BaseModel):
    chain_valid: bool
    verification_message: str
    total_records: int
    records: list[dict[str, Any]]


@router.get("", response_model=AuditLogResponse)
async def get_audit_trail(
    tenant_id: str | None = Query(None),
    limit: int = Query(100, le=500),
):
    """
    Fetch cryptographic audit records and verify unbroken SHA-256 hash chaining.
    """
    valid, message = audit_log.verify_chain()
    raw_records = audit_log.get_records(tenant_id=tenant_id, limit=limit)

    formatted = [
        {
            "index": r.index,
            "timestamp_utc": r.timestamp_utc,
            "tenant_id": r.tenant_id,
            "user_id": r.user_id,
            "role": r.role,
            "action": r.action,
            "details": r.details,
            "prev_hash": r.prev_hash,
            "record_hash": r.record_hash,
        }
        for r in raw_records
    ]

    return AuditLogResponse(
        chain_valid=valid,
        verification_message=message,
        total_records=len(raw_records),
        records=formatted,
    )
