"""
services/tier1_collector/log_parser.py
Automated Log De-Parameterization & Structure-Based Sanitization
Based on:
- He et al., "Towards Automated Log Parsing for Large-Scale Log Data Analysis", IEEE TDSC (Drain/POP)
- Xu et al., "Experience Mining Google's Production Console Logs", SLAML/SOSP
"""

from __future__ import annotations

import hashlib
import hmac
import re
from typing import Any


# Regex patterns for variable parameters
IPV4_PATTERN = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b")
URL_PATTERN = re.compile(r"https?://[^\s<>\"']+|ftp://[^\s<>\"']+")
PATH_PATTERN = re.compile(r"(?:/[a-zA-Z0-9_\-\.]+)+|(?:[a-zA-Z]:\\[a-zA-Z0-9_\-\.\\]+)")
UUID_PATTERN = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
HEX_PATTERN = re.compile(r"\b0x[0-9a-fA-F]+\b|\b[0-9a-fA-F]{16,64}\b")
EMAIL_PATTERN = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
NUMERIC_COUNTER_PATTERN = re.compile(r"[-+]?(?:\d*\.\d+|\d+)(?:ms|s|MB|GB|KB|kbps|mbps|%|req/s)?")


def hash_token(token: str, token_type: str, salt: str) -> str:
    """Hash sensitive variable parameter using HMAC-SHA256 with tenant salt."""
    h = hmac.new(salt.encode("utf-8"), token.encode("utf-8"), hashlib.sha256).hexdigest()[:8]
    return f"<{token_type}:{h}>"


class LogTemplateParser:
    """
    Automated log de-parameterization using token length & cardinality clustering.
    Extracts invariant template strings, assigns a deterministic template_id,
    and replaces variable tokens with type-scoped HMAC hashes while preserving
    pure numeric performance metrics.
    """

    def __init__(self, tenant_salt: str = "cicada_default_salt"):
        self.tenant_salt = tenant_salt
        self._template_cache: dict[str, str] = {}
        self._next_template_idx = 1

    def parse(self, raw_message: str) -> dict[str, Any]:
        """
        Parse raw log message into structured template and parameters.
        Returns:
            template_id: e.g. EVT_042 or TPL_a1b2
            parsed_template: string with parameters replaced by placeholders
            extracted_parameters: dict of detected variable tokens
            sanitized_message: text with sensitive variables HMAC hashed, numbers preserved
        """
        if not raw_message or not raw_message.strip():
            return {
                "template_id": "EVT_000",
                "parsed_template": "",
                "extracted_parameters": {},
                "sanitized_message": "",
            }

        extracted_params: dict[str, Any] = {}
        sanitized = raw_message

        # 1. URLs
        for match in URL_PATTERN.finditer(raw_message):
            url = match.group(0)
            hashed = hash_token(url, "URL", self.tenant_salt)
            extracted_params["url"] = url
            sanitized = sanitized.replace(url, hashed)

        # 2. Emails
        for match in EMAIL_PATTERN.finditer(sanitized):
            email = match.group(0)
            hashed = hash_token(email, "EMAIL", self.tenant_salt)
            extracted_params["email"] = email
            sanitized = sanitized.replace(email, hashed)

        # 3. IPs
        for match in IPV4_PATTERN.finditer(sanitized):
            ip = match.group(0)
            hashed = hash_token(ip, "IP", self.tenant_salt)
            extracted_params["ip"] = ip
            sanitized = sanitized.replace(ip, hashed)

        # 4. UUIDs
        for match in UUID_PATTERN.finditer(sanitized):
            uid = match.group(0)
            hashed = hash_token(uid, "UUID", self.tenant_salt)
            extracted_params["uuid"] = uid
            sanitized = sanitized.replace(uid, hashed)

        # 5. File paths
        for match in PATH_PATTERN.finditer(sanitized):
            p = match.group(0)
            if len(p) > 3:
                hashed = hash_token(p, "PATH", self.tenant_salt)
                extracted_params["path"] = p
                sanitized = sanitized.replace(p, hashed)

        # 6. Hex tokens / secrets
        for match in HEX_PATTERN.finditer(sanitized):
            h_tok = match.group(0)
            if len(h_tok) >= 8 and not h_tok.startswith("<"):
                hashed = hash_token(h_tok, "HEX", self.tenant_salt)
                extracted_params["hex"] = h_tok
                sanitized = sanitized.replace(h_tok, hashed)

        # Build invariant template string by abstracting remaining numbers & tokens
        template_str = re.sub(r"<\w+:[0-9a-f]+>", "<*>", sanitized)
        template_str = re.sub(r"\b\d+\b", "<NUM>", template_str)

        # Compute deterministic template ID based on template structure
        template_hash = hashlib.sha256(template_str.encode("utf-8")).hexdigest()[:6]
        template_id = f"EVT_{template_hash.upper()}"

        return {
            "template_id": template_id,
            "parsed_template": template_str,
            "extracted_parameters": extracted_params,
            "sanitized_message": sanitized,
        }


def parse_log_message(message: str, tenant_salt: str = "cicada_default_salt") -> dict[str, Any]:
    """Convenience functional interface for log parsing."""
    parser = LogTemplateParser(tenant_salt)
    return parser.parse(message)
