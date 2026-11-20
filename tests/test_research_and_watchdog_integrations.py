"""
tests/test_research_and_watchdog_integrations.py
Comprehensive Verification Suite for 14 Research Papers + observantio/watchdog Integration.
"""

from __future__ import annotations

import time
import pytest
from fastapi.testclient import TestClient

# Tier 1 Research Modules
from services.tier1_collector.log_parser import LogTemplateParser
from services.tier1_collector.ldp_privacy import LDP1BitMeanMechanism
from services.tier1_collector.edge_intelligence import (
    EphemeralMemoryPurge,
    TemporalThreatValidationModule,
    ThreatAssessmentNetwork,
)
from services.tier1_collector.edge_security import (
    MonotonicSequenceTracker,
    crc16_modbus,
    compute_frame_sha256,
    authenticate_remediation_command,
    sign_remediation_command,
    blind_aggregate_value,
    unblind_aggregate_sum,
)

# Tier 2 Research & Watchdog Modules
from services.tier2_saas.adaptive_watermark import AdaptiveWatermarkSorter
from services.tier2_saas.multivariate_detector import MultivariateResidualDetector
from services.tier2_saas.aoim_triage import AOIMTriageEngine
from services.tier2_saas.auth_rbac import Role, AuditLogChain, check_permission
from services.tier2_saas.remediation import RemediationOrchestrator
from services.tier2_saas.main import app


# ─────────────────────────────────────────────────────────────────────────────
# 1. Tier 1 Log Structure Parser (He et al. POP & Xu et al. Console Log Mining)
# ─────────────────────────────────────────────────────────────────────────────
class TestLogStructureParser:
    def test_extract_template_and_hash_variables(self):
        parser = LogTemplateParser(tenant_salt="test_salt_123")
        raw_msg = "Database connection failed for user admin@acme.com at /var/log/pg.log with error code 503"
        result = parser.parse(raw_msg)

        assert result["template_id"].startswith("EVT_")
        assert "admin@acme.com" not in result["sanitized_message"]
        assert "/var/log/pg.log" not in result["sanitized_message"]
        assert "<EMAIL:" in result["sanitized_message"] or "<PATH:" in result["sanitized_message"]
        assert "email" in result["extracted_parameters"]
        assert "path" in result["extracted_parameters"]


# ─────────────────────────────────────────────────────────────────────────────
# 2. Local Differential Privacy (Ding et al., Microsoft Research)
# ─────────────────────────────────────────────────────────────────────────────
class TestLocalDifferentialPrivacy:
    def test_1bit_mean_mechanism_and_memoization(self):
        ldp = LDP1BitMeanMechanism(epsilon=1.0, permanent_memoization=True)

        val = 75.0
        min_v = 0.0
        max_v = 100.0

        # Perturb metric
        res = ldp.perturb_counter(val, min_v, max_v, device_id="dev_01", metric_name="cpu_pct", epoch=100)
        assert res["perturbed_bit"] in (0, 1)
        assert min_v <= res["unbiased_estimate"] <= max_v
        assert res["privacy_budget_epsilon"] == 1.0

        # Permanent memoization on identical epoch
        res_again = ldp.perturb_counter(val, min_v, max_v, device_id="dev_01", metric_name="cpu_pct", epoch=100)
        assert res["perturbed_bit"] == res_again["perturbed_bit"], "Memoization must return identical bit for same epoch"


# ─────────────────────────────────────────────────────────────────────────────
# 3. Ephemeral Processing, TTVM & Deterministic TAN (PEWTAF, Bin Shafi FLS/SLS)
# ─────────────────────────────────────────────────────────────────────────────
class TestEdgeIntelligence:
    def test_ephemeral_raw_purge(self):
        buffer = {
            "raw_log": "FATAL: secret_key=987abc internal panic",
            "password": "SuperSecretPassword123",
            "metrics": {"cpu_pct": 95.0},
        }
        EphemeralMemoryPurge.purge_buffer(buffer, retain_encrypted_debug=False)

        assert "raw_log" not in buffer
        assert "password" not in buffer
        assert "metrics" in buffer

    def test_ttvm_persistence_filtering(self):
        ttvm = TemporalThreatValidationModule(window_size=10, tau_p=0.60)

        # Single transient spike should be suppressed
        res1 = ttvm.update("src_01", is_threat_detected=True)
        assert res1["is_persistent"] is False
        assert res1["suppress_alarm"] is True

        # Fill window until persistence >= 0.60
        for _ in range(5):
            res_later = ttvm.update("src_01", is_threat_detected=True)

        assert res_later["is_persistent"] is True
        assert res_later["persistence_score"] >= 0.60

    def test_tan_risk_scoring_and_ailc_escalation(self):
        assessment = ThreatAssessmentNetwork.evaluate_risk(
            event_category="security",
            severity="critical",
            persistence_score=0.85,
        )

        assert assessment["risk_level"] in ("High", "Critical")
        assert assessment["risk_score"] > 0.50
        assert assessment["ailc_escalation"] is True
        assert "FLS-Edge-To-SLS-Cloud" in assessment["architecture"]


