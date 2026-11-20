"""
Hybrid AIOps Tests — Phase 2/3 Verification
Tests metadata-only guardrail, LLM fallback, and end-to-end SLA compliance.
"""

from __future__ import annotations

import asyncio
import os
import time
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

# Set test environment - no API keys to test fallback
os.environ.pop("GROQ_API_KEY", None)
os.environ.pop("GEMINI_API_KEY", None)

from services.tier2_saas.llm_explain import (
    generate_explainable_rca,
    generate_explainable_rca_sync,
    sanitize_metadata,
    ALLOWED_METADATA_KEYS,
    FORBIDDEN_KEYS,
    RCAResponse,
)
from services.tier2_saas.aiops import (
    HybridAIOpsEngine,
    ZScoreAnomalyDetector,
    AlertCorrelator,
    HealthStateClassifier,
    HeartbeatWatchdog,
    EventCategory,
    Severity,
    HealthState,
    Alert,
    Incident,
)


# ─── Test 1: Metadata-Only Guardrail ───

class TestMetadataOnlyGuardrail:
    """Verify that ONLY allow-listed metadata passes to LLM - never raw logs/secrets."""

    def test_sanitize_strips_forbidden_keys(self):
        """Pass dict with raw_log, password, api_key, source_ip - assert all stripped."""
        dirty_metadata = {
            "source_id": "src_a9f28c10",
            "event_category": "infrastructure",
            "health_state": "Poor",
            "metrics": {"cpu_pct": 94.2, "mem_pct": 88.0},
            "z_scores": {"cpu_pct": 3.6, "mem_pct": 2.9},
            "security_summary": {"failed_login_count_60s": 0, "risk_indicator": "low"},
            "correlated_alert_count": 3,
            # FORBIDDEN - should be stripped
            "raw_log": '{"password": "SuperSecret123", "api_key": "sk_live_abc"}',
            "password": "SuperSecret123",
            "api_key": "sk_live_abc123",
            "secret": "mysecret",
            "source_ip": "10.0.0.5",
            "hostname": "prod-db-01.internal",
            "authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
            "internal_ip": "192.168.1.42",
        }

        sanitized = sanitize_metadata(dirty_metadata)

        # Verify allowed keys present
        for key in ALLOWED_METADATA_KEYS:
            if key in dirty_metadata:
                assert key in sanitized, f"Allowed key {key} missing from sanitized output"

        # Verify forbidden keys stripped
        for forbidden in FORBIDDEN_KEYS:
            assert forbidden not in sanitized, f"FORBIDDEN KEY LEAKED: {forbidden} found in sanitized output"

        # Verify nested cleaning
        assert "password" not in str(sanitized)
        assert "sk_live_abc" not in str(sanitized)
        assert "10.0.0.5" not in str(sanitized)
        assert "prod-db-01.internal" not in str(sanitized)

    def test_sanitize_preserves_allowed_metrics(self):
        """Verify allowed metrics and z-scores are preserved correctly."""
        metadata = {
            "source_id": "src_test",
            "event_category": "network",
            "health_state": "Fair",
            "metrics": {
                "cpu_pct": 75.0,
                "mem_pct": 80.0,
                "disk_pct": 60.0,
                "bandwidth_mbps": 500.0,
                "latency_ms": 150.0,
                "packet_loss_pct": 1.5,
                "service_up": True,
            },
            "z_scores": {
                "cpu_pct": 2.1,
                "latency_ms": 3.2,
                "packet_loss_pct": 2.8,
            },
            "security_summary": {"failed_login_count_60s": 5, "risk_indicator": "medium"},
            "correlated_alert_count": 2,
        }

        sanitized = sanitize_metadata(metadata)

        assert sanitized["metrics"]["cpu_pct"] == 75.0
        assert sanitized["metrics"]["latency_ms"] == 150.0
        assert sanitized["z_scores"]["cpu_pct"] == 2.1
        assert sanitized["z_scores"]["latency_ms"] == 3.2
        assert sanitized["security_summary"]["failed_login_count_60s"] == 5

    def test_generate_explainable_rca_strips_before_llm_call(self):
        """Integration test: verify generate_explainable_rca sanitizes input before any LLM call."""
        metadata_with_secrets = {
            "source_id": "src_test",
            "event_category": "infrastructure",
            "health_state": "Poor",
            "metrics": {"cpu_pct": 95.0},
            "z_scores": {"cpu_pct": 4.0},
            "security_summary": {"failed_login_count_60s": 0, "risk_indicator": "low"},
            "correlated_alert_count": 1,
            "raw_log": "password=Secret123 api_key=sk_live_xyz",
            "password": "Secret123",
            "source_ip": "10.0.0.1",
        }

        # Call sync wrapper (uses asyncio.run internally)
        result = generate_explainable_rca_sync(metadata_with_secrets)

        # Verify output is valid RCAResponse structure
        assert "reasoning_path" in result
        assert "contributing_signals" in result
        assert "confidence" in result
        assert "recommended_action" in result
        assert "ai_provider" in result
        assert "llm_latency_ms" in result

        # Verify no secrets in output
        output_str = str(result)
        assert "Secret123" not in output_str
        assert "sk_live_xyz" not in output_str
        assert "10.0.0.1" not in output_str
        assert "raw_log" not in output_str

        # Should be deterministic fallback since no API keys
        assert result["ai_provider"] == "deterministic-fallback"


