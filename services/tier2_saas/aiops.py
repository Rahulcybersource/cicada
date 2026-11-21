"""
Hybrid Two-Layer AIOps Engine — Tier 2 SaaS
Layer 1: Rolling Z-score anomaly detector + 120s alert correlator (always-on, sub-5ms)
Layer 2: Event-driven LLM explainable RCA (Groq/Gemini with 4s timeout + deterministic fallback)
"""

from __future__ import annotations

import asyncio
import json
import math
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal

from .llm_explain import generate_explainable_rca
from .multivariate_detector import MultivariateResidualDetector
from .aoim_triage import aoim_engine

# ─── Configuration ───
Z_SCORE_THRESHOLD = 2.5
ROLLING_WINDOW_SECONDS = 300  # 5 minutes
HEARTBEAT_TIMEOUT_SECONDS = 60
CORRELATION_WINDOW_SECONDS = 120
MAX_INCIDENTS_PER_TENANT = 1000


class HealthState(str, Enum):
    EXCELLENT = "Excellent"
    GOOD = "Good"
    FAIR = "Fair"
    POOR = "Poor"


class EventCategory(str, Enum):
    INFRASTRUCTURE = "infrastructure"
    NETWORK = "network"
    SECURITY = "security"
    HEARTBEAT = "heartbeat"


class Severity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


class IncidentStatus(str, Enum):
    OPEN = "open"
    ACKNOWLEDGED = "acknowledged"
    RESOLVED = "resolved"


# ─── Data Classes ───

@dataclass
class MetricBaseline:
    """Rolling statistics for a single metric on a single source."""
    values: deque = field(default_factory=lambda: deque(maxlen=100))
    timestamps: deque = field(default_factory=lambda: deque(maxlen=100))
    count: int = 0
    sum: float = 0.0
    sum_sq: float = 0.0

    def add(self, value: float, timestamp: float) -> None:
        if len(self.values) == self.values.maxlen and self.values:
            old = self.values.popleft()
            self.sum -= old
            self.sum_sq -= old * old
        self.values.append(value)
        self.timestamps.append(timestamp)
        self.sum += value
        self.sum_sq += value * value
        self.count = len(self.values)

    def mean(self) -> float:
        return self.sum / self.count if self.count > 0 else 0.0

    def std(self) -> float:
        if self.count < 2:
            return 0.0
        variance = (self.sum_sq / self.count) - (self.mean() ** 2)
        return math.sqrt(max(0.0, variance))

    def z_score(self, value: float) -> float:
        std = self.std()
        if std == 0:
            return 0.0
        return (value - self.mean()) / std

    def is_ready(self, min_samples: int = 10) -> bool:
        return self.count >= min_samples


@dataclass
class Alert:
    """Single alert from anomaly detection."""
    alert_id: str
    tenant_id: str
    source_id: str
    event_category: EventCategory
    severity: Severity
    metric_name: str
    metric_value: float
    z_score: float
    health_state: HealthState
    timestamp_utc: datetime
    alert_context: str
    correlated: bool = False


@dataclass
class Incident:
    """Correlated incident with explainable RCA."""
    incident_id: str
    tenant_id: str
    source_id: str
    event_category: EventCategory
    severity: Severity
    health_state: HealthState
    first_alert_time: datetime
    last_update_time: datetime
    alert_count: int
    contributing_signals: list[str]
    reasoning_path: str
    confidence: float
    recommended_action: str
    ai_provider: str
    llm_latency_ms: int
    status: IncidentStatus = IncidentStatus.OPEN
    z_scores: dict[str, float] = field(default_factory=dict)
    metrics_snapshot: dict[str, float] = field(default_factory=dict)
    security_summary: dict | None = None
    aoim_triage: dict | None = None


