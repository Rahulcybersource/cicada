"""
Tier 2 SaaS Database Layer — Multi-Tenant SQLite/SQLAlchemy
Enforces tenant_id on every table and query, regional residency, idempotent deduplication.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Generator, Optional

from sqlalchemy import (
    JSON,
    Column,
    DateTime,
    Float,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    event,
    select,
)
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

# ─── Database Setup ───
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./tier2_saas.db")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {},
    pool_pre_ping=True,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


# ─── Models ───

class TelemetryMetadata(Base):
    """Immutable telemetry metadata store — tenant-scoped, event-time ordered."""
    __tablename__ = "telemetry_metadata"
    __table_args__ = (
        UniqueConstraint("tenant_id", "payload_id", name="uq_tenant_payload"),
        Index("ix_telemetry_tenant_time", "tenant_id", "event_timestamp_utc"),
        Index("ix_telemetry_tenant_source", "tenant_id", "source_id"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    payload_id = Column(String(64), nullable=False)
    tenant_id = Column(String(64), nullable=False, index=True)
    region_id = Column(String(32), nullable=False)
    collector_id = Column(String(64), nullable=False)
    source_id = Column(String(64), nullable=False)
    event_timestamp_utc = Column(DateTime(timezone=True), nullable=False, index=True)
    source_timezone = Column(String(50), nullable=False)
    event_category = Column(String(32), nullable=False)
    severity = Column(String(16), nullable=False)
    health_state = Column(String(16), nullable=False)
    metrics = Column(JSON, nullable=False)
    security_summary = Column(JSON, nullable=True)
    alert_context = Column(Text, nullable=True)
    collector_meta = Column(JSON, nullable=True)
    ingested_at_utc = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class IncidentRecord(Base):
    """Correlated incidents with explainable RCA."""
    __tablename__ = "incidents"
    __table_args__ = (
        Index("ix_incidents_tenant_time", "tenant_id", "first_alert_time_utc"),
        Index("ix_incidents_tenant_source", "tenant_id", "source_id"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    incident_id = Column(String(64), nullable=False, unique=True, index=True)
    tenant_id = Column(String(64), nullable=False, index=True)
    source_id = Column(String(64), nullable=False)
    event_category = Column(String(32), nullable=False)
    severity = Column(String(16), nullable=False)
    health_state = Column(String(16), nullable=False)
    first_alert_time_utc = Column(DateTime(timezone=True), nullable=False)
    last_update_time_utc = Column(DateTime(timezone=True), nullable=False)
    alert_count = Column(Integer, default=1)
    contributing_signals = Column(JSON, nullable=False)
    reasoning_path = Column(Text, nullable=False)
    confidence = Column(Float, nullable=False)
    recommended_action = Column(Text, nullable=False)
    ai_provider = Column(String(32), nullable=False)
    llm_latency_ms = Column(Integer, default=0)
    status = Column(String(16), default="open")
    z_scores = Column(JSON, nullable=False)
    metrics_snapshot = Column(JSON, nullable=False)
    security_summary = Column(JSON, nullable=True)


class CollectorRegistry(Base):
    """Collector fleet registry with health state and heartbeat tracking."""
    __tablename__ = "collectors"
    __table_args__ = (
        UniqueConstraint("tenant_id", "collector_id", name="uq_tenant_collector"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    collector_id = Column(String(64), nullable=False, index=True)
    tenant_id = Column(String(64), nullable=False, index=True)
    region_id = Column(String(32), nullable=False)
    version = Column(String(32), default="unknown")
    collector_cpu_pct = Column(Float, default=0.0)
    collector_mem_mb = Column(Float, default=0.0)
    health_state = Column(String(16), default="Excellent")
    last_heartbeat_utc = Column(DateTime(timezone=True), nullable=False)
    state_reason = Column(Text, default="Initialized")
    state_transitions = Column(JSON, nullable=False, default=list)
    created_at_utc = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at_utc = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class SlaMetricsRecord(Base):
    """Measured SLA metrics for dashboard."""
    __tablename__ = "sla_metrics"

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), nullable=False, index=True)
    metric_name = Column(String(64), nullable=False)
    metric_value = Column(Float, nullable=False)
    measured_at_utc = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


# ─── New Models for Phase 2/3/4 Requirements ───

class CollectorToken(Base):
    """API key / Bearer token registry for collector authentication."""
    __tablename__ = "collector_tokens"
    __table_args__ = (
        UniqueConstraint("token_hash", name="uq_token_hash"),
        Index("ix_token_tenant", "tenant_id"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    token_hash = Column(String(64), nullable=False, index=True)  # SHA256 of token
    tenant_id = Column(String(64), nullable=False, index=True)
    collector_id = Column(String(64), nullable=False)
    region_id = Column(String(32), nullable=False)
    created_at_utc = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    last_used_at_utc = Column(DateTime(timezone=True), nullable=True)
    is_active = Column(Integer, default=1)  # 1=active, 0=revoked
    description = Column(Text, nullable=True)


class AuditLogRecord(Base):
    """Tamper-evident audit log with SHA256 integrity hash."""
    __tablename__ = "audit_log"
    __table_args__ = (
        Index("ix_audit_tenant_time", "tenant_id", "timestamp_utc"),
        Index("ix_audit_action", "action"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    index = Column(Integer, nullable=False)  # Chain index
    timestamp_utc = Column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))
    tenant_id = Column(String(64), nullable=False, index=True)
    user_id = Column(String(64), nullable=False)
    role = Column(String(32), nullable=False)
    action = Column(String(64), nullable=False)
    details = Column(JSON, nullable=False)
    prev_hash = Column(String(64), nullable=False)  # Previous record's hash
    record_hash = Column(String(64), nullable=False, unique=True)  # This record's hash
    record_sha256 = Column(String(64), nullable=False)  # Integrity hash of full record


class StateTransitionRecord(Base):
    """Collector health state transitions with UTC timestamps."""
    __tablename__ = "state_transitions"
    __table_args__ = (
        Index("ix_state_trans_tenant_time", "tenant_id", "timestamp_utc"),
        Index("ix_state_trans_collector", "collector_id"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), nullable=False, index=True)
    collector_id = Column(String(64), nullable=False, index=True)
    from_state = Column(String(16), nullable=False)
    to_state = Column(String(16), nullable=False)
    reason = Column(Text, nullable=False)
    timestamp_utc = Column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))
    record_hash = Column(String(64), nullable=False, unique=True)  # Integrity hash


class PolicyThresholds(Base):
    """Configurable health thresholds per tenant."""
    __tablename__ = "policy_thresholds"
    __table_args__ = (
        UniqueConstraint("tenant_id", "metric_name", name="uq_tenant_metric_threshold"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), nullable=False, index=True)
    metric_name = Column(String(64), nullable=False)
    excellent_max = Column(Float, nullable=False)
    good_max = Column(Float, nullable=False)
    fair_max = Column(Float, nullable=False)
    # Poor is anything above fair_max
    updated_at_utc = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))
    updated_by = Column(String(64), nullable=True)


class RemediationRecord(Base):
    """Remediation approval/rollback audit trail."""
    __tablename__ = "remediation_records"
    __table_args__ = (
        Index("ix_remed_tenant_time", "tenant_id", "timestamp_utc"),
        Index("ix_remed_incident", "incident_id"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    incident_id = Column(String(64), nullable=False, index=True)
    tenant_id = Column(String(64), nullable=False, index=True)
    action = Column(String(16), nullable=False)  # "approve" or "rollback"
    operator_id = Column(String(64), nullable=False)
    operator_role = Column(String(32), nullable=False)
    status = Column(String(32), nullable=False)  # "pending", "approved", "rolled_back", "executed"
    rollback_token = Column(String(64), nullable=True)
    command_signature = Column(String(64), nullable=True)
    audit_hash = Column(String(64), nullable=True)
    timestamp_utc = Column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))
    record_hash = Column(String(64), nullable=False, unique=True)  # Integrity hash


# ─── Database Initialization ───

def init_db() -> None:
    """Create all tables."""
    Base.metadata.create_all(bind=engine)


def drop_db() -> None:
    """Drop all tables (for testing)."""
    Base.metadata.drop_all(bind=engine)


# ─── Session Management ───

@contextmanager
def get_db() -> Generator[Session, None, None]:
    """Get database session with automatic cleanup."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ─── Repository Functions (Tenant-Scoped) ───

