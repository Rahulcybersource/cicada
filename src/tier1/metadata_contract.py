"""
Metadata Contract — Tier 1 (Local Collector) to Tier 2 (Central SaaS)

Strict Pydantic v2 allow-list schema for metadata crossing the Trust Boundary.
extra="forbid" ensures ZERO unapproved fields can egress.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class EventCategory(str, Enum):
    """Classification of the telemetry event source."""
    INFRA = "INFRA"
    NETWORK = "NETWORK"
    SECURITY = "SECURITY"
    COLLECTOR = "COLLECTOR"


class Severity(str, Enum):
    """Severity level for alerting and prioritization."""
    INFO = "INFO"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"


class HealthState(str, Enum):
    """Four-state health classification (product-level, not judging phases)."""
    EXCELLENT = "EXCELLENT"
    GOOD = "GOOD"
    FAIR = "FAIR"
    POOR = "POOR"


class TelemetryPayload(BaseModel):
    """
    Strict allow-list schema for metadata egressing Tier 1.

    Rules enforced:
    - extra="forbid": Rejects ANY field not explicitly defined below
    - frozen=True: Immutable after creation (audit integrity)
    - str_strip_whitespace: Sanitizes string inputs
    - All validators run on assignment
    """
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        str_strip_whitespace=True,
        validate_assignment=True,
        ser_json_timedelta="iso8601",
    )

    # ─── Identity & Routing (Required) ───
    payload_id: UUID = Field(
        ...,
        description="UUIDv7 for idempotent delivery + time-ordered sorting",
        examples=["018f3a2b-4c5d-7e8f-9a0b-c1d2e3f4a5b6"],
    )
    tenant_id: str = Field(
        ...,
        min_length=1,
        max_length=64,
        pattern=r"^[a-z0-9_-]+$",
        description="Tenant scope — enforced at ingestion, storage, and query layers",
        examples=["tenant_acme_corp"],
    )
    collector_id: str = Field(
        ...,
        min_length=1,
        max_length=64,
        pattern=r"^[a-z0-9_-]+$",
        description="Pseudonymous collector identifier",
        examples=["coll_us_east_1_003"],
    )
    source_id: str = Field(
        ...,
        min_length=1,
        max_length=32,
        pattern=r"^src_[a-f0-9]{6}$",
        description="Pseudonymous source ID (NO hostnames, IPs, or PII)",
        examples=["src_7f3a2b"],
    )

    # ─── Temporal (Required) ───
    event_timestamp: datetime = Field(
        ...,
        description="UTC event timestamp (timezone-aware, NOT arrival time)",
        examples=["2026-11-20T14:30:00.123Z"],
    )
    source_timezone: str = Field(
        ...,
        min_length=1,
        max_length=50,
        description="IANA timezone name for correct dashboard rendering",
        examples=["America/New_York", "Europe/London", "Asia/Tokyo"],
    )
    region_id: str = Field(
        ...,
        min_length=1,
        max_length=32,
        pattern=r"^[a-z0-9-]+$",
        description="Regional ingest endpoint identifier (data residency)",
        examples=["us-east-1", "eu-west-1", "ap-southeast-2"],
    )

    # ─── Metric Values (Optional — only when relevant to event_category) ───
    cpu_pct: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=100.0,
        description="CPU utilization percentage",
        examples=[73.5],
    )
    mem_pct: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=100.0,
        description="Memory utilization percentage",
        examples=[81.2],
    )
    disk_pct: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=100.0,
        description="Disk utilization percentage",
        examples=[45.0],
    )
    latency_ms: Optional[float] = Field(
        default=None,
        ge=0.0,
        description="Network latency in milliseconds",
        examples=[127.3],
    )
    packet_loss_pct: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=100.0,
        description="Packet loss percentage",
        examples=[0.5],
    )
    bandwidth_mbps: Optional[float] = Field(
        default=None,
        ge=0.0,
        description="Throughput in megabits per second",
        examples=[940.0],
    )

    # ─── Classification (Required) ───
    event_category: EventCategory = Field(
        ...,
        description="Event source category for routing and correlation",
    )
    severity: Severity = Field(
        ...,
        description="Severity for alert prioritization",
    )
    health_state: HealthState = Field(
        ...,
        description="Four-state health: Excellent/Good/Fair/Poor",
    )

    # ─── Context (Optional — concise, human-readable, NO raw data) ───
    alert_context: Optional[str] = Field(
        default=None,
        max_length=280,
        description="Concise alert summary for operators (max 280 chars)",
        examples=["CPU > 70% for 5m on src_7f3a2b"],
    )

    # ─── Validators ───
    @field_validator("event_timestamp", mode="before")
    @classmethod
    def _validate_utc_timestamp(cls, v: datetime | str) -> datetime:
        """Ensure timestamp is timezone-aware UTC."""
        if isinstance(v, str):
            v = datetime.fromisoformat(v.replace("Z", "+00:00"))
        if v.tzinfo is None:
            raise ValueError("event_timestamp must be timezone-aware")
        # Normalize to UTC
        return v.astimezone(timezone.utc)

    @field_validator("source_timezone")
    @classmethod
    def _validate_iana_tz(cls, v: str) -> str:
        """Basic IANA timezone format validation."""
        import re
        # Accept both Region/City format and common single-word zones (UTC, GMT, etc.)
        if not re.match(r"^([A-Za-z]+/[A-Za-z_]+|UTC|GMT|EST|PST|CST|MST|EDT|PDT|CDT|MDT)$", v):
            raise ValueError("source_timezone must be valid IANA tz name (e.g., America/New_York, UTC)")
        return v

    @field_validator("alert_context")
    @classmethod
    def _validate_no_secrets_in_context(cls, v: Optional[str]) -> Optional[str]:
        """Defense-in-depth: ensure alert_context doesn't accidentally contain secrets."""
        if v is None:
            return v
        secret_patterns = [
            r"password\s*[:=]\s*\S+",
            r"api[_-]?key\s*[:=]\s*\S+",
            r"secret\s*[:=]\s*\S+",
            r"token\s*[:=]\s*\S+",
            r"Bearer\s+[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+",
        ]
        import re
        for pattern in secret_patterns:
            if re.search(pattern, v, re.IGNORECASE):
                raise ValueError("alert_context must not contain secrets or credentials")
        return v