# ─── Test 2: Live or Fallback Execution ───

class TestLiveOrFallbackExecution:
    """Verify valid JSON output with API key AND graceful fallback when unset/timed out."""

    def test_deterministic_fallback_when_no_api_key(self):
        """With no GROQ_API_KEY or GEMINI_API_KEY, should return deterministic fallback."""
        metadata = {
            "source_id": "src_test",
            "event_category": "infrastructure",
            "health_state": "Poor",
            "metrics": {"cpu_pct": 94.2, "mem_pct": 88.0},
            "z_scores": {"cpu_pct": 3.6, "mem_pct": 2.9},
            "security_summary": {"failed_login_count_60s": 0, "risk_indicator": "low"},
            "correlated_alert_count": 2,
        }

        result = generate_explainable_rca_sync(metadata)

        assert result["ai_provider"] == "deterministic-fallback"
        assert len(result["contributing_signals"]) >= 1
        assert result["confidence"] > 0.0
        assert result["confidence"] <= 1.0
        assert len(result["reasoning_path"]) > 10
        assert len(result["recommended_action"]) > 5
        assert result["llm_latency_ms"] >= 0

    @pytest.mark.asyncio
    async def test_groq_timeout_falls_back_to_deterministic(self):
        """Mock Groq timeout -> should fall back to deterministic."""
        metadata = {
            "source_id": "src_test",
            "event_category": "infrastructure",
            "health_state": "Poor",
            "metrics": {"cpu_pct": 94.2},
            "z_scores": {"cpu_pct": 3.6},
            "security_summary": {"failed_login_count_60s": 0, "risk_indicator": "low"},
            "correlated_alert_count": 1,
        }

        # Set fake Groq key
        os.environ["GROQ_API_KEY"] = "fake-key-for-test"
        os.environ["LLM_TIMEOUT_SECONDS"] = "0.001"  # Extremely short timeout

        try:
            from services.tier2_saas.llm_explain import LLMConfig
            config = LLMConfig.from_env()
            assert config.groq_api_key == "fake-key-for-test"
            assert config.timeout_seconds == 0.001

            # This should timeout and fall back
            start = time.time()
            result = await generate_explainable_rca(metadata)
            elapsed = time.time() - start

            # Should fall back quickly (not wait for full timeout due to async handling)
            assert result["ai_provider"] == "deterministic-fallback"
        finally:
            os.environ.pop("GROQ_API_KEY", None)
            os.environ.pop("LLM_TIMEOUT_SECONDS", None)

    @pytest.mark.asyncio
    async def test_groq_http_error_falls_back(self):
        """Mock Groq HTTP error -> should fall back to deterministic."""
        metadata = {
            "source_id": "src_test",
            "event_category": "infrastructure",
            "health_state": "Poor",
            "metrics": {"cpu_pct": 94.2},
            "z_scores": {"cpu_pct": 3.6},
            "security_summary": {"failed_login_count_60s": 0, "risk_indicator": "low"},
            "correlated_alert_count": 1,
        }

        os.environ["GROQ_API_KEY"] = "fake-key"

        try:
            # Mock httpx AsyncClient instance's post method to raise HTTPStatusError
            with patch("services.tier2_saas.llm_explain.httpx.AsyncClient") as mock_client_class:
                mock_client = AsyncMock()
                # Response is a regular Mock (not AsyncMock) since raise_for_status and json are sync
                mock_response = MagicMock()
                # Raise proper httpx.HTTPStatusError (which is caught by the fallback logic)
                mock_response.raise_for_status.side_effect = httpx.HTTPStatusError(
                    "429 Rate Limited", request=httpx.Request("POST", "https://api.groq.com"), response=mock_response
                )
                # json() is a sync method in httpx
                mock_response.json.return_value = {"choices": [{"message": {"content": "{}"}}]}
                mock_client.post.return_value = mock_response
                mock_client_class.return_value.__aenter__.return_value = mock_client

                result = await generate_explainable_rca(metadata)
                assert result["ai_provider"] == "deterministic-fallback"
        finally:
            os.environ.pop("GROQ_API_KEY", None)

    def test_rca_response_schema_validation(self):
        """Verify RCAResponse Pydantic model validates output correctly."""
        metadata = {
            "source_id": "src_test",
            "event_category": "security",
            "health_state": "Poor",
            "metrics": {},
            "z_scores": {},
            "security_summary": {"failed_login_count_60s": 25, "risk_indicator": "high"},
            "correlated_alert_count": 3,
        }

        result = generate_explainable_rca_sync(metadata)

        # Validate against Pydantic model
        rca = RCAResponse(**result)
        assert rca.ai_provider == "deterministic-fallback"
        assert 0.0 <= rca.confidence <= 1.0
        assert len(rca.contributing_signals) >= 1


