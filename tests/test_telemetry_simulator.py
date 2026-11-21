"""
Automated Regression Tests for Emergency Tier 1 Local Telemetry Simulator
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from services.tier1_collector.main import app, IngestRequest
from services.tier1_collector.storage import init_db, get_egress_proof_logs
from services.tier1_collector.scrubber import ALLOWED_METRIC_NAMES
from scripts.simulate_telemetry import (
    generate_normal_baseline,
    generate_cpu_drift_anomaly,
    generate_network_spike_anomaly,
    generate_brute_force_security,
    generate_secret_leak_privacy_proof,
    post_telemetry,
)


@pytest.fixture(autouse=True)
def setup_db():
    init_db()
    yield


class TestTelemetrySimulator:
    """Validate telemetry simulator generators and ingestion pipeline integration."""

    @pytest.mark.parametrize(
        "generator_func, expected_category, expected_severity",
        [
            (generate_normal_baseline, "infrastructure", "info"),
            (generate_cpu_drift_anomaly, "infrastructure", "critical"),
            (generate_network_spike_anomaly, "network", "critical"),
            (generate_brute_force_security, "security", "critical"),
            (generate_secret_leak_privacy_proof, "security", "warning"),
        ],
    )
    def test_generator_schema_and_metrics_coverage(
        self,
        generator_func,
        expected_category,
        expected_severity,
    ):
        """Verify each generator output conforms to IngestRequest and covers required metrics."""
        raw_event = generator_func(1)
        req = IngestRequest(**raw_event)

        assert req.event_category == expected_category
        assert req.severity == expected_severity
        assert isinstance(req.metrics, dict)

        # All metric keys must belong to ALLOWED_METRIC_NAMES
        for k in req.metrics:
            assert k in ALLOWED_METRIC_NAMES

    def test_all_seven_telemetry_categories_covered(self):
        """Verify all 7 required hackathon metrics are generated across scenarios."""
        required_metrics = {
            "cpu_pct",
            "mem_pct",
            "disk_pct",
            "bandwidth_mbps",
            "latency_ms",
            "packet_loss_pct",
            "failed_login_count",
        }

        generated_keys = set()
        for gen in [
            generate_normal_baseline,
            generate_cpu_drift_anomaly,
            generate_network_spike_anomaly,
            generate_brute_force_security,
            generate_secret_leak_privacy_proof,
        ]:
            event = gen(1)
            generated_keys.update(event["metrics"].keys())

        assert required_metrics.issubset(generated_keys)

    def test_end_to_end_simulator_ingest_via_test_client(self):
        """Verify TestClient ingests simulator events into Tier 1 and creates egress proof."""
        client = TestClient(app)

        for gen in [
            generate_normal_baseline,
            generate_cpu_drift_anomaly,
            generate_network_spike_anomaly,
            generate_brute_force_security,
            generate_secret_leak_privacy_proof,
        ]:
            event = gen(1)
            res = client.post("/local/ingest", json=event)
            assert res.status_code == 200
            data = res.json()
            assert data["status"] == "accepted"
            assert data["queued"] is True
            assert len(data["payload_id"]) > 0

        # Verify egress proof panel contains records
        proofs = get_egress_proof_logs(tenant_id="tenant_acme_corp", limit=20)
        assert len(proofs) >= 5

    def test_privacy_scenario_redacts_credentials(self):
        """Verify secret_leak scenario redacts passwords, tokens, API keys, and IPs."""
        client = TestClient(app)
        event = generate_secret_leak_privacy_proof(1)

        res = client.post("/local/ingest", json=event)
        assert res.status_code == 200
        data = res.json()

        assert data["redacted_fields_count"] >= 3
        assert "PASSWORD" in data["redaction_types"]
        assert "TOKEN" in data["redaction_types"] or "API_KEY" in data["redaction_types"]
