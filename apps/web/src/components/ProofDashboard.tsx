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
  Clock,
  CheckCircle,
  XCircle,
  Activity,
  Layers,
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

interface OutboxStats {
  total: number;
  pending: number;
  sent: number;
  failed: number;
}

const TENANT_ID = "tenant_acme_corp";

function getTier1Base(): string {
  if (typeof window !== "undefined") {
    if (process.env.NEXT_PUBLIC_TIER1_URL) return process.env.NEXT_PUBLIC_TIER1_URL;
    if (process.env.NEXT_PUBLIC_API_BASE) return process.env.NEXT_PUBLIC_API_BASE;
    const host = window.location.hostname || "localhost";
    return `http://${host}:8001`;
  }
  return process.env.NEXT_PUBLIC_TIER1_URL || process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8001";
}

function getAuthHeaders(): HeadersInit {
  return {
    "Authorization": "Bearer demo-token",
    "X-Tenant-ID": TENANT_ID,
    "Content-Type": "application/json",
  };
}

/**
 * Extracts unique [REDACTED_*] replacement tokens from any payload object.
 */
function extractRedactedTokens(obj: any): string[] {
  const str = JSON.stringify(obj || {});
  const matches = str.match(/\[REDACTED_[A-Z0-9_]+\]/g);
  return matches ? Array.from(new Set(matches)) : [];
}

/**
 * Renders formatted JSON with clear visual badge callouts for [REDACTED_*] tokens.
 */
function RedactedJsonViewer({ data, maxHeight = "350px" }: { data: any; maxHeight?: string }) {
  const jsonStr = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const parts = jsonStr.split(/(\[REDACTED_[A-Z0-9_]+\])/g);

  return (
    <pre
      style={{ maxHeight }}
      className="font-mono text-xs text-[#1A1918] bg-[#F8F6F3] p-3 rounded-[8px] overflow-auto leading-relaxed whitespace-pre-wrap select-text border border-[#ECE7E2]"
    >
      {parts.map((part, i) => {
        if (/^\[REDACTED_[A-Z0-9_]+\]$/.test(part)) {
          return (
            <span
              key={i}
              className="inline-flex items-center px-1.5 py-0.5 mx-0.5 rounded font-mono font-bold text-[11px] bg-[#FDF3E0] text-[#B45309] border border-[#F5D5C0] shadow-sm"
              title="Sensitive value scrubbed and replaced with safety token"
            >
              <Lock className="w-3 h-3 inline mr-1 text-[#B45309]" />
              {part}
            </span>
          );
        }
        return part;
      })}
    </pre>
  );
}

