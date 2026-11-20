"""
Phase 1 Redaction & Allow-List Tests

MANDATORY: These tests must pass with ZERO failures to prove:
(a) Zero secrets leak into output JSON
(b) Unapproved fields are strictly rejected by Pydantic extra="forbid"
"""

import json
import pytest
from uuid import UUID

from src.tier1.metadata_contract import (
    TelemetryPayload,
    EventCategory,
    Severity,
    HealthState,
    scrub_secrets,
    pseudonymize_source_identifier,
    extract_allowlisted_fields,
    validate_payload,
    payload_to_json,
    create_payload_id,
    EgressProofPanel,
)


class TestSecretScrubber:
    """Test that secret scrubbing removes all sensitive patterns."""

    def test_scrubs_password(self):
        raw = 'User login password=SuperSecret123 failed'
        result = scrub_secrets(raw)
        assert "SuperSecret123" not in result.scrubbed_text
        assert "[REDACTED_PASSWORD]" in result.scrubbed_text
        assert result.redactions_count == 1

    def test_scrubs_api_key(self):
        raw = 'api_key=sk_live_abc123xyz'
        result = scrub_secrets(raw)
        assert "sk_live_abc123xyz" not in result.scrubbed_text
        assert "[REDACTED_API_KEY]" in result.scrubbed_text

    def test_scrubs_jwt(self):
        raw = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
        result = scrub_secrets(raw)
        assert "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" not in result.scrubbed_text
        assert "[REDACTED_JWT]" in result.scrubbed_text

    def test_scrubs_basic_auth(self):
        raw = 'Authorization: Basic dXNlcjpwYXNz'
        result = scrub_secrets(raw)
        assert "dXNlcjpwYXNz" not in result.scrubbed_text
        assert "[REDACTED_BASIC_AUTH]" in result.scrubbed_text

    def test_scrubs_private_key(self):
        raw = 'private_key=-----BEGIN RSA PRIVATE KEY-----\nMIIEow...'
        result = scrub_secrets(raw)
        assert "BEGIN RSA PRIVATE KEY" not in result.scrubbed_text
        assert "[REDACTED_PRIVATE_KEY]" in result.scrubbed_text

    def test_scrubs_email(self):
        raw = 'Contact admin@company.com for access'
        result = scrub_secrets(raw)
        assert "admin@company.com" not in result.scrubbed_text
        assert "[REDACTED_EMAIL]" in result.scrubbed_text

    def test_scrubs_ipv4(self):
        raw = 'Connection from 10.0.0.5 established'
        result = scrub_secrets(raw)
        assert "10.0.0.5" not in result.scrubbed_text
        assert "[REDACTED_IPV4]" in result.scrubbed_text

    def test_multiple_secrets_scrubbed(self):
        raw = 'password=Secret123 api_key=sk_live_abc token=xyz user@domain.com 192.168.1.1'
        result = scrub_secrets(raw)
        assert "Secret123" not in result.scrubbed_text
        assert "sk_live_abc" not in result.scrubbed_text
        assert "xyz" not in result.scrubbed_text  # token value
        assert "user@domain.com" not in result.scrubbed_text
        assert "192.168.1.1" not in result.scrubbed_text
        assert result.redactions_count == 5


class TestPseudonymization:
    """Test that internal identifiers are converted to pseudonymous source_ids."""

    def test_pseudonymize_ip_stable(self):
        tenant_salt = "tenant_acme_corp_salt"
        ip = "10.0.0.5"
        id1 = pseudonymize_source_identifier(ip, tenant_salt)
        id2 = pseudonymize_source_identifier(ip, tenant_salt)
        assert id1 == id2  # Stable within tenant
        assert id1.startswith("src_")
        assert len(id1) == 10  # "src_" + 6 hex chars

    def test_pseudonymize_different_tenant_different_id(self):
        ip = "10.0.0.5"
        id1 = pseudonymize_source_identifier(ip, "tenant_a_salt")
        id2 = pseudonymize_source_identifier(ip, "tenant_b_salt")
        assert id1 != id2  # Different per tenant

    def test_pseudonymize_hostname(self):
        tenant_salt = "tenant_salt"
        hostname = "prod-db-01.internal"
        source_id = pseudonymize_source_identifier(hostname, tenant_salt)
        assert source_id.startswith("src_")
        assert "prod-db-01" not in source_id


