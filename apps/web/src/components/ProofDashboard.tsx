"use client";

import { useState, useEffect, useCallback } from "react";
import { AppShell } from "@/components/AppShell";
import {
  ShieldCheck,
  ShieldAlert,
  Database,
  Server,
  FileText,
  Search,
  Filter,
  Download,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Copy,
  Check,
  AlertTriangle,
  Hash,
  Key,
  Lock,
  Unlock,
  Terminal,
  Zap,
  Brain,
  GraduationCap,
  Sparkles,
  ZapIcon,
  ShieldIcon,
  Network,
  Cpu,
  HardDrive,
  Activity,
  Bell,
  BellOff,
  User,
  Users,
  Lock as LockIcon,
  Unlock as UnlockIcon,
  Key as KeyIcon,
  Hash as HashIcon,
  ShieldCheck as ShieldCheckIcon,
  ShieldAlert as ShieldAlertIcon,
  XCircle,
} from "lucide-react";
import { formatDistanceToNow, parseISO } from "date-fns";

interface RawLog {
  id: number;
  tenant_id: string;
  collector_id: string;
  source_id: string;
  raw_payload: any;
  event_timestamp_utc: string;
  received_at_utc: string;
  redacted_fields_count: number;
  redaction_types: string[];
  payload_id?: string;
}

interface EgressProof {
  id: number;
  payload_id: string;
  tenant_id: string;
  egress_payload: any;
  scrub_result: { redactions_count: number; redaction_types: string[] };
  logged_at_utc: string;
}

const API_BASE_T1 = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8001";
const API_BASE_T2 = process.env.NEXT_PUBLIC_TIER2_API_BASE || "http://localhost:8000";
const TENANT_ID = "tenant_acme_corp";

function getAuthHeaders(): HeadersInit {
  return {
    "Authorization": "Bearer demo-token",
    "X-Tenant-ID": TENANT_ID,
    "Content-Type": "application/json",
  };
}