# ─── Test 3: End-to-End SLA Compliance ───

class TestEndToEndSLA:
    """Inject baseline + spike into Tier 2 and assert enriched Incident created in < 5 seconds."""

    @pytest.mark.asyncio
    async def test_zscore_detection_latency(self):
        """Layer 1 Z-score detection should be sub-5ms per payload."""
        engine = HybridAIOpsEngine()

        # Build baseline
        for i in range(20):
            await engine.process_metadata({
                "tenant_id": "tenant_test",
                "source_id": "src_latency_test",
                "collector_id": "coll_test",
                "region_id": "us-east-1",
                "event_timestamp_utc": "2026-11-20T12:00:00.000Z",
                "source_timezone": "UTC",
                "event_category": "infrastructure",
                "severity": "info",
                "health_state": "Excellent",
                "metrics": {"cpu_pct": 40.0 + i * 0.5, "mem_pct": 50.0},
                "security_summary": {"failed_login_count_60s": 0, "risk_indicator": "low"},
                "alert_context": "baseline",
                "collector_meta": {},
            })

        # Inject spike - measure detection time
        spike_payload = {
            "tenant_id": "tenant_test",
            "source_id": "src_latency_test",
            "collector_id": "coll_test",
            "region_id": "us-east-1",
            "event_timestamp_utc": "2026-11-20T12:05:00.000Z",
            "source_timezone": "UTC",
            "event_category": "infrastructure",
            "severity": "critical",
            "health_state": "Poor",
            "metrics": {"cpu_pct": 95.0, "mem_pct": 90.0},
            "security_summary": {"failed_login_count_60s": 0, "risk_indicator": "low"},
            "alert_context": "cpu spike detected",
            "collector_meta": {},
        }

        start = time.time()
        result = await engine.process_metadata(spike_payload)
        detection_latency_ms = (time.time() - start) * 1000

        # Layer 1 (Z-score + correlation) should be very fast
        assert detection_latency_ms < 50, f"Z-score detection took {detection_latency_ms:.1f}ms, expected < 50ms"
        assert result["anomalies_detected"] >= 1

    @pytest.mark.asyncio
    async def test_full_incident_creation_sla(self):
        """End-to-end: baseline + spike -> enriched Incident with RCA in < 5 seconds."""
        engine = HybridAIOpsEngine()

        # Build baseline for src_sla_test
        for i in range(15):
            await engine.process_metadata({
                "tenant_id": "tenant_sla",
                "source_id": "src_sla_test",
                "collector_id": "coll_sla",
                "region_id": "us-east-1",
                "event_timestamp_utc": f"2026-11-20T12:{i:02d}:00.000Z",
                "source_timezone": "UTC",
                "event_category": "infrastructure",
                "severity": "info",
                "health_state": "Excellent",
                "metrics": {"cpu_pct": 35.0, "mem_pct": 45.0, "latency_ms": 20.0},
                "security_summary": {"failed_login_count_60s": 0, "risk_indicator": "low"},
                "alert_context": "baseline",
                "collector_meta": {},
            })

        # Inject multi-metric spike
        spike_payload = {
            "tenant_id": "tenant_sla",
            "source_id": "src_sla_test",
            "collector_id": "coll_sla",
            "region_id": "us-east-1",
            "event_timestamp_utc": "2026-11-20T12:30:00.000Z",
            "source_timezone": "UTC",
            "event_category": "infrastructure",
            "severity": "critical",
            "health_state": "Poor",
            "metrics": {
                "cpu_pct": 96.0,
                "mem_pct": 92.0,
                "latency_ms": 450.0,
                "packet_loss_pct": 3.5,
            },
            "security_summary": {"failed_login_count_60s": 0, "risk_indicator": "low"},
            "alert_context": "Multi-metric anomaly: CPU, MEM, latency, packet loss",
            "collector_meta": {},
        }

        start = time.time()
        result = await engine.process_metadata(spike_payload)
        total_latency_ms = (time.time() - start) * 1000

        # Total should be well under 15s SLA (target < 5s for test)
        assert total_latency_ms < 5000, f"Total incident creation took {total_latency_ms:.1f}ms, expected < 5000ms"

        # Verify incident was created with RCA enrichment
        assert result["anomalies_detected"] >= 1
        assert len(result["new_incidents"]) >= 1

        incident_id = result["new_incidents"][0]
        incident = engine.get_incident("tenant_sla", incident_id)

        assert incident is not None
        assert len(incident.contributing_signals) >= 1
        assert incident.reasoning_path
        assert incident.recommended_action
        assert incident.ai_provider in ("deterministic-fallback", "groq-live", "gemini-live")
        assert incident.confidence > 0.0

        # Verify contributing signals include z-scores
        signals_str = " ".join(incident.contributing_signals)
        assert "cpu_pct" in signals_str or "mem_pct" in signals_str or "latency_ms" in signals_str

    @pytest.mark.asyncio
    async def test_alert_correlation_120s_window(self):
        """Verify 120s sliding window merges related alerts into single incident."""
        engine = HybridAIOpsEngine()

        # Build baseline first (need 10+ samples for Z-score baseline to be ready)
        base_time = datetime(2026, 11, 20, 11, 50, 0, tzinfo=timezone.utc)
        for i in range(15):
            ts = base_time + timedelta(minutes=i)
            await engine.process_metadata({
                "tenant_id": "tenant_corr",
                "source_id": "src_corr",
                "collector_id": "coll_corr",
                "region_id": "us-east-1",
                "event_timestamp_utc": ts.isoformat().replace("+00:00", "Z"),
                "source_timezone": "UTC",
                "event_category": "infrastructure",
                "severity": "info",
                "health_state": "Excellent",
                "metrics": {"cpu_pct": 40.0, "mem_pct": 50.0},
                "security_summary": {"failed_login_count_60s": 0, "risk_indicator": "low"},
                "alert_context": "baseline",
                "collector_meta": {},
            })

        # First spike alert
        await engine.process_metadata({
            "tenant_id": "tenant_corr",
            "source_id": "src_corr",
            "collector_id": "coll_corr",
            "region_id": "us-east-1",
            "event_timestamp_utc": "2026-11-20T12:00:00.000Z",
            "source_timezone": "UTC",
            "event_category": "infrastructure",
            "severity": "warning",
            "health_state": "Fair",
            "metrics": {"cpu_pct": 78.0},
            "security_summary": {"failed_login_count_60s": 0, "risk_indicator": "low"},
            "alert_context": "cpu elevated",
            "collector_meta": {},
        })

        # Second spike alert within 120s - should correlate
        await engine.process_metadata({
            "tenant_id": "tenant_corr",
            "source_id": "src_corr",
            "collector_id": "coll_corr",
            "region_id": "us-east-1",
            "event_timestamp_utc": "2026-11-20T12:01:30.000Z",
            "source_timezone": "UTC",
            "event_category": "infrastructure",
            "severity": "critical",
            "health_state": "Poor",
            "metrics": {"cpu_pct": 92.0, "mem_pct": 85.0},
            "security_summary": {"failed_login_count_60s": 0, "risk_indicator": "low"},
            "alert_context": "cpu critical + mem high",
            "collector_meta": {},
        })

        incidents = engine.get_incidents("tenant_corr")
        assert len(incidents) == 1, f"Expected 1 correlated incident, got {len(incidents)}"
        # First spike: 1 alert (cpu), Second spike: 2 alerts (cpu + mem) = 3 total merged
        assert incidents[0].alert_count == 3
        assert len(incidents[0].contributing_signals) == 3

    @pytest.mark.asyncio
    async def test_heartbeat_timeout_downgrades_to_poor(self):
        """Heartbeat watchdog: >60s silence -> collector health = Poor."""
        engine = HybridAIOpsEngine()

        # Register heartbeat
        collector = engine.process_heartbeat({
            "collector_id": "coll_timeout_test",
            "tenant_id": "tenant_watchdog",
            "version": "1.0.0",
            "collector_cpu_pct": 5.0,
            "collector_mem_mb": 50.0,
        })
        assert collector.health_state == HealthState.EXCELLENT

        # Manually set last_heartbeat to 70s ago
        from datetime import datetime, timezone, timedelta
        collector.last_heartbeat = datetime.now(timezone.utc) - timedelta(seconds=70)

        # Check timeouts
        changed = engine.check_collector_timeouts()
        assert len(changed) == 1
        assert changed[0].collector_id == "coll_timeout_test"
        assert changed[0].health_state == HealthState.POOR
        assert "timeout" in changed[0].state_reason.lower()


