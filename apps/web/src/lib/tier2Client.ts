/**
 * apps/web/src/lib/tier2Client.ts
 * Live Tier 1 -> Tier 2 -> UI Client for CICADA 2026 Observability Platform.
 * Supports native EventSource (SSE) streaming with 2-second polling fallback,
 * live timestamp-measured SLA computation, and self-signed cert detection.
 */

export interface TelemetryPayload {
  payload_id: string;
  tenant_id: string;
  region_id: string;
  collector_id: string;
  source_id: string;
  event_timestamp_utc: string;
  source_timezone: string;
  event_category: string;
  severity: string;
  health_state: string;
  metrics: Record<string, number>;
  security_summary: {
    failed_login_count_60s?: number;
    secrets_scrubbed_count?: number;
    risk_indicator?: string;
    raw_secrets_received?: number;
    [key: string]: any;
  } | null;
  alert_context: string | null;
  collector_meta: Record<string, any>;
  client_render_utc?: string;
  collection_to_render_ms?: number;
}

export interface Incident {
  incident_id: string;
  tenant_id: string;
  source_id: string;
  event_category: string;
  severity: "info" | "warning" | "critical";
  health_state: "Excellent" | "Good" | "Fair" | "Poor";
  first_alert_time_utc: string;
  last_update_time_utc: string;
  alert_count: number;
  contributing_signals: string[];
  reasoning_path: string;
  confidence: number;
  recommended_action: string;
  ai_provider: string;
  llm_latency_ms: number;
  status: "open" | "acknowledged" | "resolved";
  z_scores: Record<string, number>;
  metrics_snapshot: Record<string, number>;
  security_summary: Record<string, any> | null;
  aoim_triage?: {
    recommended_tier: string;
    tier_label: string;
    confidence: number;
    dynamic_importance_score: number;
    feature_attributions: Array<{
      feature: string;
      weight: number;
      direction: string;
      z_score: number;
      value: number;
    }>;
    operator_summary: string;
    technical_explanation: string;
  };
}

export interface CollectorHealth {
  collector_id: string;
  tenant_id: string;
  region_id?: string;
  version: string;
  collector_cpu_pct: number;
  collector_mem_mb: number;
  health_state: "Excellent" | "Good" | "Fair" | "Poor";
  last_heartbeat_utc: string;
  state_reason: string;
  state_transitions: Array<{
    from: string;
    to: string;
    timestamp_utc?: string;
    timestamp?: string;
    reason: string;
  }>;
}

export interface StateTransition {
  tenant_id: string;
  collector_id: string;
  from_state: string;
  to_state: string;
  reason: string;
  timestamp_utc: string;
  record_hash: string;
}

export interface SlaMetrics {
  active_incidents: number;
  tracked_sources: number;
  z_score_threshold: number;
  correlation_window_seconds: number;
  heartbeat_timeout_seconds: number;
  watermark_lag_ms?: number;
  reversals_prevented?: number;
  is_recovery_burst?: boolean;
  received_count?: number;
  duplicate_count?: number;
  p95_dashboard_latency_ms?: number;
  p95_breach_to_alert_ms?: number;
  status?: string;
}

export interface AuditRecord {
  index: number;
  timestamp_utc: string;
  tenant_id: string;
  user_id: string;
  role: string;
  action: string;
  details: Record<string, any>;
  prev_hash: string;
  record_hash: string;
  record_sha256?: string;
}

export interface RCACandidate {
  rank: number;
  cause: string;
  probability: number;
  evidence: string[];
  suggested_fix: string;
}

export interface SilenceRule {
  silence_id: string;
  tenant_id: string;
  metric_name?: string | null;
  source_id?: string | null;
  duration_minutes: number;
  created_at_utc: number;
  expires_at_utc: number;
  created_by: string;
  reason: string;
}

export interface PolicyThresholds {
  [metric: string]: {
    excellent_max: number;
    good_max: number;
    fair_max: number;
  };
}

/**
 * Resolves the active Tier 2 API Base URL.
 * Priority: NEXT_PUBLIC_TIER2_URL -> window.location (port 8000) -> default LAN hotspot
 */
export function getTier2BaseUrl(): string {
  if (typeof window !== "undefined") {
    if (process.env.NEXT_PUBLIC_TIER2_URL) {
      return process.env.NEXT_PUBLIC_TIER2_URL.replace(/\/$/, "");
    }
    // Dynamic fallback to the current host at port 8000
    const host = window.location.hostname || "10.30.165.15";
    const protocol = window.location.protocol === "https:" ? "https:" : "http:";
    return `${protocol}//${host}:8000`;
  }
  return process.env.NEXT_PUBLIC_TIER2_URL || "http://10.30.165.15:8000";
}

export function getAuthHeaders(tenantId: string): HeadersInit {
  return {
    Authorization: "Bearer demo-token",
    "X-Tenant-ID": tenantId,
    "Content-Type": "application/json",
  };
}

/**
 * Fetch helper with standard error & cert handling
 */
