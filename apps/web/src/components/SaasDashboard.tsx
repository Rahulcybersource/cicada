"use client";

import { useState, useEffect, useCallback } from "react";
import { AppShell } from "@/components/AppShell";
import {
  LayoutDashboard,
  Server,
  Database,
  Activity,
  TrendingUp,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Info,
  AlertCircle,
  Clock,
  Users,
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
  Zap,
  Brain,
  BarChart3,
} from "lucide-react";
import { formatDistanceToNow, parseISO } from "date-fns";

interface TelemetryPayload {
  payload_id: string;
  tenant_id: string;
  source_id: string;
  event_timestamp_utc: string;
  event_category: string;
  severity: string;
  health_state: string;
  metrics: Record<string, number>;
  security_summary: Record<string, any> | null;
  alert_context: string | null;
  collector_meta: Record<string, any>;
}

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

interface CollectorHealth {
  collector_id: string;
  tenant_id: string;
  region_id: string;
  version: string;
  collector_cpu_pct: number;
  collector_mem_mb: number;
  health_state: string;
  last_heartbeat_utc: string;
  state_reason: string;
  state_transitions: Array<{ from: string; to: string; timestamp: string; reason: string }>;
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

export function SaasDashboard({ tenantId }: { tenantId: string }) {
  const [telemetry, setTelemetry] = useState<TelemetryPayload[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [collectors, setCollectors] = useState<CollectorHealth[]>([]);
  const [slaMetrics, setSlaMetrics] = useState<SlaMetrics | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [outageMode, setOutageMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [eventSource, setEventSource] = useState<EventSource | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Fetch initial data
  const fetchData = useCallback(async () => {
    try {
      const [telemetryRes, incidentsRes, collectorsRes, slaRes] = await Promise.all([
        fetch(`${API_BASE}/api/v1/telemetry?limit=100`, { headers: getAuthHeaders() }),
        fetch(`${API_BASE}/api/v1/incidents?limit=100`, { headers: getAuthHeaders() }),
        fetch(`${API_BASE}/api/v1/fleet/health`, { headers: getAuthHeaders() }),
        fetch(`${API_BASE}/api/v1/sla/metrics`, { headers: getAuthHeaders() }),
      ]);

      if (telemetryRes.ok) {
        const data = await telemetryRes.json();
        setTelemetry(data);
      }
      if (incidentsRes.ok) {
        const data = await incidentsRes.json();
        setIncidents(data);
      }
      if (collectorsRes.ok) {
        const data = await collectorsRes.json();
        setCollectors(data);
      }
      if (slaRes.ok) {
        const data = await slaRes.json();
        setSlaMetrics(data);
      }
    } catch (error) {
      console.error("Failed to fetch dashboard data:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  // SSE Connection
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/v1/stream?tenant_id=${TENANT_ID}`, {
      withCredentials: false,
    });

    es.onopen = () => {
      setSseConnected(true);
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (event.type || "telemetry") {
          case "incident":
            setIncidents(prev => [data, ...prev.slice(0, 99)]);
            break;
          case "telemetry":
            setTelemetry(prev => [data, ...prev.slice(0, 199)]);
            break;
          case "collector":
            setCollectors(prev => {
              const idx = prev.findIndex(c => c.collector_id === data.collector_id);
              if (idx >= 0) {
                const updated = [...prev];
                updated[idx] = data;
                return updated;
              }
              return [data, ...prev];
            });
            break;
        }
      } catch (e) {
        // Ignore parse errors
      }
    };

    es.onerror = () => {
      setSseConnected(false);
    };

    setEventSource(es);

    return () => {
      es.close();
      setSseConnected(false);
    };
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-refresh
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
      if (res.ok) {
        setOutageMode(!outageMode);
      }
    } catch (error) {
      console.error("Failed to toggle outage:", error);
    }
  };

  const handleTenantChange = (newTenantId: string) => {
    // In a real app, this would update the tenant context
    console.log("Tenant changed to:", newTenantId);
  };

  // Filter telemetry by category
  const filteredTelemetry = selectedCategory === "all"
    ? telemetry
    : telemetry.filter(t => t.event_category === selectedCategory);

  const categories = ["all", "infrastructure", "network", "security", "heartbeat"];

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
      case "critical": return "bg-[#FDE8E8] text-[#D47A7A]";
      case "warning": return "bg-[#FDF3E0] text-[#E8B86D]";
      default: return "bg-[#E8F2E8] text-[#6B9E6B]";
    }
  };

  const getAiProviderClass = (provider: string) => {
    switch (provider) {
      case "groq": return "ai-groq";
      case "gemini": return "ai-gemini";
      default: return "ai-deterministic";
    }
  };

  if (loading) {
    return (
      <AppShell
        tenantId={tenantId}
        tenantName="Acme Corp"
        sseConnected={sseConnected}
        outageMode={outageMode}
        onTenantChange={handleTenantChange}
        onToggleOutage={handleToggleOutage}
      >
        <div className="shell-content flex items-center justify-center h-full">
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-4 border-[#EFC2AE] border-t-transparent rounded-full animate-spin" />
            <p className="text-[#7A746E]">Loading SaaS Dashboard...</p>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell
      tenantId={tenantId}
      tenantName="Acme Corp"
      sseConnected={sseConnected}
      outageMode={outageMode}
      onTenantChange={handleTenantChange}
      onToggleOutage={handleToggleOutage}
    >
      <div className="shell-content space-y-6">
        {/* Page Header */}
        <div className="page-header">
          <h1 className="page-header-title">SaaS Dashboard</h1>
          <p className="page-header-subtitle">Multi-tenant fleet overview, SLA metrics & real-time telemetry</p>
        </div>

        {/* KPI Row */}
        <div className="data-grid">
          <div className="kpi-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="kpi-card value">{slaMetrics?.active_incidents ?? 0}</div>
                <div className="kpi-card label">Active Incidents</div>
              </div>
              <div className="w-12 h-12 rounded-[12px] gradient-blush-sand flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-[#EFC2AE]" aria-hidden="true" />
              </div>
            </div>
          </div>
          <div className="kpi-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="kpi-card value">{collectors.length}</div>
                <div className="kpi-card label">Active Collectors</div>
              </div>
              <div className="w-12 h-12 rounded-[12px] gradient-sage-mist flex items-center justify-center">
                <Server className="w-6 h-6 text-[#C9D8DF]" aria-hidden="true" />
              </div>
            </div>
          </div>
          <div className="kpi-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="kpi-card value">{slaMetrics?.tracked_sources ?? 0}</div>
                <div className="kpi-card label">Tracked Sources</div>
              </div>
              <div className="w-12 h-12 rounded-[12px] gradient-cream-apricot flex items-center justify-center">
                <Database className="w-6 h-6 text-[#EFC2AE]" aria-hidden="true" />
              </div>
            </div>
          </div>
          <div className="kpi-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="kpi-card value">{telemetry.length}</div>
                <div className="kpi-card label">Events (Last 100)</div>
              </div>
              <div className="w-12 h-12 rounded-[12px] gradient-lavender-cream flex items-center justify-center">
                <Activity className="w-6 h-6 text-[#D8C9E2]" aria-hidden="true" />
              </div>
            </div>
          </div>
        </div>

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Live Telemetry Feed + Collectors */}
          <div className="lg:col-span-2 space-y-6">
            {/* Live Feed */}
            <div className="section-card flex flex-col h-[500px]">
              <div className="flex items-center justify-between mb-4">
                <h2 className="section-card-title flex items-center gap-2">
                  <Zap className="w-5 h-5 text-[#EFC2AE]" aria-hidden="true" />
                  Live Telemetry Feed
                </h2>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-sm text-[#7A746E] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoRefresh}
                      onChange={(e) => setAutoRefresh(e.target.checked)}
                      className="w-4 h-4 rounded border-[#ECE7E2] text-[#1A1918] focus:ring-[#C9D8DF]"
                    />
                    Auto-refresh
                  </label>
                  <select
                    value={selectedCategory}
                    onChange={(e) => setSelectedCategory(e.target.value)}
                    className="input-base w-auto px-3 py-1.5 text-xs"
                  >
                    {categories.map(cat => (
                      <option key={cat} value={cat}>{cat === "all" ? "All Categories" : cat.charAt(0).toUpperCase() + cat.slice(1)}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto space-y-2">
                {filteredTelemetry.length === 0 ? (
                  <div className="empty-state h-full">
                    <Activity className="empty-state-icon w-8 h-8" />
                    <p className="empty-state-text">No telemetry events yet</p>
                  </div>
                ) : (
                  filteredTelemetry.slice(0, 50).map((event) => (
                    <div
                      key={event.payload_id}
                      className="card-base p-3 animate-slide-in border-l-2 border-[#C9D8DF]"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm text-[#1A1918] truncate">
                              {event.event_category} • {event.source_id}
                            </span>
                            <span className={`badge-pill ${getHealthClass(event.health_state)}`}>
                              {event.health_state}
                            </span>
                            <span className={`badge-pill ${getSeverityClass(event.severity)}`}>
                              {event.severity}
                            </span>
                          </div>
                          <p className="text-xs text-[#7A746E] mt-1 font-mono">
                            {event.payload_id} • {formatDistanceToNow(parseISO(event.event_timestamp_utc), { addSuffix: true })}
                          </p>
                        </div>
                        <div className="text-xs text-[#B8B3AC] shrink-0 font-mono">
                          {event.metrics.cpu_pct?.toFixed(1) ?? "—"}% CPU
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Collector Fleet Health */}
            <div className="section-card">
              <h2 className="section-card-title flex items-center gap-2">
                <Server className="w-5 h-5 text-[#EFC2AE]" aria-hidden="true" />
                Collector Fleet Health
              </h2>
              <div className="table-container">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Collector ID</th>
                      <th>Health</th>
                      <th>Last Heartbeat</th>
                      <th>Version</th>
                      <th>Resources</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {collectors.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center py-8 text-[#7A746E]">No collectors registered</td>
                      </tr>
                    ) : (
                      collectors.map((collector) => (
                        <tr key={collector.collector_id}>
                          <td className="font-mono text-sm">{collector.collector_id}</td>
                          <td>
                            <span className={`badge-pill ${getHealthClass(collector.health_state)}`}>
                              {collector.health_state}
                            </span>
                          </td>
                          <td className="text-sm text-[#7A746E]">
                            {formatDistanceToNow(parseISO(collector.last_heartbeat_utc), { addSuffix: true })}
                          </td>
                          <td className="font-mono text-xs text-[#7A746E]">{collector.version}</td>
                          <td className="text-sm">
                            <div className="flex items-center gap-2 text-xs">
                              <span><Activity className="w-3 h-3 inline" /> {collector.collector_cpu_pct.toFixed(1)}%</span>
                              <span><Database className="w-3 h-3 inline" /> {collector.collector_mem_mb.toFixed(0)}MB</span>
                            </div>
                          </td>
                          <td className="text-sm text-[#7A746E] max-w-xs truncate">{collector.state_reason}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Right: SLA Metrics + Incidents Summary */}
          <div className="space-y-6">
            {/* SLA Metrics */}
            <div className="section-card">
              <h2 className="section-card-title flex items-center gap-2">
                <BarChart3 className="w-5 h-5 text-[#EFC2AE]" aria-hidden="true" />
                Measured SLA Metrics
              </h2>
              <div className="grid grid-cols-2 gap-3">
                <div className="sla-card p-3">
                  <div className="metric-value text-2xl">{slaMetrics?.active_incidents ?? 0}</div>
                  <div className="metric-label">Active Incidents</div>
                </div>
                <div className="sla-card p-3">
                  <div className="metric-value text-2xl">{slaMetrics?.tracked_sources ?? 0}</div>
                  <div className="metric-label">Tracked Sources</div>
                </div>
              </div>
              <div className="space-y-2 text-xs text-[#7A746E] mt-4 pt-4 border-t border-[#ECE7E2]">
                <div className="flex justify-between"><span>Z-Score Threshold</span><span className="font-mono text-[#1A1918]">{slaMetrics?.z_score_threshold ?? 2.5}</span></div>
                <div className="flex justify-between"><span>Correlation Window</span><span className="font-mono text-[#1A1918]">{slaMetrics?.correlation_window_seconds ?? 120}s</span></div>
                <div className="flex justify-between"><span>Heartbeat Timeout</span><span className="font-mono text-[#1A1918]">{slaMetrics?.heartbeat_timeout_seconds ?? 60}s</span></div>
              </div>
            </div>

            {/* Recent Incidents */}
            <div className="section-card">
              <h2 className="section-card-title flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-[#EFC2AE]" aria-hidden="true" />
                Recent Incidents
              </h2>
              <div className="space-y-3 max-h-[400px] overflow-y-auto">
                {incidents.length === 0 ? (
                  <div className="empty-state py-8">
                    <AlertTriangle className="empty-state-icon w-8 h-8" />
                    <p className="empty-state-text">No incidents detected</p>
                  </div>
                ) : (
                  incidents.slice(0, 10).map((incident) => (
                    <div
                      key={incident.incident_id}
                      className={`incident-card ${incident.severity === "critical" ? "critical" : incident.severity === "warning" ? "warning" : ""}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-sm text-[#1A1918]">{incident.incident_id}</span>
                            <span className={`badge-pill ${getSeverityClass(incident.severity)}`}>
                              {incident.severity}
                            </span>
                            <span className={`badge-pill ${getAiProviderClass(incident.ai_provider)}`}>
                              {incident.ai_provider.toUpperCase()}
                            </span>
                          </div>
                          <p className="text-sm text-[#7A746E] mt-1">{incident.reasoning_path}</p>
                          <div className="flex items-center gap-3 mt-2 text-xs text-[#7A746E]">
                            <span className="font-mono">{incident.alert_count} alerts</span>
                            <span className="font-mono">{incident.confidence.toFixed(0)}% confidence</span>
                            <span className="font-mono">{incident.llm_latency_ms}ms LLM</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* System Status */}
            <div className="section-card">
              <h2 className="section-card-title flex items-center gap-2">
                <Shield className="w-5 h-5 text-[#EFC2AE]" aria-hidden="true" />
                System Status
              </h2>
              <div className="space-y-3">
                <div className="card-base p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {sseConnected ? <Wifi className="w-5 h-5 text-[#6B9E6B]" /> : <WifiOff className="w-5 h-5 text-[#D47A7A]" />}
                      <span className="font-medium text-sm text-[#1A1918]">SSE Stream</span>
                    </div>
                    <span className={`badge-pill ${sseConnected ? "health-excellent" : "health-poor"}`}>
                      {sseConnected ? "Connected" : "Disconnected"}
                    </span>
                  </div>
                </div>
                <div className="card-base p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {outageMode ? <WifiOff className="w-5 h-5 text-[#D47A7A]" /> : <Wifi className="w-5 h-5 text-[#6B9E6B]" />}
                      <span className="font-medium text-sm text-[#1A1918]">Ingest Endpoint</span>
                    </div>
                    <span className={`badge-pill ${outageMode ? "health-poor" : "health-excellent"}`}>
                      {outageMode ? "Outage Mode" : "Healthy"}
                    </span>
                  </div>
                </div>
                <div className="card-base p-3">
                  <div className="flex items-center gap-2">
                    <Shield className="w-5 h-5 text-[#6B9E6B]" />
                    <span className="font-medium text-sm text-[#1A1918]">Data Integrity</span>
                  </div>
                </div>
                <div className="card-base p-3">
                  <div className="flex items-center gap-2">
                    <Brain className="w-5 h-5 text-[#EFC2AE]" />
                    <span className="font-medium text-sm text-[#1A1918]">Hybrid AIOps</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}