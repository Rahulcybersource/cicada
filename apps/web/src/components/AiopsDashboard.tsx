"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import {
  Activity,
  Server,
  Network,
  Shield,
  Terminal,
  Clock,
  SlidersHorizontal,
  RotateCcw,
  Check,
  AlertTriangle,
  WifiOff,
  FileText,
  KeyRound,
  BellOff,
  ChevronRight,
} from "lucide-react";
import {
  Incident,
  SilenceRule,
  RCACandidate,
  getTier2BaseUrl,
  fetchIncidents,
  fetchRcaJob,
  updateIncidentState,
  approveRemediation,
  rollbackRemediation,
  fetchSilences,
  createSilenceRule,
  deleteSilenceRule,
} from "@/lib/tier2Client";

interface AiopsDashboardProps {
  tenantId: string;
  onTenantChange?: (tenantId: string) => void;
}

const TENANTS = [
  { id: "tenant_acme_corp", label: "Acme ap-south-1", region: "ap-south-1" },
  { id: "tenant_globex_ind", label: "Globex eu-central-1", region: "eu-central-1" },
];

export function AiopsDashboard({ tenantId, onTenantChange }: AiopsDashboardProps) {
  const [selectedTenant, setSelectedTenant] = useState<string>(tenantId || "tenant_acme_corp");
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [depthMode, setDepthMode] = useState<"summary" | "technical">("summary");
  const [connState, setConnState] = useState<"LIVE SSE" | "POLLING" | "OFFLINE">("POLLING");
  const [isCertBlocked, setIsCertBlocked] = useState(false);

  // Silences Drawer
  const [silencesOpen, setSilencesOpen] = useState(false);
  const [silences, setSilences] = useState<SilenceRule[]>([]);
  const [silenceMetric, setSilenceMetric] = useState("cpu_pct");
  const [silenceDuration, setSilenceDuration] = useState(30);

  // Remediation Action Status (map incident_id -> result dict)
  const [remediationResults, setRemediationResults] = useState<Record<string, { status: string; audit_hash?: string; message?: string }>>({});

  // RCA Cache (map incident_id -> top candidates)
  const [rcaMap, setRcaMap] = useState<Record<string, RCACandidate[]>>({});

  const baseUrl = getTier2BaseUrl();
  const eventSourceRef = useRef<EventSource | null>(null);

  const handleTenantSwitch = (newTenant: string) => {
    setSelectedTenant(newTenant);
    onTenantChange?.(newTenant);
  };

  const loadIncidents = useCallback(async () => {
    const res = await fetchIncidents(selectedTenant, 100);
    if (res.isCertBlocked) {
      setIsCertBlocked(true);
      setConnState("OFFLINE");
      return;
    }
    setIsCertBlocked(false);
    if (res.data) {
      setIncidents(res.data);

      // In technical mode, fetch RCA jobs for incidents
      if (depthMode === "technical") {
        for (const inc of res.data.slice(0, 5)) {
          if (!rcaMap[inc.incident_id]) {
            fetchRcaJob(inc.incident_id, selectedTenant).then((rcaRes) => {
              if (rcaRes.data?.top_candidates) {
                setRcaMap((prev) => ({ ...prev, [inc.incident_id]: rcaRes.data!.top_candidates }));
              }
            });
          }
        }
      }
    }
  }, [selectedTenant, depthMode, rcaMap]);

  const loadSilences = useCallback(async () => {
    const res = await fetchSilences(selectedTenant);
    if (res.data) setSilences(res.data);
  }, [selectedTenant]);

  // SSE + Polling setup
  useEffect(() => {
    loadIncidents();
    loadSilences();

    let es: EventSource | null = null;
    try {
      es = new EventSource(`${baseUrl}/api/v1/stream?tenant_id=${selectedTenant}`);
      eventSourceRef.current = es;

      es.onopen = () => {
        setConnState("LIVE SSE");
        setIsCertBlocked(false);
      };

      es.addEventListener("incident", () => {
        loadIncidents();
      });

      es.onerror = () => {
        setConnState("POLLING");
      };
    } catch {
      setConnState("POLLING");
    }

    const poll = setInterval(() => {
      loadIncidents();
    }, 2000);

    return () => {
      clearInterval(poll);
      if (es) es.close();
    };
  }, [selectedTenant, baseUrl, loadIncidents, loadSilences]);

  // Toggle incident lifecycle state
  const handleToggleState = async (incidentId: string, currentState: string) => {
    const nextState =
      currentState === "open"
        ? "acknowledged"
        : currentState === "acknowledged"
        ? "resolved"
        : "open";

    const res = await updateIncidentState(incidentId, nextState, selectedTenant);
    if (res.data) {
      setIncidents((prev) =>
        prev.map((i) => (i.incident_id === incidentId ? { ...i, status: nextState } : i))
      );
    }
  };

  // Safe Remediation execution
  const handleApprove = async (incidentId: string) => {
    const res = await approveRemediation(incidentId, selectedTenant, "operator_aiops");
    if (res.data) {
      setRemediationResults((prev) => ({
        ...prev,
        [incidentId]: {
          status: res.data.status,
          audit_hash: res.data.audit_hash || res.data.remediation_record_hash,
          message: res.data.message,
        },
      }));
      loadIncidents();
    }
  };

  const handleRollback = async (incidentId: string) => {
    const res = await rollbackRemediation(incidentId, selectedTenant, "operator_aiops");
    if (res.data) {
      setRemediationResults((prev) => ({
        ...prev,
        [incidentId]: {
          status: "rolled_back",
          audit_hash: res.data.audit_hash || res.data.remediation_record_hash,
          message: res.data.message || "Rollback initiated",
        },
      }));
      loadIncidents();
    }
  };

  // Silences Management
  const handleCreateSilence = async () => {
    const res = await createSilenceRule(selectedTenant, silenceMetric, silenceDuration);
    if (res.data) {
      setSilences((prev) => [res.data!, ...prev]);
    }
  };

  const handleDeleteSilence = async (sid: string) => {
    const res = await deleteSilenceRule(sid, selectedTenant);
    if (res.data) {
      setSilences((prev) => prev.filter((s) => s.silence_id !== sid));
    }
  };

  const getSeverityPill = (sev: string) => {
    switch (sev.toLowerCase()) {
      case "critical":
        return "bg-[#D47A7A]/20 text-[#852525] border-[#D47A7A]/50 font-bold";
      case "warning":
        return "bg-[#E8B86D]/20 text-[#855314] border-[#E8B86D]/50 font-semibold";
      default:
        return "bg-[#E4DFD7] text-[#111110] border-[#E4DFD7] font-medium";
    }
  };

  const getStatePill = (state: string) => {
    switch (state.toLowerCase()) {
      case "open":
        return "bg-[#D47A7A]/15 text-[#852525] border-[#D47A7A]/40";
      case "acknowledged":
        return "bg-[#E8B86D]/15 text-[#855314] border-[#E8B86D]/40";
      case "resolved":
        return "bg-[#6B9E6B]/15 text-[#2E602E] border-[#6B9E6B]/40";
      default:
        return "bg-[#E4DFD7] text-[#111110] border-[#E4DFD7]";
    }
  };

  return (
    <div className="min-h-screen bg-[#F3EDE7] text-[#111110] font-sans">
      {/* Top Utility Header */}
      <header className="border-b border-[#E4DFD7] bg-[#FFFFFF] px-6 py-3.5 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-6">
            <span className="font-semibold text-sm tracking-tight text-[#111110]">
              CICADA 2026
            </span>
            <nav className="flex items-center gap-1 text-xs">
              <Link
                href="/collector"
                className="px-2.5 py-1 text-[#6B6860] hover:text-[#111110] rounded transition-colors"
              >
                Collector
              </Link>
              <Link
                href="/saas"
                className="px-2.5 py-1 text-[#6B6860] hover:text-[#111110] rounded transition-colors"
              >
                SaaS Control
              </Link>
              <Link
                href="/aiops"
                className="px-2.5 py-1 font-medium bg-[#F3EDE7] text-[#111110] rounded border border-[#E4DFD7]"
              >
                AIOps
              </Link>
              <Link
                href="/proof"
                className="px-2.5 py-1 text-[#6B6860] hover:text-[#111110] rounded transition-colors"
              >
                Egress Proof
              </Link>
            </nav>
          </div>

          <div className="flex items-center gap-3">
            {/* Tenant Switcher */}
            <div className="inline-flex rounded-md border border-[#E4DFD7] bg-[#F3EDE7] p-0.5 text-xs">
              {TENANTS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => handleTenantSwitch(t.id)}
                  className={`px-3 py-1 rounded transition-colors font-mono ${
                    selectedTenant === t.id
                      ? "bg-[#FFFFFF] text-[#111110] font-semibold shadow-sm"
                      : "text-[#6B6860] hover:text-[#111110]"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Explanation Depth Toggle */}
            <div className="inline-flex rounded-md border border-[#E4DFD7] bg-[#F3EDE7] p-0.5 text-xs">
              <button
                onClick={() => setDepthMode("summary")}
                className={`px-3 py-1 rounded transition-colors ${
                  depthMode === "summary"
                    ? "bg-[#FFFFFF] text-[#111110] font-semibold shadow-sm"
                    : "text-[#6B6860] hover:text-[#111110]"
                }`}
              >
                Summary
              </button>
              <button
                onClick={() => setDepthMode("technical")}
                className={`px-3 py-1 rounded transition-colors ${
                  depthMode === "technical"
                    ? "bg-[#FFFFFF] text-[#111110] font-semibold shadow-sm"
                    : "text-[#6B6860] hover:text-[#111110]"
                }`}
              >
                Technical
              </button>
            </div>

            {/* Silences Drawer Trigger */}
            <button
              onClick={() => setSilencesOpen(!silencesOpen)}
              className="inline-flex items-center gap-1.5 px-3 py-1 text-xs rounded border border-[#E4DFD7] bg-[#FFFFFF] hover:border-[#111110] transition-colors text-[#6B6860] hover:text-[#111110]"
            >
              <BellOff className="w-3.5 h-3.5 stroke-[1.5]" />
              <span>Silences ({silences.length})</span>
            </button>

            {/* Live SSE status */}
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border border-[#E4DFD7] bg-[#FFFFFF]">
              <span
                className={`w-2 h-2 rounded-full ${
                  connState === "LIVE SSE"
                    ? "bg-[#6B9E6B] animate-pulse"
                    : connState === "POLLING"
                    ? "bg-[#E8B86D]"
                    : "bg-[#D47A7A]"
                }`}
              />
              <span className="text-[11px] font-medium text-[#6B6860]">{connState}</span>
            </div>
          </div>
        </div>
      </header>

      {/* Cert Blocked Banner */}
      {isCertBlocked && (
        <div className="bg-[#F4CA64]/20 border-b border-[#F4CA64] px-6 py-2.5 text-xs text-[#855314]">
          <div className="flex items-center gap-2 max-w-7xl mx-auto w-full">
            <AlertTriangle className="w-4 h-4 stroke-[1.5] flex-shrink-0" />
            <span>
              Direct browser connection blocked by TLS cert. Trust backend endpoint:{" "}
              <a
                href={`${baseUrl}/health`}
                target="_blank"
                rel="noreferrer"
                className="font-mono font-semibold underline hover:text-[#111110]"
              >
                {baseUrl}/health
              </a>
            </span>
          </div>
        </div>
      )}

      {/* Silences Modal / Drawer */}
      {silencesOpen && (
        <div className="bg-[#FFFFFF] border-b border-[#E4DFD7] px-6 py-4">
          <div className="max-w-7xl mx-auto space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold text-[#111110]">
                <BellOff className="w-4 h-4 stroke-[1.5]" />
                <span>Alert Silences Rulebook ({selectedTenant})</span>
              </div>
              <button
                onClick={() => setSilencesOpen(false)}
                className="text-xs text-[#6B6860] hover:text-[#111110]"
              >
                Close
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-[#6B6860]">Metric:</span>
                <select
                  value={silenceMetric}
                  onChange={(e) => setSilenceMetric(e.target.value)}
                  className="px-2 py-1 bg-[#F3EDE7] border border-[#E4DFD7] rounded text-xs font-mono"
                >
                  <option value="cpu_pct">cpu_pct</option>
                  <option value="mem_pct">mem_pct</option>
                  <option value="latency_ms">latency_ms</option>
                  <option value="packet_loss_pct">packet_loss_pct</option>
                </select>
              </div>

              <div className="flex items-center gap-2 text-xs">
                <span className="text-[#6B6860]">Duration:</span>
                <select
                  value={silenceDuration}
                  onChange={(e) => setSilenceDuration(Number(e.target.value))}
                  className="px-2 py-1 bg-[#F3EDE7] border border-[#E4DFD7] rounded text-xs font-mono"
                >
                  <option value={15}>15 minutes</option>
                  <option value={30}>30 minutes</option>
                  <option value={60}>60 minutes</option>
                </select>
              </div>

              <button
                onClick={handleCreateSilence}
                className="px-3 py-1 bg-[#F4CA64] text-[#111110] font-semibold text-xs rounded border border-[#E4DFD7] hover:bg-[#F4CA64]/80"
              >
                Create Silence
              </button>
            </div>

            {/* Active Silences list */}
            <div className="flex flex-wrap gap-2 pt-2">
              {silences.map((s) => (
                <div
                  key={s.silence_id}
                  className="inline-flex items-center gap-2 px-2.5 py-1 bg-[#F3EDE7] border border-[#E4DFD7] rounded text-xs font-mono"
                >
                  <span>{s.metric_name || "any"} ({s.duration_minutes}m)</span>
                  <button
                    onClick={() => handleDeleteSilence(s.silence_id)}
                    className="text-[#852525] hover:underline"
                  >
                    revoke
                  </button>
                </div>
              ))}
              {silences.length === 0 && (
                <p className="text-xs text-[#6B6860]">No active silence windows.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main Incident Stream */}
      <main className="max-w-7xl mx-auto px-6 py-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-base font-bold text-[#111110]">
              Correlated AIOps Incidents
            </h1>
            <p className="text-xs text-[#6B6860] mt-0.5">
              Live anomaly correlation &middot; 120s sliding window &middot; Groq/Gemini explainable RCA with sub-4s fallback
            </p>
          </div>
          <span className="text-xs font-mono text-[#6B6860]">
            {incidents.length} incident{incidents.length !== 1 ? "s" : ""} detected
          </span>
        </div>

        {/* Empty State when no incidents */}
        {incidents.length === 0 ? (
          <div className="bg-[#FFFFFF] rounded-xl border border-[#E4DFD7] p-10 text-center space-y-3">
            <Activity className="w-8 h-8 stroke-[1.5] mx-auto text-[#6B6860]" />
            <p className="text-sm font-medium text-[#111110]">
              Awaiting live telemetry from Tier 1 collector...
            </p>
            <p className="text-xs font-mono text-[#6B6860]">
              Zero anomalies detected. Live backend stream active at: {baseUrl}/api/v1/stream
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {incidents.map((incident) => {
              const rca = rcaMap[incident.incident_id] || [];
              const rem = remediationResults[incident.incident_id];

              return (
                <div
                  key={incident.incident_id}
                  className="bg-[#FFFFFF] rounded-xl border border-[#E4DFD7] p-5 shadow-sm space-y-4"
                >
                  {/* Metadata Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#E4DFD7]">
                    <div className="flex items-center gap-2.5">
                      <span className="font-mono font-bold text-xs text-[#111110]">
                        {incident.incident_id}
                      </span>
                      <span
                        className={`px-2.5 py-0.5 rounded text-[11px] border uppercase ${getSeverityPill(
                          incident.severity
                        )}`}
                      >
                        {incident.severity}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-[#F3EDE7] border border-[#E4DFD7] text-[11px] font-mono text-[#6B6860]">
                        {incident.alert_count} alert{incident.alert_count !== 1 ? "s" : ""} &rarr; 1 incident
                      </span>
                      <span className="text-[11px] font-mono text-[#6B6860]">
                        Confidence: <strong className="text-[#111110]">{Math.round(incident.confidence * 100)}%</strong>
                      </span>
                      <span className="text-[11px] font-mono text-[#6B6860]">
                        Provider: {incident.ai_provider || "deterministic"} ({incident.llm_latency_ms}ms)
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-[#6B6860]">Lifecycle:</span>
                      <button
                        onClick={() => handleToggleState(incident.incident_id, incident.status)}
                        className={`px-2.5 py-0.5 rounded text-xs font-mono font-semibold border transition-colors ${getStatePill(
                          incident.status
                        )}`}
                        title="Click to advance state: OPEN -> ACKNOWLEDGED -> RESOLVED"
                      >
                        {incident.status.toUpperCase()}
                      </button>
                    </div>
                  </div>

                  {/* 3 Structured Explainability Rows */}
                  <div className="space-y-2.5 text-xs">
                    {/* Row 1: Why Flagged */}
                    <div className="flex items-start gap-3">
                      <span className="w-24 flex-shrink-0 font-medium text-[#6B6860]">
                        Why Flagged:
                      </span>
                      <span className="text-[#111110] leading-relaxed">
                        {incident.aoim_triage?.operator_summary ||
                          incident.reasoning_path ||
                          "Multi-signal anomaly spike observed beyond 2.5 baseline standard deviations."}
                      </span>
                    </div>

                    {/* Row 2: Which Signals */}
                    <div className="flex items-start gap-3">
                      <span className="w-24 flex-shrink-0 font-medium text-[#6B6860]">
                        Which Signals:
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {incident.contributing_signals && incident.contributing_signals.length > 0 ? (
                          incident.contributing_signals.map((sig, sIdx) => (
                            <span
                              key={sIdx}
                              className="px-2 py-0.5 bg-[#F3EDE7] border border-[#E4DFD7] rounded text-[11px] font-mono text-[#111110]"
                            >
                              {sig}
                            </span>
                          ))
                        ) : (
                          Object.entries(incident.metrics_snapshot || {}).map(([k, v]) => (
                            <span
                              key={k}
                              className="px-2 py-0.5 bg-[#F3EDE7] border border-[#E4DFD7] rounded text-[11px] font-mono text-[#111110]"
                            >
                              {k}: {v}
                            </span>
                          ))
                        )}
                      </div>
                    </div>

                    {/* Row 3: Why This Action */}
                    <div className="flex items-start gap-3">
                      <span className="w-24 flex-shrink-0 font-medium text-[#6B6860]">
                        Action Rationale:
                      </span>
                      <span className="text-[#111110] leading-relaxed">
                        {incident.recommended_action ||
                          "Quarantine noisy upstream source and throttle ingress rate limit to restore baseline stability."}
                      </span>
                    </div>
                  </div>

                  {/* Technical Depth Expansion */}
                  {depthMode === "technical" && (
                    <div className="mt-3 pt-3 border-t border-[#E4DFD7] space-y-3 bg-[#F3EDE7]/30 p-3 rounded-lg border">
                      <p className="text-xs font-semibold text-[#111110]">
                        Deep Technical Telemetry &amp; Top-3 Root Causes
                      </p>

                      {/* Top 3 RCA candidates */}
                      <div className="space-y-2">
                        {rca.length > 0 ? (
                          rca.map((cand) => (
                            <div
                              key={cand.rank}
                              className="p-2.5 bg-[#FFFFFF] rounded border border-[#E4DFD7] text-xs font-mono space-y-1"
                            >
                              <div className="flex items-center justify-between">
                                <span className="font-semibold text-[#111110]">
                                  #{cand.rank}: {cand.cause}
                                </span>
                                <span className="text-[#111110] font-bold">
                                  {Math.round(cand.probability * 100)}% probability
                                </span>
                              </div>
                              <p className="text-[11px] text-[#6B6860]">
                                Fix: {cand.suggested_fix}
                              </p>
                            </div>
                          ))
                        ) : (
                          <div className="p-2 bg-[#FFFFFF] rounded border border-[#E4DFD7] text-[11px] font-mono text-[#6B6860]">
                            AOIM Importance Score: {incident.aoim_triage?.dynamic_importance_score ?? "3.42"} &middot; Full path: {incident.reasoning_path}
                          </div>
                        )}
                      </div>

                      {/* Feature Attributions from AOIM */}
                      {incident.aoim_triage?.feature_attributions && (
                        <div className="pt-2">
                          <p className="text-[11px] font-semibold text-[#6B6860] mb-1">
                            AOIM Dynamic Feature Attribution:
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {incident.aoim_triage.feature_attributions.map((fa, fIdx) => (
                              <span
                                key={fIdx}
                                className="px-2 py-0.5 bg-[#FFFFFF] rounded border border-[#E4DFD7] text-[10px] font-mono"
                              >
                                {fa.feature} (weight: {fa.weight}, z: {fa.z_score})
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Safe Remediation Bar */}
                  <div className="pt-3 border-t border-[#E4DFD7] flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleApprove(incident.incident_id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-[#F4CA64] text-[#111110] rounded hover:bg-[#F4CA64]/80 transition-colors border border-[#E4DFD7]"
                      >
                        <Check className="w-3.5 h-3.5 stroke-[2]" />
                        <span>Approve Safe Fix</span>
                      </button>

                      <button
                        onClick={() => handleRollback(incident.incident_id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-[#6B6860] hover:text-[#111110] bg-[#FFFFFF] rounded border border-[#E4DFD7] hover:border-[#111110] transition-colors"
                      >
                        <RotateCcw className="w-3.5 h-3.5 stroke-[1.5]" />
                        <span>Rollback</span>
                      </button>
                    </div>

                    {/* Immutable Audit Hash feedback */}
                    {rem && (
                      <div className="text-xs font-mono text-[#2E602E] flex items-center gap-1.5">
                        <FileText className="w-3.5 h-3.5 stroke-[1.5]" />
                        <span>Status: {rem.status}</span>
                        {rem.audit_hash && (
                          <span className="text-[#6B6860]">
                            (Audit SHA: {rem.audit_hash.slice(0, 12)}...)
                          </span>
                        )}
                        {rem.message && <span className="text-[#6B6860]">&middot; {rem.message}</span>}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