def insert_telemetry(db: Session, metadata: dict) -> tuple[str, bool]:
    """
    Insert telemetry metadata with idempotent deduplication.
    Returns (payload_id, is_duplicate).
    """
    tenant_id = metadata["tenant_id"]
    payload_id = metadata["payload_id"]

    # Check for existing
    existing = db.execute(
        select(TelemetryMetadata).where(
            TelemetryMetadata.tenant_id == tenant_id,
            TelemetryMetadata.payload_id == payload_id,
        )
    ).scalar_one_or_none()

    if existing:
        return payload_id, True

    record = TelemetryMetadata(
        payload_id=payload_id,
        tenant_id=tenant_id,
        region_id=metadata["region_id"],
        collector_id=metadata["collector_id"],
        source_id=metadata["source_id"],
        event_timestamp_utc=datetime.fromisoformat(metadata["event_timestamp_utc"].replace("Z", "+00:00")),
        source_timezone=metadata["source_timezone"],
        event_category=metadata["event_category"],
        severity=metadata["severity"],
        health_state=metadata["health_state"],
        metrics=metadata.get("metrics", {}),
        security_summary=metadata.get("security_summary"),
        alert_context=metadata.get("alert_context"),
        collector_meta=metadata.get("collector_meta"),
    )
    db.add(record)
    db.commit()
    return payload_id, False


