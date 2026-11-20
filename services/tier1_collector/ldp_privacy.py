"""
services/tier1_collector/ldp_privacy.py
Local Differential Privacy (LDP) for Continual Counter Telemetry
Based on:
- Ding, Kulkarni, Yekhanin, "Collecting Telemetry Data Privately", Microsoft Research, NeurIPS
"""

from __future__ import annotations

import hashlib
import math
import random
from typing import Any


def _deterministic_seed(device_id: str, metric_name: str, epoch: int) -> float:
    """Generate deterministic pseudorandom float in [0, 1) for permanent memoization."""
    key = f"{device_id}:{metric_name}:{epoch}".encode("utf-8")
    h = hashlib.sha256(key).hexdigest()
    # Use first 8 hex characters as integer
    int_val = int(h[:8], 16)
    return int_val / float(0xFFFFFFFF)


class LDP1BitMeanMechanism:
    """
    1-Bit Mean Mechanism with alpha-point randomized rounding and permanent memoization.
    Allows repeated collection of continual counter metrics with bounded epsilon privacy loss.
    """

    def __init__(self, epsilon: float = 1.0, permanent_memoization: bool = True):
        self.epsilon = max(0.1, float(epsilon))
        self.permanent_memoization = permanent_memoization
        # Perturbation probability gamma: p = exp(eps) / (exp(eps) + 1)
        self.p_keep = math.exp(self.epsilon) / (math.exp(self.epsilon) + 1.0)
        self.p_flip = 1.0 - self.p_keep

    def perturb_counter(
        self,
        value: float,
        min_val: float = 0.0,
        max_val: float = 100.0,
        device_id: str = "dev_local",
        metric_name: str = "counter",
        epoch: int = 1,
    ) -> dict[str, Any]:
        """
        Apply LDP randomized rounding and output perturbation to a numeric counter.
        Returns:
            perturbed_bit: 0 or 1
            unbiased_estimate: reconstructed estimate on original scale [min_val, max_val]
            privacy_budget_epsilon: epsilon value
            mechanism: algorithm name
        """
        # 1. Normalize value to [0, 1]
        range_span = max(1e-6, max_val - min_val)
        clamped = max(min_val, min(max_val, value))
        norm_val = (clamped - min_val) / range_span

        # 2. Alpha-point randomized rounding
        if self.permanent_memoization:
            alpha = _deterministic_seed(device_id, metric_name, epoch)
        else:
            alpha = random.random()

        b_rounded = 1 if norm_val >= alpha else 0

        # 3. Output perturbation with probability gamma
        # Use second deterministic seed for flipping if memoized
        if self.permanent_memoization:
            flip_rand = _deterministic_seed(device_id, f"{metric_name}_flip", epoch)
        else:
            flip_rand = random.random()

        # If flip_rand > p_keep, flip bit
        b_perturbed = b_rounded if flip_rand <= self.p_keep else (1 - b_rounded)

        # 4. Unbiased reconstruction: E[b_perturbed] = norm_val * (2*p - 1) + (1 - p)
        # norm_val_est = (b_perturbed - (1 - p)) / (2*p - 1)
        denom = 2.0 * self.p_keep - 1.0
        if abs(denom) > 1e-6:
            norm_est = (float(b_perturbed) - (1.0 - self.p_keep)) / denom
            norm_est = max(0.0, min(1.0, norm_est))
        else:
            norm_est = norm_val

        unbiased_estimate = min_val + norm_est * range_span

        return {
            "perturbed_bit": b_perturbed,
            "raw_value": round(value, 2),
            "unbiased_estimate": round(unbiased_estimate, 2),
            "privacy_budget_epsilon": self.epsilon,
            "mechanism": "1-Bit Mean Randomized Rounding (Ding et al.)",
            "p_keep": round(self.p_keep, 4),
        }


def apply_ldp_if_enabled(
    metrics: dict[str, Any],
    device_id: str,
    enabled: bool = False,
    epsilon: float = 1.0,
    epoch: int = 1,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """
    Apply LDP to metrics if enabled.
    Returns:
        (possibly_perturbed_metrics, ldp_audit_info)
    """
    if not enabled:
        return metrics, None

    ldp = LDP1BitMeanMechanism(epsilon=epsilon, permanent_memoization=True)
    perturbed_metrics = dict(metrics)
    audit: dict[str, Any] = {"epsilon": epsilon, "perturbed_fields": {}}

    for k, v in metrics.items():
        if isinstance(v, (int, float)):
            # Normalize depending on typical bounds
            max_bound = 100.0 if "pct" in k or "percent" in k else 1000.0
            res = ldp.perturb_counter(float(v), min_val=0.0, max_val=max_bound, device_id=device_id, metric_name=k, epoch=epoch)
            perturbed_metrics[k] = res["unbiased_estimate"]
            audit["perturbed_fields"][k] = res

    return perturbed_metrics, audit
