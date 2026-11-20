"""
services/tier2_saas/remediation.py
Graduated Remediation Orchestration & Policy Guardrails
Based on:
- Automated / Semi-Automated Incident Remediation Patterns with Cryptographic Verification.

Response Tiers:
- Tier 1: Passive Monitor & Telemetry Audit
- Tier 2: Active Quarantine & Traffic Rate-Limiting
- Tier 3: Service Auto-Restart / Config Rollback (Requires Elevated Approval)
"""

from __future__ import annotations

import hmac
import hashlib
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal
from .auth_rbac import Role, audit_log, check_permission


@dataclass
class RemediationState:
    """Tracks remediation state for rollback support."""
    incident_id: str
    action: str
    before_state: dict[str, Any]
    after_state: dict[str, Any]
    rollback_plan: str
    approved_by: str
    approved_at: str
    executed_at: str | None = None
    rolled_back: bool = False
    rolled_back_at: str | None = None
    rolled_back_by: str | None = None


class RemediationOrchestrator:
    """
    Manages graduated response execution with dual approval policy for critical actions.
    Supports full 4-stage safeguard lifecycle: Policy Check -> Approval -> Execution -> Rollback.
    """

    def __init__(self, hmac_key: str = "cicada_control_key_2026"):
        self.hmac_key = hmac_key
        # Track pending multi-operator approvals: incident_id -> dict
        self._pending_approvals: dict[str, dict[str, Any]] = {}
        # Track remediation states for rollback: incident_id -> RemediationState
        self._remediation_states: dict[str, RemediationState] = {}

    def plan_remediation(self, incident: dict[str, Any]) -> dict[str, Any]:
        """
        Derive graduated remediation plan based on incident severity and health state.
        """
        sev = incident.get("severity", "info").lower()
        confidence = float(incident.get("confidence", 0.0))

        if sev == "critical" and confidence >= 0.85:
            tier = "Tier 3: Auto-Restore / Rollback"
            action = "restart_service"
            risk = "high"
            requires_dual_approval = True
            rollback_plan = "Service restart: revert to previous container image / config version via deployment rollback"
        elif sev in ("warning", "critical"):
            tier = "Tier 2: Isolate / Rate-Limit"
            action = "apply_rate_limit"
            risk = "medium"
            requires_dual_approval = False
            rollback_plan = "Rate limit: remove applied rate limit rule via API gateway / load balancer config revert"
        else:
            tier = "Tier 1: Monitor / Log"
            action = "log_telemetry"
            risk = "low"
            requires_dual_approval = False
            rollback_plan = "Log telemetry: no state change to rollback (passive monitoring only)"

        return {
            "incident_id": incident.get("incident_id"),
            "recommended_tier": tier,
            "proposed_action": action,
            "risk_level": risk,
            "requires_dual_approval": requires_dual_approval,
            "suggested_command": f"ACTION_{action.upper()}_TARGET_{incident.get('source_id', 'unknown')}",
            "rollback_plan": rollback_plan,
        }

    def execute_remediation(
        self,
        incident_id: str,
        tenant_id: str,
        operator_id: str,
        role: str,
        action: Literal["approve", "rollback"],
        severity: str = "warning",
        approved: bool = False,
        incident_data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Execute graduated response with RBAC, policy check, and audit logging.

        4-Stage Safeguard Lifecycle:
        1. Policy Check: Validate action against safe simulation policies
        2. Approval: Require explicit approved=True and operator identity
        3. Simulated Execution: Execute safely, record before/after state
        4. Rollback Support: Revert to before_state with ROLLED_BACK audit record
        """
        now_utc = datetime.now(timezone.utc).isoformat()

        # STAGE 1: POLICY CHECK
        # Validate action against safe simulation policies
        req_perm = "remediate_tier3" if severity == "critical" else "remediate_tier2"
        if not check_permission(role, req_perm) and role != Role.ADMINISTRATOR.value:
            audit_log.append(
                tenant_id=tenant_id,
                user_id=operator_id,
                role=role,
                action=f"remediation_{action}_denied",
                details={"incident_id": incident_id, "reason": "Insufficient permissions", "policy_status": "rejected"},
            )
            return {
                "status": "permission_denied",
                "message": f"Role '{role}' lacks permission '{req_perm}'",
                "incident_id": incident_id,
                "policy_status": "rejected",
            }

        # STAGE 2: APPROVAL - Require explicit approved=True
        if action == "approve" and not approved:
            audit_log.append(
                tenant_id=tenant_id,
                user_id=operator_id,
                role=role,
                action="remediation_approve_rejected",
                details={
                    "incident_id": incident_id,
                    "reason": "Explicit approval required (approved=true)",
                    "policy_status": "rejected",
                },
            )
            return {
                "status": "rejected",
                "message": "Remediation requires explicit approval: set approved=true",
                "incident_id": incident_id,
                "policy_status": "rejected",
                "requires_approval": True,
            }

        # STAGE 2b: Critical severity dual-approval check
        if action == "approve" and severity == "critical" and role != Role.ADMINISTRATOR.value:
            if incident_id not in self._pending_approvals:
                self._pending_approvals[incident_id] = {
                    "first_approver": operator_id,
                    "first_approval_time": time.time(),
                }
                audit_log.append(
                    tenant_id=tenant_id,
                    user_id=operator_id,
                    role=role,
                    action="remediation_approval_pending_dual",
                    details={"incident_id": incident_id, "policy_status": "pending_dual_approval"},
                )
                return {
                    "status": "pending_dual_approval",
                    "message": "Critical incident requires second operator approval",
                    "incident_id": incident_id,
                    "first_approver": operator_id,
                    "policy_status": "pending_dual_approval",
                }
            elif self._pending_approvals[incident_id]["first_approver"] == operator_id:
                return {
                    "status": "pending_dual_approval",
                    "message": "Second approval must be from a different operator",
                    "incident_id": incident_id,
                    "policy_status": "pending_dual_approval",
                }
            else:
                # Second approval received!
                del self._pending_approvals[incident_id]

        # Generate cryptographic remediation command token
        cmd_ts = int(time.time())
        token_src = f"{incident_id}:{action}:{operator_id}:{cmd_ts}"
        cmd_sig = hmac.new(self.hmac_key.encode(), token_src.encode(), hashlib.sha256).hexdigest()
        rollback_token = f"rb_{incident_id}_{cmd_ts}"

        # STAGE 3: SIMULATED EXECUTION
        if action == "approve":
            # Capture before_state from incident data
            before_state = {
                "health_state": incident_data.get("health_state") if incident_data else "unknown",
                "severity": incident_data.get("severity") if incident_data else "unknown",
                "status": incident_data.get("status") if incident_data else "unknown",
                "metrics_snapshot": incident_data.get("metrics_snapshot") if incident_data else {},
            }

            # Simulate after_state based on action
            proposed = self.plan_remediation(incident_data or {"incident_id": incident_id, "severity": severity})
            after_state = {
                "health_state": "Good" if severity != "critical" else "Fair",  # Simulated improvement
                "severity": "info" if severity != "critical" else "warning",   # Simulated de-escalation
                "status": "acknowledged",
                "action_executed": proposed["proposed_action"],
            }

            # Store remediation state for rollback
            self._remediation_states[incident_id] = RemediationState(
                incident_id=incident_id,
                action=proposed["proposed_action"],
                before_state=before_state,
                after_state=after_state,
                rollback_plan=proposed["rollback_plan"],
                approved_by=operator_id,
                approved_at=now_utc,
                executed_at=now_utc,
            )

        # STAGE 4: ROLLBACK
        elif action == "rollback":
            if incident_id not in self._remediation_states:
                audit_log.append(
                    tenant_id=tenant_id,
                    user_id=operator_id,
                    role=role,
                    action="remediation_rollback_failed",
                    details={"incident_id": incident_id, "reason": "No remediation state to rollback", "policy_status": "failed"},
                )
                return {
                    "status": "failed",
                    "message": "No remediation state found to rollback",
                    "incident_id": incident_id,
                    "policy_status": "failed",
                }

            state = self._remediation_states[incident_id]
            state.rolled_back = True
            state.rolled_back_at = now_utc
            state.rolled_back_by = operator_id

        # Record to tamper-evident audit trail with full policy-gated details
        audit_action = f"remediation_{action}"
        audit_details = {
            "incident_id": incident_id,
            "command_signature": cmd_sig,
            "rollback_token": rollback_token,
            "policy_status": "approved" if action == "approve" else "rolled_back",
            "approved_by": operator_id,
            "before_state": self._remediation_states[incident_id].before_state if incident_id in self._remediation_states else {},
            "after_state": self._remediation_states[incident_id].after_state if incident_id in self._remediation_states else {},
            "rollback_plan": self._remediation_states[incident_id].rollback_plan if incident_id in self._remediation_states else "",
            "timestamp_utc": now_utc,
        }

        audit_record = audit_log.append(
            tenant_id=tenant_id,
            user_id=operator_id,
            role=role,
            action=audit_action,
            details=audit_details,
        )

        return {
            "status": "approved" if action == "approve" else "rolled_back",
            "incident_id": incident_id,
            "operator_id": operator_id,
            "action": f"simulated_{action}",
            "rollback_token": rollback_token,
            "command_signature": cmd_sig,
            "audit_index": audit_record.index,
            "audit_hash": audit_record.record_hash,
            "policy_status": "approved" if action == "approve" else "rolled_back",
            "approved_by": operator_id,
            "before_state": audit_details["before_state"],
            "after_state": audit_details["after_state"],
            "rollback_plan": audit_details["rollback_plan"],
            "timestamp_utc": now_utc,
            "message": f"Remediation {action} successfully validated and signed",
        }

    def get_remediation_state(self, incident_id: str) -> RemediationState | None:
        """Get remediation state for audit/rollback inspection."""
        return self._remediation_states.get(incident_id)

    def get_audit_trail(self, incident_id: str) -> list[dict[str, Any]]:
        """Get filtered audit trail for a specific incident."""
        # This would filter from the global audit_log - simplified for now
        return []


remediation_orchestrator = RemediationOrchestrator()
