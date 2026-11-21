"""
Tier 1 Privacy Boundary Regression Tests

Verifies all critical Tier 1 privacy guarantees:
1. Password, token, and IPv4 redaction in alert_context.
2. Accumulation of alert_context redactions into composite ScrubResult.
3. Removal of nested dictionaries in metrics.
4. Stripping of unapproved metric names.
5. Rejection of booleans for numeric metrics.
6. Acceptance of service_up boolean.
7. Preservation of integer semantics for failed_login_count.
8. Rejection of NaN and Infinity in metrics.
9. Exclusion of unallowlisted top-level fields via enforce_allow_list.
10. Sanitization of sensitive strings in security_summary and collector_meta.
11. Byte-for-byte JSON parity between outbox_queue and egress_proof_log.
12. Full compliance with Tier 2 IngestPayload (extra="forbid") Pydantic model.
13. Preservation of local security analyzer behavior.
14. Preservation of local log template parser behavior.
"""

from __future__ import annotations

import asyncio
import json
import math
import uuid
from datetime import datetime, timezone
import httpx
import pytest

from services.tier1_collector.scrubber import (
    ALLOWED_EGRESS_FIELDS,
    ALLOWED_METRIC_NAMES,
    ALLOWED_COLLECTOR_META_KEYS,
    ALLOWED_SECURITY_SUMMARY_KEYS,
    ALLOWED_RISK_INDICATORS,
    ScrubResult,
    enforce_allow_list,
    scrub_dict,
    scrub_secrets,
    validate_and_sanitize_metrics,
    validate_and_sanitize_collector_meta,
    validate_and_sanitize_security_summary,
)
from services.tier1_collector.storage import (
    db_transaction,
    drop_db,
    init_db,
    get_db_path,
    get_connection,
    ensure_db_initialized,
    process_and_store_telemetry,
    get_outbox_stats,
    get_pending_outbox,
    get_recent_raw_logs,
    get_egress_proof_logs,
    cleanup_old_logs,
)
from services.tier1_collector.forwarder import Tier2Forwarder
from services.tier1_collector.analyzer import analyze_for_security
from services.tier1_collector.log_parser import parse_log_message
from services.tier2_saas.main import IngestPayload


@pytest.fixture(autouse=True)
def setup_teardown_db():
    init_db()
    yield


class TestAlertContextRedaction:
    """Requirement 1 & 2: alert_context secret redaction and ScrubResult audit tracking."""

    def test_alert_context_secrets_redacted(self):
        """Verify passwords, tokens, and IPv4 addresses in alert_context are redacted."""
        raw_context = "Alert: database failover password=SecretPass999 token=eyJh1234 on 192.168.1.50"
        egress, scrub_res = process_and_store_telemetry(
            raw_data={"message": "System operational"},
            tenant_id="tenant_acme",
            collector_id="coll_01",
            region_id="us-east-1",
            tenant_salt="salt_xyz",
            payload_id=f"test_alert_{uuid.uuid4().hex[:8]}",
            event_timestamp_utc=datetime.now(timezone.utc).isoformat(),
            source_timezone="UTC",
            event_category="infrastructure",
            severity="warning",
            health_state="Fair",
            metrics={"cpu_pct": 82.5},
            security_summary=None,
            alert_context=raw_context,
            collector_meta={},
        )

        # Ensure secrets are NOT in alert_context
        assert "SecretPass999" not in egress["alert_context"]
        assert "eyJh1234" not in egress["alert_context"]
        assert "192.168.1.50" not in egress["alert_context"]

        # Ensure redaction placeholders are present
        assert "[REDACTED_PASSWORD]" in egress["alert_context"]
        assert "[REDACTED_TOKEN]" in egress["alert_context"]
        assert "[REDACTED_IP]" in egress["alert_context"]

        # Ensure redactions are accumulated in ScrubResult
        assert scrub_res.redactions_count >= 3
        assert "PASSWORD" in scrub_res.redaction_types
        assert "TOKEN" in scrub_res.redaction_types
        assert "IP" in scrub_res.redaction_types

    def test_alert_context_none_preserved(self):
        """Verify None alert_context is preserved as None."""
        egress, scrub_res = process_and_store_telemetry(
            raw_data={"message": "Normal beat"},
            tenant_id="tenant_acme",
            collector_id="coll_01",
            region_id="us-east-1",
            tenant_salt="salt_xyz",
            payload_id=f"test_none_{uuid.uuid4().hex[:8]}",
            event_timestamp_utc=datetime.now(timezone.utc).isoformat(),
            source_timezone="UTC",
            event_category="heartbeat",
            severity="info",
            health_state="Excellent",
            metrics={"cpu_pct": 10.0},
            security_summary=None,
            alert_context=None,
            collector_meta={},
        )
        assert egress["alert_context"] is None


