"use client";

import { useState, useEffect, useCallback } from "react";
import { AppShell } from "@/components/AppShell";
import {
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
  BarChart3,
  FileText,
  GraduationCap,
  Sparkles,
  ZapIcon,
  ShieldIcon,
  Network,
  Cpu,
  HardDrive,
  Activity as ActivityIcon,
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
  Terminal,
  HardDrive as HardDriveIcon,
  MemoryStick,
  Thermometer,
  Zap as ZapIcon2,
} from "lucide-react";
import { formatDistanceToNow, parseISO } from "date-fns";

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

interface OutboxStats {
  total: number;
  pending: number;
  sent: number;
  failed: number;
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8001";
const TENANT_ID = "tenant_acme_corp";

function getAuthHeaders(): HeadersInit {
  return {
    "Authorization": "Bearer demo-token",
    "X-Tenant-ID": TENANT_ID,
    "Content-Type": "application/json",
  };
}

export function CollectorDashboard({ tenantId }: { tenantId: string }) {
  const [collectors, setCollectors] = useState<CollectorHealth[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryPayload[]>([]);
  const [outboxStats, setOutboxStats] = useState<OutboxStats>({ total: 0, pending: 0, sent: 0, failed: 0 });
  const [rawLogs, setRawLogs] = useState<any[]>([]);
  const [egressProofs, setEgressProofs] = useState<any[]>([]);
  const [sseConnected, setSseConnected] = useState(false);
  const [outageMode, setOutageMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [eventSource, setEventSource] = useState<EventSource | null>(null);
  const [selectedCollector, setSelectedCollector] = useState<CollectorHealth | null>(null);
  const [activeTab, setActiveTab] = useState<"fleet" | "telemetry" | "outbox" | "proof">("fleet");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [chaosScenario, setChaosScenario] = useState<string>("");

  const fetchData = useCallback(async () => {
    try {
      const [collectorsRes, telemetryRes, outboxRes, rawLogsRes, proofsRes] = await Promise.all([
        fetch(`${API_BASE}/local/collectors`, { headers: getAuthHeaders() }),
        fetch(`${API_BASE}/local/telemetry?limit=100`, { headers: getAuthHeaders() }),
        fetch(`${API_BASE}/local/outbox/stats`, { headers: getAuthHeaders() }),
        fetch(`${API_BASE}/local/raw-logs?limit=50`, { headers: getAuthHeaders() }),
        fetch(`${API_BASE}/local/egress-proof?limit=50`, { headers: getAuthHeaders() }),
      ]);

      if (collectorsRes.ok) setCollectors(await collectorsRes.json());
      if (telemetryRes.ok) setTelemetry(await telemetryRes.json());
      if (outboxRes.ok) setOutboxStats(await outboxRes.json());
      if (rawLogsRes.ok) setRawLogs(await rawLogsRes.json());
      if (proofsRes.ok) setEgressProofs(await proofsRes.json());
    } catch (error) {
      console.error("Failed to fetch collector data:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  // SSE for collector updates
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/local/stream?tenant_id=${TENANT_ID}`);
    es.onopen = () => setSseConnected(true);
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.collector_id) {
          setCollectors(prev => {
            const idx = prev.findIndex(c => c.collector_id === data.collector_id);
            if (idx >= 0) { const u = [...prev]; u[idx] = data; return u; }
            return [data, ...prev];
          });
        }
      } catch (e) {}
    };
    es.onerror = () => setSseConnected(false);
    setEventSource(es);
    return () => { es.close(); setSseConnected(false); };
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchData]);

  const handleToggleOutage = async () => {
    try {
      const res = await fetch(`${API_BASE}/local/chaos/outage`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ enabled: !outageMode }),
      });
      if (res.ok) setOutageMode(!outageMode);
    } catch (error) {
      console.error("Failed to toggle outage:", error);
    }
  };

  const handleChaosInject = async (scenario: string) => {
    try {
      await fetch(`${API_BASE}/local/chaos/inject`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ scenario }),
      });
      fetchData();
    } catch (error) {
      console.error("Chaos injection failed:", error);
    }
  };

  const getHealthClass = (state: string) => {
    switch (state) {
      case "Excellent": return "health-excellent";
      case "Good": return "health-good";
      case "Fair": return "health-fair";
      case "Poor": return "health-poor";
      default: return "health-fair";
    }
  };

  if (loading) {
    return (
      <AppShell tenantId={tenantId} tenantName="Acme Corp" sseConnected={sseConnected} outageMode={outageMode}>
        <div className="shell-content flex items-center justify-center h-full">
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-4 border-[#EFC2AE] border-t-transparent rounded-full animate-spin" />
            <p className="text-[#7A746E]">Loading Collector Dashboard...</p>
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
            <Server className="w-7 h-7 text-[#EFC2AE]" />
            Tier 1 Local Collector
          </h1>
          <p className="page-header-subtitle">Local ingestion, scrubbing, pseudonymization, outbox queue & egress proof panel</p>
        </div>

        {/* Collector Selector + Status */}
        <div className="card-base p-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <label className="text-sm text-[#7A746E]">Collector:</label>
              <select
                value={selectedCollector?.collector_id || ""}
                onChange={(e) => {
                  const c = collectors.find(col => col.collector_id === e.target.value);
                  setSelectedCollector(c || null);
                }}
                className="input-base w-auto px-3 py-1.5 text-xs"
              >
                <option value="">Select Collector</option>
                {collectors.map(c => (
                  <option key={c.collector_id} value={c.collector_id}>
                    {c.collector_id} ({c.health_state})
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1.5 text-sm text-[#7A746E] cursor-pointer">
                <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} className="w-4 h-4 rounded border-[#ECE7E2] text-[#1A1918] focus:ring-[#C9D8DF]" />
                Auto-refresh (10s)
              </label>
              <button onClick={fetchData} className="btn-ghost p-2" disabled={loading}>
                <RefreshCw className={`w-5 h-5 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>
            <div className="flex items-center gap-3">
              <span className={`live-indicator ${sseConnected ? "" : "text-[#D47A7A]"}`}>
                {sseConnected ? "Live" : "Offline"}
              </span>
              <button onClick={handleToggleOutage} className={`btn-secondary px-3 py-1.5 ${outageMode ? "bg-[#FDE8E8] text-[#D47A7A] border-[#FDE8E8]" : ""}`}>
                {outageMode ? (
                  <> <WifiOff className="w-4 h-4" /> <span>Outage Mode</span> </>
                ) : (
                  <> <Wifi className="w-4 h-4" /> <span>Simulate Outage</span> </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="card-base p-2">
          <div className="flex gap-1" role="tablist">
            {[
              { id: "fleet", label: "Fleet Health", icon: Server },
              { id: "telemetry", label: "Local Telemetry", icon: ActivityIcon },
              { id: "outbox", label: "Outbox Queue", icon: Database },
              { id: "proof", label: "Egress Proof", icon: ShieldCheck },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`px-4 py-2 rounded-[8px] text-sm font-medium transition-colors flex items-center gap-2 ${
                  activeTab === tab.id ? "gradient-blush-sand text-[#1A1918] shadow-card" : "text-[#7A746E] hover:bg-[#F0EDE8]"
                }`}
                role="tab"
                aria-selected={activeTab === tab.id}
              >
                <tab.icon className="w-4 h-4" />
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tab Content */}
        {activeTab === "fleet" && (
          <div className="space-y-6">
            {/* Fleet Overview */}
            <div className="data-grid">
              {collectors.map(collector => (
                <div key={collector.collector_id} className={`card-base p-4 ${selectedCollector?.collector_id === collector.collector_id ? "border-2 border-[#EFC2AE]" : ""}`}>
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-display font-semibold text-[#1A1918]">{collector.collector_id}</span>
                        <span className={`badge-pill ${getHealthClass(collector.health_state)}`}>{collector.health_state}</span>
                      </div>
                      <p className="text-sm text-[#7A746E] mt-1">{collector.state_reason}</p>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-xs text-[#7A746E]">v{collector.version}</div>
                      <div className="font-mono text-xs text-[#7A746E]">{formatDistanceToNow(parseISO(collector.last_heartbeat_utc), { addSuffix: true })}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-[#ECE7E2]">
                    <div className="card-base p-3 text-center">
                      <Cpu className="w-5 h-5 text-[#EFC2AE] mx-auto mb-1" />
                      <div className="text-xl font-bold text-[#1A1918]">{collector.collector_cpu_pct.toFixed(1)}%</div>
                      <div className="text-xs text-[#7A746E]">CPU</div>
                    </div>
                    <div className="card-base p-3 text-center">
                      <MemoryStick className="w-5 h-5 text-[#EFC2AE] mx-auto mb-1" />
                      <div className="text-xl font-bold text-[#1A1918]">{collector.collector_mem_mb.toFixed(0)}MB</div>
                      <div className="text-xs text-[#7A746E]">Memory</div>
                    </div>
                  </div>
                  {collector.state_transitions.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-[#ECE7E2]">
                      <div className="text-xs font-medium text-[#7A746E] mb-1">Recent Transitions</div>
                      <div className="space-y-1">
                        {collector.state_transitions.slice(-3).map((t, i) => (
                          <div key={i} className="text-xs text-[#7A746E] font-mono flex items-center gap-1">
                            <span>{t.from}</span>
                            <span className="text-[#EFC2AE]">→</span>
                            <span className="font-medium">{t.to}</span>
                            <span className="text-[#B8B3AC]">{formatDistanceToNow(parseISO(t.timestamp), { addSuffix: true })}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "telemetry" && (
          <div className="section-card">
            <div className="flex items-center justify-between mb-4">
              <h2 className="section-card-title flex items-center gap-2">
                <ActivityIcon className="w-5 h-5 text-[#EFC2AE]" />
                Local Telemetry Events
              </h2>
            </div>
            <div className="table-container">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Payload ID</th>
                    <th>Source</th>
                    <th>Category</th>
                    <th>Severity</th>
                    <th>Health</th>
                    <th>Time</th>
                    <th>Metrics</th>
                  </tr>
                </thead>
                <tbody>
                  {telemetry.length === 0 ? (
                    <tr><td colSpan={7} className="text-center py-8 text-[#7A746E]">No telemetry events</td></tr>
                  ) : (
                    telemetry.slice(0, 50).map(event => (
                      <tr key={event.payload_id}>
                        <td className="font-mono text-xs max-w-[120px] truncate">{event.payload_id}</td>
                        <td className="font-mono text-sm">{event.source_id}</td>
                        <td><span className="badge-pill bg-[#F0EDE8] text-[#7A746E]">{event.event_category}</span></td>
                        <td><span className="badge-pill bg-[#F0EDE8] text-[#7A746E]">{event.severity}</span></td>
                        <td><span className={`badge-pill ${getHealthClass(event.health_state)}`}>{event.health_state}</span></td>
                        <td className="text-sm text-[#7A746E]">{formatDistanceToNow(parseISO(event.event_timestamp_utc), { addSuffix: true })}</td>
                        <td className="font-mono text-xs text-[#7A746E]">
                          CPU: {event.metrics.cpu_pct?.toFixed(1) ?? "—"}% | Mem: {event.metrics.memory_mb?.toFixed(0) ?? "—"}MB
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === "outbox" && (
          <div className="space-y-6">
            {/* Outbox Stats */}
            <div className="data-grid">
              <div className="kpi-card">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="kpi-card value">{outboxStats.total}</div>
                    <div className="kpi-card label">Total Queued</div>
                  </div>
                  <Database className="w-8 h-8 text-[#C9D8DF]" />
                </div>
              </div>
              <div className="kpi-card">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="kpi-card value text-[#E8B86D]">{outboxStats.pending}</div>
                    <div className="kpi-card label">Pending</div>
                  </div>
                  <RotateCcw className="w-8 h-8 text-[#E8B86D]" />
                </div>
              </div>
              <div className="kpi-card">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="kpi-card value text-[#6B9E6B]">{outboxStats.sent}</div>
                    <div className="kpi-card label">Sent</div>
                  </div>
                  <CheckCircle className="w-8 h-8 text-[#6B9E6B]" />
                </div>
              </div>
              <div className="kpi-card">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="kpi-card value text-[#D47A7A]">{outboxStats.failed}</div>
                    <div className="kpi-card label">Failed</div>
                  </div>
                  <XCircle className="w-8 h-8 text-[#D47A7A]" />
                </div>
              </div>
            </div>

            {/* Chaos Engineering */}
            <div className="card-base p-4 gradient-lavender-cream border-l-4 border-[#D8C9E2]">
              <h3 className="font-display font-medium text-[#1A1918] mb-3 flex items-center gap-2">
                <ZapIcon2 className="w-5 h-5 text-[#D8C9E2]" />
                Chaos Engineering Scenarios
              </h3>
              <p className="text-sm text-[#7A746E] mb-4">Inject failures to test outage buffering & recovery</p>
              <div className="flex flex-wrap gap-2">
                {[
                  { id: "network_partition", label: "Network Partition", desc: "Simulate Tier 1 ↔ Tier 2 connectivity loss" },
                  { id: "collector_crash", label: "Collector Crash", desc: "Kill collector process mid-ingestion" },
                  { id: "disk_full", label: "Disk Full", desc: "Simulate SQLite WAL disk exhaustion" },
                  { id: "encryption_key_rotation", label: "Key Rotation", desc: "Rotate AES-256 key mid-operation" },
                  { id: "timestamp_drift", label: "Clock Drift", desc: "Inject NTP drift >60s" },
                  { id: "malformed_payload", label: "Malformed Payload", desc: "Send invalid JSON to ingest" },
                  { id: "rate_limit_exceeded", label: "Rate Limit", desc: "Exceed Tier 2 ingest rate limits" },
                  { id: "tls_cert_expiry", label: "TLS Expiry", desc: "Expired cert on ingest endpoint" },
                ].map(scenario => (
                  <button
                    key={scenario.id}
                    onClick={() => handleChaosInject(scenario.id)}
                    className="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5"
                    title={scenario.desc}
                  >
                    <Terminal className="w-3 h-3" />
                    {scenario.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === "proof" && (
          <div className="space-y-6">
            <h2 className="section-card-title flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-[#EFC2AE]" />
              Egress Proof Panel — Side-by-Side Raw vs Redacted
            </h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Raw Logs */}
              <div className="section-card">
                <h3 className="font-display font-medium text-[#1A1918] mb-3 flex items-center gap-2">
                  <HardDriveIcon className="w-5 h-5 text-[#EFC2AE]" />
                  Tier 1 Raw Logs (Encrypted at Rest)
                </h3>
                <div className="proof-panel max-h-[500px] font-mono text-xs">
                  {rawLogs.length === 0 ? (
                    <div className="empty-state py-8"><HardDriveIcon className="empty-state-icon w-8 h-8" /><p className="empty-state-text">No raw logs stored</p></div>
                  ) : (
                    rawLogs.slice(0, 20).map((log, idx) => (
                      <div key={idx} className="mb-3 p-3 bg-[#F8F6F3] rounded-[8px] border border-[#ECE7E2]">
                        <div className="flex items-center justify-between mb-1 text-xs text-[#7A746E]">
                          <span className="font-mono">{log.payload_id}</span>
                          <span>{formatDistanceToNow(parseISO(log.received_at_utc), { addSuffix: true })}</span>
                        </div>
                        <pre className="text-xs overflow-auto max-h-[150px]">{JSON.stringify(log.raw_payload, null, 2)}</pre>
                        <div className="flex items-center gap-2 mt-1 text-xs text-[#7A746E]">
                          <span>Redactions: {log.redacted_fields_count}</span>
                          <span className="font-mono">{JSON.stringify(log.redaction_types)}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Egress Proofs */}
              <div className="section-card">
                <h3 className="font-display font-medium text-[#1A1918] mb-3 flex items-center gap-2">
                  <ShieldCheck className="w-5 h-5 text-[#EFC2AE]" />
                  Tier 2 Egress Payloads (Allow-Listed Only)
                </h3>
                <div className="proof-panel max-h-[500px] font-mono text-xs">
                  {egressProofs.length === 0 ? (
                    <div className="empty-state py-8"><ShieldCheck className="empty-state-icon w-8 h-8" /><p className="empty-state-text">No egress proofs logged</p></div>
                  ) : (
                    egressProofs.slice(0, 20).map((proof, idx) => (
                      <div key={idx} className="mb-3 p-3 bg-[#F8F6F3] rounded-[8px] border border-[#ECE7E2]">
                        <div className="flex items-center justify-between mb-1 text-xs text-[#7A746E]">
                          <span className="font-mono">{proof.payload_id}</span>
                          <span>{formatDistanceToNow(parseISO(proof.logged_at_utc), { addSuffix: true })}</span>
                        </div>
                        <pre className="text-xs overflow-auto max-h-[150px]">{JSON.stringify(proof.egress_payload, null, 2)}</pre>
                        <div className="flex items-center gap-2 mt-1 text-xs text-[#7A746E]">
                          <span>Scrub: {proof.scrub_result?.redactions_count ?? 0}</span>
                          <span className="font-mono">{JSON.stringify(proof.scrub_result?.redaction_types ?? [])}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}