def query_telemetry(
    db: Session,
    tenant_id: str,
    source_id: str | None = None,
    event_category: str | None = None,
    start_time: datetime | None = None,
    end_time: datetime | None = None,
    limit: int = 1000,
) -> list[TelemetryMetadata]:
    """Query telemetry with strict tenant scoping and event-time ordering."""
    stmt = select(TelemetryMetadata).where(TelemetryMetadata.tenant_id == tenant_id)

    if source_id:
        stmt = stmt.where(TelemetryMetadata.source_id == source_id)
    if event_category:
        stmt = stmt.where(TelemetryMetadata.event_category == event_category)
    if start_time:
        stmt = stmt.where(TelemetryMetadata.event_timestamp_utc >= start_time)
    if end_time:
        stmt = stmt.where(TelemetryMetadata.event_timestamp_utc <= end_time)

    stmt = stmt.order_by(TelemetryMetadata.event_timestamp_utc).limit(limit)
    return list(db.execute(stmt).scalars().all())


def upsert_incident(db: Session, incident_data: dict) -> IncidentRecord:
    """Insert or update incident record."""
    incident_id = incident_data["incident_id"]
    tenant_id = incident_data["tenant_id"]

    existing = db.execute(
        select(IncidentRecord).where(
            IncidentRecord.incident_id == incident_id,
            IncidentRecord.tenant_id == tenant_id,
        )
    ).scalar_one_or_none()

    if existing:
        # Update
        for key, value in incident_data.items():
            if hasattr(existing, key) and key not in ("id", "incident_id", "tenant_id", "first_alert_time_utc"):
                setattr(existing, key, value)
        existing.last_update_time_utc = datetime.fromisoformat(incident_data["last_update_time_utc"].replace("Z", "+00:00"))
    else:
        # Insert
        existing = IncidentRecord(
            incident_id=incident_id,
            tenant_id=tenant_id,
            source_id=incident_data["source_id"],
            event_category=incident_data["event_category"],
            severity=incident_data["severity"],
            health_state=incident_data["health_state"],
            first_alert_time_utc=datetime.fromisoformat(incident_data["first_alert_time_utc"].replace("Z", "+00:00")),
            last_update_time_utc=datetime.fromisoformat(incident_data["last_update_time_utc"].replace("Z", "+00:00")),
            alert_count=incident_data["alert_count"],
            contributing_signals=incident_data["contributing_signals"],
            reasoning_path=incident_data["reasoning_path"],
            confidence=incident_data["confidence"],
            recommended_action=incident_data["recommended_action"],
            ai_provider=incident_data["ai_provider"],
            llm_latency_ms=incident_data["llm_latency_ms"],
            status=incident_data.get("status", "open"),
            z_scores=incident_data["z_scores"],
            metrics_snapshot=incident_data["metrics_snapshot"],
            security_summary=incident_data.get("security_summary"),
        )
        db.add(existing)

    db.commit()
    db.refresh(existing)
    return existing