class TestMetricValidation:
    """Requirements 3-8: Metric validation, types, and allow-listing."""

    def test_nested_dictionary_removal(self):
        """Nested dictionaries in metrics must be removed/rejected."""
        dirty_metrics = {
            "cpu_pct": 45.0,
            "nested_stats": {"core0": 40.0, "core1": 50.0},
            "disk_pct": {"used": 100},
        }
        clean = validate_and_sanitize_metrics(dirty_metrics)
        assert "nested_stats" not in clean
        assert "disk_pct" not in clean  # rejected because it was a dict, not numeric
        assert clean == {"cpu_pct": 45.0}

    def test_unapproved_metric_names_stripped(self):
        """Metrics not in ALLOWED_METRIC_NAMES must be stripped."""
        dirty_metrics = {
            "cpu_pct": 55.0,
            "gpu_usage": 90.0,
            "custom_secret_metric": 123.45,
            "mem_pct": 60.0,
        }
        clean = validate_and_sanitize_metrics(dirty_metrics)
        assert "gpu_usage" not in clean
        assert "custom_secret_metric" not in clean
        assert clean == {"cpu_pct": 55.0, "mem_pct": 60.0}

    def test_booleans_rejected_for_numeric_metrics(self):
        """Booleans must NOT be accepted for numeric metrics (even though bool is a subclass of int in Python)."""
        dirty_metrics = {
            "cpu_pct": True,
            "mem_pct": False,
            "disk_pct": 75.0,
            "failed_login_count": True,
        }
        clean = validate_and_sanitize_metrics(dirty_metrics)
        assert "cpu_pct" not in clean
        assert "mem_pct" not in clean
        assert "failed_login_count" not in clean
        assert clean == {"disk_pct": 75.0}

    def test_service_up_boolean_accepted(self):
        """service_up metric must accept booleans, but reject non-booleans."""
        clean_true = validate_and_sanitize_metrics({"service_up": True})
        assert clean_true == {"service_up": True}

        clean_false = validate_and_sanitize_metrics({"service_up": False})
        assert clean_false == {"service_up": False}

        # Non-boolean service_up rejected
        clean_numeric = validate_and_sanitize_metrics({"service_up": 1})
        assert "service_up" not in clean_numeric

        clean_str = validate_and_sanitize_metrics({"service_up": "true"})
        assert "service_up" not in clean_str

    def test_failed_login_count_integer_preservation(self):
        """failed_login_count must preserve integer type semantics."""
        clean_int = validate_and_sanitize_metrics({"failed_login_count": 7})
        assert clean_int["failed_login_count"] == 7
        assert isinstance(clean_int["failed_login_count"], int)

        clean_float_whole = validate_and_sanitize_metrics({"failed_login_count": 10.0})
        assert clean_float_whole["failed_login_count"] == 10
        assert isinstance(clean_float_whole["failed_login_count"], int)

        # Fractional failed_login_count rejected
        clean_float_frac = validate_and_sanitize_metrics({"failed_login_count": 10.5})
        assert "failed_login_count" not in clean_float_frac

    def test_failed_login_count_negative_rejected(self):
        """failed_login_count must reject negative integers and negative floats."""
        clean_neg = validate_and_sanitize_metrics({"failed_login_count": -1})
        assert "failed_login_count" not in clean_neg

        clean_neg_float = validate_and_sanitize_metrics({"failed_login_count": -5.0})
        assert "failed_login_count" not in clean_neg_float

        clean_zero = validate_and_sanitize_metrics({"failed_login_count": 0})
        assert clean_zero["failed_login_count"] == 0

    def test_nan_and_infinity_rejected(self):
        """NaN and Infinity in metrics must be rejected."""
        dirty_metrics = {
            "cpu_pct": float("nan"),
            "mem_pct": float("inf"),
            "disk_pct": float("-inf"),
            "latency_ms": 12.5,
        }
        clean = validate_and_sanitize_metrics(dirty_metrics)
        assert "cpu_pct" not in clean
        assert "mem_pct" not in clean
        assert "disk_pct" not in clean
        assert clean == {"latency_ms": 12.5}

    def test_malformed_or_missing_metrics_handled_safely(self):
        """Safe fallback on None, strings, or non-dict inputs."""
        assert validate_and_sanitize_metrics(None) == {}
        assert validate_and_sanitize_metrics("invalid") == {}
        assert validate_and_sanitize_metrics([1, 2, 3]) == {}