class TestAllowListExtraction:
    """Test the full raw-data → allow-listed payload transformation."""

    def test_extract_infra_metrics(self):
        raw_data = {
            "cpu_pct": 73.5,
            "mem_pct": 81.2,
            "disk_pct": 45.0,
            "source_ip": "10.0.0.5",
            "hostname": "prod-web-01",
            "password": "Secret123",  # Should be scrubbed
            "api_key": "sk_live_abc",  # Should be scrubbed
        }
        payload = extract_allowlisted_fields(
            raw_data=raw_data,
            tenant_id="tenant_acme_corp",
            collector_id="coll_us_east_1_003",
            region_id="us-east-1",
            source_timezone="America/New_York",
            tenant_salt="tenant_acme_corp_salt",
        )

        # Verify allow-listed fields present
        assert payload.tenant_id == "tenant_acme_corp"
        assert payload.collector_id == "coll_us_east_1_003"
        assert payload.region_id == "us-east-1"
        assert payload.source_id.startswith("src_")
        assert payload.event_category == EventCategory.INFRA
        assert payload.cpu_pct == 73.5
        assert payload.mem_pct == 81.2
        assert payload.disk_pct == 45.0
        assert payload.severity == Severity.WARNING  # CPU > 70%
        assert payload.health_state == HealthState.FAIR  # CPU > 70%
        assert payload.alert_context is not None
        assert "FAIR" in payload.alert_context
        assert "src_" in payload.alert_context

        # Verify secrets NOT in payload
        payload_json = payload_to_json(payload)
        assert "Secret123" not in payload_json
        assert "sk_live_abc" not in payload_json
        assert "10.0.0.5" not in payload_json
        assert "prod-web-01" not in payload_json

    def test_extract_network_metrics(self):
        raw_data = {
            "latency_ms": 127.3,
            "packet_loss_pct": 0.5,
            "bandwidth_mbps": 940.0,
            "source_ip": "192.168.1.42",
        }
        payload = extract_allowlisted_fields(
            raw_data=raw_data,
            tenant_id="tenant_acme_corp",
            collector_id="coll_us_east_1_003",
            region_id="us-east-1",
            source_timezone="America/New_York",
            tenant_salt="tenant_acme_corp_salt",
        )

        assert payload.event_category == EventCategory.NETWORK
        assert payload.latency_ms == 127.3
        assert payload.packet_loss_pct == 0.5
        assert payload.bandwidth_mbps == 940.0
        assert payload.health_state == HealthState.FAIR  # latency 127.3 > 100ms but < 300ms, loss 0.5% < 1%

    def test_extract_security_signals(self):
        raw_data = {
            "failed_logins": 15,
            "source_ip": "172.16.0.100",
        }
        payload = extract_allowlisted_fields(
            raw_data=raw_data,
            tenant_id="tenant_acme_corp",
            collector_id="coll_us_east_1_003",
            region_id="us-east-1",
            source_timezone="America/New_York",
            tenant_salt="tenant_acme_corp_salt",
        )

        assert payload.event_category == EventCategory.SECURITY
        assert payload.health_state == HealthState.GOOD
        assert "AUTH FAILURES" in payload.alert_context