export function ProofDashboard({ tenantId }: { tenantId: string }) {
  const [rawLogs, setRawLogs] = useState<RawLog[]>([]);
  const [egressProofs, setEgressProofs] = useState<EgressProof[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRawLog, setSelectedRawLog] = useState<RawLog | null>(null);
  const [selectedEgressProof, setSelectedEgressProof] = useState<EgressProof | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterRedaction, setFilterRedaction] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"side-by-side" | "raw" | "egress">("side-by-side");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [syncScroll, setSyncScroll] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [rawRes, egressRes] = await Promise.all([
        fetch(`${API_BASE_T1}/local/raw-logs?limit=100`, { headers: getAuthHeaders() }),
        fetch(`${API_BASE_T1}/local/egress-proof?limit=100`, { headers: getAuthHeaders() }),
      ]);
      if (rawRes.ok) setRawLogs(await rawRes.json());
      if (egressRes.ok) setEgressProofs(await egressRes.json());
    } catch (error) {
      console.error("Failed to fetch proof data:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchData]);

  // Get all unique redaction types
  const allRedactionTypes = Array.from(new Set([
    ...rawLogs.flatMap(l => l.redaction_types),
    ...egressProofs.flatMap(p => p.scrub_result?.redaction_types || []),
  ])).filter(Boolean);

  // Filter logs
  const filteredRawLogs = rawLogs.filter(log => {
    if (searchQuery && !JSON.stringify(log.raw_payload).toLowerCase().includes(searchQuery.toLowerCase())) return false;
    if (filterRedaction !== "all" && !log.redaction_types.includes(filterRedaction)) return false;
    return true;
  });

  const filteredEgressProofs = egressProofs.filter(proof => {
    if (searchQuery && !JSON.stringify(proof.egress_payload).toLowerCase().includes(searchQuery.toLowerCase())) return false;
    if (filterRedaction !== "all" && !proof.scrub_result?.redaction_types.includes(filterRedaction)) return false;
    return true;
  });

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
  };

  const formatJson = (obj: any) => JSON.stringify(obj, null, 2);

  const highlightSecrets = (text: string) => {
    // This would be enhanced with proper syntax highlighting
    return text;
  };

  if (loading) {
    return (
      <AppShell tenantId={tenantId} tenantName="Acme Corp">
        <div className="shell-content flex items-center justify-center h-full">
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-4 border-[#EFC2AE] border-t-transparent rounded-full animate-spin" />
            <p className="text-[#7A746E]">Loading Egress Proof Panel...</p>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell tenantId={tenantId} tenantName="Acme Corp">
      <div className="shell-content space-y-6">
        {/* Page Header */}
        <div className="page-header">
          <h1 className="page-header-title flex items-center gap-2">
            <ShieldCheck className="w-7 h-7 text-[#EFC2AE]" />
            Egress Proof Panel
          </h1>
          <p className="page-header-subtitle">Side-by-side verification: Tier 1 raw logs (encrypted) vs Tier 2 egress payloads (allow-listed only)</p>
        </div>

        {/* Controls */}
        <div className="card-base p-4 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2 flex-1 min-w-[300px]">
            <Search className="w-4 h-4 text-[#B8B3AC]" />
            <input
              type="text"
              placeholder="Search payloads, secrets, fields..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="input-base bg-transparent border-0 focus:ring-0 text-sm"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm text-[#7A746E]">Redaction:</label>
            <select value={filterRedaction} onChange={e => setFilterRedaction(e.target.value)} className="input-base w-auto px-3 py-1.5 text-xs">
              <option value="all">All Types</option>
              {allRedactionTypes.map(type => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <label className="flex items-center gap-1.5 text-sm text-[#7A746E] cursor-pointer">
              <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} className="w-4 h-4 rounded border-[#ECE7E2] text-[#1A1918] focus:ring-[#C9D8DF]" />
              Auto-refresh (15s)
            </label>
            <label className="flex items-center gap-1.5 text-sm text-[#7A746E] cursor-pointer">
              <input type="checkbox" checked={syncScroll} onChange={e => setSyncScroll(e.target.checked)} className="w-4 h-4 rounded border-[#ECE7E2] text-[#1A1918] focus:ring-[#C9D8DF]" />
              Sync Scroll
            </label>
            <button onClick={fetchData} className="btn-ghost p-2" disabled={loading}>
              <RefreshCw className={`w-5 h-5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {/* View Mode Tabs */}
        <div className="card-base p-2">
          <div className="flex gap-1" role="tablist">
            {[
              { id: "side-by-side", label: "Side-by-Side", icon: ShieldCheck },
              { id: "raw", label: "Raw Logs Only", icon: Database },
              { id: "egress", label: "Egress Only", icon: ShieldAlert },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setViewMode(tab.id as any)}
                className={`px-4 py-2 rounded-[8px] text-sm font-medium transition-colors flex items-center gap-2 ${
                  viewMode === tab.id ? "gradient-blush-sand text-[#1A1918] shadow-card" : "text-[#7A746E] hover:bg-[#F0EDE8]"
                }`}
                role="tab"
                aria-selected={viewMode === tab.id}
              >
                <tab.icon className="w-4 h-4" />
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Stats Summary */}
        <div className="data-grid">
          <div className="kpi-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="kpi-card value">{rawLogs.length}</div>
                <div className="kpi-card label">Raw Logs Stored</div>
              </div>
              <Database className="w-8 h-8 text-[#C9D8DF]" />
            </div>
          </div>
          <div className="kpi-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="kpi-card value">{egressProofs.length}</div>
                <div className="kpi-card label">Egress Proofs</div>
              </div>
              <ShieldCheck className="w-8 h-8 text-[#6B9E6B]" />
            </div>
          </div>
          <div className="kpi-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="kpi-card value">{rawLogs.reduce((sum, l) => sum + l.redacted_fields_count, 0)}</div>
                <div className="kpi-card label">Total Redactions</div>
              </div>
              <AlertTriangle className="w-8 h-8 text-[#E8B86D]" />
            </div>
          </div>
          <div className="kpi-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="kpi-card value">{allRedactionTypes.length}</div>
                <div className="kpi-card label">Redaction Types</div>
              </div>
              <Hash className="w-8 h-8 text-[#D8C9E2]" />
            </div>
          </div>
        </div>

        {/* Main Content */}
        {viewMode === "side-by-side" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Raw Logs Panel */}
            <div className="section-card flex flex-col h-[700px]">
              <div className="flex items-center justify-between mb-4">
                <h2 className="section-card-title flex items-center gap-2">
                  <Database className="w-5 h-5 text-[#EFC2AE]" />
                  Tier 1: Raw Logs (Encrypted at Rest)
                </h2>
                <span className="badge-pill bg-[#F0EDE8] text-[#7A746E]">{filteredRawLogs.length} entries</span>
              </div>
              <div className="flex-1 overflow-y-auto space-y-3" id="raw-logs-panel">
                {filteredRawLogs.length === 0 ? (
                  <div className="empty-state h-full">
                    <Database className="empty-state-icon w-8 h-8" />
                    <p className="empty-state-text">No raw logs matching filters</p>
                  </div>
                ) : (
                  filteredRawLogs.map((log, idx) => (
                    <div
                      key={log.id}
                      onClick={() => setSelectedRawLog(log)}
                      className={`card-base p-3 cursor-pointer transition-colors ${selectedRawLog?.id === log.id ? "border-2 border-[#EFC2AE] gradient-blush-sand" : "hover:bg-[#F9F7F4]"}`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm text-[#1A1918]">{log.raw_payload?.payload_id ?? log.id}</span>
                          <span className="badge-pill bg-[#F0EDE8] text-[#7A746E] text-xs">{log.source_id}</span>
                        </div>
                        <span className="text-xs text-[#B8B3AC]">{formatDistanceToNow(parseISO(log.received_at_utc), { addSuffix: true })}</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-[#7A746E]">
                        <span>Redactions: <span className="font-mono text-[#E8B86D]">{log.redacted_fields_count}</span></span>
                        <span className="font-mono">{JSON.stringify(log.redaction_types)}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Egress Proofs Panel */}
            <div className="section-card flex flex-col h-[700px]">
              <div className="flex items-center justify-between mb-4">
                <h2 className="section-card-title flex items-center gap-2">
                  <ShieldAlert className="w-5 h-5 text-[#EFC2AE]" />
                  Tier 2: Egress Payloads (Allow-Listed Only)
                </h2>
                <span className="badge-pill bg-[#F0EDE8] text-[#7A746E]">{filteredEgressProofs.length} entries</span>
              </div>
              <div className="flex-1 overflow-y-auto space-y-3" id="egress-proofs-panel">
                {filteredEgressProofs.length === 0 ? (
                  <div className="empty-state h-full">
                    <ShieldAlert className="empty-state-icon w-8 h-8" />
                    <p className="empty-state-text">No egress proofs matching filters</p>
                  </div>
                ) : (
                  filteredEgressProofs.map((proof, idx) => (
                    <div
                      key={proof.id}
                      onClick={() => setSelectedEgressProof(proof)}
                      className={`card-base p-3 cursor-pointer transition-colors ${selectedEgressProof?.id === proof.id ? "border-2 border-[#EFC2AE] gradient-blush-sand" : "hover:bg-[#F9F7F4]"}`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm text-[#1A1918]">{proof.payload_id}</span>
                          <span className="badge-pill bg-[#F0EDE8] text-[#7A746E] text-xs">{proof.egress_payload?.source_id ?? "unknown"}</span>
                        </div>
                        <span className="text-xs text-[#B8B3AC]">{formatDistanceToNow(parseISO(proof.logged_at_utc), { addSuffix: true })}</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-[#7A746E]">
                        <span>Scrub: <span className="font-mono text-[#E8B86D]">{proof.scrub_result?.redactions_count ?? 0}</span></span>
                        <span className="font-mono">{JSON.stringify(proof.scrub_result?.redaction_types ?? [])}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {viewMode === "raw" && (
          <div className="section-card">
            <h2 className="section-card-title flex items-center gap-2">
              <Database className="w-5 h-5 text-[#EFC2AE]" />
              All Raw Logs ({filteredRawLogs.length})
            </h2>
            <div className="overflow-y-auto max-h-[700px] space-y-3">
              {filteredRawLogs.map(log => (
                <div key={log.id} className="card-base p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-sm text-[#1A1918]">{log.raw_payload?.payload_id ?? log.id}</span>
                      <span className="badge-pill bg-[#F0EDE8] text-[#7A746E]">{log.source_id}</span>
                      <span className="text-xs text-[#B8B3AC]">{formatDistanceToNow(parseISO(log.received_at_utc), { addSuffix: true })}</span>
                    </div>
                    <button
                      onClick={() => copyToClipboard(formatJson(log.raw_payload))}
                      className="btn-ghost p-2 text-xs"
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-[#7A746E] mb-2">
                    <span>Redactions: <span className="font-mono text-[#E8B86D]">{log.redacted_fields_count}</span></span>
                    <span className="font-mono">{JSON.stringify(log.redaction_types)}</span>
                  </div>
                  <pre className="font-mono text-xs text-[#1A1918] bg-[#F8F6F3] p-3 rounded-[8px] overflow-auto max-h-[300px]">
                    {formatJson(log.raw_payload)}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        )}

        {viewMode === "egress" && (
          <div className="section-card">
            <h2 className="section-card-title flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-[#EFC2AE]" />
              All Egress Proofs ({filteredEgressProofs.length})
            </h2>
            <div className="overflow-y-auto max-h-[700px] space-y-3">
              {filteredEgressProofs.map(proof => (
                <div key={proof.id} className="card-base p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-sm text-[#1A1918]">{proof.payload_id}</span>
                      <span className="badge-pill bg-[#F0EDE8] text-[#7A746E]">{proof.egress_payload?.source_id ?? "unknown"}</span>
                      <span className="text-xs text-[#B8B3AC]">{formatDistanceToNow(parseISO(proof.logged_at_utc), { addSuffix: true })}</span>
                    </div>
                    <button
                      onClick={() => copyToClipboard(formatJson(proof.egress_payload))}
                      className="btn-ghost p-2 text-xs"
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-[#7A746E] mb-2">
                    <span>Scrub: <span className="font-mono text-[#E8B86D]">{proof.scrub_result?.redactions_count ?? 0}</span></span>
                    <span className="font-mono">{JSON.stringify(proof.scrub_result?.redaction_types ?? [])}</span>
                  </div>
                  <pre className="font-mono text-xs text-[#1A1918] bg-[#F8F6F3] p-3 rounded-[8px] overflow-auto max-h-[300px]">
                    {formatJson(proof.egress_payload)}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Detail Modal / Side Panel */}
        {(selectedRawLog || selectedEgressProof) && (
          <div className="fixed inset-0 z-50 flex items-end md:items-center justify-end bg-black/30 animate-fade-in" onClick={() => { setSelectedRawLog(null); setSelectedEgressProof(null); }}>
            <div className="w-full md:w-[600px] lg:w-[800px] max-h-[90vh] bg-white shadow-elevated animate-slide-in overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between p-4 border-b border-[#ECE7E2] sticky top-0 bg-white z-10">
                <h3 className="font-display font-semibold text-[#1A1918]">
                  {selectedRawLog ? "Raw Log Detail" : "Egress Proof Detail"}
                </h3>
                <button onClick={() => { setSelectedRawLog(null); setSelectedEgressProof(null); }} className="btn-ghost p-2">
                  <XCircle className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                {selectedRawLog && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div><span className="text-[#7A746E]">Payload ID:</span> <span className="font-mono ml-2">{selectedRawLog.payload_id}</span></div>
                      <div><span className="text-[#7A746E]">Source:</span> <span className="font-mono ml-2">{selectedRawLog.source_id}</span></div>
                      <div><span className="text-[#7A746E]">Collector:</span> <span className="font-mono ml-2">{selectedRawLog.collector_id}</span></div>
                      <div><span className="text-[#7A746E]">Received:</span> <span className="font-mono ml-2">{formatDistanceToNow(parseISO(selectedRawLog.received_at_utc), { addSuffix: true })}</span></div>
                      <div><span className="text-[#7A746E]">Event Time:</span> <span className="font-mono ml-2">{formatDistanceToNow(parseISO(selectedRawLog.event_timestamp_utc), { addSuffix: true })}</span></div>
                      <div><span className="text-[#7A746E]">Redactions:</span> <span className="font-mono ml-2 text-[#E8B86D]">{selectedRawLog.redacted_fields_count} ({JSON.stringify(selectedRawLog.redaction_types)})</span></div>
                    </div>
                    <div>
                      <h4 className="font-display font-medium text-[#1A1918] mb-2">Raw Payload (Decrypted)</h4>
                      <pre className="font-mono text-xs text-[#1A1918] bg-[#F8F6F3] p-3 rounded-[8px] overflow-auto max-h-[500px]">
                        {formatJson(selectedRawLog.raw_payload)}
                      </pre>
                    </div>
                  </div>
                )}
                {selectedEgressProof && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div><span className="text-[#7A746E]">Payload ID:</span> <span className="font-mono ml-2">{selectedEgressProof.payload_id}</span></div>
                      <div><span className="text-[#7A746E]">Source:</span> <span className="font-mono ml-2">{selectedEgressProof.egress_payload?.source_id ?? "unknown"}</span></div>
                      <div><span className="text-[#7A746E]">Logged:</span> <span className="font-mono ml-2">{formatDistanceToNow(parseISO(selectedEgressProof.logged_at_utc), { addSuffix: true })}</span></div>
                      <div><span className="text-[#7A746E]">Scrub Redactions:</span> <span className="font-mono ml-2 text-[#E8B86D]">{selectedEgressProof.scrub_result?.redactions_count ?? 0} ({JSON.stringify(selectedEgressProof.scrub_result?.redaction_types ?? [])})</span></div>
                    </div>
                    <div>
                      <h4 className="font-display font-medium text-[#1A1918] mb-2">Egress Payload (Allow-Listed Only)</h4>
                      <pre className="font-mono text-xs text-[#1A1918] bg-[#F8F6F3] p-3 rounded-[8px] overflow-auto max-h-[500px]">
                        {formatJson(selectedEgressProof.egress_payload)}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}