@dataclass
class CollectorHealth:
    """Collector fleet health tracking."""
    collector_id: str
    tenant_id: str
    last_heartbeat: datetime
    health_state: HealthState = HealthState.EXCELLENT
    version: str = "unknown"
    collector_cpu_pct: float = 0.0
    collector_mem_mb: float = 0.0
    state_reason: str = "Initialized"
    state_transitions: list[dict] = field(default_factory=list)


# ─── Rolling Z-Score Anomaly Detector (Layer 1) ───

class ZScoreAnomalyDetector:
    """
    Sub-5ms rolling Z-score anomaly detection per source per metric.
    Maintains baselines in memory for real-time detection.
    """

    def __init__(self):
        # tenant_id -> source_id -> metric_name -> MetricBaseline
        self.baselines: dict[str, dict[str, dict[str, MetricBaseline]]] = defaultdict(
            lambda: defaultdict(lambda: defaultdict(MetricBaseline))
        )

    def update_baseline(self, tenant_id: str, source_id: str, metrics: dict[str, float], timestamp: float) -> None:
        """Update rolling baselines with new metric values."""
        for metric_name, value in metrics.items():
            if value is not None and isinstance(value, (int, float)):
                self.baselines[tenant_id][source_id][metric_name].add(value, timestamp)

    def check_anomalies(
        self,
        tenant_id: str,
        source_id: str,
        metrics: dict[str, float],
        event_category: EventCategory,
        timestamp: float,
    ) -> list[Alert]:
        """Check all metrics for Z-score anomalies. Returns list of Alerts."""
        alerts = []
        source_baselines = self.baselines[tenant_id][source_id]

        for metric_name, value in metrics.items():
            if value is None or not isinstance(value, (int, float)):
                continue

            baseline = source_baselines[metric_name]
            if not baseline.is_ready():
                continue

            z = baseline.z_score(value)
            if abs(z) >= Z_SCORE_THRESHOLD:
                # Determine severity from Z-score magnitude
                if abs(z) >= 4.0:
                    severity = Severity.CRITICAL
                elif abs(z) >= 3.0:
                    severity = Severity.WARNING
                else:
                    severity = Severity.INFO

                # Determine health state
                health = self._z_to_health(abs(z))

                alert = Alert(
                    alert_id=str(uuid.uuid4())[:8],
                    tenant_id=tenant_id,
                    source_id=source_id,
                    event_category=event_category,
                    severity=severity,
                    metric_name=metric_name,
                    metric_value=value,
                    z_score=z,
                    health_state=health,
                    timestamp_utc=datetime.fromtimestamp(timestamp, tz=timezone.utc),
                    alert_context=f"{metric_name}={value} (z={z:.1f})",
                )
                alerts.append(alert)

        return alerts

    def get_z_scores(self, tenant_id: str, source_id: str, metrics: dict[str, float]) -> dict[str, float]:
        """Get current Z-scores for metrics (for RCA context)."""
        z_scores = {}
        source_baselines = self.baselines[tenant_id][source_id]
        for metric_name, value in metrics.items():
            if value is not None and isinstance(value, (int, float)):
                baseline = source_baselines[metric_name]
                if baseline.is_ready():
                    z_scores[metric_name] = baseline.z_score(value)
        return z_scores

    def _z_to_health(self, z: float) -> HealthState:
        if z >= 4.0:
            return HealthState.POOR
        elif z >= 3.0:
            return HealthState.FAIR
        elif z >= 2.5:
            return HealthState.GOOD
        return HealthState.EXCELLENT


# ─── Alert Correlator (Layer 1) ───

