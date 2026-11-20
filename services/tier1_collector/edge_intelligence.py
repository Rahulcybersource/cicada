"""
services/tier1_collector/edge_intelligence.py
Edge Intelligence: EFPM, TTVM, TAN Risk Scoring & FLS/SLS Escalation
Based on:
- Saha et al., "A privacy aware lightweight edge intelligent framework", Nature Scientific Reports, 2026 (PEWTAF)
- Bin Shafi et al., "Next-Generation Communications, Computing and Sensing for Industrial AIoT", IEICE, 2026 (FLS/SLS)
"""

from __future__ import annotations

from collections import deque
from typing import Any


class EphemeralMemoryPurge:
    """
    EFPM (Ephemeral Raw Purge): Explicitly overwrites and clears in-memory raw
    log buffers immediately after metadata extraction, unless local encrypted debug
    retention is explicitly enabled.
    """

    @staticmethod
    def purge_buffer(buffer_dict: dict[str, Any], retain_encrypted_debug: bool = False) -> None:
        """Zero out raw buffer keys in memory."""
        if retain_encrypted_debug:
            return
        for k in list(buffer_dict.keys()):
            if k in ("raw_log", "raw_logs", "raw_payload", "password", "api_key", "secret", "token"):
                # Overwrite content before deletion
                buffer_dict[k] = ""
                del buffer_dict[k]


class TemporalThreatValidationModule:
    """
    TTVM (Temporal Threat Validation Module):
    Sliding FIFO window of size N computing persistence score Pt = np / N.
    Suppresses transient single-tick false alarms unless Pt >= tau_p (default 0.60).
    """

    def __init__(self, window_size: int = 10, tau_p: float = 0.60):
        self.window_size = window_size
        self.tau_p = tau_p
        # Map source_id -> deque of bools (True = threat detected in tick)
        self._windows: dict[str, deque[bool]] = {}

    def update(self, source_id: str, is_threat_detected: bool) -> dict[str, Any]:
        """
        Record tick for source and calculate persistence Pt.
        Returns:
            persistence_score: float in [0.0, 1.0]
            is_persistent: bool (Pt >= tau_p)
            suppress_alarm: bool (not persistent)
        """
        if source_id not in self._windows:
            self._windows[source_id] = deque(maxlen=self.window_size)

        win = self._windows[source_id]
        win.append(bool(is_threat_detected))

        n_p = sum(1 for x in win if x)
        p_t = n_p / max(1, len(win))
        is_persistent = p_t >= self.tau_p
        suppress_alarm = not is_persistent and is_threat_detected

        return {
            "source_id": source_id,
            "persistence_score": round(p_t, 3),
            "threat_ticks": n_p,
            "window_size": len(win),
            "tau_p": self.tau_p,
            "is_persistent": is_persistent,
            "suppress_alarm": suppress_alarm,
        }


class ThreatAssessmentNetwork:
    """
    TAN (Threat Assessment Network):
    Deterministic microsecond risk scoring:
        R_t = W_c * c_t * P_t
    where:
        W_c: Category weight (Security=1.0, Network=0.8, Infra=0.6, Heartbeat=0.2)
        c_t: Confidence / Severity scalar in [0.1, 1.0]
        P_t: Persistence score from TTVM in [0.0, 1.0]
    """

    CATEGORY_WEIGHTS = {
        "security": 1.0,
        "network": 0.8,
        "infrastructure": 0.6,
        "heartbeat": 0.2,
    }

    SEVERITY_SCALARS = {
        "critical": 1.0,
        "high": 0.85,
        "warning": 0.65,
        "fair": 0.45,
        "good": 0.25,
        "info": 0.15,
        "excellent": 0.05,
    }

    @classmethod
    def evaluate_risk(
        cls,
        event_category: str,
        severity: str,
        persistence_score: float,
    ) -> dict[str, Any]:
        w_c = cls.CATEGORY_WEIGHTS.get(event_category.lower(), 0.5)
        c_t = cls.SEVERITY_SCALARS.get(severity.lower(), 0.5)
        p_t = max(0.0, min(1.0, persistence_score))

        # Risk score formula
        r_t = w_c * c_t * p_t

        if r_t >= 0.60:
            risk_level = "Critical"
        elif r_t >= 0.40:
            risk_level = "High"
        elif r_t >= 0.20:
            risk_level = "Medium"
        else:
            risk_level = "Low"

        # FLS / SLS Escalation Tag:
        # Tier 1 is the Fast Learning System (FLS); only escalates to Tier 2 Slow Learning System (SLS)
        # when local bounds are persistently violated
        ailc_escalation = (p_t >= 0.60 and r_t >= 0.35) or (severity.lower() == "critical")

        return {
            "risk_score": round(r_t, 4),
            "risk_level": risk_level,
            "category_weight": w_c,
            "severity_scalar": c_t,
            "persistence_score": p_t,
            "ailc_escalation": ailc_escalation,
            "architecture": "FLS-Edge-To-SLS-Cloud (Bin Shafi et al.)",
        }


# Global singleton instances for Tier 1
ttvm_module = TemporalThreatValidationModule(window_size=10, tau_p=0.60)
efpm_module = EphemeralMemoryPurge()
