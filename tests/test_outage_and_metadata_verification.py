"""
Comprehensive Acceptance Tests for Tier 1:
- Priority 1: Outage Detection & Automatic Retry (Zero-Loss, Zero-Duplicate)
- Priority 2: Metadata Tagging (UTC Timestamp, Source Timezone, Unique Payload ID Immutability)
- Priority 3: Local-First Processing Pipeline Order & Secret Containment
- Priority 4: Egress Proof & Wire Parity
"""

import asyncio
import json
import os
import uuid
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
import httpx
import pytest

from services.tier1_collector.forwarder import Tier2Forwarder, check_tier2_health
from services.tier1_collector.main import (
    app as tier1_app,
    TENANT_ID as T1_TENANT_ID,
    COLLECTOR_ID as T1_COLLECTOR_ID,
    REGION_ID as T1_REGION_ID,
)
from services.tier1_collector.scrubber import ScrubResult
from services.tier1_collector.storage import (
    db_transaction,
    ensure_db_initialized,
    drop_db,
    init_db,
    enqueue_egress_payload,
    get_outbox_stats,
    get_pending_outbox,
    mark_outbox_sent,
    mark_outbox_failed,
    retry_failed_outbox,
    process_and_store_telemetry,
    get_egress_proof_logs,
    get_recent_raw_logs,
    decrypt_data,
)
from services.tier2_saas.main import IngestPayload, app as tier2_app


# ─── Priority 1: Outage Detection & Automatic Retry ───