class AlertCorrelator:
    """
    120-second sliding window alert correlation.
    Merges related alerts for same tenant+source into single Incident.
    """

    def __init__(self):
        # tenant_id -> list of recent Alerts (within correlation window)
        self.recent_alerts: dict[str, list[Alert]] = defaultdict(list)
        # tenant_id -> incident_id -> Incident
        self.incidents: dict[str, dict[str, Incident]] = defaultdict(dict)

    def add_alert(self, alert: Alert) -> Incident | None:
        """Add alert, correlate with existing, return new/updated Incident.
        Uses alert's timestamp for sliding window (works for real-time and replay)."""
        window_start = alert.timestamp_utc.timestamp() - CORRELATION_WINDOW_SECONDS

        # Prune old alerts (relative to this alert's timestamp)
        tenant_alerts = self.recent_alerts[alert.tenant_id]
        self.recent_alerts[alert.tenant_id] = [
            a for a in tenant_alerts if a.timestamp_utc.timestamp() > window_start
        ]

        # Find correlatable alerts (same source, same category or related)
        # Don't filter by correlated status - we want to find existing incidents
        related_alerts = [
            a for a in self.recent_alerts[alert.tenant_id]
            if a.source_id == alert.source_id
            and (a.event_category == alert.event_category or self._categories_related(a.event_category, alert.event_category))
        ]

        if related_alerts:
            # Check if any related alert belongs to an existing incident
            for related_alert in related_alerts:
                existing_incident = self._find_incident_for_alert(related_alert, alert.tenant_id)
                if existing_incident:
                    return self._merge_alert_into_incident(existing_incident, alert, [related_alert])

        # Create new incident
        return self._create_incident(alert)

    def _categories_related(self, cat1: EventCategory, cat2: EventCategory) -> bool:
        """Check if two categories should be correlated."""
        related_groups = [
            {EventCategory.INFRASTRUCTURE, EventCategory.NETWORK},
            {EventCategory.SECURITY},  # Security stands alone
            {EventCategory.HEARTBEAT},
        ]
        for group in related_groups:
            if cat1 in group and cat2 in group:
                return True
        return False

    def _find_incident_for_alert(self, alert: Alert, tenant_id: str) -> Incident | None:
        """Find incident that contains this alert."""
        for incident in self.incidents[tenant_id].values():
            # Simple heuristic: same source and category
            if incident.source_id == alert.source_id and incident.event_category == alert.event_category:
                return incident
        return None

    def _create_incident(self, alert: Alert) -> Incident:
        """Create new incident from single alert."""
        incident = Incident(
            incident_id=str(uuid.uuid4())[:12],
            tenant_id=alert.tenant_id,
            source_id=alert.source_id,
            event_category=alert.event_category,
            severity=alert.severity,
            health_state=alert.health_state,
            first_alert_time=alert.timestamp_utc,
            last_update_time=alert.timestamp_utc,
            alert_count=1,
            contributing_signals=[f"{alert.metric_name}: {alert.metric_value} (z={alert.z_score:.1f})"],
            reasoning_path="",
            confidence=0.0,
            recommended_action="",
            ai_provider="",
            llm_latency_ms=0,
            z_scores={alert.metric_name: alert.z_score},
            metrics_snapshot={alert.metric_name: alert.metric_value},
        )
        alert.correlated = True
        self.recent_alerts[alert.tenant_id].append(alert)
        self.incidents[alert.tenant_id][incident.incident_id] = incident
        return incident

    def _merge_alert_into_incident(
        self,
        incident: Incident,
        new_alert: Alert,
        correlated_alerts: list[Alert],
    ) -> Incident:
        """Merge new alert into existing incident."""
        # Update incident
        incident.alert_count += 1
        incident.last_update_time = new_alert.timestamp_utc
        incident.severity = max(incident.severity, new_alert.severity, key=lambda s: {"info": 0, "warning": 1, "critical": 2}[s.value])
        incident.health_state = max(incident.health_state, new_alert.health_state, key=lambda h: {"Excellent": 0, "Good": 1, "Fair": 2, "Poor": 3}[h.value])

        # Add new signal
        incident.contributing_signals.append(f"{new_alert.metric_name}: {new_alert.metric_value} (z={new_alert.z_score:.1f})")
        incident.z_scores[new_alert.metric_name] = new_alert.z_score
        incident.metrics_snapshot[new_alert.metric_name] = new_alert.metric_value

        # Mark alerts as correlated
        for a in correlated_alerts:
            a.correlated = True
        new_alert.correlated = True
        self.recent_alerts[new_alert.tenant_id].append(new_alert)

        return incident

    def get_incidents(self, tenant_id: str) -> list[Incident]:
        """Get all incidents for tenant, most recent first."""
        return sorted(
            self.incidents[tenant_id].values(),
            key=lambda i: i.last_update_time,
            reverse=True,
        )

    def get_incident(self, tenant_id: str, incident_id: str) -> Incident | None:
        return self.incidents[tenant_id].get(incident_id)