# ─── Helper Functions ───

def create_payload_id() -> UUID:
    """Generate UUIDv7 (time-ordered) for idempotency.

    UUIDv7 format: timestamp (48 bits) + version (4 bits) + variant (2 bits) + random (74 bits)
    Falls back to uuid4 if uuid7 not available (Python < 3.11).
    """
    import uuid
    import time
    import struct
    import os

    try:
        # Python 3.11+
        return uuid.uuid7()
    except AttributeError:
        # Manual UUIDv7 implementation for compatibility
        # 48-bit Unix timestamp in milliseconds
        timestamp_ms = int(time.time() * 1000) & 0xFFFFFFFFFFFF
        # 74 random bits
        random_bits = int.from_bytes(os.urandom(10), 'big') & 0x3FFFFFFFFFFFFFFF
        # Version 7 (0111) in bits 48-51, Variant 10 in bits 64-65
        uuid_int = (timestamp_ms << 80) | (0x7 << 76) | (0x2 << 74) | random_bits
        return UUID(int=uuid_int)


def validate_payload(json_str: str) -> TelemetryPayload:
    """
    Validate a JSON string against the strict TelemetryPayload schema.
    Raises ValidationError if any unapproved field is present.
    """
    return TelemetryPayload.model_validate_json(json_str)


def payload_to_json(payload: TelemetryPayload) -> str:
    """Serialize payload to canonical JSON for egress."""
    return payload.model_dump_json(by_alias=True, exclude_none=True)


# ─── Redaction Utilities (Tier 1 Internal) ───

import re
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RedactionResult:
    """Result of secret scrubbing pass."""
    scrubbed_text: str
    redactions_count: int
    redaction_types: list[str]


