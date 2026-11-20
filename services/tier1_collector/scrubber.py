"""
Tier 1 Local Collector — Secret Scrubber & Pseudonymizer
In-memory regex scrubbing + HMAC-SHA256 hostname pseudonymization.
"""

from __future__ import annotations

import hashlib
import hmac
import re
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ScrubResult:
    """Result of secret scrubbing operation."""
    scrubbed_text: str
    redactions_count: int
    redaction_types: list[str]


# ─── Secret Patterns ───
SECRET_PATTERNS = [
    (r"(?i)(password|passwd|pwd)\s*[:=]\s*\S+", "PASSWORD"),
    (r"(?i)(api[_-]?key|apikey)\s*[:=]\s*\S+", "API_KEY"),
    (r"(?i)(secret|client[_-]?secret)\s*[:=]\s*\S+", "SECRET"),
    (r"(?i)(token|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+", "TOKEN"),
    (r"(?i)authorization\s*:\s*bearer\s+[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+", "JWT"),
    (r"(?i)jwt\s*[:=]\s*[A-Za-z0-9\-_=.]+", "JWT"),
    (r"(?i)authorization\s*:\s*basic\s+[A-Za-z0-9+/=]+", "BASIC_AUTH"),
    (r"(?i)(private[_-]?key|ssh[_-]?key)\s*[:=]\s*\S+", "PRIVATE_KEY"),
    (r"-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----", "PRIVATE_KEY"),
    (r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", "EMAIL"),
    (r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "IP"),
]


def scrub_secrets(text: str) -> ScrubResult:
    """
    Scrub secrets from raw text using regex patterns.
    Returns scrubbed text and audit info for Egress Proof Panel.
    """
    result = text
    redacted_fields = []
    total_count = 0

    for pattern, red_type in SECRET_PATTERNS:
        matches = list(re.finditer(pattern, result))
        if matches:
            total_count += len(matches)
            redacted_fields.append(red_type)
            result = re.sub(pattern, f"[REDACTED_{red_type}]", result)

    return ScrubResult(
        scrubbed_text=result,
        redactions_count=total_count,
        redaction_types=list(set(redacted_fields)),
    )


def scrub_dict(data: dict, tenant_salt: str) -> tuple[dict, ScrubResult]:
    """
    Recursively scrub secrets from dictionary values.
    Returns scrubbed dict and combined ScrubResult.
    """
    scrubbed = {}
    total_redactions = 0
    all_redacted_fields = []

    for key, value in data.items():
        if isinstance(value, str):
            result = scrub_secrets(value)
            scrubbed[key] = result.scrubbed_text
            total_redactions += result.redactions_count
            all_redacted_fields.extend(result.redaction_types)
        elif isinstance(value, dict):
            nested_scrubbed, nested_result = scrub_dict(value, tenant_salt)
            scrubbed[key] = nested_scrubbed
            total_redactions += nested_result.redactions_count
            all_redacted_fields.extend(nested_result.redaction_types)
        elif isinstance(value, list):
            scrubbed_list = []
            for item in value:
                if isinstance(item, str):
                    result = scrub_secrets(item)
                    scrubbed_list.append(result.scrubbed_text)
                    total_redactions += result.redactions_count
                    all_redacted_fields.extend(result.redaction_types)
                elif isinstance(item, dict):
                    nested_scrubbed, nested_result = scrub_dict(item, tenant_salt)
                    scrubbed_list.append(nested_scrubbed)
                    total_redactions += nested_result.redactions_count
                    all_redacted_fields.extend(nested_result.redaction_types)
                else:
                    scrubbed_list.append(item)
            scrubbed[key] = scrubbed_list
        else:
            scrubbed[key] = value

    return scrubbed, ScrubResult(
        scrubbed_text="",
        redactions_count=total_redactions,
        redaction_types=list(set(all_redacted_fields)),
    )


# ─── Pseudonymization ───

def pseudonymize_identifier(raw_identifier: str, tenant_salt: str) -> str:
    """
    Convert internal IP/hostname to stable pseudonymous source_id.
    Format: src_<8-char-hex>
    Uses HMAC-SHA256 with tenant-specific salt for determinism within tenant.
    """
    hmac_obj = hmac.new(
        tenant_salt.encode(),
        raw_identifier.encode(),
        hashlib.sha256
    )
    hash_hex = hmac_obj.hexdigest()[:8]
    return f"src_{hash_hex}"


def extract_source_identifier(raw_data: dict) -> str | None:
    """Extract source identifier from raw telemetry (IP, hostname, etc.)."""
    for key in ["source_ip", "hostname", "host", "ip", "internal_ip", "source_id"]:
        if key in raw_data and raw_data[key]:
            return str(raw_data[key])
    return None


# ─── Allow-List Validation ───

ALLOWED_EGRESS_FIELDS = {
    "payload_id", "tenant_id", "collector_id", "source_id",
    "event_timestamp_utc", "source_timezone", "region_id",
    "event_category", "severity", "health_state",
    "metrics", "security_summary", "alert_context", "collector_meta",
}

FORBIDDEN_EGRESS_FIELDS = {
    "raw_log", "raw_logs", "password", "api_key", "secret",
    "token", "authorization", "source_ip", "hostname",
    "internal_ip", "private_key", "certificate", "payload",
    "request_body", "response_body", "email", "ipv4",
}


def validate_allow_list(payload: dict) -> tuple[bool, list[str]]:
    """
    Validate that payload contains only allow-listed fields.
    Returns (is_valid, list_of_violations).
    """
    violations = []
    for key in payload.keys():
        if key not in ALLOWED_EGRESS_FIELDS:
            violations.append(key)
    return len(violations) == 0, violations


def enforce_allow_list(payload: dict) -> dict:
    """Return new dict with only allow-listed fields."""
    return {k: v for k, v in payload.items() if k in ALLOWED_EGRESS_FIELDS}


# ─── Main Processing Pipeline ───

def process_raw_telemetry(
    raw_data: dict,
    tenant_id: str,
    collector_id: str,
    region_id: str,
    tenant_salt: str,
) -> tuple[dict, ScrubResult]:
    """
    Main pipeline: scrub secrets -> pseudonymize -> enforce allow-list.
    Returns (egress_payload, scrub_result).
    """
    # 1. Scrub secrets from raw data
    scrubbed_data, scrub_result = scrub_dict(raw_data, tenant_salt)

    # 2. Extract and pseudonymize source identifier
    raw_source = extract_source_identifier(scrubbed_data)
    source_id = pseudonymize_identifier(raw_source or "unknown", tenant_salt) if raw_source else "src_unknown"

    # 3. Build egress payload with only allow-listed fields
    egress_payload = {
        "source_id": source_id,
        "tenant_id": tenant_id,
        "collector_id": collector_id,
        "region_id": region_id,
    }

    # Copy allow-listed fields from scrubbed data
    for field in ["event_timestamp_utc", "source_timezone", "event_category",
                  "severity", "health_state", "metrics", "security_summary",
                  "alert_context", "collector_meta"]:
        if field in scrubbed_data:
            egress_payload[field] = scrubbed_data[field]

    # 4. Enforce allow-list (defense in depth)
    egress_payload = enforce_allow_list(egress_payload)

    return egress_payload, scrub_result


if __name__ == "__main__":
    # Quick test
    test_data = {
        "cpu_pct": 75.0,
        "source_ip": "10.0.0.5",
        "hostname": "prod-web-01",
        "password": "SuperSecret123",
        "api_key": "sk_live_abc123",
        "message": "User login password=Secret123 api_key=sk_live_xyz",
    }

    payload, result = process_raw_telemetry(test_data, "tenant_test", "coll_1", "us-east-1", "test_salt")
    print("Egress payload:", payload)
    print("Redactions:", result.redactions_count, result.redaction_types)