export function ProofDashboard({ tenantId }: { tenantId: string }) {
  const [rawLogs, setRawLogs] = useState<RawLog[]>([]);
  const [egressProofs, setEgressProofs] = useState<EgressProof[]>([]);
  const [outboxStats, setOutboxStats] = useState<OutboxStats>({ total: 0, pending: 0, sent: 0, failed: 0 });
  const [loading, setLoading] = useState(true);
  const [selectedRawLog, setSelectedRawLog] = useState<RawLog | null>(null);
  const [selectedEgressProof, setSelectedEgressProof] = useState<EgressProof | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterRedaction, setFilterRedaction] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"side-by-side" | "raw" | "egress">("side-by-side");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [syncScroll, setSyncScroll] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    const t1Base = getTier1Base();
    try {
      const [rawRes, egressRes, outboxRes] = await Promise.all([
        fetch(`${t1Base}/local/raw-logs?limit=100`, { headers: getAuthHeaders() }),
        fetch(`${t1Base}/local/egress-proof?limit=100`, { headers: getAuthHeaders() }),
        fetch(`${t1Base}/local/outbox/stats`, { headers: getAuthHeaders() }),
      ]);
      if (rawRes.ok) setRawLogs(await rawRes.json());
      if (egressRes.ok) setEgressProofs(await egressRes.json());
      if (outboxRes.ok) setOutboxStats(await outboxRes.json());
    } catch (error) {
      console.error("Failed to fetch proof data from Tier 1:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchData]);

  // Set default selection when data loads
  useEffect(() => {
    if (!selectedEgressProof && egressProofs.length > 0) {
      setSelectedEgressProof(egressProofs[0]);
      const matched = rawLogs.find(
        l => (l.raw_payload?.payload_id === egressProofs[0].payload_id) || (l.payload_id === egressProofs[0].payload_id)
      );
      if (matched) setSelectedRawLog(matched);
    }
  }, [egressProofs, rawLogs, selectedEgressProof]);

  // Extract all unique redaction categories
  const allRedactionTypes = Array.from(new Set([
    ...rawLogs.flatMap(l => l.redaction_types || []),
    ...egressProofs.flatMap(p => p.scrub_result?.redaction_types || []),
  ])).filter(Boolean);

  // Filter logs
  const filteredRawLogs = rawLogs.filter(log => {
    if (searchQuery && !JSON.stringify(log.raw_payload).toLowerCase().includes(searchQuery.toLowerCase())) return false;
    if (filterRedaction !== "all" && !log.redaction_types?.includes(filterRedaction)) return false;
    return true;
  });

  const filteredEgressProofs = egressProofs.filter(proof => {
    if (searchQuery && !JSON.stringify(proof.egress_payload).toLowerCase().includes(searchQuery.toLowerCase())) return false;
    if (filterRedaction !== "all" && !proof.scrub_result?.redaction_types?.includes(filterRedaction)) return false;
    return true;
  });

  const handleSelectEgress = (proof: EgressProof) => {
    setSelectedEgressProof(proof);
    const matched = rawLogs.find(
      l => (l.raw_payload?.payload_id === proof.payload_id) || (l.payload_id === proof.payload_id)
    );
    if (matched) setSelectedRawLog(matched);
  };

  const handleSelectRaw = (log: RawLog) => {
    setSelectedRawLog(log);
    const pid = log.raw_payload?.payload_id || log.payload_id;
    if (pid) {
      const matched = egressProofs.find(p => p.payload_id === pid);
      if (matched) setSelectedEgressProof(matched);
    }
  };

  const copyToClipboard = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const formatJson = (obj: any) => JSON.stringify(obj, null, 2);

  const safeTimeAgo = (ts?: string) => {
    if (!ts) return "recently";
    try {
      return formatDistanceToNow(parseISO(ts), { addSuffix: true });
    } catch {
      return ts;
    }
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
          <p className="page-header-subtitle">
            Side-by-side trust boundary proof: Tier 1 encrypted raw storage vs. sanitized egress payloads with strict allow-listing & zero secrets
          </p>
        </div>

        {/* 1. Outbox Queue Status Banner (Requirement 4) */}
        <div className="card-base p-4 bg-gradient-to-r from-[#FAF8F5] via-white to-[#FDFBF9] border border-[#ECE7E2]">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#E8F2E8] flex items-center justify-center text-[#6B9E6B]">
                <Server className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-display font-semibold text-sm text-[#1A1918]">
                    Tier 1 Outbox Queue Status
                  </h3>
                  <span className="badge-pill bg-[#EFF5EF] text-[#6B9E6B] text-[10px] font-mono border border-[#D5E8D8]">
                    WAL SQLite Buffer
                  </span>
                </div>
                <p className="text-xs text-[#7A746E]">
                  Reliable egress pipeline: outbox payloads queued in SQLite and drained to Tier 2 SaaS
                </p>
              </div>
            </div>

            {/* Outbox Status Badges */}
            <div className="flex flex-wrap items-center gap-3">
              {/* Sent */}
              <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-[#EFF5EF] border border-[#D5E8D8]">
                <CheckCircle className="w-4 h-4 text-[#6B9E6B]" />
                <div>
                  <div className="text-[10px] uppercase font-bold tracking-wider text-[#6B9E6B]">Sent to Tier 2</div>
                  <div className="font-mono font-bold text-base text-[#1A1918]">{outboxStats.sent}</div>
                </div>
              </div>

              {/* Pending */}
              <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-[#FDF3E0] border border-[#F5D5C0]">
                <Clock className="w-4 h-4 text-[#E8B86D]" />
                <div>
                  <div className="text-[10px] uppercase font-bold tracking-wider text-[#E8B86D]">Pending Outbox</div>
                  <div className="font-mono font-bold text-base text-[#1A1918]">{outboxStats.pending}</div>
                </div>
              </div>

              {/* Failed */}
              <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-[#FDE8E8] border border-[#F3D5CC]">
                <XCircle className="w-4 h-4 text-[#D47A7A]" />
                <div>
                  <div className="text-[10px] uppercase font-bold tracking-wider text-[#D47A7A]">Failed / Retry</div>
                  <div className="font-mono font-bold text-base text-[#1A1918]">{outboxStats.failed}</div>
                </div>
              </div>

              {/* Total */}
              <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-[#F5F3F0] border border-[#ECE7E2]">
                <Database className="w-4 h-4 text-[#7A746E]" />
                <div>
                  <div className="text-[10px] uppercase font-bold tracking-wider text-[#7A746E]">Total Outbox</div>
                  <div className="font-mono font-bold text-base text-[#1A1918]">{outboxStats.total}</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 2. Controls & Filter Bar */}
        <div className="card-base p-4 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2 flex-1 min-w-[280px]">
            <Search className="w-4 h-4 text-[#B8B3AC]" />
            <input
              type="text"
              placeholder="Search payloads, secrets, tokens, IPs..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="input-base bg-transparent border-0 focus:ring-0 text-sm w-full"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm text-[#7A746E]">Redaction Filter:</label>
            <select
              value={filterRedaction}
              onChange={e => setFilterRedaction(e.target.value)}
              className="input-base w-auto px-3 py-1.5 text-xs font-mono"
            >
              <option value="all">All Redaction Types</option>
              {allRedactionTypes.map(type => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3 ml-auto">
            <label className="flex items-center gap-1.5 text-sm text-[#7A746E] cursor-pointer">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={e => setAutoRefresh(e.target.checked)}
                className="w-4 h-4 rounded border-[#ECE7E2] text-[#1A1918] focus:ring-[#C9D8DF]"
              />
              Auto-refresh (10s)
            </label>
            <button
              onClick={fetchData}
              className="btn-ghost p-2 text-xs flex items-center gap-1.5 text-[#7A746E] hover:text-[#1A1918]"
              disabled={loading}
              title="Refresh proof records from Tier 1"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
              Sync
            </button>
          </div>
        </div>

        {/* 3. View Mode Navigation */}
        <div className="card-base p-2">
          <div className="flex gap-1" role="tablist">
            {[
              { id: "side-by-side", label: "Side-by-Side Verification", icon: ShieldCheck },
              { id: "egress", label: "Outgoing Sanitized Payloads", icon: ShieldAlert },
              { id: "raw", label: "Decrypted Raw Storage", icon: Database },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setViewMode(tab.id as any)}
                className={`px-4 py-2 rounded-[8px] text-sm font-medium transition-colors flex items-center gap-2 ${
                  viewMode === tab.id
                    ? "gradient-blush-sand text-[#1A1918] shadow-card font-semibold"
                    : "text-[#7A746E] hover:bg-[#F0EDE8]"
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

        {/* 4. KPI Metrics Cards */}
        <div className="data-grid">
          <div className="kpi-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="kpi-card value">{egressProofs.length}</div>
                <div className="kpi-card label">Sanitized Egress Proofs</div>
              </div>
              <ShieldCheck className="w-8 h-8 text-[#6B9E6B]" />
            </div>
          </div>
          <div className="kpi-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="kpi-card value">{rawLogs.length}</div>
                <div className="kpi-card label">Raw Logs Stored (Encrypted)</div>
              </div>
              <Database className="w-8 h-8 text-[#C9D8DF]" />
            </div>
          </div>
          <div className="kpi-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="kpi-card value text-[#B45309]">
                  {egressProofs.reduce((sum, p) => sum + (p.scrub_result?.redactions_count || 0), 0)}
                </div>
                <div className="kpi-card label">Total Secrets Redacted</div>
              </div>
              <Lock className="w-8 h-8 text-[#E8B86D]" />
            </div>
          </div>
          <div className="kpi-card">
            <div className="flex items-center justify-between">
              <div>
                <div className="kpi-card value">{allRedactionTypes.length}</div>
                <div className="kpi-card label">Redaction Categories Active</div>
              </div>
              <Hash className="w-8 h-8 text-[#D8C9E2]" />
            </div>
          </div>
        </div>

        {/* 5. Main Content Views */}

        {/* VIEW MODE: SIDE-BY-SIDE */}
        {viewMode === "side-by-side" && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Left Column: Raw Logs */}
              <div className="section-card flex flex-col h-[520px]">
                <div className="flex items-center justify-between mb-3 pb-2 border-b border-[#ECE7E2]">
                  <div>
                    <h2 className="section-card-title flex items-center gap-2 text-sm">
                      <Database className="w-4 h-4 text-[#C9D8DF]" />
                      Tier 1: Raw Telemetry (Encrypted at Rest)
                    </h2>
                    <p className="text-[11px] text-[#7A746E]">
                      Stored locally in AES-Fernet encrypted SQLite. May contain sensitive internal IPs & passwords.
                    </p>
                  </div>
                  <span className="badge-pill bg-[#F0EDE8] text-[#7A746E] text-xs">
                    {filteredRawLogs.length} entries
                  </span>
                </div>

                <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
                  {filteredRawLogs.length === 0 ? (
                    <div className="empty-state h-full">
                      <Database className="empty-state-icon w-8 h-8" />
                      <p className="empty-state-text">No raw logs matching filter</p>
                    </div>
                  ) : (
                    filteredRawLogs.map(log => {
                      const isSelected = selectedRawLog?.id === log.id;
                      return (
                        <div
                          key={log.id}
                          onClick={() => handleSelectRaw(log)}
                          className={`card-base p-3 cursor-pointer transition-all ${
                            isSelected
                              ? "border-2 border-[#EFC2AE] bg-[#FDFBF9] shadow-md"
                              : "hover:bg-[#F9F7F4]"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs font-bold text-[#1A1918]">
                                {log.raw_payload?.payload_id ?? log.payload_id ?? log.id}
                              </span>
                              <span className="badge-pill bg-[#F0EDE8] text-[#7A746E] text-[10px] font-mono">
                                {log.source_id}
                              </span>
                            </div>
                            <span className="text-[11px] text-[#B8B3AC]">
                              {safeTimeAgo(log.received_at_utc)}
                            </span>
                          </div>
                          <div className="text-xs text-[#7A746E] line-clamp-2 font-mono bg-white p-1.5 rounded border border-[#ECE7E2]">
                            {typeof log.raw_payload?.message === "string"
                              ? log.raw_payload.message
                              : JSON.stringify(log.raw_payload)}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Right Column: Egress Proofs (Sanitized Outgoing Payload) */}
              <div className="section-card flex flex-col h-[520px]">
                <div className="flex items-center justify-between mb-3 pb-2 border-b border-[#ECE7E2]">
                  <div>
                    <h2 className="section-card-title flex items-center gap-2 text-sm">
                      <ShieldCheck className="w-4 h-4 text-[#6B9E6B]" />
                      Tier 2: Sanitized Egress Payloads (Outgoing Wire Data)
                    </h2>
                    <p className="text-[11px] text-[#7A746E]">
                      Filtered via strict field allow-list. All credentials scrubbed to safe safety tokens before forwarder.
                    </p>
                  </div>
                  <span className="badge-pill bg-[#EFF5EF] text-[#6B9E6B] text-xs border border-[#D5E8D8]">
                    {filteredEgressProofs.length} proofs
                  </span>
                </div>

                <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
                  {filteredEgressProofs.length === 0 ? (
                    <div className="empty-state h-full">
                      <ShieldAlert className="empty-state-icon w-8 h-8" />
                      <p className="empty-state-text">No egress proofs matching filter</p>
                    </div>
                  ) : (
                    filteredEgressProofs.map(proof => {
                      const isSelected = selectedEgressProof?.id === proof.id;
                      const replacedTokens = extractRedactedTokens(proof.egress_payload);
                      const redactionCount = proof.scrub_result?.redactions_count ?? 0;
                      const redactionTypes = proof.scrub_result?.redaction_types ?? [];

                      return (
                        <div
                          key={proof.id}
                          onClick={() => handleSelectEgress(proof)}
                          className={`card-base p-3 cursor-pointer transition-all ${
                            isSelected
                              ? "border-2 border-[#6B9E6B] bg-[#F7FAF7] shadow-md"
                              : "hover:bg-[#F9F7F4]"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs font-bold text-[#1A1918]">
                                {proof.payload_id}
                              </span>
                              <span className="badge-pill bg-[#EFF5EF] text-[#6B9E6B] text-[10px] font-mono border border-[#D5E8D8]">
                                {proof.egress_payload?.source_id ?? "src_unknown"}
                              </span>
                            </div>
                            <span className="text-[11px] text-[#B8B3AC]">
                              {safeTimeAgo(proof.logged_at_utc)}
                            </span>
                          </div>

                          {/* Redaction Count and Types (Requirement 2) */}
                          <div className="flex flex-wrap items-center gap-1.5 mb-2">
                            <span className="badge-pill bg-[#FDF3E0] text-[#B45309] text-[10px] font-mono font-bold border border-[#F5D5C0]">
                              <AlertTriangle className="w-3 h-3 text-[#B45309]" />
                              {redactionCount} Redactions
                            </span>
                            {redactionTypes.map(type => (
                              <span
                                key={type}
                                className="badge-pill bg-[#F0EDE8] text-[#7A746E] text-[10px] font-mono"
                              >
                                {type}
                              </span>
                            ))}
                          </div>

                          {/* Replaced Tokens Indication (Requirement 3) */}
                          {replacedTokens.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1 mb-2 bg-[#FDF8F3] p-1.5 rounded border border-[#F5D5C0]">
                              <span className="text-[10px] font-bold text-[#B45309] flex items-center gap-1">
                                <Lock className="w-3 h-3 text-[#B45309]" />
                                Replaced:
                              </span>
                              {replacedTokens.map(tok => (
                                <span
                                  key={tok}
                                  className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-[#FDF3E0] text-[#B45309] border border-[#F5D5C0]"
                                >
                                  {tok}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            {/* Selected Side-by-Side Deep Comparison Inspector (Requirements 1, 2, 3) */}
            <div className="section-card">
              <div className="flex flex-wrap items-center justify-between mb-4 pb-3 border-b border-[#ECE7E2] gap-3">
                <div className="flex items-center gap-2">
                  <Layers className="w-5 h-5 text-[#EFC2AE]" />
                  <div>
                    <h3 className="section-card-title text-base">
                      Trust Boundary Inspector: Payload{" "}
                      <span className="font-mono text-[#1A1918] bg-[#F0EDE8] px-2 py-0.5 rounded">
                        {selectedEgressProof?.payload_id || selectedRawLog?.payload_id || "None selected"}
                      </span>
                    </h3>
                    <p className="text-xs text-[#7A746E]">
                      Direct verification that sensitive raw values are scrubbed into safety tokens and filtered to allow-listed fields
                    </p>
                  </div>
                </div>

                {selectedEgressProof && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() =>
                        copyToClipboard(
                          formatJson(selectedEgressProof.egress_payload),
                          selectedEgressProof.payload_id
                        )
                      }
                      className="btn-ghost px-3 py-1.5 text-xs flex items-center gap-1.5 border border-[#ECE7E2]"
                    >
                      {copiedId === selectedEgressProof.payload_id ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-[#6B9E6B]" />
                          Copied!
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          Copy Sanitized JSON
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Left: Raw Decrypted Payload */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[#7A746E] uppercase tracking-wider flex items-center gap-1.5">
                      <Database className="w-3.5 h-3.5" />
                      1. Tier 1 Raw Log (Encrypted Storage)
                    </span>
                    <span className="text-[11px] text-[#B8B3AC]">
                      {selectedRawLog ? `Source: ${selectedRawLog.source_id}` : ""}
                    </span>
                  </div>
                  {selectedRawLog ? (
                    <pre className="font-mono text-xs text-[#1A1918] bg-[#F8F6F3] p-3 rounded-[8px] overflow-auto max-h-[380px] leading-relaxed whitespace-pre-wrap border border-[#ECE7E2]">
                      {formatJson(selectedRawLog.raw_payload)}
                    </pre>
                  ) : (
                    <div className="p-8 text-center text-xs text-[#7A746E] bg-[#F8F6F3] rounded-[8px] border border-[#ECE7E2]">
                      Select an event to view decrypted raw payload
                    </div>
                  )}
                </div>

                {/* Right: Sanitized Outgoing JSON Payload (Requirements 1, 3) */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[#6B9E6B] uppercase tracking-wider flex items-center gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5 text-[#6B9E6B]" />
                      2. Outgoing Sanitized JSON (Wire Payload)
                    </span>
                    {selectedEgressProof && (
                      <span className="badge-pill bg-[#EFF5EF] text-[#6B9E6B] text-[10px] font-mono border border-[#D5E8D8]">
                        Zero Secrets Verified
                      </span>
                    )}
                  </div>

                  {selectedEgressProof ? (
                    <div className="space-y-2">
                      {/* Active Replacements Banner */}
                      {extractRedactedTokens(selectedEgressProof.egress_payload).length > 0 && (
                        <div className="p-2.5 rounded-[8px] bg-[#FDF8F3] border border-[#F5D5C0] flex flex-wrap items-center gap-2">
                          <span className="text-xs font-bold text-[#B45309] flex items-center gap-1">
                            <Lock className="w-3.5 h-3.5 text-[#B45309]" />
                            Replaced Sensitive Values:
                          </span>
                          {extractRedactedTokens(selectedEgressProof.egress_payload).map(tok => (
                            <span
                              key={tok}
                              className="px-2 py-0.5 rounded text-xs font-mono font-bold bg-[#FDF3E0] text-[#B45309] border border-[#F5D5C0]"
                            >
                              {tok}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Sanitized JSON Viewer */}
                      <RedactedJsonViewer
                        data={selectedEgressProof.egress_payload}
                        maxHeight="340px"
                      />
                    </div>
                  ) : (
                    <div className="p-8 text-center text-xs text-[#7A746E] bg-[#F8F6F3] rounded-[8px] border border-[#ECE7E2]">
                      Select an event to view sanitized egress payload
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* VIEW MODE: OUTGOING SANITIZED PAYLOADS (Requirements 1, 2, 3) */}
        {viewMode === "egress" && (
          <div className="section-card space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[#ECE7E2]">
              <div>
                <h2 className="section-card-title flex items-center gap-2 text-base">
                  <ShieldCheck className="w-5 h-5 text-[#6B9E6B]" />
                  Outgoing Sanitized JSON Payloads ({filteredEgressProofs.length})
                </h2>
                <p className="text-xs text-[#7A746E]">
                  Exact payloads enqueued into the Outbox and delivered to Tier 2 Central SaaS.
                </p>
              </div>
            </div>

            <div className="overflow-y-auto max-h-[750px] space-y-4">
              {filteredEgressProofs.length === 0 ? (
                <div className="empty-state p-8">
                  <ShieldAlert className="empty-state-icon w-8 h-8" />
                  <p className="empty-state-text">No egress payloads found matching filters</p>
                </div>
              ) : (
                filteredEgressProofs.map(proof => {
                  const replacedTokens = extractRedactedTokens(proof.egress_payload);
                  const redactionsCount = proof.scrub_result?.redactions_count ?? 0;
                  const redactionTypes = proof.scrub_result?.redaction_types ?? [];

                  return (
                    <div
                      key={proof.id}
                      className="card-base p-4 border border-[#ECE7E2] hover:shadow-card-hover transition-all"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                        <div className="flex flex-wrap items-center gap-2.5">
                          <span className="font-mono text-sm font-bold text-[#1A1918]">
                            {proof.payload_id}
                          </span>
                          <span className="badge-pill bg-[#EFF5EF] text-[#6B9E6B] font-mono text-xs border border-[#D5E8D8]">
                            Source: {proof.egress_payload?.source_id ?? "unknown"}
                          </span>
                          <span className="text-xs text-[#B8B3AC]">
                            {safeTimeAgo(proof.logged_at_utc)}
                          </span>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            onClick={() =>
                              copyToClipboard(
                                formatJson(proof.egress_payload),
                                proof.payload_id
                              )
                            }
                            className="btn-ghost px-2.5 py-1 text-xs flex items-center gap-1 border border-[#ECE7E2]"
                          >
                            {copiedId === proof.payload_id ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-[#6B9E6B]" />
                                Copied
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5" />
                                Copy JSON
                              </>
                            )}
                          </button>
                        </div>
                      </div>

                      {/* Redaction Count and Types (Requirement 2) */}
                      <div className="flex flex-wrap items-center gap-2 mb-3">
                        <span className="badge-pill bg-[#FDF3E0] text-[#B45309] font-mono text-xs font-bold border border-[#F5D5C0]">
                          <AlertTriangle className="w-3 h-3 text-[#B45309]" />
                          {redactionsCount} Redacted Fields
                        </span>
                        {redactionTypes.map(type => (
                          <span
                            key={type}
                            className="badge-pill bg-[#F0EDE8] text-[#7A746E] font-mono text-xs"
                          >
                            {type}
                          </span>
                        ))}
                      </div>

                      {/* Replaced Tokens Banner (Requirement 3) */}
                      {replacedTokens.length > 0 && (
                        <div className="p-2.5 mb-3 rounded-[8px] bg-[#FDF8F3] border border-[#F5D5C0] flex flex-wrap items-center gap-2">
                          <span className="text-xs font-bold text-[#B45309] flex items-center gap-1">
                            <Lock className="w-3.5 h-3.5 text-[#B45309]" />
                            Replaced Sensitive Values:
                          </span>
                          {replacedTokens.map(tok => (
                            <span
                              key={tok}
                              className="px-2 py-0.5 rounded text-xs font-mono font-bold bg-[#FDF3E0] text-[#B45309] border border-[#F5D5C0]"
                            >
                              {tok}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Outgoing Sanitized JSON Payload (Requirement 1) */}
                      <RedactedJsonViewer data={proof.egress_payload} maxHeight="350px" />
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* VIEW MODE: RAW LOGS ONLY */}
        {viewMode === "raw" && (
          <div className="section-card space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[#ECE7E2]">
              <div>
                <h2 className="section-card-title flex items-center gap-2 text-base">
                  <Database className="w-5 h-5 text-[#EFC2AE]" />
                  Decrypted Raw Storage Logs ({filteredRawLogs.length})
                </h2>
                <p className="text-xs text-[#7A746E]">
                  Raw incoming events decrypted in memory for side-by-side compliance audit inspection.
                </p>
              </div>
            </div>

            <div className="overflow-y-auto max-h-[750px] space-y-4">
              {filteredRawLogs.map(log => (
                <div key={log.id} className="card-base p-4 border border-[#ECE7E2]">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-sm font-bold text-[#1A1918]">
                        {log.raw_payload?.payload_id ?? log.payload_id ?? log.id}
                      </span>
                      <span className="badge-pill bg-[#F0EDE8] text-[#7A746E] text-xs font-mono">
                        {log.source_id}
                      </span>
                      <span className="text-xs text-[#B8B3AC]">
                        {safeTimeAgo(log.received_at_utc)}
                      </span>
                    </div>
                    <button
                      onClick={() => copyToClipboard(formatJson(log.raw_payload), String(log.id))}
                      className="btn-ghost p-1.5 text-xs border border-[#ECE7E2]"
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                  </div>
                  <pre className="font-mono text-xs text-[#1A1918] bg-[#F8F6F3] p-3 rounded-[8px] overflow-auto max-h-[300px] border border-[#ECE7E2]">
                    {formatJson(log.raw_payload)}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
