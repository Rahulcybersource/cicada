"""
services/tier2_saas/adaptive_watermark.py
Recovery-Conscious Adaptive Watermark & Event-Time Sorter
Based on:
- Onishi, Michaelis, Kanemasa, "Recovery-Conscious Adaptive Watermark Generation for Time-Order Event Stream Processing", Fujitsu Laboratories, IEEE/ACM IoTDI 2020
"""

from __future__ import annotations

import math
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any


class AdaptiveWatermarkSorter:
    """
    Algorithm 1 from Onishi et al. (Fujitsu IoTDI):
    Generates dynamic watermarks based on linear regression of event time vs arrival time
    and residual distribution (mu_u + 2.58 * sigma_u).
    Dynamically relaxes latency cap during post-outage bursts to prevent time reversals.
    """

    def __init__(
        self,
        window_size: int = 100,
        normal_latency_cap_ms: float = 5000.0,
        recovery_latency_cap_ms: float = 60000.0,
    ):
        self.window_size = window_size
        self.normal_latency_cap_ms = normal_latency_cap_ms
        self.recovery_latency_cap_ms = recovery_latency_cap_ms

        # Rolling cycle observations: (arrival_time_s, event_time_s)
        self._history: deque[tuple[float, float]] = deque(maxlen=window_size)
        # Residuals
        self._residuals: deque[float] = deque(maxlen=window_size)

        # Regression parameters: estimateET(ta) = a * ta + b
        self._slope_a: float = 1.0
        self._intercept_b: float = 0.0

        # Stats
        self._reversals_prevented: int = 0
        self._last_emitted_event_time: float = 0.0
        self._is_recovering: bool = False
        self._last_arrival_rate: float = 1.0

    def record_observation(self, arrival_time: float, event_time: float) -> None:
        """Record (t_arrival, t_event) pair and update regression & residuals."""
        self._history.append((arrival_time, event_time))
        n = len(self._history)

        if n >= 5:
            # Ordinary least squares regression
            sum_x = sum(x for x, y in self._history)
            sum_y = sum(y for x, y in self._history)
            sum_xx = sum(x * x for x, y in self._history)
            sum_xy = sum(x * y for x, y in self._history)

            denom = (n * sum_xx - sum_x * sum_x)
            if abs(denom) > 1e-9:
                self._slope_a = (n * sum_xy - sum_x * sum_y) / denom
                self._intercept_b = (sum_y - self._slope_a * sum_x) / n
            else:
                self._slope_a = 1.0
                self._intercept_b = sum_y / n - sum_x / n

            # Compute residual for newest point: dt = estimateET(ta) - te
            est_et = self._slope_a * arrival_time + self._intercept_b
            residual = est_et - event_time
            self._residuals.append(residual)

    def set_recovery_mode(self, is_recovering: bool) -> None:
        """Trigger post-outage recovery mode to relax latency cap."""
        self._is_recovering = is_recovering

    def compute_watermark(self, current_arrival_time: float | None = None) -> float:
        """
        Compute current adaptive watermark wm:
        wm = (a * Ta + b) - (mu_u + 2.58 * sigma_u)
        """
        t_a = current_arrival_time or time.time()
        est_et = self._slope_a * t_a + self._intercept_b

        if len(self._residuals) >= 5:
            mean_r = sum(self._residuals) / len(self._residuals)
            var_r = sum((r - mean_r) ** 2 for r in self._residuals) / len(self._residuals)
            std_r = math.sqrt(max(0.0, var_r))
            buffer_lag = mean_r + 2.58 * std_r  # 99% coverage
        else:
            buffer_lag = 1.0  # 1 second default lag

        # Apply latency cap
        cap_s = (self.recovery_latency_cap_ms if self._is_recovering else self.normal_latency_cap_ms) / 1000.0
        effective_lag = min(buffer_lag, cap_s)

        wm = est_et - effective_lag
        return wm

    def sort_and_filter_batch(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """
        Sort arriving telemetry batch strictly by event_timestamp_utc.
        Tracks and prevents time-order reversals.
        """
        if not items:
            return []

        def parse_ts(item: dict[str, Any]) -> float:
            ts_str = item.get("event_timestamp_utc") or item.get("event_timestamp")
            if isinstance(ts_str, str):
                try:
                    dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                    return dt.timestamp()
                except Exception:
                    pass
            return time.time()

        # Sort batch by event time
        sorted_batch = sorted(items, key=parse_ts)

        # Check for reversals relative to previously emitted event time
        for item in sorted_batch:
            ts = parse_ts(item)
            if self._last_emitted_event_time > 0 and ts < self._last_emitted_event_time:
                self._reversals_prevented += 1
            self._last_emitted_event_time = max(self._last_emitted_event_time, ts)

        return sorted_batch

    def get_metrics(self) -> dict[str, Any]:
        """Expose SLA metrics."""
        now = time.time()
        wm = self.compute_watermark(now)
        lag_ms = max(0.0, (now - wm) * 1000.0)
        return {
            "watermark_lag_ms": round(lag_ms, 1),
            "reversals_prevented": self._reversals_prevented,
            "is_recovery_burst": self._is_recovering,
            "regression_slope": round(self._slope_a, 4),
        }


# Global instance
watermark_sorter = AdaptiveWatermarkSorter()
