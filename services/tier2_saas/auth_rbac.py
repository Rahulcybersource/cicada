"""
services/tier2_saas/auth_rbac.py
Tenant-Scoped RBAC/ABAC & Tamper-Evident Audit Chain
Based on:
- Tran IIoT Thesis & Enterprise Multi-Tenant Security Standards.

Provides role definitions (Administrator, Operator, Viewer), permission checks,
and a tamper-evident audit log with cryptographic SHA-256 chain linking.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal


class Role(str, Enum):
    ADMINISTRATOR = "Administrator"
    OPERATOR = "Operator"
    VIEWER = "Viewer"


# Permission catalog
PERMISSIONS = {
    Role.ADMINISTRATOR: {
        "view_telemetry",
        "view_incidents",
        "view_audit",
        "remediate_tier1",
        "remediate_tier2",
        "remediate_tier3",
        "manage_silences",
        "admin_outage",
        "manage_tenants",
    },
    Role.OPERATOR: {
        "view_telemetry",
        "view_incidents",
        "view_audit",
        "remediate_tier1",
        "remediate_tier2",
        "manage_silences",
    },
    Role.VIEWER: {
        "view_telemetry",
        "view_incidents",
        "view_audit",
    },
}


@dataclass
class AuditRecord:
    index: int
    timestamp_utc: str
    tenant_id: str
    user_id: str
    role: str
    action: str
    details: dict[str, Any]
    prev_hash: str
    record_hash: str


class AuditLogChain:
    """
    Tamper-evident append-only audit trail using SHA-256 hash chaining.
    H_i = SHA256(index || timestamp || tenant || user || role || action || details || H_{i-1})
    """

    GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000"

    def __init__(self):
        self._records: list[AuditRecord] = []
        self._last_hash = self.GENESIS_HASH

    def append(
        self,
        tenant_id: str,
        user_id: str,
        role: str,
        action: str,
        details: dict[str, Any],
    ) -> AuditRecord:
        idx = len(self._records)
        now_str = datetime.now(timezone.utc).isoformat()
        details_str = json.dumps(details, sort_keys=True)

        payload_bytes = f"{idx}:{now_str}:{tenant_id}:{user_id}:{role}:{action}:{details_str}:{self._last_hash}".encode("utf-8")
        current_hash = hashlib.sha256(payload_bytes).hexdigest()

        rec = AuditRecord(
            index=idx,
            timestamp_utc=now_str,
            tenant_id=tenant_id,
            user_id=user_id,
            role=role,
            action=action,
            details=details,
            prev_hash=self._last_hash,
            record_hash=current_hash,
        )
        self._records.append(rec)
        self._last_hash = current_hash
        return rec

    def verify_chain(self) -> tuple[bool, str]:
        """Verify the integrity of every block in the chain."""
        expected_prev = self.GENESIS_HASH
        for rec in self._records:
            if rec.prev_hash != expected_prev:
                return False, f"Broken link at index {rec.index}: expected {expected_prev}, got {rec.prev_hash}"
            details_str = json.dumps(rec.details, sort_keys=True)
            payload_bytes = f"{rec.index}:{rec.timestamp_utc}:{rec.tenant_id}:{rec.user_id}:{rec.role}:{rec.action}:{details_str}:{expected_prev}".encode("utf-8")
            recomputed = hashlib.sha256(payload_bytes).hexdigest()
            if recomputed != rec.record_hash:
                return False, f"Corrupted hash at index {rec.index}: expected {recomputed}, got {rec.record_hash}"
            expected_prev = rec.record_hash
        return True, "Chain valid and uncorrupted"

    def get_records(self, tenant_id: str | None = None, limit: int = 100) -> list[AuditRecord]:
        if tenant_id:
            filtered = [r for r in self._records if r.tenant_id == tenant_id]
        else:
            filtered = self._records
        return list(reversed(filtered[-limit:]))


# Global audit log
audit_log = AuditLogChain()


def check_permission(role: Role | str, required_permission: str) -> bool:
    """Check if the given role possesses the required permission."""
    try:
        r = Role(role) if isinstance(role, str) else role
        return required_permission in PERMISSIONS.get(r, set())
    except ValueError:
        return False