class TestStrictAllowListValidation:
    """Test that Pydantic extra='forbid' rejects ANY unapproved field."""

    def test_valid_payload_accepted(self):
        valid_payload = {
            "payload_id": str(create_payload_id()),
            "tenant_id": "tenant_acme_corp",
            "collector_id": "coll_us_east_1_003",
            "source_id": "src_7f3a2b",
            "event_timestamp": "2026-11-20T14:30:00.123Z",
            "source_timezone": "America/New_York",
            "region_id": "us-east-1",
            "cpu_pct": 50.0,
            "event_category": "INFRA",
            "severity": "INFO",
            "health_state": "EXCELLENT",
        }
        payload = validate_payload(json.dumps(valid_payload))
        assert isinstance(payload, TelemetryPayload)

    def test_extra_field_rejected(self):
        """Any field not in schema MUST be rejected."""
        invalid_payload = {
            "payload_id": str(create_payload_id()),
            "tenant_id": "tenant_acme_corp",
            "collector_id": "coll_us_east_1_003",
            "source_id": "src_7f3a2b",
            "event_timestamp": "2026-11-20T14:30:00.123Z",
            "source_timezone": "America/New_York",
            "region_id": "us-east-1",
            "event_category": "INFRA",
            "severity": "INFO",
            "health_state": "EXCELLENT",
            "unapproved_field": "must_fail",  # This should cause rejection
        }
        with pytest.raises(Exception) as exc_info:
            validate_payload(json.dumps(invalid_payload))
        # Pydantic v2 raises ValidationError for extra fields
        assert "extra" in str(exc_info.value).lower() or "unapproved_field" in str(exc_info.value)

    def test_raw_log_field_rejected(self):
        """raw_log must never cross boundary."""
        invalid_payload = {
            "payload_id": str(create_payload_id()),
            "tenant_id": "tenant_acme_corp",
            "collector_id": "coll_us_east_1_003",
            "source_id": "src_7f3a2b",
            "event_timestamp": "2026-11-20T14:30:00.123Z",
            "source_timezone": "America/New_York",
            "region_id": "us-east-1",
            "event_category": "INFRA",
            "severity": "INFO",
            "health_state": "EXCELLENT",
            "raw_log": "GET /api/users 200 15ms",  # FORBIDDEN
        }
        with pytest.raises(Exception):
            validate_payload(json.dumps(invalid_payload))

    def test_password_field_rejected(self):
        """password field must never cross boundary."""
        invalid_payload = {
            "payload_id": str(create_payload_id()),
            "tenant_id": "tenant_acme_corp",
            "collector_id": "coll_us_east_1_003",
            "source_id": "src_7f3a2b",
            "event_timestamp": "2026-11-20T14:30:00.123Z",
            "source_timezone": "America/New_York",
            "region_id": "us-east-1",
            "event_category": "INFRA",
            "severity": "INFO",
            "health_state": "EXCELLENT",
            "password": "Secret123",  # FORBIDDEN
        }
        with pytest.raises(Exception):
            validate_payload(json.dumps(invalid_payload))

    def test_internal_ip_field_rejected(self):
        """Internal IP must never cross boundary (use source_id instead)."""
        invalid_payload = {
            "payload_id": str(create_payload_id()),
            "tenant_id": "tenant_acme_corp",
            "collector_id": "coll_us_east_1_003",
            "source_id": "src_7f3a2b",
            "event_timestamp": "2026-11-20T14:30:00.123Z",
            "source_timezone": "America/New_York",
            "region_id": "us-east-1",
            "event_category": "INFRA",
            "severity": "INFO",
            "health_state": "EXCELLENT",
            "source_ip": "10.0.0.5",  # FORBIDDEN
        }
        with pytest.raises(Exception):
            validate_payload(json.dumps(invalid_payload))

    def test_hostname_field_rejected(self):
        """Hostname must never cross boundary (use source_id instead)."""
        invalid_payload = {
            "payload_id": str(create_payload_id()),
            "tenant_id": "tenant_acme_corp",
            "collector_id": "coll_us_east_1_003",
            "source_id": "src_7f3a2b",
            "event_timestamp": "2026-11-20T14:30:00.123Z",
            "source_timezone": "America/New_York",
            "region_id": "us-east-1",
            "event_category": "INFRA",
            "severity": "INFO",
            "health_state": "EXCELLENT",
            "hostname": "prod-db-01.internal",  # FORBIDDEN
        }
        with pytest.raises(Exception):
            validate_payload(json.dumps(invalid_payload))