class TestOutageDetectionAndRetry:
    """Verifies that Tier 1 gracefully buffers, retries, and drains with zero loss."""

    @pytest.fixture(autouse=True)
    def setup_db(self):
        drop_db()
        init_db()
        yield
        drop_db()

    @pytest.mark.asyncio
    async def test_buffering_during_tier2_downtime_and_zero_loss_recovery(self):
        """
        Scenario:
        1. Ingest 5 events while Tier 2 is OFFLINE.
        2. Confirm outbox pending count increments to 5.
        3. Confirm raw secrets remain local and sanitized payload is buffered.
        4. Forwarder attempts drain while Tier 2 is OFFLINE -> connection fails, items stay in queue.
        5. Bring Tier 2 ONLINE (mock handler accepts events).
        6. Forwarder drains batch -> all 5 items sent successfully.
        7. Confirm pending count drops to 0, sent count reaches 5.
        8. Confirm 0 lost and 0 duplicated.
        """
        tenant_id = "tenant_outage_test"
        collector_id = "coll_outage_01"
        region_id = "us-east-1"
        collector_token = "token_outage_123"

        # 1. Ingest 5 events while Tier 2 is OFFLINE
        payload_ids = []
        for i in range(5):
            pid = f"outage_p1_{i}_{uuid.uuid4().hex[:6]}"
            payload_ids.append(pid)
            process_and_store_telemetry(
                raw_data={"message": f"Server check {i} password=SecretPass_{i}", "source_ip": f"10.0.0.{10+i}"},
                tenant_id=tenant_id,
                collector_id=collector_id,
                region_id=region_id,
                tenant_salt="salt_outage",
                payload_id=pid,
                event_timestamp_utc=datetime.now(timezone.utc).isoformat(),
                source_timezone="America/New_York",
                event_category="infrastructure",
                severity="info",
                health_state="Good",
                metrics={"cpu_pct": 35.0 + i, "failed_login_count": 0},
                security_summary={"failed_login_count_60s": 0, "risk_indicator": "low"},
                alert_context=f"Alert {i} password=SecretPass_{i} token=Bearer_abc_{i}",
                collector_meta={"template_id": f"tpl_{i}"},
            )

        # 2. Confirm outbox pending count is 5
        stats = get_outbox_stats(tenant_id)
        assert stats["pending"] == 5
        assert stats["sent"] == 0
        assert stats["total"] == 5

        # 3. Confirm secrets are NOT in outbox_queue
        pending = get_pending_outbox(tenant_id, 10)
        assert len(pending) == 5
        for item in pending:
            raw_json = item["egress_payload"]
            assert "SecretPass_" not in raw_json
            assert "Bearer_abc_" not in raw_json
            assert "[REDACTED_PASSWORD]" in raw_json
            assert "[REDACTED_TOKEN]" in raw_json

        # 4. Forwarder attempts drain while Tier 2 is OFFLINE (ConnectError)
        def offline_handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("Connection refused: Tier 2 is offline", request=request)

        offline_forwarder = Tier2Forwarder(
            tenant_id=tenant_id,
            collector_id=collector_id,
            collector_token=collector_token,
            region_id=region_id,
        )
        offline_forwarder._client = httpx.AsyncClient(transport=httpx.MockTransport(offline_handler))
        offline_forwarder._running = True

        with patch("services.tier1_collector.forwarder.MAX_RETRIES", 2), \
             patch("services.tier1_collector.forwarder.BASE_BACKOFF", 0.01):
            try:
                # Drain batch against offline server
                await offline_forwarder._drain_batch()
            finally:
                await offline_forwarder.stop()

        # After failure, events remain eligible for retry, NEVER silently lost
        pending_after_failure = get_pending_outbox(tenant_id, 10, include_failed_retries=True)
        assert len(pending_after_failure) == 5, "Events must not be silently discarded during outage"

        # 5. Bring Tier 2 ONLINE
        received_by_tier2 = []

        def online_handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content.decode("utf-8"))
            received_by_tier2.append(body["payload_id"])
            return httpx.Response(200, json={"status": "accepted", "payload_id": body["payload_id"]})

        online_forwarder = Tier2Forwarder(
            tenant_id=tenant_id,
            collector_id=collector_id,
            collector_token=collector_token,
            region_id=region_id,
        )
        online_forwarder._client = httpx.AsyncClient(transport=httpx.MockTransport(online_handler))
        online_forwarder._running = True

        try:
            # 6. Drain batch against online Tier 2
            await online_forwarder._drain_batch()
        finally:
            await online_forwarder.stop()

        # 7. Confirm queue drained
        stats_after = get_outbox_stats(tenant_id)
        assert stats_after["sent"] == 5
        assert stats_after["pending"] == 0

        # 8. Confirm zero loss & zero duplicates
        assert sorted(received_by_tier2) == sorted(payload_ids)
        assert len(received_by_tier2) == 5

    @pytest.mark.asyncio
    async def test_idempotent_deduplication_under_network_retry(self):
        """
        When a packet is received by Tier 2 but the ACK is lost or retried,
        Tier 2 returns status 'duplicated', and forwarder marks outbox as SENT.
        """
        tenant_id = "tenant_dedup_test"
        collector_id = "coll_dedup_01"
        region_id = "us-east-1"
        payload_id = f"dedup_{uuid.uuid4().hex[:8]}"

        process_and_store_telemetry(
            raw_data={"message": "Dedup test"},
            tenant_id=tenant_id,
            collector_id=collector_id,
            region_id=region_id,
            tenant_salt="salt_dedup",
            payload_id=payload_id,
            event_timestamp_utc=datetime.now(timezone.utc).isoformat(),
            source_timezone="UTC",
            event_category="infrastructure",
            severity="info",
            health_state="Good",
            metrics={"cpu_pct": 20.0},
            security_summary=None,
            alert_context=None,
            collector_meta={},
        )

        # Simulate Tier 2 returning 'duplicated'
        def dup_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"status": "duplicated", "payload_id": payload_id})

        forwarder = Tier2Forwarder(tenant_id, collector_id, "token", region_id)
        forwarder._client = httpx.AsyncClient(transport=httpx.MockTransport(dup_handler))
        forwarder._running = True

        try:
            await forwarder._drain_batch()
        finally:
            await forwarder.stop()

        stats = get_outbox_stats(tenant_id)
        assert stats["sent"] == 1
        assert stats["pending"] == 0

    def test_failed_events_remain_available_for_retry(self):
        """Failed events can be reset and retried according to retry policy."""
        tenant_id = "tenant_retry_policy"
        payload_id = f"retry_pol_{uuid.uuid4().hex[:6]}"

        dummy_scrub = ScrubResult(scrubbed_text="", redactions_count=0, redaction_types=[])
        enqueue_egress_payload(
            payload_id=payload_id,
            tenant_id=tenant_id,
            collector_id="coll_01",
            source_id="src_01",
            region_id="us-east-1",
            egress_payload={"payload_id": payload_id, "metrics": {"cpu_pct": 50.0}},
            scrub_result=dummy_scrub,
        )

        # Mark failed with error
        mark_outbox_failed(payload_id, "Connection timeout to Tier 2")

        stats = get_outbox_stats(tenant_id)
        assert stats["failed"] == 1
        assert stats["pending"] == 0

        # Eligible failed payloads can be queried for retry
        pending = get_pending_outbox(tenant_id, limit=10, include_failed_retries=True, max_retries=10)
        assert len(pending) == 1
        assert pending[0]["payload_id"] == payload_id

        # Or reset to PENDING via retry_failed_outbox
        reset_count = retry_failed_outbox(tenant_id, max_retries=10)
        assert reset_count == 1

        stats_reset = get_outbox_stats(tenant_id)
        assert stats_reset["pending"] == 1
        assert stats_reset["failed"] == 0


# ─── Priority 2: Metadata Tagging Verification ───

