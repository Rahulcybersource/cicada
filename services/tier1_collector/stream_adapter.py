"""
Tier 1 Local Collector — Pluggable Stream Adapter
Hot-swappable ingestion: local chaos generator → organizer-provided telemetry stream.
Supports 3 modes via env vars:
  STREAM_MODE=mock (default): Built-in realistic telemetry generator
  STREAM_MODE=http_sse + ORGANIZER_STREAM_URL: Consumes organizer HTTP/SSE JSON stream
  STREAM_MODE=jsonl + ORGANIZER_STREAM_FILE: Tails/replays organizer JSONL file
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import uuid
from abc import ABC, abstractmethod
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, AsyncGenerator, Optional

import httpx


class StreamSource(ABC):
    """Abstract base class for telemetry stream sources."""

    @abstractmethod
    async def start(self) -> None:
        """Start consuming from source."""

    @abstractmethod
    async def stop(self) -> None:
        """Stop consuming from source."""

    @abstractmethod
    async def telemetry_stream(self) -> AsyncGenerator[dict, None]:
        """Yield raw telemetry payloads."""


class ChaosGenerator(StreamSource):
    """Local synthetic telemetry generator for development and demo."""

    SCENARIOS = [
        # Baseline infrastructure
        {
            "weight": 40,
            "generator": lambda: {
                "cpu_pct": round(random.uniform(20, 60), 1),
                "mem_pct": round(random.uniform(30, 70), 1),
                "disk_pct": round(random.uniform(10, 50), 1),
            },
            "event_category": "infrastructure",
            "severity": "info",
            "health_state": "Excellent",
        },
        # Elevated but normal
        {
            "weight": 25,
            "generator": lambda: {
                "cpu_pct": round(random.uniform(60, 75), 1),
                "mem_pct": round(random.uniform(70, 85), 1),
                "disk_pct": round(random.uniform(50, 70), 1),
            },
            "event_category": "infrastructure",
            "severity": "info",
            "health_state": "Good",
        },
        # Network baseline
        {
            "weight": 15,
            "generator": lambda: {
                "latency_ms": round(random.uniform(10, 50), 1),
                "packet_loss_pct": round(random.uniform(0, 0.5), 2),
                "bandwidth_mbps": round(random.uniform(800, 1000), 1),
            },
            "event_category": "network",
            "severity": "info",
            "health_state": "Excellent",
        },
        # Network degraded
        {
            "weight": 8,
            "generator": lambda: {
                "latency_ms": round(random.uniform(100, 200), 1),
                "packet_loss_pct": round(random.uniform(0.5, 2), 2),
                "bandwidth_mbps": round(random.uniform(400, 800), 1),
            },
            "event_category": "network",
            "severity": "warning",
            "health_state": "Fair",
        },
        # Security baseline
        {
            "weight": 10,
            "generator": lambda: {},
            "event_category": "security",
            "severity": "info",
            "health_state": "Excellent",
        },
        # Chaos events (injected via chaos endpoint)
        {
            "weight": 2,
            "generator": lambda: {"cpu_pct": round(random.uniform(90, 99), 1)},
            "event_category": "infrastructure",
            "severity": "critical",
            "health_state": "Poor",
        },
    ]

    def __init__(self, interval_range: tuple[float, float] = (1.0, 5.0)):
        self.interval_range = interval_range
        self._running = False
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        self._running = True

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def telemetry_stream(self) -> AsyncGenerator[dict, None]:
        """Generate synthetic telemetry continuously."""
        # Weighted random selection
        total_weight = sum(s["weight"] for s in self.SCENARIOS)
        choices = []
        for s in self.SCENARIOS:
            choices.extend([s] * s["weight"])

        while self._running:
            try:
                scenario = random.choice(choices)
                metrics = scenario["generator"]()

                yield {
                    "payload": metrics,
                    "event_timestamp_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "event_category": scenario["event_category"],
                    "severity": scenario["severity"],
                    "health_state": scenario["health_state"],
                    "metrics": metrics,
                }

                await asyncio.sleep(random.uniform(*self.interval_range))
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"Chaos generator error: {e}")
                await asyncio.sleep(1)


class OrganizerStreamConsumer(StreamSource):
    """
    Consumes organizer-provided telemetry stream via HTTP/SSE.
    Expected format: JSON Lines over HTTP long-poll or SSE.
    """

    def __init__(
        self,
        stream_url: str,
        auth_token: str | None = None,
        tenant_id: str | None = None,
    ):
        self.stream_url = stream_url
        self.auth_token = auth_token
        self.tenant_id = tenant_id
        self._running = False
        self._client: httpx.AsyncClient | None = None

    async def start(self) -> None:
        self._running = True
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=10.0),
            headers={"Authorization": f"Bearer {self.auth_token}"} if self.auth_token else {},
        )

    async def stop(self) -> None:
        self._running = False
        if self._client:
            await self._client.aclose()

    async def telemetry_stream(self) -> AsyncGenerator[dict, None]:
        """Consume organizer stream (SSE or JSON Lines)."""
        if not self._client:
            raise RuntimeError("OrganizerStreamConsumer not started")

        while self._running:
            try:
                # Try SSE first
                async with self._client.stream("GET", self.stream_url) as response:
                    if response.headers.get("content-type", "").startswith("text/event-stream"):
                        async for line in response.aiter_lines():
                            if not self._running:
                                break
                            if line.startswith("data: "):
                                try:
                                    payload = json.loads(line[6:])
                                    yield payload
                                except json.JSONDecodeError:
                                    pass
                    else:
                        # JSON Lines fallback
                        async for line in response.aiter_lines():
                            if not self._running:
                                break
                            if line.strip():
                                try:
                                    payload = json.loads(line)
                                    yield payload
                                except json.JSONDecodeError:
                                    pass

            except httpx.RequestError as e:
                print(f"Organizer stream connection error: {e}")
                if not self._running:
                    break
                await asyncio.sleep(5)  # Reconnect delay
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"Organizer stream error: {e}")
                await asyncio.sleep(5)


class JsonlFileConsumer(StreamSource):
    """
    Tails/replays an organizer-provided JSONL telemetry file in real time.
    Preserves event_timestamp_utc from each line.
    """

    def __init__(
        self,
        file_path: str,
        replay_speed: float = 1.0,  # 1.0 = real-time, >1 = faster replay
        loop: bool = False,
    ):
        self.file_path = Path(file_path)
        self.replay_speed = replay_speed
        self.loop = loop
        self._running = False
        self._position = 0

    async def start(self) -> None:
        self._running = True
        if not self.file_path.exists():
            print(f"JSONL file not found: {self.file_path}")

    async def stop(self) -> None:
        self._running = False

    async def telemetry_stream(self) -> AsyncGenerator[dict, None]:
        """Yield lines from JSONL file, preserving timestamps."""
        while self._running:
            try:
                if not self.file_path.exists():
                    await asyncio.sleep(1)
                    continue

                with open(self.file_path, "r", encoding="utf-8") as f:
                    f.seek(self._position)
                    for line in f:
                        if not self._running:
                            return
                        if line.strip():
                            try:
                                payload = json.loads(line)
                                yield payload
                            except json.JSONDecodeError:
                                pass
                    self._position = f.tell()

                if not self.loop:
                    break  # End of file, stop unless looping

                # Loop: wait a bit and restart from beginning
                await asyncio.sleep(1)
                self._position = 0

            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"JSONL consumer error: {e}")
                await asyncio.sleep(5)


class IngestionAdapter:
    """
    Unified ingestion adapter that routes to appropriate stream source.
    Hot-swappable between chaos generator, organizer stream, and JSONL file.
    """

    def __init__(
        self,
        tenant_id: str,
        collector_id: str,
        region_id: str,
        collector_token: str,
        tenant_salt: str,
        source_timezone: str,
    ):
        self.tenant_id = tenant_id
        self.collector_id = collector_id
        self.region_id = region_id
        self.collector_token = collector_token
        self.tenant_salt = tenant_salt
        self.source_timezone = source_timezone

        self._source: StreamSource | None = None
        self._mode: str = "mock"
        self._running = False
        self._task: asyncio.Task | None = None

    def set_mode(self, mode: str, **kwargs) -> None:
        """Switch stream mode: 'mock', 'http_sse', or 'jsonl'."""
        if mode not in ("mock", "http_sse", "jsonl"):
            raise ValueError(f"Invalid mode: {mode}. Must be 'mock', 'http_sse', or 'jsonl'")

        self._mode = mode

        if self._running:
            # Restart with new mode
            asyncio.create_task(self._restart_with_mode(mode, **kwargs))

    async def _restart_with_mode(self, mode: str, **kwargs) -> None:
        await self.stop()
        await self.start(mode, **kwargs)

    async def start(self, mode: str = "mock", **kwargs) -> None:
        """Start the configured stream source."""
        if self._running:
            await self.stop()

        if mode == "mock":
            self._source = ChaosGenerator()
        elif mode == "http_sse":
            stream_url = kwargs.get("stream_url") or os.getenv("ORGANIZER_STREAM_URL")
            if not stream_url:
                raise ValueError("http_sse mode requires stream_url (ORGANIZER_STREAM_URL env var)")
            self._source = OrganizerStreamConsumer(
                stream_url=stream_url,
                auth_token=kwargs.get("auth_token") or self.collector_token,
                tenant_id=kwargs.get("tenant_id") or self.tenant_id,
            )
        elif mode == "jsonl":
            file_path = kwargs.get("file_path") or os.getenv("ORGANIZER_STREAM_FILE")
            if not file_path:
                raise ValueError("jsonl mode requires file_path (ORGANIZER_STREAM_FILE env var)")
            replay_speed = float(kwargs.get("replay_speed", os.getenv("ORGANIZER_REPLAY_SPEED", "1.0")))
            loop = kwargs.get("loop", os.getenv("ORGANIZER_LOOP", "false").lower() == "true")
            self._source = JsonlFileConsumer(
                file_path=file_path,
                replay_speed=replay_speed,
                loop=loop,
            )
        else:
            raise ValueError(f"Unknown mode: {mode}")

        await self._source.start()
        self._running = True
        self._task = asyncio.create_task(self._consume_loop())
        print(f"[IngestionAdapter] Started in {mode} mode")

    async def stop(self) -> None:
        """Stop the stream source."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._source:
            await self._source.stop()
        print(f"[IngestionAdapter] Stopped")

    async def _consume_loop(self) -> None:
        """Main consumption loop - processes telemetry through local pipeline."""
        if not self._source:
            return

        # Import here to avoid circular imports
        from .storage import process_and_store_telemetry

        async for telemetry in self._source.telemetry_stream():
            if not self._running:
                break

            try:
                payload = telemetry.get("payload", {})
                event_timestamp = telemetry.get("event_timestamp_utc")
                event_category = telemetry.get("event_category", "infrastructure")
                severity = telemetry.get("severity", "info")
                health_state = telemetry.get("health_state", "Excellent")
                metrics = telemetry.get("metrics", {})

                payload_id = str(uuid.uuid4())[:12]

                process_and_store_telemetry(
                    raw_data=payload,
                    tenant_id=self.tenant_id,
                    collector_id=self.collector_id,
                    region_id=self.region_id,
                    tenant_salt=self.tenant_salt,
                    payload_id=payload_id,
                    event_timestamp_utc=event_timestamp or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    source_timezone=self.source_timezone,
                    event_category=event_category,
                    severity=severity,
                    health_state=health_state,
                    metrics=metrics,
                    security_summary=None,
                    alert_context=None,
                    collector_meta={},
                )

            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"[IngestionAdapter] Processing error: {e}")


