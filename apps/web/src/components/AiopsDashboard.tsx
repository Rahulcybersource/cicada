"use client";

import { useState, useEffect, useCallback } from "react";
import { AppShell } from "@/components/AppShell";
import {
  AlertTriangle,
  Brain,
  Zap,
  CheckCircle,
  XCircle,
  Info,
  AlertCircle,
  Clock,
  Shield,
  Wifi,
  WifiOff,
  RotateCcw,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Filter,
  Download,
  RefreshCw,
  Search,
  Eye,
  Code,
  Link2,
  Filter as FilterIcon,
  TrendingUp,
  BarChart3,
  FileText,
  GraduationCap,
  Sparkles,
  ZapIcon,
  ShieldIcon,
  Server,
  Database,
  Network,
  Cpu,
  HardDrive,
  Activity,
  Bell,
  BellOff,
  User,
  Users,
  Lock,
  Unlock,
  Key,
  Hash,
  ShieldCheck,
  ShieldAlert,
  Signal,
} from "lucide-react";
import { formatDistanceToNow, parseISO } from "date-fns";

interface Incident {
  incident_id: string;
  tenant_id: string;
  source_id: string;
  event_category: string;
  severity: string;
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
  status: string;
  z_scores: Record<string, number>;
  metrics_snapshot: Record<string, number>;
  security_summary: Record<string, any> | null;
  aoim_triage: Record<string, any> | null;
  suppressed_duplicate_count: number;
  affected_components: string[];
  why_flagged: string;
  why_this_action: string;
}

interface CollectorHealth {
  collector_id: string;
  health_state: string;
  last_heartbeat_utc: string;
  version: string;
  collector_cpu_pct: number;
  collector_mem_mb: number;
  state_reason: string;
  state_transitions: Array<{
    from: string;
    to: string;
    reason: string;
    timestamp_utc: string;
  }>;
}

interface SlaMetrics {
  active_incidents: number;
  tracked_sources: number;
  z_score_threshold: number;
  correlation_window_seconds: number;
  heartbeat_timeout_seconds: number;
  watermark_lag_ms: number;
  reversals_prevented: number;
  is_recovery_burst: boolean;
}

interface RemediationResponse {
  status: "approved" | "rejected" | "pending_dual_approval" | "permission_denied" | "rolled_back" | "failed";
  message: string;
  incident_id: string;
  operator_id: string;
  action: string;
  rollback_token: string;
  command_signature: string;
  audit_index: number;
  audit_hash: string;
  policy_status: string;
  approved_by: string;
  before_state: Record<string, any>;
  after_state: Record<string, any>;
  rollback_plan: string;
  timestamp_utc: string;
  why_flagged: string;
  why_this_action: string;
  audit_trail: {
    audit_index: number;
    audit_hash: string;
    timestamp_utc: string;
    policy_status: string;
    approved_by: string;
    rolled_back_by?: string;
  };
}