class TestAllowListAndEgressBoundary:
    """Requirements 9-12: Allow-list enforcement, secret containment, parity, and Tier 2 contract."""

    def test_unexpected_top_level_fields_omitted(self):
        """Any top-level fields not in ALLOWED_EGRESS_FIELDS must be omitted."""
        payload_with_extras = {
            "payload_id": "p123",
            "tenant_id": "tenant_1",
            "collector_id": "c1",
            "source_id": "src_12345678",
            "region_id": "us-east-1",
            "event_timestamp_utc": "2026-11-20T12:00:00Z",
            "source_timezone": "UTC",
            "event_category": "infrastructure",
            "severity": "info",
            "health_state": "Good",
            "metrics": {},
            "security_summary": None,
            "alert_context": None,
            "collector_meta": {},
            # Forbidden / unexpected fields
            "raw_log": "Secret system log",
            "password": "Password123!",
            "internal_ip": "10.0.0.1",
            "api_key": "sk-12345",
        }
        enforced = enforce_allow_list(payload_with_extras)
        for forbidden in ["raw_log", "password", "internal_ip", "api_key"]:
            assert forbidden not in enforced
        assert set(enforced.keys()).issubset(ALLOWED_EGRESS_FIELDS)

    def test_security_summary_and_collector_meta_secrets_contained(self):
        """Secrets in security_summary or collector_meta must be scrubbed and not leaked."""
        sec_summary = {
            "failed_login_count_60s": 3,
            "risk_indicator": "medium",
            "flagged_user": "admin password=SuperSecret456",
        }
        coll_meta = {
            "template_id": "EVT_api_key=sk_live_collector_secret_xyz token=abcde12345",
            "seq_num": 101,
            "debug_trace": "should_be_stripped_completely",
        }

        egress, scrub_res = process_and_store_telemetry(
            raw_data={"message": "auth check"},
            tenant_id="tenant_sec",
            collector_id="coll_sec",
            region_id="us-east-1",
            tenant_salt="salt_sec",
            payload_id=f"sec_{uuid.uuid4().hex[:8]}",
            event_timestamp_utc=datetime.now(timezone.utc).isoformat(),
            source_timezone="UTC",
            event_category="security",
            severity="warning",
            health_state="Fair",
            metrics={"cpu_pct": 50.0},
            security_summary=sec_summary,
            alert_context=None,
            collector_meta=coll_meta,
        )

        # Inspect egress security_summary: unapproved flagged_user must be stripped completely
        assert "SuperSecret456" not in str(egress["security_summary"])
        assert "flagged_user" not in egress["security_summary"]
        assert egress["security_summary"]["failed_login_count_60s"] == 3
        assert egress["security_summary"]["risk_indicator"] == "medium"

        # Inspect egress collector_meta
        assert "debug_trace" not in egress["collector_meta"]
        assert "should_be_stripped_completely" not in str(egress["collector_meta"])
        assert "sk_live_collector_secret_xyz" not in str(egress["collector_meta"])
        assert "abcde12345" not in str(egress["collector_meta"])
        assert "[REDACTED_API_KEY]" in str(egress["collector_meta"])
        assert "[REDACTED_TOKEN]" in str(egress["collector_meta"])

        # Redactions counted
        assert scrub_res.redactions_count >= 3
        assert "PASSWORD" in scrub_res.redaction_types
        assert "API_KEY" in scrub_res.redaction_types
        assert "TOKEN" in scrub_res.redaction_types

    def test_collector_meta_unapproved_keys_stripped(self):
        """Unapproved keys in collector_meta must be stripped while approved keys are retained and scrubbed."""
        assert "debug_trace" not in ALLOWED_COLLECTOR_META_KEYS
        assert "parsed_template" not in ALLOWED_COLLECTOR_META_KEYS

        dirty_meta = {
            "template_id": "tpl_123 password=SecretInTemplate",
            "seq_num": 42,
            "unapproved_secret_field": "val1",
            "customer_ssn": "999-99-9999",
            "debug_trace": "password=LeakedSecret",
            "parsed_template": "Customer John Doe transfer 500",
        }
        clean_meta, scrub_res = validate_and_sanitize_collector_meta(dirty_meta, "test_salt")
        assert "template_id" in clean_meta
        assert "[REDACTED_PASSWORD]" in clean_meta["template_id"]
        assert "SecretInTemplate" not in clean_meta["template_id"]
        assert "seq_num" in clean_meta
        assert "debug_trace" not in clean_meta
        assert "parsed_template" not in clean_meta
        assert "unapproved_secret_field" not in clean_meta
        assert "customer_ssn" not in clean_meta

    def test_parsed_template_stripped_from_egress_payload(self):
        """Verify parsed_template is stripped from egress payload while template_id is preserved."""
        parsed_log = {
            "template_id": "TPL_login_failure_01",
            "parsed_template": "Failed password for <*> from <NUM>.<NUM>.<NUM>.<NUM> user admin",
            "param_tokens": ["root", "192.168.1.1"],
        }
        egress, _ = process_and_store_telemetry(
            raw_data={"message": "Failed password for root from 192.168.1.1"},
            tenant_id="tenant_tpl",
            collector_id="coll_tpl",
            region_id="us-east-1",
            tenant_salt="salt_tpl",
            payload_id=f"tpl_{uuid.uuid4().hex[:8]}",
            event_timestamp_utc=datetime.now(timezone.utc).isoformat(),
            source_timezone="UTC",
            event_category="security",
            severity="warning",
            health_state="Fair",
            metrics={"failed_login_count": 1},
            security_summary=None,
            alert_context=None,
            collector_meta=parsed_log,
        )
        assert "template_id" in egress["collector_meta"]
        assert egress["collector_meta"]["template_id"] == "TPL_login_failure_01"
        assert "parsed_template" not in egress["collector_meta"]
        assert "param_tokens" not in egress["collector_meta"]

    def test_outbox_queue_and_egress_proof_byte_for_byte_parity(self):
        """outbox_queue.egress_payload and egress_proof_log.egress_payload must be byte-for-byte identical."""
        payload_id = f"parity_{uuid.uuid4().hex[:8]}"
        tenant_id = "tenant_parity"

        egress_returned, scrub_res = process_and_store_telemetry(
            raw_data={"message": "Job complete password=TestPass01"},
            tenant_id=tenant_id,
            collector_id="coll_parity",
            region_id="us-east-1",
            tenant_salt="salt_parity",
            payload_id=payload_id,
            event_timestamp_utc=datetime.now(timezone.utc).isoformat(),
            source_timezone="UTC",
            event_category="infrastructure",
            severity="info",
            health_state="Excellent",
            metrics={"cpu_pct": 33.3, "mem_pct": 44.4},
            security_summary={"failed_login_count_60s": 0, "risk_indicator": "low"},
            alert_context="Alert token=test_tok_123456",
            collector_meta={"seq_num": 42},
        )

        with db_transaction() as conn:
            outbox_row = conn.execute(
                "SELECT egress_payload FROM outbox_queue WHERE payload_id = ?",
                (payload_id,)
            ).fetchone()
            proof_row = conn.execute(
                "SELECT egress_payload FROM egress_proof_log WHERE payload_id = ?",
                (payload_id,)
            ).fetchone()

        assert outbox_row is not None, "Payload was not found in outbox_queue"
        assert proof_row is not None, "Payload was not found in egress_proof_log"

        outbox_json = outbox_row["egress_payload"]
        proof_json = proof_row["egress_payload"]

        # Byte-for-byte exact match of serialized JSON string
        assert outbox_json == proof_json

        # Exactly matches returned payload
        assert json.loads(outbox_json) == egress_returned

        # Zero raw secrets in either record
        for secret in ["TestPass01", "test_tok_123456"]:
            assert secret not in outbox_json
            assert secret not in proof_json

    def test_tier2_pydantic_ingest_payload_contract_compatibility(self):
        """The egress payload must validate against Tier 2 IngestPayload with extra='forbid'."""
        pid = f"contract_{uuid.uuid4().hex[:8]}"
        egress, _ = process_and_store_telemetry(
            raw_data={"message": "Normal system event", "source_ip": "10.0.0.12"},
            tenant_id="tenant_contract",
            collector_id="coll_contract",
            region_id="us-east-1",
            tenant_salt="salt_contract",
            payload_id=pid,
            event_timestamp_utc="2026-11-20T12:00:00Z",
            source_timezone="UTC",
            event_category="infrastructure",
            severity="info",
            health_state="Excellent",
            metrics={
                "cpu_pct": 55.0,
                "mem_pct": 65.0,
                "disk_pct": 70.0,
                "latency_ms": 15.2,
                "packet_loss_pct": 0.0,
                "bandwidth_mbps": 100.5,
                "failed_login_count": 0,
                "service_up": True,
            },
            security_summary={"failed_login_count_60s": 0, "risk_indicator": "low"},
            alert_context=None,
            collector_meta={"template_id": "tpl_01"},
        )

        # Must parse without ValidationError under extra='forbid'
        tier2_model = IngestPayload(**egress)
        assert tier2_model.payload_id == pid
        assert tier2_model.tenant_id == "tenant_contract"
        assert tier2_model.metrics["service_up"] is True
        assert tier2_model.metrics["failed_login_count"] == 0
        assert isinstance(tier2_model.metrics["failed_login_count"], int)

    async def test_tier2_forwarder_wire_parity_with_egress_proof(self):
        """Pass an outbox payload through the actual Tier2Forwarder serialization path and compare wire JSON against egress proof."""
        payload_id = f"fwd_parity_{uuid.uuid4().hex[:8]}"
        tenant_id = "tenant_fwd_parity"
        collector_id = "coll_fwd"
        region_id = "us-east-1"
        collector_token = "valid-token-fwd"

        egress_returned, _ = process_and_store_telemetry(
            raw_data={"message": "Forwarder parity test password=SecretPassWd987", "source_ip": "10.10.10.10"},
            tenant_id=tenant_id,
            collector_id=collector_id,
            region_id=region_id,
            tenant_salt="salt_fwd_parity",
            payload_id=payload_id,
            event_timestamp_utc=datetime.now(timezone.utc).isoformat(),
            source_timezone="UTC",
            event_category="infrastructure",
            severity="info",
            health_state="Good",
            metrics={"cpu_pct": 45.0, "failed_login_count": 0},
            security_summary={"failed_login_count_60s": 0, "risk_indicator": "low"},
            alert_context="High CPU observed password=SecretPassWd987 token=my_secret_token",
            collector_meta={"template_id": "tpl_fwd_01", "parsed_template": "raw words to strip"},
        )

        proof_logs = get_egress_proof_logs(tenant_id=tenant_id, limit=10)
        matching_proofs = [p for p in proof_logs if p["payload_id"] == payload_id]
        assert len(matching_proofs) == 1, "Egress proof record missing"
        egress_proof_dict = matching_proofs[0]["egress_payload"]

        captured_requests: list[httpx.Request] = []

        def mock_handler(request: httpx.Request) -> httpx.Response:
            captured_requests.append(request)
            return httpx.Response(200, json={"status": "accepted", "payload_id": payload_id})

        forwarder = Tier2Forwarder(
            tenant_id=tenant_id,
            collector_id=collector_id,
            collector_token=collector_token,
            region_id=region_id,
        )
        forwarder._client = httpx.AsyncClient(transport=httpx.MockTransport(mock_handler))
        forwarder._running = True

        try:
            await forwarder._drain_batch()
        finally:
            await forwarder.stop()

        assert len(captured_requests) == 1, "Expected exactly one wire HTTP request"
        req = captured_requests[0]

        assert req.headers["x-tenant-id"] == tenant_id
        assert req.headers["x-region-id"] == region_id
        assert req.headers["authorization"] == f"Bearer {collector_token}"

        wire_payload = json.loads(req.content.decode("utf-8"))

        # Value-for-value exact parity between wire JSON and Egress Proof JSON
        assert wire_payload == egress_proof_dict
        assert wire_payload == egress_returned

        stats = get_outbox_stats(tenant_id)
        assert stats["sent"] >= 1

        wire_str = req.content.decode("utf-8")
        assert "SecretPassWd987" not in wire_str
        assert "my_secret_token" not in wire_str
        assert "parsed_template" not in wire_str
        assert "raw words to strip" not in wire_str
        assert "[REDACTED_PASSWORD]" in wire_str
        assert "[REDACTED_TOKEN]" in wire_str


