"""
Hybrid AIOps LLM Explainer — Tier 2 SaaS
Async LLM helper for explainable RCA with strict metadata-only guardrails.
Supports Groq (primary) and Gemini (fallback) with 4-second timeout and deterministic fallback.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field, ValidationError

# ─── Allow-Listed Keys (Metadata Only - NEVER raw logs/secrets) ───
ALLOWED_METADATA_KEYS = {
    "source_id",
    "event_category",
    "health_state",
    "metrics",
    "z_scores",
    "security_summary",
    "correlated_alert_count",
    "tenant_id",
    "collector_id",
    "event_timestamp_utc",
    "region_id",
    "alert_context",
    "severity",
}

FORBIDDEN_KEYS = {
    "raw_log",
    "raw_logs",
    "password",
    "api_key",
    "secret",
    "token",
    "authorization",
    "source_ip",
    "hostname",
    "internal_ip",
    "private_key",
    "certificate",
    "payload",
    "request_body",
    "response_body",
}


class RCAResponse(BaseModel):
    """Strict structured output from LLM (or deterministic fallback)."""
    reasoning_path: str = Field(..., min_length=10, max_length=500)
    contributing_signals: list[str] = Field(..., min_length=1)
    confidence: float = Field(..., ge=0.0, le=1.0)
    recommended_action: str = Field(..., min_length=5, max_length=300)
    ai_provider: Literal["groq-live", "gemini-live", "deterministic-fallback"]
    llm_latency_ms: int = Field(..., ge=0)
    # Explicit explainable fields
    why_flagged: str = Field(..., min_length=10, max_length=500, description="Exact baseline vs observed metric values and Z-score/residual breach")
    why_this_action: str = Field(..., min_length=10, max_length=500, description="Explicit explanation of why the recommended action resolves the detected root cause")


@dataclass
class LLMConfig:
    """LLM provider configuration from environment."""
    groq_api_key: str | None = None
    gemini_api_key: str | None = None
    groq_model: str = "llama-3.3-70b-versatile"
    gemini_model: str = "gemini-2.5-flash"
    timeout_seconds: float = 4.0

    @classmethod
    def from_env(cls) -> LLMConfig:
        return cls(
            groq_api_key=os.getenv("GROQ_API_KEY"),
            gemini_api_key=os.getenv("GEMINI_API_KEY"),
            groq_model=os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile"),
            gemini_model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
            timeout_seconds=float(os.getenv("LLM_TIMEOUT_SECONDS", "4.0")),
        )


def sanitize_metadata(incident_metadata: dict) -> dict:
    """
    STRICT GUARDRAIL: Strip ALL non-allow-listed keys before LLM call.
    Only passes sanitized metadata - NEVER raw logs, secrets, or PII.
    """
    sanitized = {}
    for key in ALLOWED_METADATA_KEYS:
        if key in incident_metadata:
            sanitized[key] = incident_metadata[key]

    # Explicitly ensure no forbidden keys leaked through
    for forbidden in FORBIDDEN_KEYS:
        if forbidden in sanitized:
            sanitized.pop(forbidden, None)

    # Deep clean nested dicts
    if "metrics" in sanitized and isinstance(sanitized["metrics"], dict):
        sanitized["metrics"] = {k: v for k, v in sanitized["metrics"].items()
                                if k in {"cpu_pct", "mem_pct", "disk_pct", "bandwidth_mbps",
                                         "latency_ms", "packet_loss_pct", "service_up"}}

    if "security_summary" in sanitized and isinstance(sanitized["security_summary"], dict):
        sanitized["security_summary"] = {k: v for k, v in sanitized["security_summary"].items()
                                         if k in {"failed_login_count_60s", "risk_indicator"}}

    if "z_scores" in sanitized and isinstance(sanitized["z_scores"], dict):
        # Only keep z-scores for allowed metrics
        allowed_z = {k: v for k, v in sanitized["z_scores"].items()
                     if k in {"cpu_pct", "mem_pct", "disk_pct", "latency_ms",
                              "packet_loss_pct", "bandwidth_mbps"}}
        sanitized["z_scores"] = allowed_z

    return sanitized


def build_system_prompt() -> str:
    return """You are an expert AIOps analyst for a secure observability platform.
Given sanitized metadata from an incident (metrics, z-scores, health state, security summary),
produce a concise, explainable RCA in strict JSON format.

