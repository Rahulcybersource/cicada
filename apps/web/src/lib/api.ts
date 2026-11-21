/**
 * Centralized API Service for SOLARIUS OPS
 * Connects Tier 3 Frontend to Tier 1 Collector (port 8001) and Tier 2 SaaS (port 8000).
 * Implements graceful fallback to simulated demo data when backends are offline or unreachable.
 */

// ─── Backend Response Types (Matching FastAPI Schemas) ───

export interface BackendTelemetryItem {
  payload_id: string;
  tenant_id: string;
  source_id: string;
  event_timestamp_utc: string;
  event_category: string;
  severity: string;
  health_state: string;
  metrics: {
    cpu_pct?: number;
    mem_used_pct?: number;
    disk_used_pct?: number;
    net_throughput_mbps?: number;
    latency_ms?: number;
    failed_login_count_60s?: number;
    [key: string]: any;
  };
  security_summary?: {
    failed_login_count_60s?: number;
    risk_indicator?: string;
    [key: string]: any;
  } | null;
  alert_context?: string | null;
  collector_meta: {
    template_id?: string;
    parsed_template?: string;
    seq_num?: number;
    crc16_hex?: string;
    frame_sha256?: string;
    ttvm_persistence?: number;
    tan_risk_score?: number;
    tan_risk_level?: string;
    [key: string]: any;
  };
}

export interface BackendCollectorHealth {
  collector_id: string;
  health_state: "Excellent" | "Good" | "Fair" | "Poor";
  last_heartbeat_utc: string;
  version: string;
  collector_cpu_pct: number;
  collector_mem_mb: number;
  state_reason: string;
  state_transitions: Array<{
    from_state: string;
    to_state: string;
    timestamp_utc: string;
    reason: string;
  }>;
}

export interface BackendIncident {
  incident_id: string;
  tenant_id: string;
  source_id: string;
  event_category: string;
  severity: "critical" | "warning" | "info";
  health_state: string;
  first_alert_time_utc: string;
  last_update_time_utc: string;
  alert_count: number;
  contributing_signals: string[];
  reasoning_path: string;
  confidence: number;
  recommended_action: string;
  ai_provider: string;
  llm_latency_ms: number;
  status: "active" | "acknowledged" | "resolved" | "suppressed";
  z_scores: Record<string, number>;
  metrics_snapshot: Record<string, any>;
  security_summary?: Record<string, any> | null;
  aoim_triage?: Record<string, any> | null;
}

export interface BackendSlaMetrics {
  active_incidents: number;
  tracked_sources: number;
  z_score_threshold: number;
  correlation_window_seconds: number;
  heartbeat_timeout_seconds: number;
  watermark_lag_ms?: number;
  reversals_prevented?: number;
  is_recovery_burst?: boolean;
}

export interface BackendRawLog {
  id: number;
  tenant_id: string;
  collector_id: string;
  source_id: string;
  raw_payload: Record<string, any>;
  event_timestamp_utc: string;
  received_at_utc: string;
  redacted_fields_count: number;
  redaction_types: string[];
}

export interface BackendEgressProof {
  id: number;
  payload_id: string;
  tenant_id: string;
  egress_payload: Record<string, any>;
  scrub_result: {
    redactions_count?: number;
    redaction_types?: string[];
    schema_valid?: boolean;
    [key: string]: any;
  };
  logged_at_utc: string;
}

export interface BackendOutboxStats {
  total: number;
  pending: number;
  sent: number;
  failed: number;
}

export interface ApiResponse<T> {
  data: T | null;
  isLive: boolean;
  error?: string;
  statusCode?: number;
}

// ─── Environment Base URLs & Configuration ───

export function getTier2BaseUrl(): string {
  if (typeof window !== "undefined") {
    if (process.env.NEXT_PUBLIC_TIER2_URL) return process.env.NEXT_PUBLIC_TIER2_URL;
    const host = window.location.hostname || "localhost";
    return `http://${host}:8000`;
  }
  return process.env.NEXT_PUBLIC_TIER2_URL || "http://localhost:8000";
}

export function getTier1BaseUrl(): string {
  if (typeof window !== "undefined") {
    if (process.env.NEXT_PUBLIC_TIER1_URL) return process.env.NEXT_PUBLIC_TIER1_URL;
    const host = window.location.hostname || "localhost";
    return `http://${host}:8001`;
  }
  return process.env.NEXT_PUBLIC_TIER1_URL || "http://localhost:8001";
}