# ─── Health State Classifier ───

class HealthStateClassifier:
    """4-state health classification with configurable thresholds."""

    DEFAULT_THRESHOLDS = {
        "cpu_pct": {"excellent": 50, "good": 70, "fair": 85},
        "mem_pct": {"excellent": 60, "good": 80, "fair": 90},
        "disk_pct": {"excellent": 50, "good": 75, "fair": 90},
        "latency_ms": {"excellent": 50, "good": 100, "fair": 300},
        "packet_loss_pct": {"excellent": 0.1, "good": 1, "fair": 5},
        "bandwidth_mbps": {},  # No upper threshold
    }

    def __init__(self, custom_thresholds: dict | None = None):
        self.thresholds = custom_thresholds or self.DEFAULT_THRESHOLDS

    def classify(self, metrics: dict[str, float], event_category: EventCategory) -> tuple[HealthState, str]:
        """Classify health state from metrics, return (state, reason)."""
        worst_state = HealthState.EXCELLENT
        reasons = []

        for metric, value in metrics.items():
            if value is None or metric not in self.thresholds:
                continue
            t = self.thresholds[metric]
            if not t:
                continue

            if value >= t.get("fair", float("inf")):
                state = HealthState.POOR
                reasons.append(f"{metric}={value} >= fair threshold {t['fair']}")
            elif value >= t.get("good", float("inf")):
                state = HealthState.FAIR
                reasons.append(f"{metric}={value} >= good threshold {t['good']}")
            elif value >= t.get("excellent", float("inf")):
                state = HealthState.GOOD
                reasons.append(f"{metric}={value} >= excellent threshold {t['excellent']}")
            else:
                state = HealthState.EXCELLENT

            if {"Excellent": 0, "Good": 1, "Fair": 2, "Poor": 3}[state.value] > {"Excellent": 0, "Good": 1, "Fair": 2, "Poor": 3}[worst_state.value]:
                worst_state = state

        if not reasons:
            reason = "All metrics within excellent thresholds"
        else:
            reason = "; ".join(reasons[:3])  # Top 3 reasons

        return worst_state, reason


# ─── Heartbeat Watchdog ───