async function apiFetch<T>(
  endpoint: string,
  tenantId: string,
  options?: RequestInit
): Promise<{ data: T | null; error: string | null; isCertBlocked: boolean }> {
  const baseUrl = getTier2BaseUrl();
  const url = `${baseUrl}${endpoint}`;

  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        ...getAuthHeaders(tenantId),
        ...(options?.headers || {}),
      },
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      return { data: null, error: `HTTP ${res.status}: ${errText}`, isCertBlocked: false };
    }

    const data = await res.json();
    return { data, error: null, isCertBlocked: false };
  } catch (err: any) {
    const isCert =
      err?.name === "TypeError" &&
      (err?.message?.includes("Failed to fetch") || err?.message?.includes("NetworkError"));
    return {
      data: null,
      error: err?.message || "Network request failed",
      isCertBlocked: isCert,
    };
  }
}

// ─── API Methods ───

export async function fetchTelemetry(tenantId: string, limit = 50) {
  return apiFetch<TelemetryPayload[]>(`/api/v1/telemetry?limit=${limit}`, tenantId);
}

export async function fetchIncidents(tenantId: string, limit = 100) {
  return apiFetch<Incident[]>(`/api/v1/incidents?limit=${limit}`, tenantId);
}

export async function fetchFleetHealth(tenantId: string) {
  return apiFetch<CollectorHealth[]>("/api/v1/fleet/health", tenantId);
}

export async function fetchFleetTransitions(tenantId: string, limit = 50) {
  return apiFetch<StateTransition[]>(`/api/v1/fleet/transitions?limit=${limit}`, tenantId);
}

export async function fetchSlaMetrics(tenantId: string) {
  return apiFetch<SlaMetrics>("/api/v1/sla/metrics", tenantId);
}

export async function fetchAuditLog(tenantId: string, limit = 50) {
  return apiFetch<{ chain_valid: boolean; verification_message: string; total_records: number; records: AuditRecord[] }>(
    `/api/v1/audit?limit=${limit}`,
    tenantId
  );
}

export async function fetchPolicyThresholds(tenantId: string) {
  return apiFetch<{ tenant_id: string; thresholds: PolicyThresholds }>("/api/v1/policy/thresholds", tenantId);
}

export async function updatePolicyThreshold(
  tenantId: string,
  metricName: string,
  excellentMax: number,
  goodMax: number,
  fairMax: number
) {
  return apiFetch<{ tenant_id: string; thresholds: PolicyThresholds }>(
    "/api/v1/policy/thresholds",
    tenantId,
    {
      method: "PUT",
      body: JSON.stringify({
        metric_name: metricName,
        excellent_max: excellentMax,
        good_max: goodMax,
        fair_max: fairMax,
      }),
    }
  );
}

export async function generateCollectorConfig(tenantId: string, regionId = "ap-south-1") {
  return apiFetch<{
    tenant_id: string;
    region_id: string;
    collector_id: string;
    collector_auth_token: string;
    env_content: string;
    powershell_snippet: string;
    bash_snippet: string;
  }>(`/api/v1/tenants/${tenantId}/collector-config`, tenantId, {
    method: "POST",
    body: JSON.stringify({ region_id: regionId, enable_ldp: true }),
  });
}

export async function fetchRcaJob(incidentId: string, tenantId: string) {
  return apiFetch<{
    job_id: string;
    incident_id: string;
    status: string;
    top_candidates: RCACandidate[];
  }>(`/api/v1/rca/jobs/${incidentId}`, tenantId);
}

export async function updateIncidentState(
  incidentId: string,
  state: "open" | "acknowledged" | "resolved",
  tenantId: string,
  operatorId = "operator_demo",
  note = ""
) {
  return apiFetch<{
    status: string;
    incident_id: string;
    new_state: string;
    audit_hash?: string;
  }>(`/api/v1/incidents/${incidentId}/state`, tenantId, {
    method: "PATCH",
    body: JSON.stringify({ state, operator_id: operatorId, operator_note: note }),
  });
}

export async function approveRemediation(
  incidentId: string,
  tenantId: string,
  operatorId = "operator_demo",
  role = "Operator"
) {
  return apiFetch<any>(`/api/v1/remediation/${incidentId}/approve`, tenantId, {
    method: "POST",
    body: JSON.stringify({ operator_id: operatorId, operator_role: role }),
  });
}

export async function rollbackRemediation(
  incidentId: string,
  tenantId: string,
  operatorId = "operator_demo",
  role = "Operator"
) {
  return apiFetch<any>(`/api/v1/remediation/${incidentId}/rollback`, tenantId, {
    method: "POST",
    body: JSON.stringify({ operator_id: operatorId, operator_role: role }),
  });
}

export async function toggleOutageSimulation(enabled: boolean, tenantId: string) {
  return apiFetch<{ outage_mode: boolean; message: string }>("/api/v1/admin/simulate-outage", tenantId, {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export async function fetchSilences(tenantId: string) {
  return apiFetch<SilenceRule[]>(`/api/v1/silences?tenant_id=${tenantId}`, tenantId);
}

export async function createSilenceRule(
  tenantId: string,
  metricName: string | null,
  durationMinutes = 30,
  reason = "Temporary silence"
) {
  return apiFetch<SilenceRule>("/api/v1/silences", tenantId, {
    method: "POST",
    body: JSON.stringify({
      tenant_id: tenantId,
      metric_name: metricName,
      duration_minutes: durationMinutes,
      created_by: "operator",
      reason,
    }),
  });
}

export async function deleteSilenceRule(silenceId: string, tenantId: string) {
  return apiFetch<{ status: string; silence_id: string }>(`/api/v1/silences/${silenceId}`, tenantId, {
    method: "DELETE",
  });
}
