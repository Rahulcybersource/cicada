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
  const [slaMetrics, setSlaMetrics] = useState<SlaMetrics | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [outageMode, setOutageMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [eventSource, setEventSource] = useState<EventSource | null>(null);
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterSeverity, setFilterSeverity] = useState<string>("all");
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [incidentsRes, slaRes] = await Promise.all([
        fetch(`${API_BASE}/api/v1/incidents?limit=200`, { headers: getAuthHeaders() }),
        fetch(`${API_BASE}/api/v1/sla/metrics`, { headers: getAuthHeaders() }),
      ]);

      if (incidentsRes.ok) {
        const data = await incidentsRes.json();
        setIncidents(data);
      }
      if (slaRes.ok) {
        const data = await slaRes.json();
        setSlaMetrics(data);
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

  const handleRemediate = async (incidentId: string, action: "approve" | "rollback") => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/incidents/${incidentId}/remediate`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ action, operator_id: "demo-operator" }),
      });
      if (res.ok) {
        const result = await res.json();
        alert(`${action} result: ${result.status} - ${result.message}`);
        fetchData();
      }
    } catch (error) {
      console.error("Remediation failed:", error);
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
                          </div>
                          <p className="text-xs text-[#7A746E] mt-1 truncate">{incident.reasoning_path}</p>
                          <div className="flex items-center gap-2 mt-1 text-xs text-[#B8B3AC]">
                            <span className="font-mono">{incident.alert_count} alerts</span>
                            <span className="font-mono">{incident.confidence.toFixed(0)}%</span>
                            <span className="font-mono">{incident.llm_latency_ms}ms</span>
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
                    <button onClick={() => handleRemediate(selectedIncident.incident_id, "approve")} className="btn-primary" disabled={selectedIncident.status !== "open"}>
                      <CheckCircle className="w-4 h-4" /> Approve
                    </button>
                    <button onClick={() => handleRemediate(selectedIncident.incident_id, "rollback")} className="btn-secondary">
                      <RotateCcw className="w-4 h-4" /> Rollback
                    </button>
                  </div>
                </div>

                {/* Meta Grid */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
                </div>

                {/* Contributing Signals */}
                <div className="card-base p-4">
                  <h3 className="font-display font-medium text-[#1A1918] mb-3">Contributing Signals</h3>
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

                {/* Recommended Action */}
                <div className="card-base p-4 gradient-cream-apricot border-l-4 border-[#EFC2AE]">
                  <h3 className="font-display font-medium text-[#1A1918] mb-2">Recommended Action</h3>
                  <p className="text-[#1A1918]">{selectedIncident.recommended_action}</p>
                </div>

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