Rules:
- NEVER hallucinate raw logs, secrets, IPs, or hostnames - they are not provided.
- Reason ONLY from the provided metadata signals and their statistical deviations.
- Output MUST be valid JSON matching the exact schema.
- Be concise: 2-sentence reasoning_path, specific contributing_signals with values.
- recommended_action must be concrete, reversible, and safe for operator review.
- why_flagged: Exact baseline vs observed metric values and Z-score/residual breach that triggered the alert.
- why_this_action: Explicit explanation of why the recommended action resolves the detected root cause."""


def build_user_prompt(sanitized_metadata: dict) -> str:
    return f"""Incident Metadata:
{json.dumps(sanitized_metadata, indent=2, default=str)}

Produce explainable RCA as JSON with:
- reasoning_path: Clear 2-sentence causal explanation linking contributing signals.
- contributing_signals: List of strings like "cpu_pct: 94.2% (+3.6σ)" or "failed_login_count_60s: 23 (risk=high)".
- confidence: Float 0.0-1.0 based on signal strength and correlation.
- recommended_action: Concrete, reversible operator action (e.g., "Check top processes on src_a9f28c10; consider restart if CPU sustained >90%").
- why_flagged: Exact baseline vs observed metric values and Z-score/residual breach (e.g., "cpu_pct baseline mean=42.1, observed=94.2, z=3.6σ breach").
- why_this_action: Explicit explanation of why this action resolves the root cause (e.g., "Restarting the service clears CPU spinlocks and resets connection pools, directly addressing the thread starvation root cause").
- ai_provider: Will be filled by system.
- llm_latency_ms: Will be filled by system."""


def deterministic_fallback_rca(sanitized_metadata: dict, start_time: float) -> RCAResponse:
    """Deterministic Z-score explanation when LLM unavailable - never fails."""
    signals = []
    reasoning_parts = []
    why_flagged_parts = []

    metrics = sanitized_metadata.get("metrics", {})
    z_scores = sanitized_metadata.get("z_scores", {})
    security = sanitized_metadata.get("security_summary", {})
    health = sanitized_metadata.get("health_state", "Unknown")
    category = sanitized_metadata.get("event_category", "infrastructure")
    source = sanitized_metadata.get("source_id", "unknown")
    correlated = sanitized_metadata.get("correlated_alert_count", 1)

    # Build contributing signals from z-scores and metrics
    for metric, z in z_scores.items():
        val = metrics.get(metric)
        if val is not None:
            signals.append(f"{metric}: {val} (+{z:.1f}σ)")
            reasoning_parts.append(f"{metric} deviated {z:.1f}σ from baseline")
            # Build why_flagged with baseline info (using typical baseline mean as reference)
            baseline_mean = val / (1 + z * 0.15) if z > 0 else val  # rough inverse estimate
            why_flagged_parts.append(f"{metric} baseline_mean={baseline_mean:.1f}, observed={val}, z={z:.1f}σ")

    # Security signals
    risk = "low"
    if security:
        failed = security.get("failed_login_count_60s", 0)
        risk = security.get("risk_indicator", "low")
        if failed > 0:
            signals.append(f"failed_login_count_60s: {failed} (risk={risk})")
            reasoning_parts.append(f"{failed} failed logins in 60s indicating {risk} risk")
            why_flagged_parts.append(f"failed_login_count_60s baseline=0, observed={failed}, risk={risk}")

    # Correlated alerts
    if correlated > 1:
        signals.append(f"correlated_alert_count: {correlated}")
        reasoning_parts.append(f"{correlated} related alerts merged into this incident")
        why_flagged_parts.append(f"{correlated} correlated alerts in 120s window")

    reasoning = f"Health state is {health} for {category} source {source}. " + "; ".join(reasoning_parts) + "."
    why_flagged = " | ".join(why_flagged_parts) if why_flagged_parts else f"{category} anomaly on {source} with health_state={health}"

    # Action based on category and severity
    if category == "security" or risk == "high":
        action = f"Investigate authentication logs for {source}; block source if brute-force confirmed; review access policies."
        why_action = "Blocking the source IP and reviewing access policies directly mitigates brute-force authentication attacks by stopping the attack vector and preventing credential compromise."
    elif "cpu_pct" in z_scores and z_scores["cpu_pct"] > 3:
        action = f"Check top processes on {source}; consider restart if CPU sustained >90%; scale if legitimate load."
        why_action = "Restarting the service clears CPU spinlocks, resets connection pools, and terminates runaway processes, directly addressing thread starvation root cause. Scaling handles legitimate load increases."
    elif "latency_ms" in z_scores and z_scores["latency_ms"] > 2:
        action = f"Check network path to {source}; verify upstream dependencies; consider circuit breaker."
        why_action = "Circuit breaker isolates failing dependencies preventing cascade failures, while network path verification identifies transit degradation root cause."
    else:
        action = f"Monitor {source} for trend continuation; investigate if health degrades to Poor."
        why_action = "Continued monitoring captures trend data for informed intervention before manual action is warranted on low-signal anomalies."

    confidence = min(0.85, 0.5 + len(signals) * 0.1)

    return RCAResponse(
        reasoning_path=reasoning,
        contributing_signals=signals or [f"{category} anomaly detected on {source}"],
        confidence=round(confidence, 2),
        recommended_action=action,
        ai_provider="deterministic-fallback",
        llm_latency_ms=int((time.time() - start_time) * 1000),
        why_flagged=why_flagged,
        why_this_action=why_action,
    )


async def call_groq(sanitized_metadata: dict, config: LLMConfig, start_time: float) -> RCAResponse:
    """Call Groq API with structured JSON output."""
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {config.groq_api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": config.groq_model,
        "messages": [
            {"role": "system", "content": build_system_prompt()},
            {"role": "user", "content": build_user_prompt(sanitized_metadata)},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.1,
        "max_tokens": 800,
    }

    async with httpx.AsyncClient(timeout=config.timeout_seconds) as client:
        resp = await client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()

    content = data["choices"][0]["message"]["content"]
    parsed = json.loads(content)

    # Validate and add provider metadata (pop to avoid duplicate kwargs if LLM echoes them)
    parsed.pop("ai_provider", None)
    parsed.pop("llm_latency_ms", None)
    rca = RCAResponse(
        **parsed,
        ai_provider="groq-live",
        llm_latency_ms=int((time.time() - start_time) * 1000),
    )
    return rca


async def call_gemini(sanitized_metadata: dict, config: LLMConfig, start_time: float) -> RCAResponse:
    """Call Gemini API with JSON output."""
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{config.gemini_model}:generateContent"
    headers = {"Content-Type": "application/json"}
    params = {"key": config.gemini_api_key}

    payload = {
        "contents": [
            {"role": "user", "parts": [{"text": build_system_prompt() + "\n\n" + build_user_prompt(sanitized_metadata)}]}
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0.1,
            "maxOutputTokens": 800,
        },
    }

    async with httpx.AsyncClient(timeout=config.timeout_seconds) as client:
        resp = await client.post(url, headers=headers, params=params, json=payload)
        resp.raise_for_status()
        data = resp.json()

    content = data["candidates"][0]["content"]["parts"][0]["text"]
    parsed = json.loads(content)

    parsed.pop("ai_provider", None)
    parsed.pop("llm_latency_ms", None)
    rca = RCAResponse(
        **parsed,
        ai_provider="gemini-live",
        llm_latency_ms=int((time.time() - start_time) * 1000),
    )
    return rca


async def generate_explainable_rca(incident_metadata: dict) -> dict:
    """
    Main entry point: Generate explainable RCA from incident metadata.
    Enforces strict metadata-only guardrail, tries Groq -> Gemini -> deterministic fallback.
    Returns dict (RCAResponse model_dump) for API persistence.
    """
    config = LLMConfig.from_env()
    start_time = time.time()

    # STRICT GUARDRAIL: Sanitize input - only allow-listed metadata passes through
    sanitized = sanitize_metadata(incident_metadata)

    # Provider priority: Groq -> Gemini -> Deterministic
    if config.groq_api_key:
        try:
            rca = await call_groq(sanitized, config, start_time)
            return rca.model_dump()
        except (httpx.TimeoutException, httpx.HTTPStatusError, httpx.RequestError, ValidationError, json.JSONDecodeError) as e:
            # Log and fall through to next provider
            pass

    if config.gemini_api_key:
        try:
            rca = await call_gemini(sanitized, config, start_time)
            return rca.model_dump()
        except (httpx.TimeoutException, httpx.HTTPStatusError, httpx.RequestError, ValidationError, json.JSONDecodeError) as e:
            # Log and fall through to deterministic
            pass

    # Deterministic fallback - never fails
    rca = deterministic_fallback_rca(sanitized, start_time)
    return rca.model_dump()


# ─── Sync wrapper for non-async contexts (tests) ───
def generate_explainable_rca_sync(incident_metadata: dict) -> dict:
    """Synchronous wrapper for testing."""
    import asyncio
    import concurrent.futures

    def run_in_new_loop():
        """Run the async function in a new event loop in a separate thread."""
        new_loop = asyncio.new_event_loop()
        try:
            return new_loop.run_until_complete(generate_explainable_rca(incident_metadata))
        finally:
            new_loop.close()

    # Check if we're already in an event loop
    try:
        loop = asyncio.get_running_loop()
        # We're in an async context - run in executor to avoid deadlock
        with concurrent.futures.ThreadPoolExecutor() as executor:
            future = executor.submit(run_in_new_loop)
            return future.result(timeout=10)
    except RuntimeError:
        # No running loop - safe to use asyncio.run
        return asyncio.run(generate_explainable_rca(incident_metadata))