class TestPreservedLocalAnalysisBehavior:
    """Requirements 13 & 14: Local security analyzer and log template parser continue working."""

    def test_local_security_analysis_detects_invalid_password(self):
        """Local security analysis must detect 'invalid password' in unredacted raw message."""
        raw_payload = {"message": "User alice failed: invalid password from internal host"}
        summary = analyze_for_security(raw_payload, "tenant_local", "src_host1")
        assert summary is not None
        assert summary["failed_login_count_60s"] >= 1

    def test_local_log_template_parser_extracts_templates(self):
        """Log template parser must extract templates and parameter tokens from raw log."""
        log_line = "Failed password for root from 192.168.1.100 port 22 ssh2 user admin@domain.com"
        parsed = parse_log_message(log_line, "test_salt")
        assert "template_id" in parsed
        assert "parsed_template" in parsed
        assert len(parsed["template_id"]) > 0


class TestDatabaseInitialization:
    """Verify Finding 1: Database initialization occurs lazily without import-time side-effects."""

    def test_dynamic_db_path_resolution(self, monkeypatch, tmp_path):
        """Verify get_db_path dynamically reflects TIER1_DB_PATH environment variable."""
        custom_path = tmp_path / "custom_collector.db"
        monkeypatch.setenv("TIER1_DB_PATH", str(custom_path))
        assert get_db_path() == custom_path

    def test_lazy_ensure_db_initialized(self, monkeypatch, tmp_path):
        """Verify ensure_db_initialized creates tables only on-demand."""
        custom_path = tmp_path / "lazy_collector.db"
        monkeypatch.setenv("TIER1_DB_PATH", str(custom_path))
        # File should not exist initially
        assert not custom_path.exists()
        # Call lazy init
        ensure_db_initialized()
        assert custom_path.exists()
        conn = get_connection()
        tables = [row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        conn.close()
        assert "outbox_queue" in tables
        assert "local_raw_logs" in tables
        assert "egress_proof_log" in tables

    def test_standalone_repository_calls_auto_initialize_db(self, monkeypatch, tmp_path):
        """Verify standalone repository operations auto-initialize missing tables on fresh DB."""
        db_file = tmp_path / "standalone_test.db"
        monkeypatch.setenv("TIER1_DB_PATH", str(db_file))
        assert not db_file.exists()

        # Standalone read operations should auto-initialize and succeed without exception
        stats = get_outbox_stats("tenant_standalone")
        assert stats["pending"] == 0
        assert stats["sent"] == 0

        pending = get_pending_outbox("tenant_standalone", limit=10)
        assert pending == []

        raw_logs = get_recent_raw_logs("tenant_standalone", limit=5)
        assert raw_logs == []

        proof_logs = get_egress_proof_logs("tenant_standalone", limit=5)
        assert proof_logs == []

        cleaned = cleanup_old_logs("tenant_standalone", retention_hours=24)
        assert cleaned >= 0

        assert db_file.exists()


# ─── Strict Security Summary Privacy & Allowlist Verification ───

class TestSecuritySummaryStrictAllowlist:
    """Verify that arbitrary security_summary keys and freeform values cannot reach egress."""

    def test_approved_fields_survive_with_valid_values(self):
        """Approved fields (failed_login_count_60s, risk_indicator, total_failures) survive validation."""
        valid_input = {
            "failed_login_count_60s": 7,
            "risk_indicator": "HIGH",
            "total_failures": 14,
        }
        sanitized, scrub_res = validate_and_sanitize_security_summary(valid_input, "tenant_salt")
        assert sanitized == {
            "failed_login_count_60s": 7,
            "risk_indicator": "high",
            "total_failures": 14,
        }
        assert isinstance(sanitized["failed_login_count_60s"], int)
        assert isinstance(sanitized["total_failures"], int)
        assert isinstance(sanitized["risk_indicator"], str)

    def test_invalid_types_and_negative_counts_rejected(self):
        """Invalid types (booleans, strings, floats, negatives, unapproved risks) are discarded."""
        invalid_input = {
            "failed_login_count_60s": True,       # Boolean must be rejected
            "total_failures": -10,                 # Negative must be rejected
            "risk_indicator": "EXTREME_CATASTROPHIC",  # Unapproved risk level
        }
        sanitized, scrub_res = validate_and_sanitize_security_summary(invalid_input, "tenant_salt")
        assert "failed_login_count_60s" not in sanitized
        assert "total_failures" not in sanitized
        assert "risk_indicator" not in sanitized
        assert sanitized == {}

    def test_unapproved_keys_and_freeform_pii_discarded(self):
        """Unapproved keys (flagged_user, customer_ssn, auth_secret, patient_records) are completely stripped."""
        leaky_input = {
            "failed_login_count_60s": 5,
            "risk_indicator": "critical",
            "flagged_user": "admin password=SuperSecret456",
            "customer_ssn": "000-11-2222",
            "patient_notes": "Prescription details for confidential patient",
            "internal_repo": "https://vault.internal.corp/secret",
            "auth_secret": "raw_unredacted_secret_token",
        }
        sanitized, scrub_res = validate_and_sanitize_security_summary(leaky_input, "tenant_salt")

        # Only approved keys survive
        assert set(sanitized.keys()) == {"failed_login_count_60s", "risk_indicator"}
        assert sanitized["failed_login_count_60s"] == 5
        assert sanitized["risk_indicator"] == "critical"

        # All unapproved keys stripped
        assert "flagged_user" not in sanitized
        assert "customer_ssn" not in sanitized
        assert "patient_notes" not in sanitized
        assert "internal_repo" not in sanitized
        assert "auth_secret" not in sanitized

        # Secret in discarded flagged_user is accounted in ScrubResult audit
        assert scrub_res.redactions_count >= 1
        assert "PASSWORD" in scrub_res.redaction_types

    @pytest.mark.asyncio
    async def test_end_to_end_wire_parity_and_secret_containment(self):
        """Verify end-to-end through storage, outbox, and forwarder that no unapproved keys reach the wire."""
        payload_id = f"sec_allow_{uuid.uuid4().hex[:8]}"
        tenant_id = "tenant_sec_wire"
        collector_id = "coll_sec_01"
        region_id = "us-east-1"
        collector_token = "token_sec_123"

        egress_returned, scrub_res = process_and_store_telemetry(
            raw_data={"message": "Security check with raw secret password=TestPass123"},
            tenant_id=tenant_id,
            collector_id=collector_id,
            region_id=region_id,
            tenant_salt="salt_sec_wire",
            payload_id=payload_id,
            event_timestamp_utc=datetime.now(timezone.utc).isoformat(),
            source_timezone="UTC",
            event_category="security",
            severity="warning",
            health_state="Fair",
            metrics={"cpu_pct": 50.0},
            security_summary={
                "failed_login_count_60s": 4,
                "risk_indicator": "medium",
                "flagged_user": "operator password=SecretFlagged999",
                "customer_ssn": "999-88-7777",
                "auth_secret": "bare_token_xyz",
            },
            alert_context="Security alert token=BearerSecret456",
            collector_meta={"template_id": "tpl_sec_01"},
        )

        # 1. Egress returned dict must have clean security_summary
        assert set(egress_returned["security_summary"].keys()) == {"failed_login_count_60s", "risk_indicator"}
        assert "flagged_user" not in egress_returned["security_summary"]
        assert "customer_ssn" not in egress_returned["security_summary"]
        assert "auth_secret" not in egress_returned["security_summary"]

        # 2. Egress proof log matches
        proof_logs = get_egress_proof_logs(tenant_id, limit=5)
        matching = [p for p in proof_logs if p["payload_id"] == payload_id]
        assert len(matching) == 1
        proof_payload = matching[0]["egress_payload"]
        assert set(proof_payload["security_summary"].keys()) == {"failed_login_count_60s", "risk_indicator"}

        # 3. Wire serialization matches
        wire_requests: list[dict] = []

        def mock_wire(request: httpx.Request) -> httpx.Response:
            wire_requests.append(json.loads(request.content.decode("utf-8")))
            return httpx.Response(200, json={"status": "accepted", "payload_id": payload_id})

        forwarder = Tier2Forwarder(tenant_id, collector_id, collector_token, region_id)
        forwarder._client = httpx.AsyncClient(transport=httpx.MockTransport(mock_wire))
        forwarder._running = True

        try:
            await forwarder._drain_batch()
        finally:
            await forwarder.stop()

        assert len(wire_requests) == 1
        wire_body = wire_requests[0]
        assert wire_body["security_summary"] == egress_returned["security_summary"]
        assert set(wire_body["security_summary"].keys()) == {"failed_login_count_60s", "risk_indicator"}
        assert "flagged_user" not in wire_body["security_summary"]
        assert "customer_ssn" not in str(wire_body)
        assert "SecretFlagged999" not in str(wire_body)
        assert "bare_token_xyz" not in str(wire_body)