# ─────────────────────────────────────────────────────────────────────────────
# 4. Tamper-Evident Sequence, CRC-16 & Blind Aggregation (Tran, Li/Fujita)
# ─────────────────────────────────────────────────────────────────────────────
class TestEdgeSecurity:
    def test_monotonic_sequence_counter(self):
        tracker = MonotonicSequenceTracker()
        s1 = tracker.next_seq("tenant_acme", "src_01")
        s2 = tracker.next_seq("tenant_acme", "src_01")
        assert s2 == s1 + 1

    def test_crc16_modbus_and_frame_digest(self):
        data_bytes = b"CICADA_EDGE_TELEMETRY_FRAME_2026"
        crc = crc16_modbus(data_bytes)
        assert len(crc) == 4
        assert isinstance(crc, str)

        payload = {"seq_num": 1, "cpu_pct": 45.2, "tenant_id": "tenant_acme"}
        digest = compute_frame_sha256(payload)
        assert len(digest) == 64

    def test_command_authenticator(self):
        token = "secret_operator_token"
        payload = {"action": "restart_service", "target": "src_01"}
        sig = sign_remediation_command(payload, token)
        assert authenticate_remediation_command(payload, token, sig) is True
        assert authenticate_remediation_command(payload, token, "invalid_sig") is False

    def test_blind_additive_homomorphic_encoding(self):
        r1 = 12345
        r2 = 67890
        c1 = blind_aggregate_value(50.5, blinding_factor=r1)
        c2 = blind_aggregate_value(75.5, blinding_factor=r2)

        c_sum = (c1 + c2) % (10**9 + 7)
        plain = unblind_aggregate_sum(c_sum, sum_blinding_factors=r1 + r2)
        assert plain == 126.0  # 50.5 + 75.5


# ─────────────────────────────────────────────────────────────────────────────
# 5. Recovery-Conscious Adaptive Watermark (Onishi et al., Fujitsu IoTDI)
# ─────────────────────────────────────────────────────────────────────────────
class TestAdaptiveWatermark:
    def test_watermark_generation_and_sorting(self):
        sorter = AdaptiveWatermarkSorter(window_size=20)
        now = time.time()
        for i in range(10):
            sorter.record_observation(arrival_time=now + i, event_time=now + i - 0.5)

        wm = sorter.compute_watermark(now + 10)
        assert wm <= (now + 10)

        # Batch sorting & reversal prevention
        batch = [
            {"event_timestamp_utc": "2026-11-20T12:00:10Z", "id": 2},
            {"event_timestamp_utc": "2026-11-20T12:00:05Z", "id": 1},
        ]
        sorted_batch = sorter.sort_and_filter_batch(batch)
        assert sorted_batch[0]["id"] == 1
        assert sorted_batch[1]["id"] == 2

        metrics = sorter.get_metrics()
        assert "watermark_lag_ms" in metrics
        assert "reversals_prevented" in metrics


# ─────────────────────────────────────────────────────────────────────────────
# 6. Multivariate Residual Anomaly Detection (Google Patent US 2025/0190292 A1)
# ─────────────────────────────────────────────────────────────────────────────
class TestMultivariateDetector:
    def test_ols_multivariate_residual_detection(self):
        detector = MultivariateResidualDetector(
            target_metric="cpu_pct",
            covariate_metrics=["bandwidth_mbps", "mem_pct"],
        )

        # Train linear relationship: cpu ~ 0.5*bandwidth + 0.2*mem + 10
        for i in range(15):
            bw = 50.0 + i * 2
            mem = 40.0 + i
            cpu = 10.0 + 0.5 * bw + 0.2 * mem
            detector.update({"bandwidth_mbps": bw, "mem_pct": mem, "cpu_pct": cpu})

        # Test normal point
        res_normal = detector.check_anomaly({"bandwidth_mbps": 70.0, "mem_pct": 50.0, "cpu_pct": 55.0})
        assert res_normal is not None
        assert not res_normal.is_anomaly

        # Test anomalous spike far above expectation
        res_anomaly = detector.check_anomaly({"bandwidth_mbps": 70.0, "mem_pct": 50.0, "cpu_pct": 98.0})
        assert res_anomaly is not None
        assert res_anomaly.is_anomaly
        assert res_anomaly.residual > 0