class HeartbeatWatchdog:
    """Monitors collector heartbeats, downgrades to Poor after timeout."""

    def __init__(self, timeout_seconds: int = HEARTBEAT_TIMEOUT_SECONDS):
        self.timeout_seconds = timeout_seconds
        self.collectors: dict[str, CollectorHealth] = {}  # collector_id -> CollectorHealth

    def register_heartbeat(
        self,
        collector_id: str,
        tenant_id: str,
        version: str = "unknown",
        collector_cpu_pct: float = 0.0,
        collector_mem_mb: float = 0.0,
    ) -> CollectorHealth:
        """Register or update collector heartbeat."""
        now = datetime.now(timezone.utc)
        if collector_id not in self.collectors:
            self.collectors[collector_id] = CollectorHealth(
                collector_id=collector_id,
                tenant_id=tenant_id,
                last_heartbeat=now,
                version=version,
                collector_cpu_pct=collector_cpu_pct,
                collector_mem_mb=collector_mem_mb,
            )
        else:
            c = self.collectors[collector_id]
            c.last_heartbeat = now
            c.version = version
            c.collector_cpu_pct = collector_cpu_pct
            c.collector_mem_mb = collector_mem_mb

        return self.collectors[collector_id]

    def check_timeouts(self) -> list[CollectorHealth]:
        """Check for timed-out collectors, downgrade to Poor. Returns list of changed collectors."""
        now = datetime.now(timezone.utc)
        changed = []
        for collector in self.collectors.values():
            if collector.health_state != HealthState.POOR:
                elapsed = (now - collector.last_heartbeat).total_seconds()
                if elapsed > self.timeout_seconds:
                    old_state = collector.health_state
                    collector.health_state = HealthState.POOR
                    collector.state_reason = f"Collector heartbeat timeout (>{self.timeout_seconds}s, last seen {elapsed:.0f}s ago)"
                    collector.state_transitions.append({
                        "from": old_state.value,
                        "to": HealthState.POOR.value,
                        "reason": collector.state_reason,
                        "timestamp_utc": now.isoformat(),
                    })
                    changed.append(collector)
        return changed

    def get_collector(self, collector_id: str) -> CollectorHealth | None:
        return self.collectors.get(collector_id)

    def get_tenant_collectors(self, tenant_id: str) -> list[CollectorHealth]:
        return [c for c in self.collectors.values() if c.tenant_id == tenant_id]


# ─── Hybrid AIOps Engine (Main Orchestrator) ───

