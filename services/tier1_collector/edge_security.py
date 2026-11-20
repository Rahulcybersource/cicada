"""
services/tier1_collector/edge_security.py
Edge Security: Monotonic Sequence Counter, CRC-16 Modbus, Frame SHA-256,
Inbound Command Authentication & Blind Additive Homomorphic Reduction
Based on:
- Tran, "A Secure Multi-Layer Embedded Framework for Real-Time Fault Detection in IIoT", Thesis 2026
- Li & Fujita, "A Two-Tier Secure Event Model for Privacy-Preserving IoT with Encrypted Reductions", IEEE IPDPSW 2026
"""

from __future__ import annotations

import hashlib
import hmac
import json
import threading
from typing import Any


def crc16_modbus(data: bytes) -> str:
    """
    Calculate 16-bit CRC using standard Modbus polynomial (0xA001), initial 0xFFFF.
    Returns 4-character uppercase hex string (e.g. '4B3A').
    """
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 0x0001:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    # Low byte first for Modbus standard
    return f"{crc & 0xFFFF:04X}"


def compute_frame_sha256(payload_dict: dict[str, Any]) -> str:
    """Compute deterministic canonical SHA-256 digest of payload."""
    canonical_json = json.dumps(payload_dict, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()


class MonotonicSequenceTracker:
    """
    Anti-Replay Protection: Maintains strictly monotonic sequence counters
    s_k > s_{k-1} per tenant and source to detect replay or out-of-order attacks.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._counters: dict[str, int] = {}

    def next_seq(self, tenant_id: str, source_id: str) -> int:
        key = f"{tenant_id}:{source_id}"
        with self._lock:
            val = self._counters.get(key, 0) + 1
            self._counters[key] = val
            return val

    def get_current_seq(self, tenant_id: str, source_id: str) -> int:
        key = f"{tenant_id}:{source_id}"
        with self._lock:
            return self._counters.get(key, 0)


def authenticate_remediation_command(
    command_payload: dict[str, Any],
    expected_token: str,
    signature: str,
) -> bool:
    """
    HMAC/SipHash command authentication for inbound Tier 2 remediation requests.
    Validates that remediation action was signed by authorized Tier 2 operator.
    """
    if not signature or not expected_token:
        return False
    canonical = json.dumps(command_payload, sort_keys=True, separators=(",", ":"))
    computed = hmac.new(expected_token.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(computed, signature)


def sign_remediation_command(command_payload: dict[str, Any], secret_token: str) -> str:
    """Sign remediation command payload with secret token."""
    canonical = json.dumps(command_payload, sort_keys=True, separators=(",", ":"))
    return hmac.new(secret_token.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()


# ─── Lightweight Additive Blind Reduction (Li & Fujita 2026) ───

MODULUS = 10**9 + 7

def blind_aggregate_value(value: float, blinding_factor: int, modulus: int = MODULUS) -> int:
    """
    Lightweight additive homomorphic encoding:
    blinded = (round(value * 100) + blinding_factor) % modulus
    Allows Tier 2 to compute fleet-wide sums without learning raw values.
    """
    scaled = int(round(value * 100))
    return (scaled + blinding_factor) % modulus


def unblind_aggregate_sum(
    blinded_sum: int,
    sum_blinding_factors: int,
    modulus: int = MODULUS,
) -> float:
    """Reconstruct cleartext sum from fleet blinded sum."""
    raw_scaled = (blinded_sum - sum_blinding_factors) % modulus
    return round(raw_scaled / 100.0, 2)


# Global sequence tracker instance
seq_tracker = MonotonicSequenceTracker()