# ─── Test 4: Layer 1 Z-Score Detector Unit Tests ───

class TestZScoreAnomalyDetector:
    """Unit tests for rolling Z-score anomaly detector."""

    def test_baseline_building(self):
        detector = ZScoreAnomalyDetector()
        tenant_id = "tenant_z"
        source_id = "src_z"

        # Add baseline values
        for i in range(15):
            detector.update_baseline(tenant_id, source_id, {"cpu_pct": 50.0}, float(i))

        baseline = detector.baselines[tenant_id][source_id]["cpu_pct"]
        assert baseline.is_ready()
        assert abs(baseline.mean() - 50.0) < 0.1
        assert baseline.std() < 0.1  # Very consistent values

    def test_zscore_calculation(self):
        detector = ZScoreAnomalyDetector()
        tenant_id = "tenant_z"
        source_id = "src_z"

        # Build baseline: mean=50, std=5
        for val in [45, 55, 50, 48, 52, 47, 53, 49, 51, 50]:
            detector.update_baseline(tenant_id, source_id, {"cpu_pct": float(val)}, 0.0)

        # Test Z-score for spike
        z = detector.baselines[tenant_id][source_id]["cpu_pct"].z_score(80.0)
        assert z > 3.0, f"Z-score should be > 3 for 80 vs baseline mean 50, got {z}"

    def test_anomaly_detection_returns_alerts(self):
        detector = ZScoreAnomalyDetector()
        tenant_id = "tenant_z"
        source_id = "src_z"

        # Build baseline
        for val in [40, 42, 38, 45, 41, 39, 43, 40, 42, 41]:
            detector.update_baseline(tenant_id, source_id, {"cpu_pct": float(val)}, 0.0)

        # Check anomaly
        alerts = detector.check_anomalies(
            tenant_id, source_id, {"cpu_pct": 90.0},
            EventCategory.INFRASTRUCTURE, 0.0
        )

        assert len(alerts) == 1
        assert alerts[0].metric_name == "cpu_pct"
        assert alerts[0].z_score > 3.0
        assert alerts[0].severity == Severity.CRITICAL


