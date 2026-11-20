"""
services/tier2_saas/aoim_triage.py
Dynamic AOIM Adaptive Weighting & Explainable Triage
Based on:
- Adaptive Operational Incident Management (AOIM) and Alert Correlation frameworks.

Computes dynamic importance weights w_i = alpha_i * S_i based on alert frequency and severity,
performs confidence-gated triage routing, extracts structured feature attributions,
and produces dual-mode explanations (operator summary vs technical engineering detail).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Literal


SEVERITY_WEIGHTS = {
    "info": 1.0,
    "warning": 2.5,
    "critical": 5.0,
}


@dataclass
class FeatureAttribution:
    feature: str
    weight: float
    direction: Literal["+", "-"]
    z_score: float
    value: float


@dataclass
class AOIMTriageResult:
    incident_id: str
    recommended_tier: Literal["tier1_monitor", "tier2_analyst", "tier3_auto_restore"]
    tier_label: str
    confidence: float
    dynamic_importance_score: float
    feature_attributions: list[FeatureAttribution]
    operator_summary: str
    technical_explanation: str


class AOIMTriageEngine:
    """
    Evaluates incident signals with adaptive weighting and produces
    graduated triage decisions with dual-mode explainability.
    """

    def __init__(self):
        # Rolling alert frequency per metric/source
        self._metric_frequency: dict[str, int] = {}

    def record_alert(self, metric_name: str) -> None:
        self._metric_frequency[metric_name] = self._metric_frequency.get(metric_name, 0) + 1

    def evaluate_incident(
        self,
        incident_id: str,
        severity: str,
        confidence: float,
        metrics: dict[str, float],
        z_scores: dict[str, float],
        contributing_signals: list[str],
        alert_count: int,
    ) -> AOIMTriageResult:
        """
        Evaluate incident using dynamic AOIM weighting and confidence gating.
        """
        # 1. Compute dynamic weights per feature
        sev_weight = SEVERITY_WEIGHTS.get(severity.lower(), 1.0)
        attributions: list[FeatureAttribution] = []

        total_weight = 0.0
        for metric, val in metrics.items():
            if not isinstance(val, (int, float)):
                continue
            z = z_scores.get(metric, 0.0)
            freq = self._metric_frequency.get(metric, 1)
            # Alpha factor: frequent noisy alerts get dampening, rare spikes get priority
            alpha = 1.0 / (1.0 + 0.1 * math.log(max(1, freq)))
            feature_w = alpha * sev_weight * (abs(z) if abs(z) > 0.1 else 0.5)

            direction: Literal["+", "-"] = "+" if z >= 0 else "-"
            attributions.append(FeatureAttribution(
                feature=metric,
                weight=round(feature_w, 2),
                direction=direction,
                z_score=round(z, 2),
                value=round(val, 2),
            ))
            total_weight += feature_w

        # Sort attributions by weight descending
        attributions.sort(key=lambda a: a.weight, reverse=True)

        # Normalize weights to sum to 1.0 if any exist
        norm_attributions: list[FeatureAttribution] = []
        if total_weight > 0:
            for attr in attributions:
                norm_attributions.append(FeatureAttribution(
                    feature=attr.feature,
                    weight=round(attr.weight / total_weight, 3),
                    direction=attr.direction,
                    z_score=attr.z_score,
                    value=attr.value,
                ))
        else:
            norm_attributions = attributions

        # 2. Confidence-gated routing:
        # > 0.90 & high severity -> Tier 3: Auto-Restore / Auto-Remediate
        # > 0.70 -> Tier 2: Escalate to Analyst
        # else -> Tier 1: Log and Monitor
        if confidence >= 0.90 and severity.lower() in ("warning", "critical"):
            tier: Literal["tier1_monitor", "tier2_analyst", "tier3_auto_restore"] = "tier3_auto_restore"
            tier_label = "Tier 3: Automated Action / Immediate Remediation"
        elif confidence >= 0.70:
            tier = "tier2_analyst"
            tier_label = "Tier 2: Escalate to On-Call Analyst"
        else:
            tier = "tier1_monitor"
            tier_label = "Tier 1: Telemetry Log & Passive Monitoring"

        # 3. Dual-mode explanations
        top_feature = norm_attributions[0] if norm_attributions else None
        top_name = top_feature.feature if top_feature else "telemetry"
        top_z = top_feature.z_score if top_feature else 0.0

        operator_summary = (
            f"Alert cluster on {top_name} (z={top_z:+.1f}) elevated with {severity.upper()} severity. "
            f"Recommended path: {tier_label}. Confidence: {int(confidence * 100)}%."
        )

        tech_details = [
            f"Dynamic importance score: {round(total_weight, 2)} across {len(norm_attributions)} active features.",
            f"Top driver: {top_name} (normalized weight={top_feature.weight if top_feature else 0.0}, value={top_feature.value if top_feature else 0.0}).",
            f"Correlated alerts in window: {alert_count}. Raw signals: {', '.join(contributing_signals[:3])}.",
        ]
        technical_explanation = " | ".join(tech_details)

        return AOIMTriageResult(
            incident_id=incident_id,
            recommended_tier=tier,
            tier_label=tier_label,
            confidence=round(confidence, 3),
            dynamic_importance_score=round(total_weight, 2),
            feature_attributions=norm_attributions,
            operator_summary=operator_summary,
            technical_explanation=technical_explanation,
        )


aoim_engine = AOIMTriageEngine()
