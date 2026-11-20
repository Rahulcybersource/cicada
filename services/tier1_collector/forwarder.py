"""
Tier 1 Local Collector — Forwarder
Background async worker draining outbox_queue to Tier 2 SaaS with exponential backoff retry.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from .storage import (
    get_pending_outbox,
    mark_outbox_sent,
    mark_outbox_failed,
    get_outbox_stats,
)


# ─── Configuration ───

TIER2_BASE_URL = os.getenv("TIER2_BASE_URL", "http://localhost:8000")
FORWARDER_INTERVAL = float(os.getenv("FORWARDER_INTERVAL", "2.0"))  # seconds
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "10"))
BASE_BACKOFF = float(os.getenv("BASE_BACKOFF", "1.0"))  # seconds
MAX_BACKOFF = float(os.getenv("MAX_BACKOFF", "60.0"))
BATCH_SIZE = int(os.getenv("BATCH_SIZE", "50"))
REQUEST_TIMEOUT = float(os.getenv("REQUEST_TIMEOUT", "10.0"))


@dataclass
class ForwardResult:
    """Result of forward attempt."""
    payload_id: str
    success: bool
    error: str | None = None
    latency_ms: float = 0.0
    status_code: int | None = None


class Tier2Forwarder:
    """
    Background worker that drains outbox_queue to Tier 2 SaaS.
    Features: exponential backoff, batching, zero-loss recovery.
    """

    def __init__(
        self,
        tenant_id: str,
        collector_id: str,
        collector_token: str,
        region_id: str,
    ):
        self.tenant_id = tenant_id
        self.collector_id = collector_id
        self.collector_token = collector_token
        self.region_id = region_id
        self.tier2_base_url = TIER2_BASE_URL
        self._running = False
        self._task: asyncio.Task | None = None
        self._client: httpx.AsyncClient | None = None
        self._consecutive_failures = 0
        self._last_success_time = time.time()

    async def start(self) -> None:
        """Start the forwarder background task."""
        if self._running:
            return

        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(REQUEST_TIMEOUT),
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
        )
        self._running = True
        self._task = asyncio.create_task(self._run_loop())
        print(f"[Forwarder] Started for tenant={self.tenant_id}, collector={self.collector_id}")

    async def stop(self) -> None:
        """Stop the forwarder gracefully."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._client:
            await self._client.aclose()
        print(f"[Forwarder] Stopped for tenant={self.tenant_id}")

    async def _run_loop(self) -> None:
        """Main forwarding loop."""
        while self._running:
            try:
                await self._drain_batch()
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"[Forwarder] Loop error: {e}")
            await asyncio.sleep(FORWARDER_INTERVAL)

    async def _drain_batch(self) -> None:
        """Drain one batch of pending payloads."""
        pending = get_pending_outbox(self.tenant_id, BATCH_SIZE)
        if not pending:
            return

        print(f"[Forwarder] Draining {len(pending)} payloads for tenant={self.tenant_id}")

        for item in pending:
            if not self._running:
                break

            payload_id = item["payload_id"]
            egress_payload = json.loads(item["egress_payload"])

            result = await self._forward_with_retry(payload_id, egress_payload)

            if result.success:
                mark_outbox_sent(payload_id)
                self._consecutive_failures = 0
                self._last_success_time = time.time()
                print(f"[Forwarder] Sent payload_id={payload_id} ({result.latency_ms:.1f}ms)")
            else:
                mark_outbox_failed(payload_id, result.error or "Unknown error")
                self._consecutive_failures += 1
                print(f"[Forwarder] Failed payload_id={payload_id}: {result.error}")

    async def _forward_with_retry(self, payload_id: str, payload: dict) -> ForwardResult:
        """Forward single payload with exponential backoff retry."""
        url = f"{self.tier2_base_url}/api/v1/ingest/{self.region_id}"
        headers = {
            "Authorization": f"Bearer {self.collector_token}",
            "X-Tenant-ID": self.tenant_id,
            "X-Region-ID": self.region_id,
            "Content-Type": "application/json",
        }

        for attempt in range(MAX_RETRIES):
            if not self._running:
                return ForwardResult(payload_id=payload_id, success=False, error="Forwarder stopped")

            start = time.time()
            try:
                response = await self._client.post(url, headers=headers, json=payload)
                latency_ms = (time.time() - start) * 1000

                if response.status_code in (200, 201):
                    data = response.json()
                    if data.get("status") in ("accepted", "duplicated"):
                        return ForwardResult(
                            payload_id=payload_id,
                            success=True,
                            latency_ms=latency_ms,
                            status_code=response.status_code,
                        )
                    else:
                        error = f"Unexpected response: {data}"
                elif response.status_code == 409:
                    # Duplicate - treat as success (idempotent)
                    return ForwardResult(
                        payload_id=payload_id,
                        success=True,
                        latency_ms=latency_ms,
                        status_code=response.status_code,
                    )
                elif response.status_code == 403:
                    # Tenant/region mismatch - don't retry
                    return ForwardResult(
                        payload_id=payload_id,
                        success=False,
                        error=f"Forbidden: {response.text}",
                        latency_ms=latency_ms,
                        status_code=response.status_code,
                    )
                elif response.status_code == 503:
                    # Service unavailable - retry with backoff
                    error = "Service unavailable (503)"
                else:
                    error = f"HTTP {response.status_code}: {response.text}"

            except httpx.TimeoutException:
                error = f"Timeout after {REQUEST_TIMEOUT}s"
            except httpx.ConnectError as e:
                error = f"Connection error: {e}"
            except Exception as e:
                error = f"Unexpected error: {e}"

            # Exponential backoff
            if attempt < MAX_RETRIES - 1:
                backoff = min(BASE_BACKOFF * (2 ** attempt), MAX_BACKOFF)
                print(f"[Forwarder] Retry {attempt + 1}/{MAX_RETRIES} for {payload_id} in {backoff:.1f}s: {error}")
                await asyncio.sleep(backoff)

        return ForwardResult(payload_id=payload_id, success=False, error=error)