class TestZeroSecretLeakage:
    """Comprehensive test: pass raw log with secrets through full pipeline → assert zero leakage."""

    def test_full_pipeline_zero_secret_leakage(self):
        """
        THE MANDATORY TEST: Raw log with fake API key, password, internal IP
        passes through redaction + allow-list → output JSON has ZERO secrets.
        """
        # Simulated raw log from a collector (e.g., nginx access log with embedded creds)
        raw_log = (
            '10.0.0.5 - - [20/Nov/2026:14:30:00 +0000] '
            '"POST /api/login HTTP/1.1" 200 1234 '
            'password=SuperSecret123 api_key=sk_live_abc123xyz '
            'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake.signature '
            'user=admin@company.com'
        )

        # Step 1: Scrub secrets
        scrubbed = scrub_secrets(raw_log)
        assert "[REDACTED_PASSWORD]" in scrubbed.scrubbed_text
        assert "[REDACTED_API_KEY]" in scrubbed.scrubbed_text
        assert "[REDACTED_JWT]" in scrubbed.scrubbed_text
        assert "[REDACTED_EMAIL]" in scrubbed.scrubbed_text
        assert "[REDACTED_IPV4]" in scrubbed.scrubbed_text
        assert "SuperSecret123" not in scrubbed.scrubbed_text
        assert "sk_live_abc123xyz" not in scrubbed.scrubbed_text
        assert "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" not in scrubbed.scrubbed_text
        assert "admin@company.com" not in scrubbed.scrubbed_text
        assert "10.0.0.5" not in scrubbed.scrubbed_text

        # Step 2: Simulate raw data dict (as collector would parse)
        raw_data = {
            "cpu_pct": 65.0,
            "mem_pct": 72.0,
            "source_ip": "10.0.0.5",
            "hostname": "prod-web-01.internal",
            # These should NEVER appear in output:
            "password": "SuperSecret123",
            "api_key": "sk_live_abc123xyz",
            "raw_log": raw_log,
        }

        # Step 3: Extract allow-listed fields (full pipeline)
        payload = extract_allowlisted_fields(
            raw_data=raw_data,
            tenant_id="tenant_acme_corp",
            collector_id="coll_us_east_1_003",
            region_id="us-east-1",
            source_timezone="America/New_York",
            tenant_salt="tenant_acme_corp_salt",
        )

        # Step 4: Serialize to JSON (what crosses the wire)
        output_json = payload_to_json(payload)

        # ASSERTIONS: Zero secret leakage
        forbidden_strings = [
            "SuperSecret123",
            "sk_live_abc123xyz",
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
            "admin@company.com",
            "10.0.0.5",
            "prod-web-01.internal",
            "password",
            "api_key",
            "raw_log",
            "Authorization",
            "Bearer",
        ]

        for forbidden in forbidden_strings:
            assert forbidden not in output_json, f"SECRET LEAKAGE DETECTED: '{forbidden}' found in output JSON"

        # Verify required fields present
        assert "payload_id" in output_json
        assert "tenant_id" in output_json
        assert "tenant_acme_corp" in output_json
        assert "source_id" in output_json
        assert payload.source_id.startswith("src_")
        assert "cpu_pct" in output_json
        assert "65.0" in output_json
        assert "event_category" in output_json
        assert "INFRA" in output_json
        assert "health_state" in output_json

    def test_payload_serialization_excludes_none_metrics(self):
        """Optional metrics not present should be excluded from JSON (exclude_none=True)."""
        raw_data = {"cpu_pct": 50.0, "source_ip": "10.0.0.1"}
        payload = extract_allowlisted_fields(
            raw_data=raw_data,
            tenant_id="tenant_test",
            collector_id="coll_1",
            region_id="us-east-1",
            source_timezone="UTC",
            tenant_salt="salt",
        )
        json_str = payload_to_json(payload)
        # mem_pct, disk_pct, etc. should NOT appear
        assert "mem_pct" not in json_str
        assert "disk_pct" not in json_str
        assert "latency_ms" not in json_str