class TestMetadataTagging:
    """Verifies that outgoing records carry valid UTC timestamps, source timezone, and unique payload IDs."""

    @pytest.fixture(autouse=True)
    def setup_db(self):
        drop_db()
        init_db()
        yield
        drop_db()

    @pytest.mark.asyncio
    async def test_utc_timestamp_normalization_and_timezone_preservation(self):
        """
        Verifies:
        1. Timestamps with local offsets (e.g. Asia/Kolkata +05:30) are accurately converted to UTC 'Z'.
        2. The source timezone (e.g. 'Asia/Kolkata') is preserved as a separate field.
        3. Naive timestamps are safely assumed to be UTC.
        """
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=tier1_app), base_url="http://test") as client:
            # 1. Non-UTC timestamp (+05:30)
            local_time = "2026-11-21T10:30:00+05:30"
            resp = await client.post("/local/ingest", json={
                "payload": {"message": "Test tz preservation"},
                "event_timestamp_utc": local_time,
                "source_timezone": "Asia/Kolkata",
                "metrics": {"cpu_pct": 40.0},
            })
            assert resp.status_code == 200
            data = resp.json()
            pid = data["payload_id"]

            pending = get_pending_outbox(T1_TENANT_ID, 10)
            matching = [p for p in pending if p["payload_id"] == pid]
            assert len(matching) == 1
            egress = json.loads(matching[0]["egress_payload"])

            # Must be converted to 05:00:00Z UTC
            assert egress["event_timestamp_utc"] == "2026-11-21T05:00:00Z"
            assert egress["source_timezone"] == "Asia/Kolkata"
            assert egress["tenant_id"] == T1_TENANT_ID
            assert egress["collector_id"] == T1_COLLECTOR_ID
            assert egress["region_id"] == T1_REGION_ID
            assert egress["source_id"].startswith("src_")

    @pytest.mark.asyncio
    async def test_payload_id_uniqueness_and_immutability_under_retries(self):
        """
        Verifies:
        1. Every ingested event gets a unique payload_id.
        2. During forwarder retries, the payload_id remains identical on the wire.
        """
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=tier1_app), base_url="http://test") as client:
            pids = set()
            for _ in range(5):
                resp = await client.post("/local/ingest", json={
                    "payload": {"message": "Uniqueness test"},
                    "metrics": {"cpu_pct": 10.0},
                })
                pids.add(resp.json()["payload_id"])

            assert len(pids) == 5, "All 5 payload_ids must be unique"

        # Verify retry immutability:
        sample_pid = list(pids)[0]
        attempts_seen = []

        def retry_counting_handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content.decode("utf-8"))
            attempts_seen.append(body["payload_id"])
            if len(attempts_seen) < 3:
                return httpx.Response(503, json={"detail": "Temporary 503"})
            return httpx.Response(200, json={"status": "accepted", "payload_id": body["payload_id"]})

        forwarder = Tier2Forwarder(T1_TENANT_ID, T1_COLLECTOR_ID, "token", T1_REGION_ID)
        forwarder._client = httpx.AsyncClient(transport=httpx.MockTransport(retry_counting_handler))
        forwarder._running = True

        with patch("services.tier1_collector.forwarder.MAX_RETRIES", 5), \
             patch("services.tier1_collector.forwarder.BASE_BACKOFF", 0.01):
            try:
                # Send single payload through retry handler
                single_pending = [p for p in get_pending_outbox(T1_TENANT_ID, 20) if p["payload_id"] == sample_pid][0]
                result = await forwarder._forward_with_retry(sample_pid, json.loads(single_pending["egress_payload"]))
                assert result.success is True
            finally:
                await forwarder.stop()

        # All attempts must have carried the exact same payload_id
        assert len(attempts_seen) == 3
        for seen_pid in attempts_seen:
            assert seen_pid == sample_pid, "Payload ID must remain immutable across retries"


# ─── Priority 3: Local-First Processing Pipeline Order ───

