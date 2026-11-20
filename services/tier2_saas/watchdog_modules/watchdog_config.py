"""
services/tier2_saas/watchdog_modules/watchdog_config.py
Watchdog Dynamic Config Generator
Based on:
- observantio/watchdog agent configuration module.

Generates ready-to-run `.env` parameters and PowerShell/bash launch scripts
dynamically customized for any tenant and region.
"""

from __future__ import annotations

import secrets
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field


router = APIRouter(prefix="/api/v1/tenants", tags=["Watchdog Config"])


class CollectorConfigRequest(BaseModel):
    region_id: str = "ap-south-1"
    collector_id: str | None = None
    saas_endpoint: str = "http://127.0.0.1:8000"
    enable_ldp: bool = True


class CollectorConfigResponse(BaseModel):
    tenant_id: str
    region_id: str
    collector_id: str
    collector_auth_token: str
    env_content: str
    powershell_snippet: str
    bash_snippet: str


@router.post("/{tenant_id}/collector-config", response_model=CollectorConfigResponse)
async def generate_collector_config(tenant_id: str, request: CollectorConfigRequest):
    """
    Generate instant copy-paste .env and launcher commands for a new edge collector.
    """
    cid = request.collector_id or f"col_{tenant_id.replace('tenant_', '')}_{secrets.token_hex(3)}"
    token = f"col_tok_{secrets.token_hex(16)}"
    salt = secrets.token_hex(16)
    enc_key = secrets.token_hex(32)

    env_lines = [
        f"# Auto-generated Collector Configuration for {tenant_id}",
        f"TENANT_ID={tenant_id}",
        f"REGION_ID={request.region_id}",
        f"COLLECTOR_ID={cid}",
        f"COLLECTOR_AUTH_TOKEN={token}",
        f"PSEUDONYM_SALT={salt}",
        f"LOCAL_ENCRYPTION_KEY={enc_key}",
        f"TIER2_INGEST_URL={request.saas_endpoint}/api/v1/ingest/{request.region_id}",
        f"ENABLE_LDP_TELEMETRY={'true' if request.enable_ldp else 'false'}",
        "COLLECTOR_PORT=8001",
        "LOG_RETENTION_TTL_HOURS=24",
    ]
    env_content = "\n".join(env_lines) + "\n"

    ps_snippet = f"""# Run in PowerShell from repository root:
$env:TENANT_ID = "{tenant_id}"
$env:REGION_ID = "{request.region_id}"
$env:COLLECTOR_ID = "{cid}"
$env:COLLECTOR_AUTH_TOKEN = "{token}"
$env:ENABLE_LDP_TELEMETRY = "{str(request.enable_ldp).lower()}"
uvicorn services.tier1_collector.main:app --host 0.0.0.0 --port 8001
"""

    bash_snippet = f"""# Run in Bash:
export TENANT_ID="{tenant_id}"
export REGION_ID="{request.region_id}"
export COLLECTOR_ID="{cid}"
export COLLECTOR_AUTH_TOKEN="{token}"
export ENABLE_LDP_TELEMETRY="{str(request.enable_ldp).lower()}"
uvicorn services.tier1_collector.main:app --host 0.0.0.0 --port 8001
"""

    return CollectorConfigResponse(
        tenant_id=tenant_id,
        region_id=request.region_id,
        collector_id=cid,
        collector_auth_token=token,
        env_content=env_content,
        powershell_snippet=ps_snippet,
        bash_snippet=bash_snippet,
    )