SECRET_PATTERNS = [
    (r"(?i)(password|passwd|pwd)\s*[:=]\s*\S+", "PASSWORD"),
    (r"(?i)(api[_-]?key|apikey)\s*[:=]\s*\S+", "API_KEY"),
    (r"(?i)(secret|client[_-]?secret)\s*[:=]\s*\S+", "SECRET"),
    (r"(?i)(token|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+", "TOKEN"),
    (r"(?i)authorization\s*:\s*bearer\s+[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+", "JWT"),
    (r"(?i)authorization\s*:\s*basic\s+[A-Za-z0-9+/=]+", "BASIC_AUTH"),
    (r"(?i)(private[_-]?key|ssh[_-]?key)\s*[:=]\s*\S+", "PRIVATE_KEY"),
    (r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", "EMAIL"),
    (r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "IPV4"),  # Basic IPv4 — will be pseudonymized
]


def scrub_secrets(text: str) -> RedactionResult:
    """
    Scrub secrets from raw text before any processing.
    Returns scrubbed text and audit info for Egress Proof Panel.
    """
    result = text
    redaction_types = []
    total_count = 0

    for pattern, red_type in SECRET_PATTERNS:
        matches = list(re.finditer(pattern, result))
        if matches:
            total_count += len(matches)
            redaction_types.append(red_type)
            result = re.sub(pattern, f"[REDACTED_{red_type}]", result)

    return RedactionResult(
        scrubbed_text=result,
        redactions_count=total_count,
        redaction_types=list(set(redaction_types)),
    )


def pseudonymize_source_identifier(
    raw_identifier: str,
    tenant_salt: str,
) -> str:
    """
    Convert internal IP/hostname to stable pseudonymous source_id.
    Format: src_<6-char-hex>
    """
    import hashlib
    hash_input = f"{tenant_salt}:{raw_identifier}".encode()
    hash_hex = hashlib.sha256(hash_input).hexdigest()[:6]
    return f"src_{hash_hex}"


def extract_allowlisted_fields(
    raw_data: dict[str, Any],
    tenant_id: str,
    collector_id: str,
    region_id: str,
    source_timezone: str,
    tenant_salt: str,
) -> TelemetryPayload:
    """
    Transform raw collected telemetry into strict TelemetryPayload.
    Performs: secret scrubbing → pseudonymization → allow-list extraction → validation.
    """
    # This is the core transformation pipeline — tested in test_phase1_redaction.py
    from datetime import datetime, timezone

    # 1. Generate payload ID (UUIDv7 for time ordering)
    payload_id = create_payload_id()

    # 2. Determine source_id from raw data (pseudonymize IP/hostname)
    raw_source = raw_data.get("source_ip") or raw_data.get("hostname") or raw_data.get("source_id") or "unknown"
    source_id = pseudonymize_source_identifier(str(raw_source), tenant_salt)

    # 3. Determine event category from raw data keys
    event_category = _infer_event_category(raw_data)

    # 4. Extract metrics (only allow-listed ones)
    metrics = _extract_metrics(raw_data)

    # 5. Compute health state from metrics
    health_state = _compute_health_state(metrics, event_category)

    # 6. Determine severity
    severity = _compute_severity(metrics, event_category, raw_data)

    # 7. Build concise alert context (NO raw data)
    alert_context = _build_alert_context(metrics, event_category, health_state, source_id)

    # 8. Construct and validate payload
    payload = TelemetryPayload(
        payload_id=payload_id,
        tenant_id=tenant_id,
        collector_id=collector_id,
        source_id=source_id,
        event_timestamp=datetime.now(timezone.utc),
        source_timezone=source_timezone,
        region_id=region_id,
        event_category=event_category,
        severity=severity,
        health_state=health_state,
        alert_context=alert_context,
        **metrics,
    )

    return payload


def _infer_event_category(raw_data: dict) -> EventCategory:
    """Infer event category from raw data keys."""
    keys = set(raw_data.keys())
    if any(k in keys for k in ["cpu_pct", "mem_pct", "disk_pct", "cpu", "memory", "disk"]):
        return EventCategory.INFRA
    if any(k in keys for k in ["latency_ms", "packet_loss", "bandwidth", "rtt", "throughput"]):
        return EventCategory.NETWORK
    if any(k in keys for k in ["failed_logins", "auth_failures", "login_attempts", "brute_force"]):
        return EventCategory.SECURITY
    return EventCategory.COLLECTOR


def _extract_metrics(raw_data: dict) -> dict:
    """Extract only allow-listed metric fields from raw data."""
    allowed = {
        "cpu_pct", "mem_pct", "disk_pct",
        "latency_ms", "packet_loss_pct", "bandwidth_mbps",
    }
    return {k: v for k, v in raw_data.items() if k in allowed and isinstance(v, (int, float))}


def _compute_health_state(metrics: dict, category: EventCategory) -> HealthState:
    """Compute 4-state health from metrics (simplified for demo)."""
    if category == EventCategory.INFRA:
        cpu = metrics.get("cpu_pct", 0)
        mem = metrics.get("mem_pct", 0)
        disk = metrics.get("disk_pct", 0)
        max_pct = max(cpu, mem, disk)
        if max_pct < 50:
            return HealthState.EXCELLENT
        elif max_pct < 70:
            return HealthState.GOOD
        elif max_pct < 90:
            return HealthState.FAIR
        return HealthState.POOR

    elif category == EventCategory.NETWORK:
        loss = metrics.get("packet_loss_pct", 0)
        latency = metrics.get("latency_ms", 0)
        if loss < 0.1 and latency < 50:
            return HealthState.EXCELLENT
        elif loss < 1 and latency < 100:
            return HealthState.GOOD
        elif loss < 5 and latency < 300:
            return HealthState.FAIR
        return HealthState.POOR

    elif category == EventCategory.SECURITY:
        # Security health based on failed login rate
        return HealthState.GOOD  # Simplified

    return HealthState.EXCELLENT


def _compute_severity(metrics: dict, category: EventCategory, raw_data: dict) -> Severity:
    """Compute severity from metrics and raw signals."""
    health = _compute_health_state(metrics, category)
    if health == HealthState.POOR:
        return Severity.CRITICAL
    elif health == HealthState.FAIR:
        return Severity.WARNING
    return Severity.INFO


def _build_alert_context(
    metrics: dict,
    category: EventCategory,
    health: HealthState,
    source_id: str,
) -> str:
    """Build concise alert context (max 280 chars, no raw data)."""
    parts = []

    if category == EventCategory.INFRA:
        cpu = metrics.get("cpu_pct")
        mem = metrics.get("mem_pct")
        disk = metrics.get("disk_pct")
        if cpu is not None:
            parts.append(f"CPU {cpu:.0f}%")
        if mem is not None:
            parts.append(f"MEM {mem:.0f}%")
        if disk is not None:
            parts.append(f"DISK {disk:.0f}%")

    elif category == EventCategory.NETWORK:
        lat = metrics.get("latency_ms")
        loss = metrics.get("packet_loss_pct")
        bw = metrics.get("bandwidth_mbps")
        if lat is not None:
            parts.append(f"LAT {lat:.0f}ms")
        if loss is not None:
            parts.append(f"LOSS {loss:.1f}%")
        if bw is not None:
            parts.append(f"BW {bw:.0f}Mbps")

    elif category == EventCategory.SECURITY:
        parts.append("AUTH FAILURES")

    context = f"{health.value}: {', '.join(parts)} on {source_id}"
    return context[:280]


# ─── Egress Proof Panel Logging ───

import json
from pathlib import Path
from threading import Lock


class EgressProofPanel:
    """
    Immutable append-only log of every payload crossing the Trust Boundary.
    Judges can inspect live: "Show me exactly what left the customer environment."
    """

    def __init__(self, log_path: Path):
        self.log_path = log_path
        self._lock = Lock()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        # Initialize with header if new
        if not log_path.exists():
            with log_path.open("w") as f:
                f.write("# EGRESS PROOF PANEL — Immutable Audit Log\n")
                f.write("# Format: timestamp | payload_id | tenant_id | serialized_json\n")

    def log_egress(self, payload: TelemetryPayload) -> None:
        """Record payload before it crosses the Trust Boundary."""
        import time
        timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        json_str = payload_to_json(payload)
        entry = f"{timestamp} | {payload.payload_id} | {payload.tenant_id} | {json_str}\n"
        with self._lock:
            with self.log_path.open("a") as f:
                f.write(entry)

    def get_recent(self, limit: int = 10) -> list[str]:
        """Retrieve recent egress entries for judge inspection."""
        lines = self.log_path.read_text().strip().split("\n")
        # Skip header lines
        entries = [l for l in lines if not l.startswith("#")]
        return entries[-limit:]

    def verify_payload_id(self, payload_id: UUID) -> bool:
        """Verify a specific payload_id was logged (for idempotency demo)."""
        entries = self.get_recent(1000)
        return any(str(payload_id) in e for e in entries)