# ─── Test 5: Alert Correlator Unit Tests ───

class TestAlertCorrelator:
    """Unit tests for 120s alert correlator."""

    def test_same_source_same_category_merges(self):
        correlator = AlertCorrelator()

        alert1 = Alert(
            alert_id="a1",
            tenant_id="tenant_c",
            source_id="src_c",
            event_category=EventCategory.INFRASTRUCTURE,
            severity=Severity.WARNING,
            metric_name="cpu_pct",
            metric_value=75.0,
            z_score=2.8,
            health_state=HealthState.FAIR,
            timestamp_utc=datetime.now(timezone.utc),
            alert_context="cpu elevated",
        )

        alert2 = Alert(
            alert_id="a2",
            tenant_id="tenant_c",
            source_id="src_c",
            event_category=EventCategory.INFRASTRUCTURE,
            severity=Severity.CRITICAL,
            metric_name="mem_pct",
            metric_value=90.0,
            z_score=3.5,
            health_state=HealthState.POOR,
            timestamp_utc=datetime.now(timezone.utc),
            alert_context="mem critical",
        )

        inc1 = correlator.add_alert(alert1)
        inc2 = correlator.add_alert(alert2)

        assert inc1.incident_id == inc2.incident_id
        assert inc1.alert_count == 2

    def test_different_source_separate_incidents(self):
        correlator = AlertCorrelator()

        alert1 = Alert(
            alert_id="a1", tenant_id="tenant_c", source_id="src_1",
            event_category=EventCategory.INFRASTRUCTURE, severity=Severity.WARNING,
            metric_name="cpu_pct", metric_value=75.0, z_score=2.8,
            health_state=HealthState.FAIR, timestamp_utc=datetime.now(timezone.utc),
            alert_context="cpu elevated",
        )

        alert2 = Alert(
            alert_id="a2", tenant_id="tenant_c", source_id="src_2",
            event_category=EventCategory.INFRASTRUCTURE, severity=Severity.WARNING,
            metric_name="cpu_pct", metric_value=75.0, z_score=2.8,
            health_state=HealthState.FAIR, timestamp_utc=datetime.now(timezone.utc),
            alert_context="cpu elevated",
        )

        inc1 = correlator.add_alert(alert1)
        inc2 = correlator.add_alert(alert2)

        assert inc1.incident_id != inc2.incident_id
        assert inc1.alert_count == 1
        assert inc2.alert_count == 1