interface SlaMetrics {
  active_incidents: number;
  tracked_sources: number;
  z_score_threshold: number;
  correlation_window_seconds: number;
  heartbeat_timeout_seconds: number;
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";
const TENANT_ID = "tenant_acme_corp";

function getAuthHeaders(): HeadersInit {
  return {
    "Authorization": "Bearer demo-token",
    "X-Tenant-ID": TENANT_ID,
    "Content-Type": "application/json",
  };
}

export function AiopsDashboard({ tenantId }: { tenantId: string }) {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [collectors, setCollectors] = useState<CollectorHealth[]>([]);
  const [slaMetrics, setSlaMetrics] = useState<SlaMetrics | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [outageMode, setOutageMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [eventSource, setEventSource] = useState<EventSource | null>(null);
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterSeverity, setFilterSeverity] = useState<string>("all");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [remediationState, setRemediationState] = useState<RemediationResponse | null>(null);
  const [showRemediationModal, setShowRemediationModal] = useState(false);
  const [dualApprovalPending, setDualApprovalPending] = useState<{ incidentId: string; firstApprover: string } | null>(null);
  const [auditTrail, setAuditTrail] = useState<Array<any>>([]);

  const fetchData = useCallback(async () => {
    try {
      const [incidentsRes, slaRes, collectorsRes] = await Promise.all([
        fetch(`${API_BASE}/api/v1/incidents?limit=200`, { headers: getAuthHeaders() }),
        fetch(`${API_BASE}/api/v1/sla/metrics`, { headers: getAuthHeaders() }),
        fetch(`${API_BASE}/api/v1/fleet/health`, { headers: getAuthHeaders() }),
      ]);

      if (incidentsRes.ok) {
        const data = await incidentsRes.json();
        setIncidents(data);
      }
      if (slaRes.ok) {
        const data = await slaRes.json();
        setSlaMetrics(data);
      }
      if (collectorsRes.ok) {
        const data = await collectorsRes.json();
        setCollectors(data);
      }
    } catch (error) {
      console.error("Failed to fetch AIOps data:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/v1/stream?tenant_id=${TENANT_ID}`);

    es.onopen = () => setSseConnected(true);
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (event.type === "incident" || data.incident_id) {
          setIncidents(prev => {
            const idx = prev.findIndex(i => i.incident_id === data.incident_id);
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = data;
              return updated;
            }
            return [data, ...prev];
          });
          if (selectedIncident?.incident_id === data.incident_id) {
            setSelectedIncident(data);
          }
        }
        if (event.type === "collector_health" || data.collector_id) {
          setCollectors(prev => {
            const idx = prev.findIndex(c => c.collector_id === data.collector_id);
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = data;
              return updated;
            }
            return [data, ...prev];
          });
        }
      } catch (e) {}
    };
    es.onerror = () => setSseConnected(false);
    setEventSource(es);
    return () => { es.close(); setSseConnected(false); };
  }, [selectedIncident]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchData]);

  const handleToggleOutage = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/simulate-outage`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ enabled: !outageMode }),
      });
      if (res.ok) setOutageMode(!outageMode);
    } catch (error) {
      console.error("Failed to toggle outage:", error);
    }
  };

  const handleRemediate = async (incidentId: string, action: "approve" | "rollback", approved?: boolean) => {
    try {
      const endpoint = action === "rollback"
        ? `${API_BASE}/api/v1/incidents/${incidentId}/rollback`
        : `${API_BASE}/api/v1/incidents/${incidentId}/remediate`;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          action,
          operator_id: "demo-operator",
          role: "Operator",
          approved: approved ?? (action === "approve")
        }),
      });
      if (res.ok) {
        const result = await res.json();
        setRemediationState(result);
        setShowRemediationModal(true);

        // Handle dual approval
        if (result.policy_status === "pending_dual_approval") {
          setDualApprovalPending({ incidentId, firstApprover: result.first_approver || "demo-operator" });
        } else {
          setDualApprovalPending(null);
        }

        // Fetch audit trail
        fetchAuditTrail(incidentId);
        fetchData();
      }
    } catch (error) {
      console.error("Remediation failed:", error);
    }
  };

  const fetchAuditTrail = async (incidentId: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/incidents/${incidentId}`, { headers: getAuthHeaders() });
      if (res.ok) {
        const data = await res.json();
        // Audit trail would come from the incident detail or a separate endpoint
        // For now, we'll use the remediation response audit_trail
        if (remediationState?.audit_trail) {
          setAuditTrail([remediationState.audit_trail]);
        }
      }
    } catch (error) {
      console.error("Failed to fetch audit trail:", error);
    }
  };

  const handleDualApproval = async (incidentId: string) => {
    if (!dualApprovalPending) return;

    try {
      const res = await fetch(`${API_BASE}/api/v1/incidents/${incidentId}/remediate`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          action: "approve",
          operator_id: "demo-operator-2",
          role: "Operator",
          approved: true
        }),
      });
      if (res.ok) {
        const result = await res.json();
        setRemediationState(result);
        setShowRemediationModal(true);
        setDualApprovalPending(null);
        fetchAuditTrail(incidentId);
        fetchData();
      }
    } catch (error) {
      console.error("Dual approval failed:", error);
    }
  };

  const filteredIncidents = incidents.filter(inc => {
    if (filterStatus !== "all" && inc.status !== filterStatus) return false;
    if (filterSeverity !== "all" && inc.severity !== filterSeverity) return false;
    return true;
  });

  const getHealthClass = (state: string) => {
    switch (state) {
      case "Excellent": return "health-excellent";
      case "Good": return "health-good";
      case "Fair": return "health-fair";
      case "Poor": return "health-poor";
      default: return "health-fair";
    }
  };

  const getHealthBadge = (state: string) => (
    <span className={`badge-pill ${getHealthClass(state)}`}>{state}</span>
  );

  const formatTransitionTime = (timestamp: string) => {
    try {
      return new Date(timestamp).toLocaleString();
    } catch {
      return timestamp;
    }
  };

  const getSeverityClass = (severity: string) => {
    switch (severity) {
      case "critical": return "bg-[#FDE8E8] text-[#D47A7A] border-[#FDE8E8]";
      case "warning": return "bg-[#FDF3E0] text-[#E8B86D] border-[#FDF3E0]";
      default: return "bg-[#E8F2E8] text-[#6B9E6B] border-[#E8F2E8]";
    }
  };

  const getAiProviderClass = (provider: string) => {
    switch (provider) {
      case "groq": return "ai-groq";
      case "gemini": return "ai-gemini";
      default: return "ai-deterministic";
    }
  };

  const getAiProviderIcon = (provider: string) => {
    switch (provider) {
      case "groq": return <ZapIcon className="w-3 h-3" />;
      case "gemini": return <Sparkles className="w-3 h-3" />;
      default: return <ShieldIcon className="w-3 h-3" />;
    }
  };

  if (loading) {
    return (
      <AppShell tenantId={tenantId} tenantName="Acme Corp" sseConnected={sseConnected} outageMode={outageMode}>
        <div className="shell-content flex items-center justify-center h-full">
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-4 border-[#EFC2AE] border-t-transparent rounded-full animate-spin" />
            <p className="text-[#7A746E]">Loading AIOps Engine...</p>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell tenantId={tenantId} tenantName="Acme Corp" sseConnected={sseConnected} outageMode={outageMode} onToggleOutage={handleToggleOutage}>
      <div className="shell-content space-y-6">
        {/* Page Header */}
        <div className="page-header">
          <h1 className="page-header-title flex items-center gap-2">
            <Brain className="w-7 h-7 text-[#EFC2AE]" />
            AIOps Engine
          </h1>
          <p className="page-header-subtitle">Hybrid Z-Score anomaly detection + Explainable LLM RCA with 4s timeout fallback</p>
        </div>

        {/* SLA Bar */}
        <div className="data-grid">
          <div className="kpi-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="kpi-card value">{slaMetrics?.active_incidents ?? 0}</div>
                <div className="kpi-card label">Active Incidents</div>
              </div>
              <div className="w-12 h-12 rounded-[12px] gradient-blush-sand flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-[#EFC2AE]" />
              </div>
            </div>
          </div>
          <div className="kpi-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="kpi-card value">{slaMetrics?.tracked_sources ?? 0}</div>
                <div className="kpi-card label">Tracked Sources</div>
              </div>
              <div className="w-12 h-12 rounded-[12px] gradient-sage-mist flex items-center justify-center">
                <TrendingUp className="w-6 h-6 text-[#C9D8DF]" />
              </div>
            </div>
          </div>
          <div className="kpi-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="kpi-card value">{slaMetrics?.z_score_threshold ?? 2.5}</div>
                <div className="kpi-card label">Z-Score Threshold</div>
              </div>
              <div className="w-12 h-12 rounded-[12px] gradient-cream-apricot flex items-center justify-center">
                <Zap className="w-6 h-6 text-[#EFC2AE]" />
              </div>
            </div>
          </div>
          <div className="kpi-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="kpi-card value">{slaMetrics?.correlation_window_seconds ?? 120}s</div>
                <div className="kpi-card label">Correlation Window</div>
              </div>
              <div className="w-12 h-12 rounded-[12px] gradient-lavender-cream flex items-center justify-center">
                <Link2 className="w-6 h-6 text-[#D8C9E2]" />
              </div>
            </div>
          </div>
        </div>

        {/* Collector Health Panel */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1">
            <div className="section-card">
              <h2 className="section-card-title flex items-center gap-2">
                <Server className="w-5 h-5 text-[#EFC2AE]" />
                Collector Fleet Health ({collectors.length})
              </h2>
              <div className="space-y-2 max-h-[300px] overflow-y-auto">
                {collectors.length === 0 ? (
                  <div className="empty-state py-4">
                    <WifiOff className="empty-state-icon w-8 h-8" />
                    <p className="empty-state-text">No collectors registered</p>
                  </div>
                ) : (
                  collectors.map(collector => (
                    <div key={collector.collector_id} className="card-base p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className={`badge-pill ${getHealthClass(collector.health_state)}`}>{collector.health_state}</span>
                          <span className="font-mono text-sm text-[#1A1918]">{collector.collector_id}</span>
                          <span className="text-xs text-[#7A746E]">v{collector.version}</span>
                        </div>
                        <div className="text-right text-xs text-[#7A746E]">
                          <div>CPU: {collector.collector_cpu_pct.toFixed(1)}%</div>
                          <div>MEM: {collector.collector_mem_mb.toFixed(0)}MB</div>
                        </div>
                      </div>
                      <div className="mt-2 text-xs text-[#7A746E]">
                        <div className="font-mono text-[#1A1918]">Reason: {collector.state_reason}</div>
                        <div>Last Heartbeat: {formatTransitionTime(collector.last_heartbeat_utc)}</div>
                        {collector.state_transitions?.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {collector.state_transitions.slice(-3).map((t, idx) => (
                              <span key={idx} className="badge-pill bg-[#F8F6F3] text-[#7A746E] border-[#ECE7E2] text-[10px]">
                                {t.from}→{t.to}: {formatTransitionTime(t.timestamp_utc)}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="lg:col-span-2">
            {/* Filters */}
            <div className="card-base p-4 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <label className="text-sm text-[#7A746E]">Status:</label>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="input-base w-auto px-3 py-1.5 text-xs">
              <option value="all">All</option>
              <option value="open">Open</option>
              <option value="acknowledged">Acknowledged</option>
              <option value="resolved">Resolved</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm text-[#7A746E]">Severity:</label>
            <select value={filterSeverity} onChange={e => setFilterSeverity(e.target.value)} className="input-base w-auto px-3 py-1.5 text-xs">
              <option value="all">All</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <label className="flex items-center gap-1.5 text-sm text-[#7A746E] cursor-pointer">
              <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} className="w-4 h-4 rounded border-[#ECE7E2] text-[#1A1918] focus:ring-[#C9D8DF]" />
              Auto-refresh (30s)
            </label>
            <button onClick={fetchData} className="btn-ghost p-2" disabled={loading}>
              <RefreshCw className={`w-5 h-5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>
      </div>

        {/* Incidents List + Detail */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Incidents List */}
          <div className="lg:col-span-1 space-y-6">
            <div className="section-card">
              <h2 className="section-card-title flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-[#EFC2AE]" />
                Incidents ({filteredIncidents.length})
              </h2>
              <div className="space-y-2 max-h-[700px] overflow-y-auto">
                {filteredIncidents.length === 0 ? (
                  <div className="empty-state py-8">
                    <AlertTriangle className="empty-state-icon w-8 h-8" />
                    <p className="empty-state-text">No incidents match filters</p>
                  </div>
                ) : (
                  filteredIncidents.map(incident => (
                    <button
                      key={incident.incident_id}
                      onClick={() => setSelectedIncident(incident)}
                      className={`w-full text-left p-3 card-base transition-colors ${selectedIncident?.incident_id === incident.incident_id ? "gradient-blush-sand border-2 border-[#EFC2AE]" : "hover:bg-[#F9F7F4]"}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-mono text-sm text-[#1A1918] truncate">{incident.incident_id}</span>
                            <span className={`badge-pill ${getSeverityClass(incident.severity)}`}>{incident.severity}</span>
                            <span className={`badge-pill ${getAiProviderClass(incident.ai_provider)}`}>
                              {getAiProviderIcon(incident.ai_provider)}
                              {incident.ai_provider.toUpperCase()}
                            </span>
                            <span className={`badge-pill ${getHealthClass(incident.health_state)}`}>{incident.health_state}</span>
                          </div>
                          <p className="text-xs text-[#7A746E] mt-1 truncate">{incident.reasoning_path}</p>
                          <div className="flex items-center gap-2 mt-1 text-xs text-[#B8B3AC] flex-wrap">
                            <span className="font-mono">{incident.alert_count} alerts</span>
                            <span className="font-mono">{incident.confidence.toFixed(0)}%</span>
                            <span className="font-mono">{incident.llm_latency_ms}ms</span>
                            {(incident.suppressed_duplicate_count ?? 0) > 0 && (
                              <span className="badge-pill bg-[#FDF3E0] text-[#E8B86D] border-[#FDF3E0]">
                                <BellOff className="w-3 h-3 inline mr-1" />
                                Duplicates Suppressed: {incident.suppressed_duplicate_count}
                              </span>
                            )}
                            {incident.affected_components?.length > 0 && (
                              <span className="badge-pill bg-[#E8F2E8] text-[#6B9E6B] border-[#E8F2E8]">
                                <Server className="w-3 h-3 inline mr-1" />
                                Components: {incident.affected_components.length}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Incident Detail */}
          <div className="lg:col-span-2 space-y-6">
            {selectedIncident ? (
              <div className="section-card space-y-6 animate-fade-in">
                {/* Incident Header */}
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-3 flex-wrap">
                      <h2 className="font-display text-xl font-semibold text-[#1A1918]">{selectedIncident.incident_id}</h2>
                      <span className={`badge-pill ${getSeverityClass(selectedIncident.severity)}`}>{selectedIncident.severity.toUpperCase()}</span>
                      <span className={`badge-pill ${getAiProviderClass(selectedIncident.ai_provider)}`}>
                        {getAiProviderIcon(selectedIncident.ai_provider)}
                        {selectedIncident.ai_provider.toUpperCase()}
                      </span>
                      <span className={`badge-pill ${getHealthClass(selectedIncident.health_state)}`}>{selectedIncident.health_state}</span>
                    </div>
                    <p className="text-[#7A746E] mt-2">{selectedIncident.reasoning_path}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleRemediate(selectedIncident.incident_id, "approve", true)}
                      className="btn-primary"
                      disabled={selectedIncident.status !== "open" || remediationState?.policy_status === "approved"}
                    >
                      <CheckCircle className="w-4 h-4" /> {remediationState?.policy_status === "approved" ? "Approved" : "Approve & Simulate"}
                    </button>
                    <button onClick={() => handleRemediate(selectedIncident.incident_id, "rollback")} className="btn-secondary" disabled={!remediationState?.rollback_token || remediationState?.policy_status === "rolled_back"}>
                      <RotateCcw className="w-4 h-4" /> Rollback
                    </button>
                  </div>
                </div>

                {/* Policy Status Badge */}
                {remediationState && (
                  <div className="card-base p-4">
                    <div className="flex items-center gap-4 flex-wrap">
                      <span className={`badge-pill ${
                        remediationState.policy_status === "approved" ? "health-good" :
                        remediationState.policy_status === "rolled_back" ? "health-poor" :
                        remediationState.policy_status === "pending_dual_approval" ? "bg-[#FDF3E0] text-[#E8B86D] border-[#FDF3E0]" :
                        "health-fair"
                      }`}>
                        {remediationState.policy_status === "pending_dual_approval" ? (
                          <>
                            <Users className="w-3 h-3 inline mr-1" />
                            Pending Dual Approval (First: {remediationState.approved_by})
                          </>
                        ) : remediationState.policy_status === "approved" ? (
                          <>
                            <ShieldCheck className="w-3 h-3 inline mr-1" />
                            Approved by {remediationState.approved_by}
                          </>
                        ) : remediationState.policy_status === "rolled_back" ? (
                          <>
                            <RotateCcw className="w-3 h-3 inline mr-1" />
                            Rolled Back by {remediationState.audit_trail?.rolled_back_by || "unknown"}
                          </>
                        ) : (
                          <>
                            <Info className="w-3 h-3 inline mr-1" />
                            {remediationState.policy_status}
                          </>
                        )}
                      </span>
                      {remediationState.policy_status === "pending_dual_approval" && dualApprovalPending && (
                        <button onClick={() => handleDualApproval(selectedIncident.incident_id)} className="btn-primary">
                          <Users className="w-4 h-4 mr-1" /> Second Operator Approve
                        </button>
                      )}
                      {remediationState.rollback_token && remediationState.policy_status !== "rolled_back" && (
                        <button onClick={() => handleRemediate(selectedIncident.incident_id, "rollback")} className="btn-destructive">
                          <RotateCcw className="w-4 h-4 mr-1" /> Execute Rollback
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Meta Grid */}
                <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
                  <div className="card-base p-4">
                    <div className="text-2xl font-bold text-[#1A1918] font-display">{selectedIncident.alert_count}</div>
                    <div className="text-sm text-[#7A746E]">Alert Count</div>
                  </div>
                  <div className="card-base p-4">
                    <div className="text-2xl font-bold text-[#1A1918] font-display">{selectedIncident.confidence.toFixed(0)}%</div>
                    <div className="text-sm text-[#7A746E]">Confidence</div>
                  </div>
                  <div className="card-base p-4">
                    <div className="text-2xl font-bold text-[#1A1918] font-display">{selectedIncident.llm_latency_ms}ms</div>
                    <div className="text-sm text-[#7A746E]">LLM Latency</div>
                  </div>
                  <div className="card-base p-4">
                    <div className="text-2xl font-bold text-[#1A1918] font-display">{selectedIncident.status}</div>
                    <div className="text-sm text-[#7A746E]">Status</div>
                  </div>
                  <div className="card-base p-4">
                    <div className="text-2xl font-bold text-[#1A1918] font-display">{selectedIncident.suppressed_duplicate_count ?? 0}</div>
                    <div className="text-sm text-[#7A746E]">Duplicates Suppressed</div>
                  </div>
                  <div className="card-base p-4">
                    <div className="text-2xl font-bold text-[#1A1918] font-display">{selectedIncident.affected_components?.length ?? 0}</div>
                    <div className="text-sm text-[#7A746E]">Affected Components</div>
                  </div>
                </div>

                {/* Explainable AIOps Detail Panel */}
                <div className="card-base p-4 space-y-4 border-l-4 border-[#C9D8DF] bg-[#F8FAF8]">
                  <h3 className="font-display font-medium text-[#1A1918] flex items-center gap-2">
                    <Brain className="w-5 h-5 text-[#C9D8DF]" />
                    Explainable AIOps Detail
                  </h3>

                  {/* Why Flagged */}
                  <div className="space-y-2">
                    <h4 className="font-display font-medium text-[#1A1918] flex items-center gap-2">
                      <Zap className="w-4 h-4 text-[#EFC2AE]" />
                      Why Flagged (Baseline vs Observed)
                    </h4>
                    <div className="font-mono text-sm text-[#1A1918] bg-[#F8F6F3] p-3 rounded-[8px] whitespace-pre-wrap border border-[#ECE7E2]">
                      {selectedIncident.why_flagged || "No baseline deviation data available"}
                    </div>
                  </div>

                  {/* Contributing Signals */}
                  <div className="space-y-2">
                    <h4 className="font-display font-medium text-[#1A1918] flex items-center gap-2">
                      <Signal className="w-4 h-4 text-[#C9D8DF]" />
                      Contributing Signals (Allow-listed Metadata Only)
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {selectedIncident.contributing_signals.map((signal, idx) => (
                        <span key={idx} className="signal-chip bg-[#F8F6F3] border border-[#ECE7E2]">{signal}</span>
                      ))}
                    </div>
                  </div>

                  {/* Confidence & Reasoning */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <h4 className="font-display font-medium text-[#1A1918] flex items-center gap-2">
                        <Activity className="w-4 h-4 text-[#EFC2AE]" />
                        Confidence
                      </h4>
                      <div className="card-base p-3">
                        <div className="text-3xl font-bold text-[#1A1918] font-display">{selectedIncident.confidence.toFixed(0)}%</div>
                        <div className="w-full bg-[#ECE7E2] rounded-full h-2 mt-2">
                          <div
                            className="bg-[#EFC2AE] h-2 rounded-full transition-all duration-500"
                            style={{ width: `${selectedIncident.confidence * 100}%` }}
                          />
                        </div>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <h4 className="font-display font-medium text-[#1A1918] flex items-center gap-2">
                        <FileText className="w-4 h-4 text-[#C9D8DF]" />
                        Reasoning Path
                      </h4>
                      <div className="card-base p-3">
                        <p className="text-[#1A1918] whitespace-pre-wrap">{selectedIncident.reasoning_path}</p>
                      </div>
                    </div>
                  </div>

                  {/* Action Rationale */}
                  <div className="space-y-2">
                    <h4 className="font-display font-medium text-[#1A1918] flex items-center gap-2">
                      <ShieldIcon className="w-4 h-4 text-[#EFC2AE]" />
                      Action Rationale (Why This Action)
                    </h4>
                    <div className="font-mono text-sm text-[#1A1918] bg-[#F8F6F3] p-3 rounded-[8px] whitespace-pre-wrap border border-[#ECE7E2]">
                      {selectedIncident.why_this_action || "No action rationale available"}
                    </div>
                  </div>
                </div>

                {/* Contributing Signals (Legacy Display) */}
                <div className="card-base p-4">
                  <h3 className="font-display font-medium text-[#1A1918] mb-3">All Contributing Signals</h3>
                  <div className="flex flex-wrap gap-2">
                    {selectedIncident.contributing_signals.map((signal, idx) => (
                      <span key={idx} className="signal-chip">{signal}</span>
                    ))}
                  </div>
                </div>

                {/* Z-Scores */}
                <div className="card-base p-4">
                  <h3 className="font-display font-medium text-[#1A1918] mb-3">Z-Scores (Anomaly Detection)</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {Object.entries(selectedIncident.z_scores).map(([metric, value]) => (
                      <div key={metric} className="card-base p-3 text-center">
                        <div className={`text-xl font-bold font-mono ${Math.abs(value) > 2.5 ? "text-[#D47A7A]" : "text-[#1A1918]"}`}>{value.toFixed(2)}</div>
                        <div className="text-xs text-[#7A746E] font-mono">{metric}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Metrics Snapshot */}
                <div className="card-base p-4">
                  <h3 className="font-display font-medium text-[#1A1918] mb-3">Metrics Snapshot at Detection</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {Object.entries(selectedIncident.metrics_snapshot).map(([metric, value]) => (
                      <div key={metric} className="card-base p-3 text-center">
                        <div className="text-xl font-bold text-[#1A1918] font-display">{typeof value === "number" ? value.toFixed(2) : value}</div>
                        <div className="text-xs text-[#7A746E] font-mono">{metric}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Affected Components */}
                {selectedIncident.affected_components?.length > 0 && (
                  <div className="card-base p-4">
                    <h3 className="font-display font-medium text-[#1A1918] mb-3 flex items-center gap-2">
                      <Server className="w-5 h-5 text-[#C9D8DF]" />
                      Affected Components (Cross-Category Correlation)
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {selectedIncident.affected_components.map((comp, idx) => (
                        <span key={idx} className="badge-pill bg-[#E8F2E8] text-[#6B9E6B] border-[#E8F2E8]">
                          <Server className="w-3 h-3 inline mr-1" />
                          {comp}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Recommended Action */}
                <div className="card-base p-4 gradient-cream-apricot border-l-4 border-[#EFC2AE]">
                  <h3 className="font-display font-medium text-[#1A1918] mb-2 flex items-center gap-2">
                    <CheckCircle className="w-5 h-5 text-[#EFC2AE]" />
                    Recommended Action
                  </h3>
                  <p className="text-[#1A1918]">{selectedIncident.recommended_action}</p>
                </div>

                {/* AOIM Triage */}
                {selectedIncident.aoim_triage && (
                  <div className="card-base p-4 gradient-lavender-cream border-l-4 border-[#D8C9E2]">
                    <h3 className="font-display font-medium text-[#1A1918] mb-3 flex items-center gap-2">
                      <GraduationCap className="w-5 h-5 text-[#D8C9E2]" />
                      AOIM Adaptive Triage
                    </h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div>
                        <div className="text-[#7A746E]">Recommended Tier</div>
                        <div className="font-bold text-[#1A1918]">{selectedIncident.aoim_triage.tier_label || selectedIncident.aoim_triage.recommended_tier}</div>
                      </div>
                      <div>
                        <div className="text-[#7A746E]">Confidence</div>
                        <div className="font-bold text-[#1A1918]">{(selectedIncident.aoim_triage.confidence * 100).toFixed(0)}%</div>
                      </div>
                      <div>
                        <div className="text-[#7A746E]">Dynamic Importance</div>
                        <div className="font-bold text-[#1A1918]">{selectedIncident.aoim_triage.dynamic_importance_score?.toFixed(2) || "N/A"}</div>
                      </div>
                      <div>
                        <div className="text-[#7A746E]">Feature Attributions</div>
                        <div className="font-bold text-[#1A1918]">{selectedIncident.aoim_triage.feature_attributions?.length || 0}</div>
                      </div>
                    </div>
                    {selectedIncident.aoim_triage.feature_attributions && selectedIncident.aoim_triage.feature_attributions.length > 0 && (
                      <div className="mt-3">
                        <div className="text-xs text-[#7A746E] mb-2">Feature Attributions:</div>
                        <div className="flex flex-wrap gap-2">
                          {selectedIncident.aoim_triage.feature_attributions.map((attr: any, idx: number) => (
                            <span key={idx} className="badge-pill bg-[#F8F6F3] text-[#1A1918] border-[#ECE7E2] font-mono text-xs">
                              {attr.feature}: {attr.weight.toFixed(3)} ({attr.direction})
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Security Summary */}
                {selectedIncident.security_summary && Object.keys(selectedIncident.security_summary).length > 0 && (
                  <div className="card-base p-4">
                    <h3 className="font-display font-medium text-[#1A1918] mb-3 flex items-center gap-2">
                      <ShieldAlert className="w-5 h-5 text-[#EFC2AE]" />
                      Security Summary
                    </h3>
                    <pre className="font-mono text-xs text-[#1A1918] bg-[#F8F6F3] p-3 rounded-[8px] overflow-auto">
                      {JSON.stringify(selectedIncident.security_summary, null, 2)}
                    </pre>
                  </div>
                )}

                {/* Audit Trail Timeline */}
                {(remediationState?.audit_trail || auditTrail.length > 0) && (
                  <div className="card-base p-4 border-l-4 border-[#EFC2AE] bg-[#FEF9F5]">
                    <h3 className="font-display font-medium text-[#1A1918] mb-4 flex items-center gap-2">
                      <Hash className="w-5 h-5 text-[#EFC2AE]" />
                      Audit Trail Timeline
                    </h3>
                    <div className="space-y-3">
                      {[
                        remediationState?.audit_trail,
                        ...auditTrail
                      ].filter(Boolean).map((entry, idx) => (
                        <div key={idx} className="flex items-start gap-3 p-3 bg-white rounded-[8px] border border-[#ECE7E2]">
                          <div className="flex flex-col items-center min-w-[120px] text-xs text-[#7A746E]">
                            <span className="font-mono">{entry.timestamp_utc ? new Date(entry.timestamp_utc).toLocaleString() : "N/A"}</span>
                            <span className={`badge-pill ${entry.policy_status === "approved" ? "health-good" : entry.policy_status === "rolled_back" ? "health-poor" : "health-fair"}`}>
                              {entry.policy_status}
                            </span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="font-mono text-sm text-[#1A1918]">{entry.approved_by || entry.rolled_back_by || "system"} - {entry.policy_status === "rolled_back" ? "Rollback executed" : "Remediation approved"}</div>
                            <div className="text-xs text-[#7A746E] mt-1">Hash: <span className="font-mono">{entry.audit_hash?.slice(0, 32)}...</span></div>
                            <div className="text-xs text-[#7A746E] mt-1">Index: <span className="font-mono">{entry.audit_index}</span></div>
                          </div>
                          <div className="min-w-[200px]">
                            <div className="text-xs text-[#7A746E] mb-1">Before State:</div>
                            <pre className="font-mono text-xs text-[#1A1918] bg-[#F8F6F3] p-2 rounded-[6px] overflow-auto max-h-[100px]">
                              {JSON.stringify(remediationState?.before_state || {}, null, 2)}
                            </pre>
                            <div className="text-xs text-[#7A746E] mt-2 mb-1">After State:</div>
                            <pre className="font-mono text-xs text-[#1A1918] bg-[#F8F6F3] p-2 rounded-[6px] overflow-auto max-h-[100px]">
                              {JSON.stringify(remediationState?.after_state || {}, null, 2)}
                            </pre>
                          </div>
                        </div>
                      ))}
                    </div>
                    {remediationState?.rollback_plan && (
                      <div className="mt-4 p-3 bg-[#FDF3E0] rounded-[8px] border border-[#FDE8E0]">
                        <div className="text-xs text-[#7A746E] mb-1">Rollback Plan:</div>
                        <div className="font-mono text-sm text-[#1A1918]">{remediationState.rollback_plan}</div>
                      </div>
                    )}
                    {remediationState?.rollback_token && (
                      <div className="mt-3 p-3 bg-[#F8F6F3] rounded-[8px] border border-[#ECE7E2]">
                        <div className="text-xs text-[#7A746E] mb-1">Rollback Token:</div>
                        <div className="font-mono text-xs text-[#1A1918] break-all">{remediationState.rollback_token}</div>
                      </div>
                    )}
                  </div>
                )}

              </div>
            ) : (
              <div className="section-card empty-state h-[500px]">
                <Brain className="empty-state-icon w-12 h-12 text-[#EFC2AE]" />
                <p className="empty-state-text text-lg">Select an incident to view explainable RCA</p>
                <p className="text-[#B8B3AC] text-sm mt-1">Click any incident from the list to see full details including Z-scores, contributing signals, and AI reasoning path</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}