# ─── Health Check ───

async def check_tier2_health(base_url: str = TIER2_BASE_URL) -> dict:
    """Check Tier 2 SaaS health endpoint."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{base_url}/health")
            if resp.status_code == 200:
                return {"healthy": True, "data": resp.json()}
            return {"healthy": False, "error": f"HTTP {resp.status_code}"}
    except Exception as e:
        return {"healthy": False, "error": str(e)}


# ─── Demo: Forced Outage Simulation ───

async def simulate_outage_and_recovery(
    forwarder: Tier2Forwarder,
    outage_duration_seconds: int = 10,
) -> dict:
    """
    Demo function: simulate Tier 2 outage, watch buffering, verify zero-loss recovery.
    """
    import uuid
    from storage import enqueue_egress_payload, process_and_store_telemetry

    print(f"\n{'='*60}")
    print("SIMULATING TIER 2 OUTAGE")
    print(f"{'='*60}")

    # 1. Verify Tier 2 is healthy initially
    health = await check_tier2_health()
    print(f"Initial Tier 2 health: {health}")

    # 2. Inject test payloads during outage
    test_payload_ids = []
    for i in range(10):
        payload_id = str(uuid.uuid4())[:12]
        test_payload_ids.append(payload_id)

        # Manually enqueue (simulating local processing during outage)
        egress_payload = {
            "payload_id": payload_id,
            "tenant_id": forwarder.tenant_id,
            "collector_id": forwarder.collector_id,
            "source_id": "src_outage_test",
            "region_id": forwarder.region_id,
            "event_timestamp_utc": datetime.now(timezone.utc).isoformat(),
            "source_timezone": "UTC",
            "event_category": "infrastructure",
            "severity": "info",
            "health_state": "Excellent",
            "metrics": {"cpu_pct": 50.0 + i},
            "security_summary": {"failed_login_count_60s": 0, "risk_indicator": "low"},
            "alert_context": f"Outage test payload {i+1}",
            "collector_meta": {},
        }

        # This would normally go through process_and_store_telemetry
        enqueue_egress_payload(
            payload_id, forwarder.tenant_id, forwarder.collector_id,
            "src_outage_test", forwarder.region_id, egress_payload,
            type('obj', (object,), {"redactions_count": 0, "redaction_types": []})()
        )

    print(f"Enqueued {len(test_payload_ids)} test payloads during outage")

    # 3. Check outbox stats
    stats_before = get_outbox_stats(forwarder.tenant_id)
    print(f"Outbox before outage: {stats_before}")

    # 4. Simulate outage by setting a flag (in real demo, Tier 2 returns 503)
    # For this test, we'll just wait and let forwarder fail
    print(f"\nWaiting {outage_duration_seconds}s for outage simulation...")
    await asyncio.sleep(outage_duration_seconds)

    # 5. Check outbox during outage
    stats_during = get_outbox_stats(forwarder.tenant_id)
    print(f"Outbox during outage: {stats_during}")

    # 6. Recovery - Tier 2 comes back online
    print("\nTier 2 recovered - draining outbox...")
    # In real scenario, forwarder would automatically retry and succeed
    # For demo, trigger manual drain
    for _ in range(5):
        await forwarder._drain_batch()
        await asyncio.sleep(1)

    # 7. Verify zero loss
    stats_after = get_outbox_stats(forwarder.tenant_id)
    print(f"Outbox after recovery: {stats_after}")

    sent_ids = set()
    # In real implementation, query Tier 2 for received payload IDs
    # For demo, we check outbox sent count
    total_sent = stats_after.get("sent", 0)

    result = {
        "test_payload_ids": test_payload_ids,
        "stats_before": stats_before,
        "stats_during": stats_during,
        "stats_after": stats_after,
        "zero_loss": stats_during.get("pending", 0) == len(test_payload_ids) and stats_after.get("pending", 0) == 0,
        "total_sent": total_sent,
    }

    print(f"\n{'='*60}")
    print(f"OUTAGE RECOVERY RESULT: {'PASS' if result['zero_loss'] else 'FAIL'}")
    print(f"Zero Loss: {result['zero_loss']}, Total Sent: {total_sent}")
    print(f"{'='*60}\n")

    return result


if __name__ == "__main__":
    # Quick test
    async def test():
        forwarder = Tier2Forwarder("tenant_test", "coll_test", "test-token", "us-east-1")
        await forwarder.start()
        await asyncio.sleep(2)
        await forwarder.stop()

    asyncio.run(test())