// Runtime in-memory auth token (never stored in NEXT_PUBLIC_ variables)
let _runtimeAuthToken: string | null = null;

/**
 * Dynamically configure the bearer token at runtime.
 * Persists in sessionStorage to maintain authentication across page refreshes
 * without embedding secrets into client-side JS bundles.
 */
export function setAuthToken(token: string | null): void {
  _runtimeAuthToken = token;
  if (typeof window !== "undefined") {
    try {
      if (token) {
        window.sessionStorage.setItem("solarius_auth_token", token);
      } else {
        window.sessionStorage.removeItem("solarius_auth_token");
      }
    } catch {
      // Storage access may be restricted in sandboxed environments
    }
  }
}

/**
 * Retrieve the current active authentication token.
 * Checks runtime in-memory token, then sessionStorage.
 * In development fallback environments, uses safe unprivileged placeholder.
 * NEVER exposes private secrets through NEXT_PUBLIC_ environment variables.
 */
export function getAuthToken(): string {
  if (_runtimeAuthToken) return _runtimeAuthToken;
  if (typeof window !== "undefined") {
    try {
      const stored = window.sessionStorage.getItem("solarius_auth_token");
      if (stored) return stored;
    } catch {
      // Ignore sessionStorage read errors
    }
  }
  return "demo-token";
}

// ─── Safe Fetch Wrapper with Timeout & Isolation ───

async function safeFetch<T>(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 3000
): Promise<ApiResponse<T>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text().catch(() => "HTTP Error");
      return {
        data: null,
        isLive: false,
        error: `HTTP ${res.status}: ${errText}`,
        statusCode: res.status,
      };
    }

    const data = await res.json();
    return {
      data,
      isLive: true,
      statusCode: res.status,
    };
  } catch (err: any) {
    clearTimeout(timeoutId);
    const errorMsg =
      err.name === "AbortError"
        ? `Request timed out after ${timeoutMs}ms`
        : err.message || "Failed to connect to backend service";

    return {
      data: null,
      isLive: false,
      error: errorMsg,
    };
  }
}

function getHeaders(tenantId: string, customHeaders: Record<string, string> = {}) {
  const token = getAuthToken();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-Tenant-ID": tenantId,
    ...customHeaders,
  };
}

// ─── Centralized API Client Methods ───