class HybridAIOpsEngine:
    """
    Main AIOps engine combining Layer 1 (Z-score + Correlation) and Layer 2 (LLM RCA).
    """

    def __init__(self):
        self.detector = ZScoreAnomalyDetector()
        self.correlator = AlertCorrelator()
        self.classifier = HealthStateClassifier()
        self.watchdog = HeartbeatWatchdog()
        self.multivariate_detector = MultivariateResidualDetector()
        self._rca_semaphore = asyncio.Semaphore(5)  # Limit concurrent LLM calls

    async def process_metadata(self, metadata: dict) -> dict:
        """
        Process incoming metadata payload through Layer 1 and Layer 2.
        Returns processing result with any new/updated incidents.
        """
        tenant_id = metadata["tenant_id"]
        source_id = metadata["source_id"]
        event_category = EventCategory(metadata["event_category"])
        metrics = metadata.get("metrics", {})
        timestamp = datetime.fromisoformat(metadata["event_timestamp_utc"].replace("Z", "+00:00")).timestamp()
        health_state = HealthState(metadata["health_state"])
        severity = Severity(metadata["severity"])
        security_summary = metadata.get("security_summary")
        alert_context = metadata.get("alert_context", "")

        # Update baselines (always, for all metrics)
        self.detector.update_baseline(tenant_id, source_id, metrics, timestamp)

        # Check for anomalies
        anomalies = self.detector.check_anomalies(
            tenant_id, source_id, metrics, event_category, timestamp
        )

        # Check for multivariate anomalies (Google Patent US 2025/0190292 A1)
        self.multivariate_detector.update(metrics)
        multi_res = self.multivariate_detector.check_anomaly(metrics)
        if multi_res and multi_res.is_anomaly:
            if not any(a.metric_name == multi_res.target_metric for a in anomalies):
                anomalies.append(Alert(
                    alert_id=str(uuid.uuid4())[:8],
                    tenant_id=tenant_id,
                    source_id=source_id,
                    event_category=event_category,
                    severity=Severity.CRITICAL if multi_res.confidence > 0.85 else Severity.WARNING,
                    metric_name=f"multivariate_{multi_res.target_metric}",
                    metric_value=multi_res.actual_value,
                    z_score=multi_res.z_score_residual,
                    health_state=HealthState.POOR if multi_res.confidence > 0.85 else HealthState.FAIR,
                    timestamp_utc=datetime.fromtimestamp(timestamp, tz=timezone.utc),
                    alert_context=f"Multivariate residual={multi_res.residual:.1f} exceeds interval +/-{multi_res.interval_size:.1f} (expected {multi_res.expected_value:.1f})",
                ))

        for a in anomalies:
            aoim_engine.record_alert(a.metric_name)

        results = {
            "anomalies_detected": len(anomalies),
            "new_incidents": [],
            "updated_incidents": [],
            "health_state": health_state.value,
        }

        # Process each anomaly through correlation and RCA
        for alert in anomalies:
            incident = self.correlator.add_alert(alert)
            if incident:
                # Trigger Layer 2 RCA if new incident or significantly updated
                if incident.alert_count == 1 or len(anomalies) > 1:
                    await self._enrich_incident_with_rca(incident, metadata)
                    results["new_incidents"].append(incident.incident_id)

        # Also check security summary for alerts
        if security_summary and security_summary.get("failed_login_count_60s", 0) > 5:
            risk = security_summary.get("risk_indicator", "medium")
            if risk in ("medium", "high"):
                alert = Alert(
                    alert_id=str(uuid.uuid4())[:8],
                    tenant_id=tenant_id,
                    source_id=source_id,
                    event_category=EventCategory.SECURITY,
                    severity=Severity.WARNING if risk == "medium" else Severity.CRITICAL,
                    metric_name="failed_login_count_60s",
                    metric_value=security_summary["failed_login_count_60s"],
                    z_score=0.0,  # Not Z-score based
                    health_state=HealthState.FAIR if risk == "medium" else HealthState.POOR,
                    timestamp_utc=datetime.now(timezone.utc),
                    alert_context=f"Security: {security_summary['failed_login_count_60s']} failed logins (risk={risk})",
                )
                incident = self.correlator.add_alert(alert)
                if incident:
                    await self._enrich_incident_with_rca(incident, metadata)
                    results["new_incidents"].append(incident.incident_id)

        return results

    async def _enrich_incident_with_rca(self, incident: Incident, metadata: dict) -> None:
        """Call LLM RCA (Layer 2) and enrich incident with explainable analysis."""
        async with self._rca_semaphore:
            # Prepare metadata for LLM (sanitized in generate_explainable_rca)
            rca_metadata = {
                "source_id": incident.source_id,
                "event_category": incident.event_category.value,
                "health_state": incident.health_state.value,
                "metrics": incident.metrics_snapshot,
                "z_scores": incident.z_scores,
                "security_summary": metadata.get("security_summary"),
                "correlated_alert_count": incident.alert_count,
                "tenant_id": incident.tenant_id,
                "collector_id": metadata.get("collector_id"),
                "event_timestamp_utc": metadata.get("event_timestamp_utc"),
                "region_id": metadata.get("region_id"),
                "alert_context": metadata.get("alert_context"),
                "severity": incident.severity.value,
            }

            # Call LLM with timeout handled inside
            rca_result = await generate_explainable_rca(rca_metadata)

            # Update incident with RCA
            incident.reasoning_path = rca_result["reasoning_path"]
            incident.contributing_signals = rca_result["contributing_signals"]
            incident.confidence = rca_result["confidence"]
            incident.recommended_action = rca_result["recommended_action"]
            incident.ai_provider = rca_result["ai_provider"]
            incident.llm_latency_ms = rca_result["llm_latency_ms"]

            # Evaluate AOIM adaptive triage
            triage = aoim_engine.evaluate_incident(
                incident_id=incident.incident_id,
                severity=incident.severity.value,
                confidence=incident.confidence,
                metrics=incident.metrics_snapshot,
                z_scores=incident.z_scores,
                contributing_signals=incident.contributing_signals,
                alert_count=incident.alert_count,
            )
            incident.aoim_triage = {
                "recommended_tier": triage.recommended_tier,
                "tier_label": triage.tier_label,
                "confidence": triage.confidence,
                "dynamic_importance_score": triage.dynamic_importance_score,
                "feature_attributions": [
                    {"feature": a.feature, "weight": a.weight, "direction": a.direction, "z_score": a.z_score, "value": a.value}
                    for a in triage.feature_attributions
                ],
                "operator_summary": triage.operator_summary,
                "technical_explanation": triage.technical_explanation,
            }

    def process_heartbeat(self, metadata: dict) -> CollectorHealth:
        """Process collector heartbeat metadata."""
        collector = self.watchdog.register_heartbeat(
            collector_id=metadata["collector_id"],
            tenant_id=metadata["tenant_id"],
            version=metadata.get("version", metadata.get("collector_meta", {}).get("version", "unknown")),
            collector_cpu_pct=metadata.get("collector_cpu_pct", metadata.get("collector_meta", {}).get("collector_cpu_pct", 0.0)),
            collector_mem_mb=metadata.get("collector_mem_mb", metadata.get("collector_meta", {}).get("collector_mem_mb", 0.0)),
        )
        return collector

    def check_collector_timeouts(self) -> list[CollectorHealth]:
        """Check and return collectors that timed out."""
        return self.watchdog.check_timeouts()

    def get_incidents(self, tenant_id: str) -> list[Incident]:
        return self.correlator.get_incidents(tenant_id)

    def get_incident(self, tenant_id: str, incident_id: str) -> Incident | None:
        return self.correlator.get_incident(tenant_id, incident_id)

    def get_collector_health(self, tenant_id: str) -> list[CollectorHealth]:
        return self.watchdog.get_tenant_collectors(tenant_id)

    def get_sla_metrics(self) -> dict:
        """Return current SLA metrics for dashboard."""
        return {
            "z_score_threshold": Z_SCORE_THRESHOLD,
            "correlation_window_seconds": CORRELATION_WINDOW_SECONDS,
            "heartbeat_timeout_seconds": HEARTBEAT_TIMEOUT_SECONDS,
            "active_incidents": sum(len(i) for i in self.correlator.incidents.values()),
            "tracked_sources": sum(len(s) for t in self.detector.baselines.values() for s in t.values()),
        }


