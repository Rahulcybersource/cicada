"""
Tier 1 Local Collector — Local Analyzer
60-second sliding window detector for repeated failed logins.
Emits security_summary risk indicator without exporting raw auth records.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any


@dataclass
class SlidingWindowCounter:
    """Sliding window counter for rate-based detection."""
    window_seconds: int = 60
    timestamps: deque = field(default_factory=deque)

    def add(self, timestamp: float = None) -> int:
        """Add event at timestamp, return current count in window."""
        if timestamp is None:
            timestamp = time.time()
        self.timestamps.append(timestamp)
        self._prune(timestamp)
        return len(self.timestamps)

    def count(self, timestamp: float = None) -> int:
        """Get current count in window."""
        if timestamp is None:
            timestamp = time.time()
        self._prune(timestamp)
        return len(self.timestamps)

    def _prune(self, now: float) -> None:
        """Remove timestamps outside window."""
        cutoff = now - self.window_seconds
        while self.timestamps and self.timestamps[0] < cutoff:
            self.timestamps.popleft()


@dataclass
class SourceSecurityState:
    """Security tracking state per source."""
    failed_login_counter: SlidingWindowCounter = field(default_factory=lambda: SlidingWindowCounter(60))
    last_risk_level: str = "low"
    total_failures: int = 0


class LocalSecurityAnalyzer:
    """
    Local 60-second sliding window detector for repeated failed logins.
    Emits security_summary risk indicator WITHOUT exporting raw auth records.
    """

    def __init__(self):
        # tenant_id -> source_id -> SourceSecurityState
        self.sources: dict[str, dict[str, SourceSecurityState]] = defaultdict(dict)

        # Thresholds
        self.LOW_THRESHOLD = 3
        self.MEDIUM_THRESHOLD = 10
        self.HIGH_THRESHOLD = 20

    def record_failed_login(
        self,
        tenant_id: str,
        source_id: str,
        timestamp: float = None,
    ) -> dict:
        """
        Record a failed login attempt.
        Returns security_summary dict for egress payload.
        """
        if tenant_id not in self.sources:
            self.sources[tenant_id] = {}
        if source_id not in self.sources[tenant_id]:
            self.sources[tenant_id][source_id] = SourceSecurityState()

        state = self.sources[tenant_id][source_id]
        count = state.failed_login_counter.add(timestamp)
        state.total_failures += 1

        # Determine risk level
        if count >= self.HIGH_THRESHOLD:
            risk = "high"
        elif count >= self.MEDIUM_THRESHOLD:
            risk = "medium"
        elif count >= self.LOW_THRESHOLD:
            risk = "low"
        else:
            risk = "none"

        state.last_risk_level = risk

        return {
            "failed_login_count_60s": count,
            "risk_indicator": risk,
            "total_failures": state.total_failures,
        }

    def get_security_summary(self, tenant_id: str, source_id: str) -> dict:
        """Get current security summary for a source."""
        if tenant_id in self.sources and source_id in self.sources[tenant_id]:
            state = self.sources[tenant_id][source_id]
            count = state.failed_login_counter.count()
            return {
                "failed_login_count_60s": count,
                "risk_indicator": state.last_risk_level,
                "total_failures": state.total_failures,
            }
        return {
            "failed_login_count_60s": 0,
            "risk_indicator": "none",
            "total_failures": 0,
        }

    def analyze_raw_event(self, raw_data: dict, tenant_id: str, source_id: str) -> dict | None:
        """
        Analyze raw telemetry event for security signals.
        Returns security_summary if security-relevant, else None.
        """
        # Check for failed login indicators in raw data
        event_type = raw_data.get("event_type", "").lower()
        message = raw_data.get("message", "").lower()
        level = raw_data.get("level", "").lower()

        is_auth_failure = any(keyword in message for keyword in [
            "failed login", "authentication failed", "invalid password",
            "login failed", "auth failure", "unauthorized", "access denied",
        ]) or event_type in ("auth_failure", "failed_login", "login_failure")

        if is_auth_failure:
            return self.record_failed_login(tenant_id, source_id)

        # Check for explicit failed_login_count in metrics
        if "failed_login_count" in raw_data:
            count = raw_data["failed_login_count"]
            # Ensure source state exists
            if tenant_id not in self.sources:
                self.sources[tenant_id] = {}
            if source_id not in self.sources[tenant_id]:
                self.sources[tenant_id][source_id] = SourceSecurityState()
            state = self.sources[tenant_id][source_id]
            # Manually set counter (for synthetic telemetry)
            state.failed_login_counter.timestamps.clear()
            for i in range(int(count)):
                state.failed_login_counter.add(time.time() - i)
            return self.get_security_summary(tenant_id, source_id)

        return None


class LocalResourceAnalyzer:
    """Analyze local collector resource usage."""

    def __init__(self):
        self.samples: dict[str, deque] = defaultdict(lambda: deque(maxlen=100))

    def record(self, collector_id: str, cpu_pct: float, mem_mb: float) -> None:
        self.samples[collector_id].append({
            "timestamp": time.time(),
            "cpu_pct": cpu_pct,
            "mem_mb": mem_mb,
        })

    def get_stats(self, collector_id: str) -> dict:
        samples = self.samples[collector_id]
        if not samples:
            return {"cpu_pct": 0.0, "mem_mb": 0.0, "cpu_avg": 0.0, "mem_avg": 0.0}

        latest = samples[-1]
        cpu_avg = sum(s["cpu_pct"] for s in samples) / len(samples)
        mem_avg = sum(s["mem_mb"] for s in samples) / len(samples)

        return {
            "cpu_pct": latest["cpu_pct"],
            "mem_mb": latest["mem_mb"],
            "cpu_avg": cpu_avg,
            "mem_avg": mem_avg,
            "sample_count": len(samples),
        }


# ─── Singleton Instances ───
security_analyzer = LocalSecurityAnalyzer()
resource_analyzer = LocalResourceAnalyzer()


def analyze_for_security(raw_data: dict, tenant_id: str, source_id: str) -> dict | None:
    """Convenience function for security analysis."""
    return security_analyzer.analyze_raw_event(raw_data, tenant_id, source_id)


def record_collector_resources(collector_id: str, cpu_pct: float, mem_mb: float) -> None:
    """Record collector resource usage."""
    resource_analyzer.record(collector_id, cpu_pct, mem_mb)


def get_collector_resource_stats(collector_id: str) -> dict:
    """Get collector resource statistics."""
    return resource_analyzer.get_stats(collector_id)


if __name__ == "__main__":
    # Quick test
    analyzer = LocalSecurityAnalyzer()
    for i in range(15):
        summary = analyzer.record_failed_login("tenant_test", "src_test")
        print(f"Attempt {i+1}: {summary}")