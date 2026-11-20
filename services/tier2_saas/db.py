"""
Tier 2 SaaS Database Layer — Multi-Tenant SQLite/SQLAlchemy
Enforces tenant_id on every table and query, regional residency, idempotent deduplication.
"""

from __future__ import annotations

import os
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


# ─── Database Initialization ───

def init_db() -> None:
    """Create all tables."""
    Base.metadata.create_all(bind=engine)


def drop_db() -> None:
    """Drop all tables (for testing)."""
    Base.metadata.drop_all(bind=engine)


# Ensure tables are created at module import for tests and direct imports
init_db()


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