# ─────────────────────────────────────────────────────────────────────────────
# 7. AOIM Adaptive Weighting & Explainable Triage
# ─────────────────────────────────────────────────────────────────────────────
class TestAOIMTriageEngine:
    def test_dynamic_weights_and_confidence_gating(self):
        engine = AOIMTriageEngine()
        engine.record_alert("cpu_pct")

        # Critical severity + high confidence -> Tier 3
        res_tier3 = engine.evaluate_incident(
            incident_id="inc_001",
            severity="critical",
            confidence=0.95,
            metrics={"cpu_pct": 94.0, "mem_pct": 82.0},
            z_scores={"cpu_pct": 3.8, "mem_pct": 2.1},
            contributing_signals=["cpu_pct: 94.0"],
            alert_count=3,
        )
        assert res_tier3.recommended_tier == "tier3_auto_restore"
        assert len(res_tier3.feature_attributions) == 2
        assert "Tier 3" in res_tier3.tier_label
        assert len(res_tier3.operator_summary) > 0
        assert len(res_tier3.technical_explanation) > 0

        # Lower confidence -> Tier 2
        res_tier2 = engine.evaluate_incident(
            incident_id="inc_002",
            severity="warning",
            confidence=0.75,
            metrics={"latency_ms": 150.0},
            z_scores={"latency_ms": 2.6},
            contributing_signals=["latency_ms: 150.0"],
            alert_count=1,
        )
        assert res_tier2.recommended_tier == "tier2_analyst"


# ─────────────────────────────────────────────────────────────────────────────
# 8. Cryptographic Audit Chain & RBAC Guardrails
# ─────────────────────────────────────────────────────────────────────────────
class TestAuthAuditChain:
    def test_audit_log_hash_chain_verification(self):
        chain = AuditLogChain()
        rec1 = chain.append("tenant_1", "usr_admin", Role.ADMINISTRATOR.value, "create_user", {"user": "bob"})
        rec2 = chain.append("tenant_1", "usr_op", Role.OPERATOR.value, "remediate", {"incident": "inc_99"})

        assert rec2.prev_hash == rec1.record_hash
        valid, msg = chain.verify_chain()
        assert valid is True

        # Tampering detection
        rec1.details["user"] = "mallory"
        valid_tampered, _ = chain.verify_chain()
        assert valid_tampered is False

    def test_rbac_permissions(self):
        assert check_permission(Role.ADMINISTRATOR, "remediate_tier3") is True
        assert check_permission(Role.OPERATOR, "remediate_tier3") is False
        assert check_permission(Role.OPERATOR, "remediate_tier2") is True
        assert check_permission(Role.VIEWER, "remediate_tier2") is False


# ─────────────────────────────────────────────────────────────────────────────
# 9. Watchdog Control-Plane API Endpoints
# ─────────────────────────────────────────────────────────────────────────────
class TestWatchdogEndpoints:
    @pytest.fixture
    def client(self):
        return TestClient(app)

    def test_rca_jobs_endpoints(self, client):
        payload = {
            "incident_id": "inc_test_watchdog",
            "tenant_id": "tenant_acme_corp",
            "source_id": "src_01",
            "metrics_snapshot": {"cpu_pct": 92.0, "mem_pct": 85.0, "latency_ms": 120.0},
            "contributing_signals": ["cpu elevated"],
        }
        resp = client.post("/api/v1/rca/jobs", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["incident_id"] == "inc_test_watchdog"
        assert len(data["top_candidates"]) == 3
        # Probabilities sum to ~1.0
        prob_sum = sum(c["probability"] for c in data["top_candidates"])
        assert abs(prob_sum - 1.0) < 0.05

        # Fetch job by ID
        resp_get = client.get("/api/v1/rca/jobs/inc_test_watchdog")
        assert resp_get.status_code == 200
        assert resp_get.json()["incident_id"] == "inc_test_watchdog"

    def test_dynamic_collector_config(self, client):
        resp = client.post("/api/v1/tenants/tenant_acme_corp/collector-config", json={"region_id": "ap-south-1"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["tenant_id"] == "tenant_acme_corp"
        assert "COLLECTOR_AUTH_TOKEN=" in data["env_content"]
        assert "uvicorn services.tier1_collector.main:app" in data["powershell_snippet"]

    def test_silences_lifecycle(self, client):
        # Create silence
        resp = client.post("/api/v1/silences", json={
            "tenant_id": "tenant_acme_corp",
            "metric_name": "cpu_pct",
            "duration_minutes": 15,
            "created_by": "test_operator",
            "reason": "load testing",
        })
        assert resp.status_code == 200
        silence_id = resp.json()["silence_id"]

        # List silences
        resp_list = client.get("/api/v1/silences?tenant_id=tenant_acme_corp")
        assert resp_list.status_code == 200
        assert any(s["silence_id"] == silence_id for s in resp_list.json())

        # Delete silence
        resp_del = client.delete(f"/api/v1/silences/{silence_id}")
        assert resp_del.status_code == 200
        assert resp_del.json()["status"] == "deleted"

    def test_incident_state_and_audit(self, client):
        # Transition incident state
        resp_state = client.patch(
            "/api/v1/incidents/inc_audit_test/state",
            json={"state": "acknowledged", "operator_id": "alice", "operator_note": "Investigating spike"},
        )
        assert resp_state.status_code == 200
        assert resp_state.json()["new_state"] == "acknowledged"

        # Verify audit endpoint
        resp_audit = client.get("/api/v1/audit")
        assert resp_audit.status_code == 200
        audit_data = resp_audit.json()
        assert audit_data["chain_valid"] is True
        assert audit_data["total_records"] >= 1