def query_incidents(
    db: Session,
    tenant_id: str,
    limit: int = 100,
    status: str | None = None,
) -> list[IncidentRecord]:
    """Query incidents for tenant, most recent first."""
    stmt = select(IncidentRecord).where(IncidentRecord.tenant_id == tenant_id)
    if status:
        stmt = stmt.where(IncidentRecord.status == status)
    stmt = stmt.order_by(IncidentRecord.last_update_time_utc.desc()).limit(limit)
    return list(db.execute(stmt).scalars().all())


def get_incident(db: Session, tenant_id: str, incident_id: str) -> IncidentRecord | None:
    """Get single incident by ID with tenant scoping."""
    return db.execute(
        select(IncidentRecord).where(
            IncidentRecord.incident_id == incident_id,
            IncidentRecord.tenant_id == tenant_id,
        )
    ).scalar_one_or_none()


def upsert_collector(db: Session, collector_data: dict) -> CollectorRegistry:
    """Insert or update collector registry."""
    collector_id = collector_data["collector_id"]
    tenant_id = collector_data["tenant_id"]

    existing = db.execute(
        select(CollectorRegistry).where(
            CollectorRegistry.collector_id == collector_id,
            CollectorRegistry.tenant_id == tenant_id,
        )
    ).scalar_one_or_none()

    if existing:
        for key, value in collector_data.items():
            if hasattr(existing, key) and key not in ("id", "collector_id", "tenant_id", "created_at_utc"):
                setattr(existing, key, value)
        existing.updated_at_utc = datetime.now(timezone.utc)
    else:
        existing = CollectorRegistry(**collector_data)
        db.add(existing)

    db.commit()
    db.refresh(existing)
    return existing


def query_collectors(db: Session, tenant_id: str) -> list[CollectorRegistry]:
    """Get all collectors for tenant."""
    stmt = select(CollectorRegistry).where(CollectorRegistry.tenant_id == tenant_id)
    return list(db.execute(stmt).scalars().all())


def record_sla_metric(db: Session, tenant_id: str, metric_name: str, metric_value: float) -> None:
    """Record SLA metric measurement."""
    record = SlaMetricsRecord(
        tenant_id=tenant_id,
        metric_name=metric_name,
        metric_value=metric_value,
    )
    db.add(record)
    db.commit()


def get_latest_sla_metrics(db: Session, tenant_id: str) -> dict[str, float]:
    """Get latest SLA metrics for tenant."""
    # Get latest of each metric type
    subquery = (
        select(
            SlaMetricsRecord.metric_name,
            SlaMetricsRecord.metric_value,
            SlaMetricsRecord.measured_at_utc,
        )
        .where(SlaMetricsRecord.tenant_id == tenant_id)
        .order_by(SlaMetricsRecord.metric_name, SlaMetricsRecord.measured_at_utc.desc())
        .distinct(SlaMetricsRecord.metric_name)
    )
    results = db.execute(subquery).all()
    return {row.metric_name: row.metric_value for row in results}


# ─── Collector Token Management ───

def register_collector_token(
    db: Session,
    tenant_id: str,
    collector_id: str,
    region_id: str,
    description: str | None = None,
) -> str:
    """Generate and register a new collector token. Returns the plain token (only shown once)."""
    plain_token = f"ct_{secrets.token_hex(32)}"
    token_hash = hashlib.sha256(plain_token.encode()).hexdigest()

    record = CollectorToken(
        token_hash=token_hash,
        tenant_id=tenant_id,
        collector_id=collector_id,
        region_id=region_id,
        description=description,
    )
    db.add(record)
    db.commit()
    return plain_token