export const api = {
  getTier2BaseUrl,
  getTier1BaseUrl,
  getAuthToken,
  setAuthToken,

  // 1. Health Checks
  async checkTier2Health(): Promise<ApiResponse<{ status: string; service: string; timestamp: string }>> {
    const base = getTier2BaseUrl();
    return safeFetch(`${base}/health`, { method: "GET" }, 2000);
  },

  async checkTier1Health(): Promise<ApiResponse<{ status: string; service: string; tenant_id: string; tier2_health: boolean }>> {
    const base = getTier1BaseUrl();
    return safeFetch(`${base}/health`, { method: "GET" }, 2000);
  },

  // 2. SLA Metrics
  async getSlaMetrics(tenantId: string): Promise<ApiResponse<BackendSlaMetrics>> {
    const base = getTier2BaseUrl();
    return safeFetch<BackendSlaMetrics>(`${base}/api/v1/sla/metrics`, {
      method: "GET",
      headers: getHeaders(tenantId),
    });
  },

  // 3. Collector Fleet Health
  async getFleetHealth(tenantId: string): Promise<ApiResponse<BackendCollectorHealth[]>> {
    const base = getTier2BaseUrl();
    return safeFetch<BackendCollectorHealth[]>(`${base}/api/v1/fleet/health`, {
      method: "GET",
      headers: getHeaders(tenantId),
    });
  },

  // 4. Incidents & Alerts
  async getIncidents(
    tenantId: string,
    limit: number = 100,
    status?: string
  ): Promise<ApiResponse<BackendIncident[]>> {
    const base = getTier2BaseUrl();
    const query = new URLSearchParams({ limit: limit.toString() });
    if (status && status !== "all") query.append("status", status.toLowerCase());
    return safeFetch<BackendIncident[]>(`${base}/api/v1/incidents?${query.toString()}`, {
      method: "GET",
      headers: getHeaders(tenantId),
    });
  },

  async getIncidentDetail(
    tenantId: string,
    incidentId: string
  ): Promise<ApiResponse<BackendIncident>> {
    const base = getTier2BaseUrl();
    return safeFetch<BackendIncident>(`${base}/api/v1/incidents/${encodeURIComponent(incidentId)}`, {
      method: "GET",
      headers: getHeaders(tenantId),
    });
  },

  async remediateIncident(
    tenantId: string,
    incidentId: string,
    action: "approve" | "rollback",
    operatorId: string = "operator-dashboard"
  ): Promise<ApiResponse<{ status: string; action: string; message: string; audit_hash?: string }>> {
    const base = getTier2BaseUrl();
    return safeFetch(`${base}/api/v1/incidents/${encodeURIComponent(incidentId)}/remediate`, {
      method: "POST",
      headers: getHeaders(tenantId),
      body: JSON.stringify({ action, operator_id: operatorId }),
    });
  },

  // 5. Telemetry Time-Series & Logs
  async getTelemetry(
    tenantId: string,
    options: {
      limit?: number;
      sourceId?: string;
      eventCategory?: string;
      startTime?: string;
      endTime?: string;
    } = {}
  ): Promise<ApiResponse<BackendTelemetryItem[]>> {
    const base = getTier2BaseUrl();
    const params = new URLSearchParams();
    if (options.limit) params.append("limit", options.limit.toString());
    if (options.sourceId) params.append("source_id", options.sourceId);
    if (options.eventCategory) params.append("event_category", options.eventCategory);
    if (options.startTime) params.append("start_time", options.startTime);
    if (options.endTime) params.append("end_time", options.endTime);

    const qs = params.toString() ? `?${params.toString()}` : "";
    return safeFetch<BackendTelemetryItem[]>(`${base}/api/v1/telemetry${qs}`, {
      method: "GET",
      headers: getHeaders(tenantId),
    });
  },

  // 6. Tier 1 Collector Specifics (Local Inspection)
  async getRawLogs(limit: number = 50): Promise<ApiResponse<BackendRawLog[]>> {
    const base = getTier1BaseUrl();
    return safeFetch<BackendRawLog[]>(`${base}/local/raw-logs?limit=${limit}`, {
      method: "GET",
    });
  },

  async getEgressProofs(limit: number = 50): Promise<ApiResponse<BackendEgressProof[]>> {
    const base = getTier1BaseUrl();
    return safeFetch<BackendEgressProof[]>(`${base}/local/egress-proof?limit=${limit}`, {
      method: "GET",
    });
  },

  async getOutboxStats(): Promise<ApiResponse<BackendOutboxStats>> {
    const base = getTier1BaseUrl();
    return safeFetch<BackendOutboxStats>(`${base}/local/outbox/stats`, {
      method: "GET",
    });
  },

  // 7. Live Demo Chaos & Outage Controls
  async simulateOutage(enabled: boolean, tenantId: string): Promise<ApiResponse<{ outage_mode: boolean; message: string }>> {
    const base = getTier2BaseUrl();
    return safeFetch(`${base}/api/v1/admin/simulate-outage`, {
      method: "POST",
      headers: getHeaders(tenantId),
      body: JSON.stringify({ enabled }),
    });
  },

  // 8. Server-Sent Events Real-Time Connection
  connectSSE(
    tenantId: string,
    onIncident?: (incident: BackendIncident) => void,
    onStatusChange?: (connected: boolean) => void
  ): { disconnect: () => void } {
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      return { disconnect: () => {} };
    }

    const base = getTier2BaseUrl();
    const token = getAuthToken();
    const url = `${base}/api/v1/stream?tenant_id=${encodeURIComponent(tenantId)}&token=${encodeURIComponent(token)}`;

    let es: EventSource | null = null;
    try {
      es = new EventSource(url);

      es.onopen = () => {
        onStatusChange?.(true);
      };

      es.onerror = () => {
        onStatusChange?.(false);
      };

      es.addEventListener("incident", (event) => {
        try {
          const data = JSON.parse(event.data);
          onIncident?.(data);
        } catch {
          // Ignore JSON parse errors on malformed messages
        }
      });
    } catch {
      onStatusChange?.(false);
    }

    return {
      disconnect: () => {
        if (es) {
          es.close();
          onStatusChange?.(false);
        }
      },
    };
  },
};