class TestEnumValidation:
    """Test that enums enforce valid values only."""

    def test_invalid_event_category_rejected(self):
        invalid = {
            "payload_id": str(create_payload_id()),
            "tenant_id": "t",
            "collector_id": "c",
            "source_id": "src_abc123",
            "event_timestamp": "2026-11-20T14:30:00.123Z",
            "source_timezone": "UTC",
            "region_id": "us-east-1",
            "event_category": "INVALID_CATEGORY",
            "severity": "INFO",
            "health_state": "EXCELLENT",
        }
        with pytest.raises(Exception):
            validate_payload(json.dumps(invalid))

    def test_invalid_severity_rejected(self):
        invalid = {
            "payload_id": str(create_payload_id()),
            "tenant_id": "t",
            "collector_id": "c",
            "source_id": "src_abc123",
            "event_timestamp": "2026-11-20T14:30:00.123Z",
            "source_timezone": "UTC",
            "region_id": "us-east-1",
            "event_category": "INFRA",
            "severity": "INVALID",
            "health_state": "EXCELLENT",
        }
        with pytest.raises(Exception):
            validate_payload(json.dumps(invalid))

    def test_invalid_health_state_rejected(self):
        invalid = {
            "payload_id": str(create_payload_id()),
            "tenant_id": "t",
            "collector_id": "c",
            "source_id": "src_abc123",
            "event_timestamp": "2026-11-20T14:30:00.123Z",
            "source_timezone": "UTC",
            "region_id": "us-east-1",
            "event_category": "INFRA",
            "severity": "INFO",
            "health_state": "UNKNOWN",
        }
        with pytest.raises(Exception):
            validate_payload(json.dumps(invalid))


class TestMetricRanges:
    """Test metric value constraints."""

    def test_cpu_pct_bounds(self):
        base = {
            "payload_id": str(create_payload_id()),
            "tenant_id": "t",
            "collector_id": "c",
            "source_id": "src_abc123",
            "event_timestamp": "2026-11-20T14:30:00.123Z",
            "source_timezone": "UTC",
            "region_id": "us-east-1",
            "event_category": "INFRA",
            "severity": "INFO",
            "health_state": "EXCELLENT",
        }
        # Valid
        payload = {**base, "cpu_pct": 0.0}
        validate_payload(json.dumps(payload))
        payload = {**base, "cpu_pct": 100.0}
        validate_payload(json.dumps(payload))
        # Invalid
        payload = {**base, "cpu_pct": -1.0}
        with pytest.raises(Exception):
            validate_payload(json.dumps(payload))
        payload = {**base, "cpu_pct": 101.0}
        with pytest.raises(Exception):
            validate_payload(json.dumps(payload))

    def test_packet_loss_bounds(self):
        base = {
            "payload_id": str(create_payload_id()),
            "tenant_id": "t",
            "collector_id": "c",
            "source_id": "src_abc123",
            "event_timestamp": "2026-11-20T14:30:00.123Z",
            "source_timezone": "UTC",
            "region_id": "us-east-1",
            "event_category": "NETWORK",
            "severity": "INFO",
            "health_state": "EXCELLENT",
        }
        payload = {**base, "packet_loss_pct": 0.0}
        validate_payload(json.dumps(payload))
        payload = {**base, "packet_loss_pct": 100.0}
        validate_payload(json.dumps(payload))
        payload = {**base, "packet_loss_pct": -0.1}
        with pytest.raises(Exception):
            validate_payload(json.dumps(payload))
        payload = {**base, "packet_loss_pct": 100.1}
        with pytest.raises(Exception):
            validate_payload(json.dumps(payload))