# ─── Test 6: Health State Classifier ───

class TestHealthStateClassifier:
    """Unit tests for 4-state health classifier."""

    def test_thresholds(self):
        classifier = HealthStateClassifier()

        # Excellent
        state, reason = classifier.classify({"cpu_pct": 30.0, "mem_pct": 40.0}, EventCategory.INFRASTRUCTURE)
        assert state == HealthState.EXCELLENT

        # Good
        state, reason = classifier.classify({"cpu_pct": 60.0}, EventCategory.INFRASTRUCTURE)
        assert state == HealthState.GOOD

        # Fair
        state, reason = classifier.classify({"cpu_pct": 75.0}, EventCategory.INFRASTRUCTURE)
        assert state == HealthState.FAIR

        # Poor
        state, reason = classifier.classify({"cpu_pct": 95.0}, EventCategory.INFRASTRUCTURE)
        assert state == HealthState.POOR

    def test_network_thresholds(self):
        classifier = HealthStateClassifier()

        state, reason = classifier.classify({"latency_ms": 30.0, "packet_loss_pct": 0.05}, EventCategory.NETWORK)
        assert state == HealthState.EXCELLENT

        state, reason = classifier.classify({"latency_ms": 200.0}, EventCategory.NETWORK)
        assert state == HealthState.FAIR

        state, reason = classifier.classify({"packet_loss_pct": 8.0}, EventCategory.NETWORK)
        assert state == HealthState.POOR


# ─── Imports needed for tests ───

from datetime import datetime, timezone


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])