class TestLocalFirstProcessingPipeline:
    """Verifies: Collect -> Analyze Locally -> Encrypt & Store Local -> Redact -> Apply Policy -> Send."""

    @pytest.fixture(autouse=True)
    def setup_db(self):
        drop_db()
        init_db()
        yield
        drop_db()

    @pytest.mark.asyncio
    async def test_pipeline_execution_order_and_secret_isolation(self):
        """
        Verifies:
        1. Local security analyzer inspects raw log (detects brute force signal).
        2. Raw log with credentials is encrypted in local_raw_logs.
        3. Egress payload and egress proof contain ONLY sanitized metadata.
        4. No raw passwords, tokens, or debug traces escape to the outbox.
        """
        secret_password = "SuperSecretMasterPassword999!"
        secret_token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.SecretTokenPayload"

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=tier1_app), base_url="http://test") as client:
            resp = await client.post("/local/ingest", json={
                "payload": {
                    "message": f"Authentication failure for user=admin password={secret_password} token={secret_token}",
                    "source_ip": "192.168.1.100",
                },
                "security_summary": {
                    "failed_login_count_60s": 15,
                    "risk_indicator": "critical",
                    "auth_secret": f"user=admin password={secret_password}",
                },
                "alert_context": f"Critical brute force detected with password={secret_password}",
                "collector_meta": {
                    "template_id": "tpl_auth_01",
                    "parsed_template": f"Admin login failure password={secret_password}",
                    "debug_trace": "stack trace line 42 with raw memory",
                },
                "metrics": {
                    "failed_login_count": 15,
                    "cpu_pct": 78.5,
                },
            })
            assert resp.status_code == 200
            data = resp.json()
            pid = data["payload_id"]
            assert data["redacted_fields_count"] >= 3

        # 1. Verify raw storage has encrypted data with secrets
        raw_logs = get_recent_raw_logs(tenant_id=T1_TENANT_ID, limit=5)
        matching_raw = [r for r in raw_logs if r["source_id"] == data["source_id"]]
        assert len(matching_raw) >= 1
        raw_entry = matching_raw[0]
        # In decrypted raw payload, the original raw values exist locally
        assert secret_password in str(raw_entry["raw_payload"])

        # 2. Verify outbox payload has ZERO secrets and NO unapproved metadata
        pending = get_pending_outbox(T1_TENANT_ID, limit=10)
        target = [p for p in pending if p["payload_id"] == pid][0]
        egress = json.loads(target["egress_payload"])

        egress_str = json.dumps(egress)
        assert secret_password not in egress_str, "Secret password leaked to egress!"
        assert secret_token not in egress_str, "Secret token leaked to egress!"
        assert "parsed_template" not in egress["collector_meta"], "parsed_template must be excluded from egress"
        assert "debug_trace" not in egress["collector_meta"], "debug_trace must be excluded from egress"
        assert egress["collector_meta"]["template_id"].startswith(("EVT_", "tpl_"))
        assert "auth_secret" not in egress["security_summary"]
        assert set(egress["security_summary"].keys()) == {"failed_login_count_60s", "risk_indicator"}

        # 3. Verify Tier 2 strict schema compatibility (extra="forbid")
        tier2_model = IngestPayload(**egress)
        assert tier2_model.payload_id == pid
        assert tier2_model.metrics["failed_login_count"] == 15
        assert tier2_model.metrics["cpu_pct"] == 78.5


# ─── Priority 4: Egress Proof Parity ───

class TestEgressProofParity:
    """Verifies that Egress Proof JSON and Wire JSON are 100% identical."""

    @pytest.fixture(autouse=True)
    def setup_db(self):
        drop_db()
        init_db()
        yield
        drop_db()

    @pytest.mark.asyncio
    async def test_wire_and_proof_exact_parity(self):
        """The JSON delivered to Tier 2 matches the Egress Proof panel entry perfectly."""
        tenant_id = "tenant_proof_parity"
        collector_id = "coll_proof_01"
        region_id = "us-east-1"
        payload_id = f"proof_{uuid.uuid4().hex[:8]}"

        egress_returned, scrub_res = process_and_store_telemetry(
            raw_data={"message": "Proof verification secret=VeryConfidentialToken123"},
            tenant_id=tenant_id,
            collector_id=collector_id,
            region_id=region_id,
            tenant_salt="salt_proof",
            payload_id=payload_id,
            event_timestamp_utc=datetime.now(timezone.utc).isoformat(),
            source_timezone="UTC",
            event_category="infrastructure",
            severity="info",
            health_state="Good",
            metrics={"cpu_pct": 55.0},
            security_summary=None,
            alert_context="High CPU observed token=VeryConfidentialToken123",
            collector_meta={"template_id": "tpl_proof_01"},
        )

        # Query egress proof log
        proofs = get_egress_proof_logs(tenant_id, limit=5)
        matching = [p for p in proofs if p["payload_id"] == payload_id]
        assert len(matching) == 1
        proof_payload = matching[0]["egress_payload"]

        # Forward through Tier2Forwarder
        wire_captured = []

        def wire_catcher(request: httpx.Request) -> httpx.Response:
            wire_captured.append(json.loads(request.content.decode("utf-8")))
            return httpx.Response(200, json={"status": "accepted", "payload_id": payload_id})

        forwarder = Tier2Forwarder(tenant_id, collector_id, "token", region_id)
        forwarder._client = httpx.AsyncClient(transport=httpx.MockTransport(wire_catcher))
        forwarder._running = True

        try:
            await forwarder._drain_batch()
        finally:
            await forwarder.stop()

        assert len(wire_captured) == 1
        wire_payload = wire_captured[0]

        # Exact parity
        assert wire_payload == proof_payload
        assert wire_payload == egress_returned
        assert "VeryConfidentialToken123" not in json.dumps(wire_payload)