# ─── Global Engine Instance ───
engine = HybridAIOpsEngine()


async def process_ingest_payload(payload: dict) -> dict:
    """Main entry point for /api/v1/ingest endpoint."""
    return await engine.process_metadata(payload)


async def process_heartbeat(payload: dict) -> dict:
    """Process collector heartbeat."""
    collector = engine.process_heartbeat(payload)
    return {"collector_id": collector.collector_id, "health_state": collector.health_state.value}


def get_incidents(tenant_id: str) -> list[dict]:
    incidents = engine.get_incidents(tenant_id)
    return [_incident_to_dict(i) for i in incidents]


def get_incident(tenant_id: str, incident_id: str) -> dict | None:
    incident = engine.get_incident(tenant_id, incident_id)
    return _incident_to_dict(incident) if incident else None


def get_collector_health(tenant_id: str) -> list[dict]:
    collectors = engine.get_collector_health(tenant_id)
    return [
        {
            "collector_id": c.collector_id,
            "health_state": c.health_state.value,
            "last_heartbeat_utc": c.last_heartbeat.isoformat(),
            "version": c.version,
            "collector_cpu_pct": c.collector_cpu_pct,
            "collector_mem_mb": c.collector_mem_mb,
            "state_reason": c.state_reason,
            "state_transitions": c.state_transitions,
        }
        for c in collectors
    ]


def check_collector_timeouts() -> list[dict]:
    changed = engine.check_collector_timeouts()
    return [
        {
            "collector_id": c.collector_id,
            "health_state": c.health_state.value,
            "state_reason": c.state_reason,
        }
        for c in changed
    ]


def get_sla_metrics() -> dict:
    return engine.get_sla_metrics()


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
        "aoim_triage": incident.aoim_triage,
    }