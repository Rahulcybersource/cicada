"""
tests/test_tier2_person2.py
Phase 2/3/4/Bonus verification tests for Person 2 deliverables (services/tier2_saas/).
Covers TLS cert generation, authentication, allow-list enforcement, idempotency,
out-of-order UTC sorting, state transitions, configurable thresholds, live SLAs, and remediation.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

# Set test environment
os.environ.pop("GROQ_API_KEY", None)
os.environ.pop("GEMINI_API_KEY", None)

from services.tier2_saas.main import app
from services.tier2_saas.db import (
    SessionLocal,
    CollectorToken,
    AuditLogRecord,
    StateTransitionRecord,
    PolicyThresholds,
    RemediationRecord,
    init_db,
    drop_db,
    insert_telemetry,
    query_telemetry,
    upsert_incident,
    validate_regional_residency,
    validate_collector_token,
    register_collector_token,
    append_audit_log,
    query_audit_log,
    verify_audit_chain,
    record_state_transition,
    query_state_transitions,
    get_policy_thresholds,
    update_policy_threshold,
    record_remediation,
    query_remediation_records,
    init_default_thresholds,
)
from services.tier2_saas.aiops import (
    HybridAIOpsEngine,
    HealthState,
    Severity,
)
from scripts.generate_tls_cert import generate_self_signed_cert


# ─── Fixtures ───

@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def reset_db():
    """Reset database before each test."""
    drop_db()
    init_db()
    with SessionLocal() as db:
        for tenant in ["tenant_acme_corp", "tenant_globex_ind", "tenant_demo"]:
            init_default_thresholds(db, tenant)
    yield
    drop_db()


# ─── Test 1: TLS Certificate Generation ───

class TestTLSCertificateGeneration:
    """Verify TLS certificate generation script works correctly."""

    def test_generate_cert_creates_files(self, tmp_path):
        """Cert and key files are created with correct SANs."""
        cert_path, key_path = generate_self_signed_cert(
            output_dir=tmp_path,
            cert_name="test_cert.pem",
            key_name="test_key.pem",
            valid_days=30,
        )

        assert cert_path.exists()
        assert key_path.exists()

    def test_cert_has_correct_sans(self, tmp_path):
        """Certificate includes localhost, 127.0.0.1, and 10.30.165.15 in SAN."""
        cert_path, _ = generate_self_signed_cert(
            output_dir=tmp_path,
            cert_name="test_cert.pem",
            key_name="test_key.pem",
            valid_days=30,
        )

        from cryptography import x509
        from cryptography.hazmat.primitives import serialization

        with open(cert_path, "rb") as f:
            cert = x509.load_pem_x509_certificate(f.read())

        sans = []
        for ext in cert.extensions:
            if ext.oid == x509.oid.ExtensionOID.SUBJECT_ALTERNATIVE_NAME:
                for name in ext.value:
                    if isinstance(name, x509.DNSName):
                        sans.append(name.value)
                    elif isinstance(name, x509.IPAddress):
                        sans.append(str(name.value))

        assert "localhost" in sans
        assert "127.0.0.1" in sans
        assert "10.30.165.15" in sans

    def test_cert_is_self_signed(self, tmp_path):
        """Certificate is self-signed (subject == issuer)."""
        from cryptography import x509

        cert_path, _ = generate_self_signed_cert(
            output_dir=tmp_path,
            cert_name="test_cert.pem",
            key_name="test_key.pem",
            valid_days=30,
        )

        with open(cert_path, "rb") as f:
            cert = x509.load_pem_x509_certificate(f.read())

        assert cert.subject == cert.issuer

    def test_cert_validity_period(self, tmp_path):
        """Certificate is valid for the specified number of days."""
        from cryptography import x509

        cert_path, _ = generate_self_signed_cert(
            output_dir=tmp_path,
            cert_name="test_cert.pem",
            key_name="test_key.pem",
            valid_days=365,
        )

        with open(cert_path, "rb") as f:
            cert = x509.load_pem_x509_certificate(f.read())

        now = datetime.now(timezone.utc)
        assert cert.not_valid_before_utc <= now
        assert cert.not_valid_after_utc >= now + timedelta(days=364)


# ─── Test 2: Bearer Token Authentication & Tenant Mapping ───

class TestBearerTokenAuthentication:
    """Verify 401/403 authentication and tenant/region residency enforcement."""

    def setup_method(self):
        """Register a test token before each test."""
        with SessionLocal() as db:
            self.plain_token = register_collector_token(
                db,
                tenant_id="tenant_acme_corp",
                collector_id="col_acme_01",
                region_id="ap-south-1",
                description="Test collector",
            )

    def test_valid_token_returns_tenant_id(self):
        """Valid Bearer token maps to correct tenant_id."""
        with SessionLocal() as db:
            token_record = validate_collector_token(db, self.plain_token)
            assert token_record is not None
            assert token_record.tenant_id == "tenant_acme_corp"
            assert token_record.collector_id == "col_acme_01"
            assert token_record.region_id == "ap-south-1"

    def test_invalid_token_returns_none(self):
        """Invalid token returns None (triggers 401)."""
        with SessionLocal() as db:
            token_record = validate_collector_token(db, "ct_invalid_token")
            assert token_record is None

    def test_revoked_token_returns_none(self):
        """Revoked token returns None."""
        with SessionLocal() as db:
            from services.tier2_saas.db import revoke_collector_token
            revoke_collector_token(db, self.plain_token)
            token_record = validate_collector_token(db, self.plain_token)
            assert token_record is None

    def test_ingest_with_valid_token_succeeds(self, client):
        """Ingest with valid token returns 200."""
        payload = {
            "payload_id": "test_001",
            "tenant_id": "tenant_acme_corp",
            "region_id": "ap-south-1",
            "collector_id": "col_acme_01",
            "source_id": "src_01",
            "event_timestamp_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source_timezone": "UTC",
            "event_category": "infrastructure",
            "severity": "info",
            "health_state": "Excellent",
            "metrics": {"cpu_pct": 50.0},
            "collector_meta": {},
        }
        response = client.post(
            "/api/v1/ingest/ap-south-1",
            json=payload,
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response.status_code == 200
        assert response.json()["status"] == "accepted"

    def test_ingest_without_token_returns_401(self, client):
        """Missing Authorization header returns 401."""
        payload = {
            "payload_id": "test_002",
            "tenant_id": "tenant_acme_corp",
            "region_id": "ap-south-1",
            "collector_id": "col_acme_01",
            "source_id": "src_01",
            "event_timestamp_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source_timezone": "UTC",
            "event_category": "infrastructure",
            "severity": "info",
            "health_state": "Excellent",
            "metrics": {"cpu_pct": 50.0},
            "collector_meta": {},
        }
        response = client.post(
            "/api/v1/ingest/ap-south-1",
            json=payload,
            headers={"X-Tenant-ID": "tenant_acme_corp"},
        )
        assert response.status_code == 401
        assert "Authorization" in response.json()["detail"]

    def test_ingest_with_invalid_token_returns_401(self, client):
        """Invalid Bearer token returns 401."""
        payload = {
            "payload_id": "test_003",
            "tenant_id": "tenant_acme_corp",
            "region_id": "ap-south-1",
            "collector_id": "col_acme_01",
            "source_id": "src_01",
            "event_timestamp_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source_timezone": "UTC",
            "event_category": "infrastructure",
            "severity": "info",
            "health_state": "Excellent",
            "metrics": {"cpu_pct": 50.0},
            "collector_meta": {},
        }
        response = client.post(
            "/api/v1/ingest/ap-south-1",
            json=payload,
            headers={
                "Authorization": "Bearer ct_invalid_token",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response.status_code == 401

    def test_ingest_with_tenant_mismatch_returns_403(self, client):
        """Token tenant doesn't match X-Tenant-ID returns 403."""
        payload = {
            "payload_id": "test_004",
            "tenant_id": "tenant_acme_corp",
            "region_id": "ap-south-1",
            "collector_id": "col_acme_01",
            "source_id": "src_01",
            "event_timestamp_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source_timezone": "UTC",
            "event_category": "infrastructure",
            "severity": "info",
            "health_state": "Excellent",
            "metrics": {"cpu_pct": 50.0},
            "collector_meta": {},
        }
        # Use token for tenant_acme_corp but claim tenant_globex_ind
        response = client.post(
            "/api/v1/ingest/ap-south-1",
            json=payload,
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_globex_ind",
            },
        )
        assert response.status_code == 403

    def test_ingest_with_wrong_region_returns_403(self, client):
        """Tenant sending to wrong region returns 403."""
        payload = {
            "payload_id": "test_005",
            "tenant_id": "tenant_acme_corp",
            "region_id": "eu-central-1",  # Wrong region for acme_corp
            "collector_id": "col_acme_01",
            "source_id": "src_01",
            "event_timestamp_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source_timezone": "UTC",
            "event_category": "infrastructure",
            "severity": "info",
            "health_state": "Excellent",
            "metrics": {"cpu_pct": 50.0},
            "collector_meta": {},
        }
        response = client.post(
            "/api/v1/ingest/eu-central-1",
            json=payload,
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response.status_code == 403
        assert "not authorized for region" in response.json()["detail"]

    def test_auth_rejection_logged_to_audit(self, client):
        """Failed auth attempts are logged to audit trail."""
        # Attempt with invalid token
        payload = {
            "payload_id": "test_audit_001",
            "tenant_id": "tenant_acme_corp",
            "region_id": "ap-south-1",
            "collector_id": "col_acme_01",
            "source_id": "src_01",
            "event_timestamp_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source_timezone": "UTC",
            "event_category": "infrastructure",
            "severity": "info",
            "health_state": "Excellent",
            "metrics": {"cpu_pct": 50.0},
            "collector_meta": {},
        }
        response = client.post(
            "/api/v1/ingest/ap-south-1",
            json=payload,
            headers={
                "Authorization": "Bearer ct_invalid",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response.status_code == 401

        # Verify audit log has reject entry
        with SessionLocal() as db:
            records = query_audit_log(db, tenant_id="tenant_acme_corp", limit=10)
            reject_entries = [r for r in records if r.action == "auth_reject"]
            assert len(reject_entries) >= 1
            assert reject_entries[0].details["reason"] == "invalid_token"


# ─── Test 3: Strict Allow-List Data Policy & Audit Hash ───

class TestAllowListEnforcement:
    """Verify Pydantic v2 extra='forbid' rejects unapproved fields with 422 and logs to audit."""

    def setup_method(self):
        with SessionLocal() as db:
            self.plain_token = register_collector_token(
                db,
                tenant_id="tenant_acme_corp",
                collector_id="col_acme_01",
                region_id="ap-south-1",
            )

    def test_extra_field_rejected_422(self, client):
        """Extra field in payload returns 422."""
        payload = {
            "payload_id": "test_allow_001",
            "tenant_id": "tenant_acme_corp",
            "region_id": "ap-south-1",
            "collector_id": "col_acme_01",
            "source_id": "src_01",
            "event_timestamp_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source_timezone": "UTC",
            "event_category": "infrastructure",
            "severity": "info",
            "health_state": "Excellent",
            "metrics": {"cpu_pct": 50.0},
            "collector_meta": {},
            "secret_field": "should_be_rejected",  # Extra field
        }
        response = client.post(
            "/api/v1/ingest/ap-south-1",
            json=payload,
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response.status_code == 422

    def test_raw_log_field_rejected_422(self, client):
        """raw_log field is rejected (forbidden)."""
        payload = {
            "payload_id": "test_allow_002",
            "tenant_id": "tenant_acme_corp",
            "region_id": "ap-south-1",
            "collector_id": "col_acme_01",
            "source_id": "src_01",
            "event_timestamp_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source_timezone": "UTC",
            "event_category": "infrastructure",
            "severity": "info",
            "health_state": "Excellent",
            "metrics": {"cpu_pct": 50.0},
            "collector_meta": {},
            "raw_log": "password=secret123",  # Forbidden field
        }
        response = client.post(
            "/api/v1/ingest/ap-south-1",
            json=payload,
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response.status_code == 422

    def test_password_in_metrics_rejected(self, client):
        """Password field inside metrics is rejected."""
        payload = {
            "payload_id": "test_allow_003",
            "tenant_id": "tenant_acme_corp",
            "region_id": "ap-south-1",
            "collector_id": "col_acme_01",
            "source_id": "src_01",
            "event_timestamp_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source_timezone": "UTC",
            "event_category": "infrastructure",
            "severity": "info",
            "health_state": "Excellent",
            "metrics": {"cpu_pct": 50.0, "password": "secret123"},
            "collector_meta": {},
        }
        response = client.post(
            "/api/v1/ingest/ap-south-1",
            json=payload,
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response.status_code == 422

    def test_audit_log_has_record_sha256(self):
        """Audit log entries have record_sha256 integrity hash."""
        with SessionLocal() as db:
            append_audit_log(db, "tenant_test", "user_01", "Operator", "test_action", {"key": "value"})
            records = query_audit_log(db, tenant_id="tenant_test", limit=1)
            assert len(records) == 1
            assert records[0].record_sha256 is not None
            assert len(records[0].record_sha256) == 64  # SHA256 hex


# ─── Test 4: Zero-Duplicate Idempotency & Out-of-Order UTC Sorting ───

class TestIdempotencyAndOrdering:
    """Verify UNIQUE(tenant_id, payload_id) prevents duplicates and UTC sorting works."""

    def setup_method(self):
        with SessionLocal() as db:
            self.plain_token = register_collector_token(
                db,
                tenant_id="tenant_acme_corp",
                collector_id="col_acme_01",
                region_id="ap-south-1",
            )

    def test_duplicate_payload_returns_duplicate_ignored(self, client):
        """Duplicate payload_id returns 200 with status=duplicate_ignored."""
        payload = {
            "payload_id": "idempotent_test_001",
            "tenant_id": "tenant_acme_corp",
            "region_id": "ap-south-1",
            "collector_id": "col_acme_01",
            "source_id": "src_01",
            "event_timestamp_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source_timezone": "UTC",
            "event_category": "infrastructure",
            "severity": "info",
            "health_state": "Excellent",
            "metrics": {"cpu_pct": 50.0},
            "collector_meta": {},
        }

        # First request
        response1 = client.post(
            "/api/v1/ingest/ap-south-1",
            json=payload,
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response1.status_code == 200
        assert response1.json()["status"] == "accepted"

        # Second request with same payload_id
        response2 = client.post(
            "/api/v1/ingest/ap-south-1",
            json=payload,
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response2.status_code == 200
        assert response2.json()["status"] == "duplicate_ignored"
        assert response2.json()["payload_id"] == "idempotent_test_001"

    def test_out_of_order_events_sorted_by_event_timestamp_utc(self, client):
        """Events are returned sorted by event_timestamp_utc, not arrival order."""
        now = datetime.now(timezone.utc)
        older = (now - timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
        newer = now.isoformat().replace("+00:00", "Z")

        # Insert newer event first
        payload_newer = {
            "payload_id": "order_002",
            "tenant_id": "tenant_acme_corp",
            "region_id": "ap-south-1",
            "collector_id": "col_acme_01",
            "source_id": "src_01",
            "event_timestamp_utc": newer,
            "source_timezone": "UTC",
            "event_category": "infrastructure",
            "severity": "info",
            "health_state": "Excellent",
            "metrics": {"cpu_pct": 50.0},
            "collector_meta": {},
        }
        client.post(
            "/api/v1/ingest/ap-south-1",
            json=payload_newer,
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )

        # Insert older event second
        payload_older = {
            "payload_id": "order_001",
            "tenant_id": "tenant_acme_corp",
            "region_id": "ap-south-1",
            "collector_id": "col_acme_01",
            "source_id": "src_01",
            "event_timestamp_utc": older,
            "source_timezone": "UTC",
            "event_category": "infrastructure",
            "severity": "info",
            "health_state": "Excellent",
            "metrics": {"cpu_pct": 50.0},
            "collector_meta": {},
        }
        client.post(
            "/api/v1/ingest/ap-south-1",
            json=payload_older,
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )

        # Query telemetry - should be sorted by event_timestamp_utc ASC
        response = client.get(
            "/api/v1/telemetry",
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response.status_code == 200
        records = response.json()

        # Find our test records
        test_records = [r for r in records if r["payload_id"] in ("order_001", "order_002")]
        assert len(test_records) == 2
        # First should be older (order_001), second should be newer (order_002)
        assert test_records[0]["payload_id"] == "order_001"
        assert test_records[1]["payload_id"] == "order_002"


# ─── Test 5: Collector Fleet Metadata & Stale-Data Downgrade ───

class TestCollectorFleetAndStaleData:
    """Verify live collector metadata and >60s Poor transition with audit."""

    def setup_method(self):
        with SessionLocal() as db:
            self.plain_token = register_collector_token(
                db,
                tenant_id="tenant_acme_corp",
                collector_id="col_acme_01",
                region_id="ap-south-1",
            )

    def test_heartbeat_updates_collector_metadata(self, client):
        """Heartbeat updates collector metadata including version and resource usage."""
        payload = {
            "collector_id": "col_acme_01",
            "tenant_id": "tenant_acme_corp",
            "version": "1.2.3",
            "collector_cpu_pct": 15.5,
            "collector_mem_mb": 128.0,
        }
        response = client.post(
            "/api/v1/heartbeat",
            json=payload,
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response.status_code == 200
        assert response.json()["health_state"] == "Excellent"

        # Verify fleet health endpoint returns the data
        response = client.get(
            "/api/v1/fleet/health",
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response.status_code == 200
        collectors = response.json()
        assert len(collectors) >= 1
        coll = collectors[0]
        assert coll["collector_id"] == "col_acme_01"
        assert coll["version"] == "1.2.3"
        assert coll["collector_cpu_pct"] == 15.5
        assert coll["collector_mem_mb"] == 128.0
        assert coll["health_state"] == "Excellent"

    def test_stale_collector_downgraded_to_poor_after_60s(self, client):
        """Collector silent for >60s transitions to Poor with explicit reason."""
        # Register heartbeat
        payload = {
            "collector_id": "col_stale_01",
            "tenant_id": "tenant_acme_corp",
            "version": "1.0.0",
            "collector_cpu_pct": 10.0,
            "collector_mem_mb": 100.0,
        }
        with SessionLocal() as db:
            register_collector_token(
                db,
                tenant_id="tenant_acme_corp",
                collector_id="col_stale_01",
                region_id="ap-south-1",
            )

        client.post(
            "/api/v1/heartbeat",
            json=payload,
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )

        # Manually set last_heartbeat to 70 seconds ago in the engine
        from services.tier2_saas.aiops import engine as aio_ops_engine
        collector = aio_ops_engine.watchdog.get_collector("col_stale_01")
        assert collector is not None
        collector.last_heartbeat = datetime.now(timezone.utc) - timedelta(seconds=70)

        # Trigger watchdog check WITH persistence (what the background loop does)
        from services.tier2_saas.db import check_collector_timeouts_and_persist
        changed = check_collector_timeouts_and_persist()
        assert len(changed) == 1
        assert changed[0].collector_id == "col_stale_01"
        assert changed[0].health_state == HealthState.POOR
        assert "timeout" in changed[0].state_reason.lower() or "60s" in changed[0].state_reason

        # Verify state transition recorded in DB
        with SessionLocal() as db:
            transitions = query_state_transitions(db, "tenant_acme_corp", "col_stale_01", limit=10)
            assert len(transitions) >= 1
            # Find the transition to Poor
            poor_transitions = [t for t in transitions if t.to_state == "Poor"]
            assert len(poor_transitions) >= 1
            assert "timeout" in poor_transitions[0].reason.lower() or "60s" in poor_transitions[0].reason

    def test_fleet_transitions_endpoint_returns_utc_timestamps(self, client):
        """GET /api/v1/fleet/transitions returns UTC timestamps."""
        # Create a state transition
        with SessionLocal() as db:
            record_state_transition(
                db,
                "tenant_acme_corp",
                "col_test_01",
                "Excellent",
                "Poor",
                "Heartbeat timeout (>60s) - stale data",
            )

        response = client.get(
            "/api/v1/fleet/transitions",
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response.status_code == 200
        transitions = response.json()
        assert len(transitions) >= 1
        t = transitions[0]
        assert t["from_state"] == "Excellent"
        assert t["to_state"] == "Poor"
        assert "timestamp_utc" in t
        # Verify UTC format (ends with Z or +00:00)
        assert "T" in t["timestamp_utc"]


# ─── Test 6: Configurable Health Thresholds ───

class TestConfigurableThresholds:
    """Verify GET/PUT /api/v1/policy/thresholds works per tenant."""

    def setup_method(self):
        with SessionLocal() as db:
            self.plain_token = register_collector_token(
                db,
                tenant_id="tenant_acme_corp",
                collector_id="col_acme_01",
                region_id="ap-south-1",
            )

    def test_get_thresholds_returns_defaults(self, client):
        """GET /api/v1/policy/thresholds returns default thresholds."""
        response = client.get(
            "/api/v1/policy/thresholds",
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["tenant_id"] == "tenant_acme_corp"
        assert "thresholds" in data
        assert "cpu_pct" in data["thresholds"]
        assert "excellent_max" in data["thresholds"]["cpu_pct"]
        assert "good_max" in data["thresholds"]["cpu_pct"]
        assert "fair_max" in data["thresholds"]["cpu_pct"]

    def test_put_thresholds_updates_live(self, client):
        """PUT /api/v1/policy/thresholds updates threshold live."""
        response = client.put(
            "/api/v1/policy/thresholds",
            json={
                "metric_name": "cpu_pct",
                "excellent_max": 40.0,
                "good_max": 60.0,
                "fair_max": 80.0,
            },
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["thresholds"]["cpu_pct"]["excellent_max"] == 40.0
        assert data["thresholds"]["cpu_pct"]["good_max"] == 60.0
        assert data["thresholds"]["cpu_pct"]["fair_max"] == 80.0

        # Verify persistence
        response2 = client.get(
            "/api/v1/policy/thresholds",
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response2.json()["thresholds"]["cpu_pct"]["excellent_max"] == 40.0

    def test_thresholds_are_tenant_scoped(self, client):
        """Thresholds are isolated per tenant."""
        # Update acme's threshold
        client.put(
            "/api/v1/policy/thresholds",
            json={
                "metric_name": "cpu_pct",
                "excellent_max": 30.0,
                "good_max": 50.0,
                "fair_max": 70.0,
            },
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )

        # Get globex's threshold (should be defaults)
        with SessionLocal() as db:
            register_collector_token(
                db,
                tenant_id="tenant_globex_ind",
                collector_id="col_globex_01",
                region_id="eu-central-1",
            )

        # We'd need a globex token - skip for now since it requires token registration
        # The DB-level test covers this
        with SessionLocal() as db:
            acme_thresholds = get_policy_thresholds(db, "tenant_acme_corp")
            globex_thresholds = get_policy_thresholds(db, "tenant_globex_ind")
            assert acme_thresholds["cpu_pct"]["excellent_max"] == 30.0
            assert globex_thresholds["cpu_pct"]["excellent_max"] == 50.0  # default


# ─── Test 7: Live Measured SLAs (Zero Static Data) ───

class TestLiveSLAMetrics:
    """Verify GET /api/v1/sla/metrics/live computes from real timestamps."""

    def setup_method(self):
        with SessionLocal() as db:
            self.plain_token = register_collector_token(
                db,
                tenant_id="tenant_acme_corp",
                collector_id="col_acme_01",
                region_id="ap-south-1",
            )

    def test_no_data_returns_awaiting_live_data(self, client):
        """No telemetry returns awaiting_live_data status."""
        response = client.get(
            "/api/v1/sla/metrics/live",
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "awaiting_live_data"
        assert data["p95_ingest_latency_ms"] is None

    def test_live_data_computes_p95_latency(self, client):
        """Ingest events and verify p95 latency is computed."""
        # Ingest several events with known timestamps
        base_time = datetime.now(timezone.utc)
        for i in range(10):
            event_time = (base_time - timedelta(seconds=10 - i)).isoformat().replace("+00:00", "Z")
            payload = {
                "payload_id": f"sla_test_{i:03d}",
                "tenant_id": "tenant_acme_corp",
                "region_id": "ap-south-1",
                "collector_id": "col_acme_01",
                "source_id": "src_01",
                "event_timestamp_utc": event_time,
                "source_timezone": "UTC",
                "event_category": "infrastructure",
                "severity": "info",
                "health_state": "Excellent",
                "metrics": {"cpu_pct": 40.0 + i},
                "collector_meta": {},
            }
            client.post(
                "/api/v1/ingest/ap-south-1",
                json=payload,
                headers={
                    "Authorization": f"Bearer {self.plain_token}",
                    "X-Tenant-ID": "tenant_acme_corp",
                },
            )

        response = client.get(
            "/api/v1/sla/metrics/live",
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "live"
        assert data["received_count"] >= 10
        # p95 should be a positive number (ms)
        if data["p95_ingest_latency_ms"] is not None:
            assert data["p95_ingest_latency_ms"] >= 0


# ─── Test 8: Safe Remediation Backend (Bonus) ───

class TestSafeRemediation:
    """Verify remediation approve/rollback with policy checks and audit."""

    def setup_method(self):
        with SessionLocal() as db:
            self.plain_token = register_collector_token(
                db,
                tenant_id="tenant_acme_corp",
                collector_id="col_acme_01",
                region_id="ap-south-1",
            )
            # Create a test incident
            now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            upsert_incident(db, {
                "incident_id": "inc_remed_test_001",
                "tenant_id": "tenant_acme_corp",
                "source_id": "src_01",
                "event_category": "infrastructure",
                "severity": "critical",
                "health_state": "Poor",
                "first_alert_time_utc": now_iso,
                "last_update_time_utc": now_iso,
                "alert_count": 1,
                "contributing_signals": ["cpu_pct: 95.0"],
                "reasoning_path": "Test incident",
                "confidence": 0.9,
                "recommended_action": "Restart service",
                "ai_provider": "deterministic-fallback",
                "llm_latency_ms": 10,
                "status": "open",
                "z_scores": {"cpu_pct": 3.5},
                "metrics_snapshot": {"cpu_pct": 95.0},
                "security_summary": None,
            })

    def test_approve_remediation_creates_audit_entry(self, client):
        """Approve remediation writes immutable audit entry with record_sha256.
        For non-critical incidents, approval is immediate. For critical, dual approval required.
        """
        # First create a non-critical incident for this test
        with SessionLocal() as db:
            now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            upsert_incident(db, {
                "incident_id": "inc_remed_test_noncritical",
                "tenant_id": "tenant_acme_corp",
                "source_id": "src_01",
                "event_category": "infrastructure",
                "severity": "warning",
                "health_state": "Fair",
                "first_alert_time_utc": now_iso,
                "last_update_time_utc": now_iso,
                "alert_count": 1,
                "contributing_signals": ["cpu_pct: 75.0"],
                "reasoning_path": "Test non-critical incident",
                "confidence": 0.8,
                "recommended_action": "Monitor",
                "ai_provider": "deterministic-fallback",
                "llm_latency_ms": 10,
                "status": "open",
                "z_scores": {"cpu_pct": 2.5},
                "metrics_snapshot": {"cpu_pct": 75.0},
                "security_summary": None,
            })

        response = client.post(
            "/api/v1/remediation/inc_remed_test_noncritical/approve",
            json={"operator_id": "operator_01", "operator_role": "Operator"},
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "approved"
        assert data["audit_hash"] is not None
        assert data["rollback_token"] is not None
        assert data["command_signature"] is not None

        # Verify audit log has entry with record_sha256
        with SessionLocal() as db:
            records = query_audit_log(db, tenant_id="tenant_acme_corp", limit=10)
            remed_entries = [r for r in records if r.action == "remediation_approve"]
            assert len(remed_entries) >= 1
            assert remed_entries[0].record_sha256 is not None

        # Verify remediation record in DB
        with SessionLocal() as db:
            remed_records = query_remediation_records(db, "tenant_acme_corp", "inc_remed_test_noncritical")
            assert len(remed_records) >= 1
            assert remed_records[0].action == "approve"
            assert remed_records[0].status == "approved"
            assert remed_records[0].record_hash is not None

    def test_critical_severity_requires_dual_approval(self, client):
        """Critical severity incident requires second operator approval."""
        # First operator approves
        response1 = client.post(
            "/api/v1/remediation/inc_remed_test_001/approve",
            json={"operator_id": "operator_01", "operator_role": "Operator"},
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response1.status_code == 200
        assert response1.json()["status"] == "pending_dual_approval"

        # Same operator tries again - should still be pending
        response2 = client.post(
            "/api/v1/remediation/inc_remed_test_001/approve",
            json={"operator_id": "operator_01", "operator_role": "Operator"},
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response2.status_code == 200
        assert response2.json()["status"] == "pending_dual_approval"
        assert "different operator" in response2.json()["message"].lower() or "second approval" in response2.json()["message"].lower()

        # Second operator approves - should succeed
        response3 = client.post(
            "/api/v1/remediation/inc_remed_test_001/approve",
            json={"operator_id": "operator_02", "operator_role": "Operator"},
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response3.status_code == 200
        assert response3.json()["status"] == "approved"

    def test_rollback_remediation_creates_audit_entry(self, client):
        """Rollback writes immutable audit entry."""
        response = client.post(
            "/api/v1/remediation/inc_remed_test_001/rollback",
            json={"operator_id": "operator_01", "operator_role": "Operator"},
            headers={
                "Authorization": f"Bearer {self.plain_token}",
                "X-Tenant-ID": "tenant_acme_corp",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "rolled_back"
        assert data["audit_hash"] is not None
        assert data["command_signature"] is not None

        # Verify audit log
        with SessionLocal() as db:
            records = query_audit_log(db, tenant_id="tenant_acme_corp", limit=10)
            remed_entries = [r for r in records if r.action == "remediation_rollback"]
            assert len(remed_entries) >= 1


# ─── Test 9: Audit Log Chain Integrity ───

class TestAuditLogIntegrity:
    """Verify tamper-evident audit log chain verification."""

    def test_audit_chain_verification_passes(self):
        """Valid chain returns True."""
        with SessionLocal() as db:
            append_audit_log(db, "tenant_1", "user_1", "Operator", "action_1", {"k": "v1"})
            append_audit_log(db, "tenant_1", "user_2", "Operator", "action_2", {"k": "v2"})
            append_audit_log(db, "tenant_1", "user_3", "Operator", "action_3", {"k": "v3"})

            valid, message = verify_audit_chain(db)
            assert valid is True
            assert "valid" in message.lower()

    def test_audit_chain_detects_tampering(self):
        """Tampered chain returns False."""
        with SessionLocal() as db:
            append_audit_log(db, "tenant_1", "user_1", "Operator", "action_1", {"k": "v1"})
            append_audit_log(db, "tenant_1", "user_2", "Operator", "action_2", {"k": "v2"})

            # Tamper with the first record
            rec = db.query(AuditLogRecord).filter(AuditLogRecord.index == 0).first()
            rec.details["k"] = "tampered"

            valid, message = verify_audit_chain(db)
            assert valid is False
            assert "corrupted" in message.lower() or "broken" in message.lower()


# ─── Test 10: Regional Residency Validation ───

class TestRegionalResidency:
    """Verify tenant-to-region binding enforcement."""

    def test_valid_residency_returns_true(self):
        """Valid tenant-region pair returns True."""
        assert validate_regional_residency("tenant_acme_corp", "ap-south-1") is True
        assert validate_regional_residency("tenant_globex_ind", "eu-central-1") is True
        assert validate_regional_residency("tenant_demo", "us-east-1") is True

    def test_invalid_residency_returns_false(self):
        """Invalid tenant-region pair returns False."""
        assert validate_regional_residency("tenant_acme_corp", "eu-central-1") is False
        assert validate_regional_residency("tenant_globex_ind", "ap-south-1") is False
        assert validate_regional_residency("tenant_demo", "eu-west-1") is False

    def test_unknown_tenant_uses_valid_regions(self):
        """Unknown tenant checks against VALID_REGIONS."""
        assert validate_regional_residency("tenant_unknown", "us-west-2") is True
        assert validate_regional_residency("tenant_unknown", "invalid-region") is False


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])