def validate_collector_token(db: Session, token: str) -> CollectorToken | None:
    """Validate a collector token and return the token record if valid."""
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    record = db.execute(
        select(CollectorToken).where(
            CollectorToken.token_hash == token_hash,
            CollectorToken.is_active == 1,
        )
    ).scalar_one_or_none()

    if record:
        # Update last used timestamp
        record.last_used_at_utc = datetime.now(timezone.utc)
        db.commit()
    return record


def revoke_collector_token(db: Session, token: str) -> bool:
    """Revoke a collector token."""
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    record = db.execute(
        select(CollectorToken).where(CollectorToken.token_hash == token_hash)
    ).scalar_one_or_none()

    if record:
        record.is_active = 0
        db.commit()
        return True
    return False


def list_collector_tokens(db: Session, tenant_id: str) -> list[CollectorToken]:
    """List all tokens for a tenant (without showing plain tokens)."""
    stmt = select(CollectorToken).where(CollectorToken.tenant_id == tenant_id)
    return list(db.execute(stmt).scalars().all())


# ─── Tamper-Evident Audit Log ───

AUDIT_GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000"


def _compute_record_hash(index: int, timestamp: str, tenant_id: str, user_id: str, role: str, action: str, details: dict, prev_hash: str) -> str:
    """Compute SHA256 hash for an audit record."""
    details_str = json.dumps(details, sort_keys=True)
    payload = f"{index}:{timestamp}:{tenant_id}:{user_id}:{role}:{action}:{details_str}:{prev_hash}"
    return hashlib.sha256(payload.encode()).hexdigest()