class TestAlertContextValidation:
    """Test alert_context constraints."""

    def test_alert_context_max_length(self):
        base = {
            "payload_id": str(create_payload_id()),
            "tenant_id": "t",
            "collector_id": "c",
            "source_id": "src_abc123",
            "event_timestamp": "2026-11-20T14:30:00.123Z",
            "source_timezone": "UTC",
            "region_id": "us-east-1",
            "event_category": "INFRA",
            "severity": "INFO",
            "health_state": "EXCELLENT",
        }
        # Valid: 280 chars
        payload = {**base, "alert_context": "x" * 280}
        validate_payload(json.dumps(payload))
        # Invalid: 281 chars
        payload = {**base, "alert_context": "x" * 281}
        with pytest.raises(Exception):
            validate_payload(json.dumps(payload))

    def test_alert_context_rejects_secrets(self):
        base = {
            "payload_id": str(create_payload_id()),
            "tenant_id": "t",
            "collector_id": "c",
            "source_id": "src_abc123",
            "event_timestamp": "2026-11-20T14:30:00.123Z",
            "source_timezone": "UTC",
            "region_id": "us-east-1",
            "event_category": "INFRA",
            "severity": "INFO",
            "health_state": "EXCELLENT",
        }
        payload = {**base, "alert_context": "password=Secret123"}
        with pytest.raises(Exception) as exc_info:
            validate_payload(json.dumps(payload))
        assert "secret" in str(exc_info.value).lower() or "credential" in str(exc_info.value).lower()


class TestTimestampValidation:
    """Test UTC timestamp enforcement."""

    def test_naive_timestamp_rejected(self):
        base = {
            "payload_id": str(create_payload_id()),
            "tenant_id": "t",
            "collector_id": "c",
            "source_id": "src_abc123",
            "event_timestamp": "2026-11-20T14:30:00.123",  # No timezone
            "source_timezone": "UTC",
            "region_id": "us-east-1",
            "event_category": "INFRA",
            "severity": "INFO",
            "health_state": "EXCELLENT",
        }
        with pytest.raises(Exception) as exc_info:
            validate_payload(json.dumps(base))
        assert "timezone" in str(exc_info.value).lower()

    def test_utc_timestamp_accepted(self):
        base = {
            "payload_id": str(create_payload_id()),
            "tenant_id": "t",
            "collector_id": "c",
            "source_id": "src_abc123",
            "source_timezone": "UTC",
            "region_id": "us-east-1",
            "event_category": "INFRA",
            "severity": "INFO",
            "health_state": "EXCELLENT",
        }
        # UTC with Z
        payload = {**base, "event_timestamp": "2026-11-20T14:30:00.123Z"}
        validate_payload(json.dumps(payload))
        # UTC with +00:00
        payload = {**base, "event_timestamp": "2026-11-20T14:30:00.123+00:00"}
        validate_payload(json.dumps(payload))
        # Non-UTC but timezone-aware (should normalize)
        payload = {**base, "event_timestamp": "2026-11-20T09:30:00.123-05:00"}
        validated = validate_payload(json.dumps(payload))
        assert validated.event_timestamp.utcoffset().total_seconds() == 0


class TestEgressProofPanel:
    """Test the immutable audit log."""

    def test_logs_payload_before_egress(self, tmp_path):
        panel = EgressProofPanel(tmp_path / "egress.log")
        payload = TelemetryPayload(
            payload_id=create_payload_id(),
            tenant_id="tenant_test",
            collector_id="coll_1",
            source_id="src_abc123",
            event_timestamp="2026-11-20T14:30:00.123Z",
            source_timezone="UTC",
            region_id="us-east-1",
            event_category=EventCategory.INFRA,
            severity=Severity.INFO,
            health_state=HealthState.EXCELLENT,
        )
        panel.log_egress(payload)
        entries = panel.get_recent(1)
        assert len(entries) == 1
        assert str(payload.payload_id) in entries[0]
        assert payload.tenant_id in entries[0]

    def test_verifies_payload_id(self, tmp_path):
        panel = EgressProofPanel(tmp_path / "egress.log")
        payload = TelemetryPayload(
            payload_id=create_payload_id(),
            tenant_id="tenant_test",
            collector_id="coll_1",
            source_id="src_abc123",
            event_timestamp="2026-11-20T14:30:00.123Z",
            source_timezone="UTC",
            region_id="us-east-1",
            event_category=EventCategory.INFRA,
            severity=Severity.INFO,
            health_state=HealthState.EXCELLENT,
        )
        panel.log_egress(payload)
        assert panel.verify_payload_id(payload.payload_id) is True
        # Non-existent ID
        from uuid import uuid4
        assert panel.verify_payload_id(uuid4()) is False


if __name__ == "__main__":
    pytest.main([__file__, "-v"])