def create_ingestion_adapter(config: dict) -> IngestionAdapter:
    """Create ingestion adapter from configuration."""
    return IngestionAdapter(
        tenant_id=config.get("tenant_id", "tenant_acme_corp"),
        collector_id=config.get("collector_id", "col_blr_edge_01"),
        region_id=config.get("region_id", "ap-south-1"),
        collector_token=config.get("collector_token", "collector-token-demo"),
        tenant_salt=config.get("tenant_salt", "tenant_acme_corp_salt_2024"),
        source_timezone=config.get("source_timezone", "Asia/Kolkata"),
    )


# ─── Demo Configuration ───

DEMO_CONFIG = {
    "tenant_id": "tenant_acme_corp",
    "collector_id": "col_blr_edge_01",
    "region_id": "ap-south-1",
    "collector_token": "collector-token-demo",
    "tenant_salt": "tenant_acme_corp_salt_2024",
    "source_timezone": "Asia/Kolkata",
}


async def demo_hot_swap():
    """Demonstrate hot-swapping from mock to organizer mode."""
    adapter = create_ingestion_adapter(DEMO_CONFIG)

    print("Starting in MOCK mode...")
    await adapter.start("mock")
    await asyncio.sleep(5)

    print("\nSwitching to HTTP_SSE mode (requires ORGANIZER_STREAM_URL)...")
    # In real demo, organizer provides stream URL
    # await adapter.set_mode("http_sse", stream_url="https://organizer.example.com/telemetry")
    await adapter.set_mode("mock")  # Stay in mock for demo

    await asyncio.sleep(5)
    await adapter.stop()


if __name__ == "__main__":
    asyncio.run(demo_hot_swap())