def append_audit_log(
    db: Session,
    tenant_id: str,
    user_id: str,
    role: str,
    action: str,
    details: dict,
) -> AuditLogRecord:
    """Append a tamper-evident audit log record."""
    # Get the latest record to chain from
    latest = db.execute(
        select(AuditLogRecord)
        .order_by(AuditLogRecord.index.desc())
        .limit(1)
    ).scalar_one_or_none()

    index = (latest.index + 1) if latest else 0
    prev_hash = latest.record_hash if latest else AUDIT_GENESIS_HASH
    # Use naive UTC timestamp for consistent hash computation (matches DB read-back)
    timestamp = datetime.utcnow()
    timestamp_iso = timestamp.isoformat()

    record_hash = _compute_record_hash(index, timestamp_iso, tenant_id, user_id, role, action, details, prev_hash)
    record_sha256 = hashlib.sha256(
        f"{record_hash}:{tenant_id}:{user_id}:{action}".encode()
    ).hexdigest()

    record = AuditLogRecord(
        index=index,
        timestamp_utc=timestamp,
        tenant_id=tenant_id,
        user_id=user_id,
        role=role,
        action=action,
        details=details,
        prev_hash=prev_hash,
        record_hash=record_hash,
        record_sha256=record_sha256,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


def query_audit_log(
    db: Session,
    tenant_id: str | None = None,
    limit: int = 100,
) -> list[AuditLogRecord]:
    """Query audit log with optional tenant filter."""
    stmt = select(AuditLogRecord).order_by(AuditLogRecord.index.desc()).limit(limit)
    if tenant_id:
        stmt = stmt.where(AuditLogRecord.tenant_id == tenant_id)
    return list(db.execute(stmt).scalars().all())


def verify_audit_chain(db: Session) -> tuple[bool, str]:
    """Verify the integrity of the audit log chain."""
    records = db.execute(
        select(AuditLogRecord).order_by(AuditLogRecord.index.asc())
    ).scalars().all()

    expected_prev = AUDIT_GENESIS_HASH
    for rec in records:
        if rec.prev_hash != expected_prev:
            return False, f"Broken chain at index {rec.index}: expected {expected_prev}, got {rec.prev_hash}"
        # Recompute hash - use naive UTC isoformat to match append_audit_log
        details_str = json.dumps(rec.details, sort_keys=True)
        ts = rec.timestamp_utc
        # Normalize to naive UTC isoformat (strip timezone if present)
        if ts.tzinfo is not None:
            ts = ts.replace(tzinfo=None)
        payload = f"{rec.index}:{ts.isoformat()}:{rec.tenant_id}:{rec.user_id}:{rec.role}:{rec.action}:{details_str}:{expected_prev}"
        recomputed = hashlib.sha256(payload.encode()).hexdigest()
        if recomputed != rec.record_hash:
            return False, f"Corrupted hash at index {rec.index}: expected {recomputed}, got {rec.record_hash}"
        expected_prev = rec.record_hash
    return True, "Chain valid and uncorrupted"


# ─── State Transitions ───

def record_state_transition(
    db: Session,
    tenant_id: str,
    collector_id: str,
    from_state: str,
    to_state: str,
    reason: str,
) -> StateTransitionRecord:
    """Record a collector health state transition."""
    timestamp = datetime.now(timezone.utc)
    record_hash = hashlib.sha256(
        f"{tenant_id}:{collector_id}:{from_state}:{to_state}:{reason}:{timestamp.isoformat()}".encode()
    ).hexdigest()

    record = StateTransitionRecord(
        tenant_id=tenant_id,
        collector_id=collector_id,
        from_state=from_state,
        to_state=to_state,
        reason=reason,
        timestamp_utc=timestamp,
        record_hash=record_hash,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


def query_state_transitions(
    db: Session,
    tenant_id: str,
    collector_id: str | None = None,
    limit: int = 100,
) -> list[StateTransitionRecord]:
    """Query state transitions for a tenant."""
    stmt = select(StateTransitionRecord).where(
        StateTransitionRecord.tenant_id == tenant_id
    ).order_by(StateTransitionRecord.timestamp_utc.desc()).limit(limit)
    if collector_id:
        stmt = stmt.where(StateTransitionRecord.collector_id == collector_id)
    return list(db.execute(stmt).scalars().all())


# ─── Policy Thresholds ───

DEFAULT_THRESHOLDS = {
    "cpu_pct": {"excellent": 50, "good": 70, "fair": 85},
    "mem_pct": {"excellent": 60, "good": 80, "fair": 90},
    "disk_pct": {"excellent": 50, "good": 75, "fair": 90},
    "latency_ms": {"excellent": 50, "good": 100, "fair": 300},
    "packet_loss_pct": {"excellent": 0.1, "good": 1, "fair": 5},
    "bandwidth_mbps": {"excellent": 1000, "good": 500, "fair": 100},
}


def init_default_thresholds(db: Session, tenant_id: str) -> None:
    """Initialize default thresholds for a tenant if not already set."""
    for metric, thresholds in DEFAULT_THRESHOLDS.items():
        existing = db.execute(
            select(PolicyThresholds).where(
                PolicyThresholds.tenant_id == tenant_id,
                PolicyThresholds.metric_name == metric,
            )
        ).scalar_one_or_none()
        if not existing:
            record = PolicyThresholds(
                tenant_id=tenant_id,
                metric_name=metric,
                excellent_max=thresholds["excellent"],
                good_max=thresholds["good"],
                fair_max=thresholds["fair"],
            )
            db.add(record)
    db.commit()


def get_policy_thresholds(db: Session, tenant_id: str) -> dict:
    """Get all policy thresholds for a tenant."""
    records = db.execute(
        select(PolicyThresholds).where(PolicyThresholds.tenant_id == tenant_id)
    ).scalars().all()

    result = {}
    for r in records:
        result[r.metric_name] = {
            "excellent_max": r.excellent_max,
            "good_max": r.good_max,
            "fair_max": r.fair_max,
        }
    return result


def update_policy_threshold(
    db: Session,
    tenant_id: str,
    metric_name: str,
    excellent_max: float,
    good_max: float,
    fair_max: float,
    updated_by: str,
) -> PolicyThresholds:
    """Update or create a policy threshold for a tenant."""
    existing = db.execute(
        select(PolicyThresholds).where(
            PolicyThresholds.tenant_id == tenant_id,
            PolicyThresholds.metric_name == metric_name,
        )
    ).scalar_one_or_none()

    if existing:
        existing.excellent_max = excellent_max
        existing.good_max = good_max
        existing.fair_max = fair_max
        existing.updated_by = updated_by
        existing.updated_at_utc = datetime.now(timezone.utc)
    else:
        existing = PolicyThresholds(
            tenant_id=tenant_id,
            metric_name=metric_name,
            excellent_max=excellent_max,
            good_max=good_max,
            fair_max=fair_max,
            updated_by=updated_by,
        )
        db.add(existing)

    db.commit()
    db.refresh(existing)
    return existing


# ─── Remediation Records ───

def record_remediation(
    db: Session,
    incident_id: str,
    tenant_id: str,
    action: str,
    operator_id: str,
    operator_role: str,
    status: str,
    rollback_token: str | None = None,
    command_signature: str | None = None,
    audit_hash: str | None = None,
) -> RemediationRecord:
    """Record a remediation action."""
    record_hash = hashlib.sha256(
        f"{incident_id}:{tenant_id}:{action}:{operator_id}:{datetime.now(timezone.utc).isoformat()}".encode()
    ).hexdigest()

    record = RemediationRecord(
        incident_id=incident_id,
        tenant_id=tenant_id,
        action=action,
        operator_id=operator_id,
        operator_role=operator_role,
        status=status,
        rollback_token=rollback_token,
        command_signature=command_signature,
        audit_hash=audit_hash,
        record_hash=record_hash,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


def query_remediation_records(
    db: Session,
    tenant_id: str,
    incident_id: str | None = None,
    limit: int = 100,
) -> list[RemediationRecord]:
    """Query remediation records for a tenant."""
    stmt = select(RemediationRecord).where(
        RemediationRecord.tenant_id == tenant_id
    ).order_by(RemediationRecord.timestamp_utc.desc()).limit(limit)
    if incident_id:
        stmt = stmt.where(RemediationRecord.incident_id == incident_id)
    return list(db.execute(stmt).scalars().all())


def check_collector_timeouts_and_persist() -> list:
    """Check collector timeouts and persist state transitions to DB."""
    from .aiops import engine as aio_ops_engine
    changed = aio_ops_engine.check_collector_timeouts()
    if changed:
        for collector in changed:
            with SessionLocal() as db:
                upsert_collector(db, {
                    "collector_id": collector.collector_id,
                    "tenant_id": collector.tenant_id,
                    "region_id": "ap-south-1",
                    "version": collector.version,
                    "collector_cpu_pct": collector.collector_cpu_pct,
                    "collector_mem_mb": collector.collector_mem_mb,
                    "health_state": collector.health_state.value,
                    "last_heartbeat_utc": collector.last_heartbeat,
                    "state_reason": collector.state_reason,
                    "state_transitions": collector.state_transitions,
                })
                # Record state transition if health state changed to Poor
                if collector.health_state.value == "Poor" and collector.state_transitions:
                    for transition in collector.state_transitions:
                        if transition.get("to") == "Poor":
                            record_state_transition(
                                db,
                                collector.tenant_id,
                                collector.collector_id,
                                transition.get("from", "Excellent"),
                                "Poor",
                                collector.state_reason,
                            )
                            break
    return changed


# ─── Regional Residency Validation ───

VALID_REGIONS = {"us-east-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-south-1", "ap-southeast-1", "ap-northeast-1"}

TENANT_REGION_MAP = {
    "tenant_acme_corp": "ap-south-1",
    "tenant_globex_ind": "eu-central-1",
    "tenant_demo": "us-east-1",
}


def validate_regional_residency(tenant_id: str, region_id: str) -> bool:
    """Validate tenant-to-region residency binding."""
    expected_region = TENANT_REGION_MAP.get(tenant_id)
    if expected_region and region_id != expected_region:
        return False
    return region_id in VALID_REGIONS


# ─── SQLite WAL Mode (for better concurrency) ───

if DATABASE_URL.startswith("sqlite"):

    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.close()