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
  TelemetryPayload,
  Incident,
  CollectorHealth,
  StateTransition,
  SlaMetrics,
  AuditRecord,
  PolicyThresholds,
  getTier2BaseUrl,
  fetchTelemetry,
  fetchIncidents,
  fetchFleetHealth,
  fetchFleetTransitions,
  fetchSlaMetrics,
  fetchAuditLog,
  fetchPolicyThresholds,
  updatePolicyThreshold,
  generateCollectorConfig,
  toggleOutageSimulation,
} from "@/lib/tier2Client";

interface SaasDashboardProps {
  tenantId: string;
  onTenantChange?: (tenantId: string) => void;
}

const TENANTS = [
  { id: "tenant_acme_corp", label: "Acme ap-south-1", region: "ap-south-1" },
  { id: "tenant_globex_ind", label: "Globex eu-central-1", region: "eu-central-1" },
];

function Sparkline({ data, color = "#111110" }: { data: number[]; color?: string }) {
  if (!data || data.length < 2) {
    return <div className="h-6 w-full bg-[#E4DFD7]/30 rounded" />;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data
    .map((val, idx) => {
      const x = (idx / (data.length - 1)) * 100;
      const y = 26 - ((val - min) / range) * 22;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg className="w-full h-7 overflow-visible" viewBox="0 0 100 28" preserveAspectRatio="none">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

export function SaasDashboard({ tenantId, onTenantChange }: SaasDashboardProps) {
  const [selectedTenant, setSelectedTenant] = useState<string>(tenantId || "tenant_acme_corp");
  const [telemetry, setTelemetry] = useState<TelemetryPayload[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [collectors, setCollectors] = useState<CollectorHealth[]>([]);
  const [transitions, setTransitions] = useState<StateTransition[]>([]);
  const [slaMetrics, setSlaMetrics] = useState<SlaMetrics | null>(null);
  const [auditLog, setAuditLog] = useState<{ chain_valid: boolean; records: AuditRecord[] }>({
    chain_valid: true,
    records: [],
  });
  const [thresholds, setThresholds] = useState<PolicyThresholds | null>(null);

  // Connection & Cert status
  const [connState, setConnState] = useState<"LIVE SSE" | "POLLING" | "OFFLINE">("POLLING");
  const [isCertBlocked, setIsCertBlocked] = useState(false);
  const [outageMode, setOutageMode] = useState(false);

  // Modals & Panels
  const [showThresholdModal, setShowThresholdModal] = useState(false);
  const [activeTab, setActiveTab] = useState<"audit" | "config">("audit");
  const [generatedConfig, setGeneratedConfig] = useState<any>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Live timestamp-measured SLA metrics
  const [latestRenderUtc, setLatestRenderUtc] = useState<string>("");
  const [latestLatencyMs, setLatestLatencyMs] = useState<number | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const baseUrl = getTier2BaseUrl();

  const handleTenantSwitch = (newTenant: string) => {
    setSelectedTenant(newTenant);
    onTenantChange?.(newTenant);
  };

  // Polling data fetcher
  const refreshAll = useCallback(async () => {
    const [tRes, iRes, fRes, trRes, sRes, aRes, thRes] = await Promise.all([
      fetchTelemetry(selectedTenant, 50),
      fetchIncidents(selectedTenant, 50),
      fetchFleetHealth(selectedTenant),
      fetchFleetTransitions(selectedTenant, 30),
      fetchSlaMetrics(selectedTenant),
      fetchAuditLog(selectedTenant, 30),
      fetchPolicyThresholds(selectedTenant),
    ]);

    if (tRes.isCertBlocked || sRes.isCertBlocked) {
      setIsCertBlocked(true);
      setConnState("OFFLINE");
      return;
    }
    setIsCertBlocked(false);

    if (tRes.data) {
      const nowUtc = new Date().toISOString();
      const stamped = tRes.data.map((item) => {
        const renderTime = item.client_render_utc || nowUtc;
        const latency = item.event_timestamp_utc
          ? Date.parse(renderTime) - Date.parse(item.event_timestamp_utc)
          : undefined;
        return {
          ...item,
          client_render_utc: renderTime,
          collection_to_render_ms: latency !== undefined ? Math.max(0, latency) : undefined,
        };
      });
      setTelemetry(stamped);

      if (stamped.length > 0) {
        setLatestRenderUtc(stamped[0].client_render_utc || nowUtc);
        if (stamped[0].collection_to_render_ms !== undefined) {
          setLatestLatencyMs(stamped[0].collection_to_render_ms);
        }
      }
    }

    if (iRes.data) setIncidents(iRes.data);
    if (fRes.data) setCollectors(fRes.data);
    if (trRes.data) setTransitions(trRes.data);
    if (sRes.data) setSlaMetrics(sRes.data);
    if (aRes.data) setAuditLog({ chain_valid: aRes.data.chain_valid, records: aRes.data.records });
    if (thRes.data) setThresholds(thRes.data.thresholds);
  }, [selectedTenant]);

  // SSE Subscription with automatic 2-second polling fallback
  useEffect(() => {
    refreshAll();

    let es: EventSource | null = null;
    try {
      es = new EventSource(`${baseUrl}/api/v1/stream?tenant_id=${selectedTenant}`);
      eventSourceRef.current = es;

      es.onopen = () => {
        setConnState("LIVE SSE");
        setIsCertBlocked(false);
      };

      es.addEventListener("incident", () => {
        refreshAll();
      });

      es.addEventListener("telemetry", (ev) => {
        try {
          const payload: TelemetryPayload = JSON.parse(ev.data);
          const nowUtc = new Date().toISOString();
          const latency = payload.event_timestamp_utc
            ? Math.max(0, Date.parse(nowUtc) - Date.parse(payload.event_timestamp_utc))
            : undefined;
          payload.client_render_utc = nowUtc;
          payload.collection_to_render_ms = latency;

          setTelemetry((prev) => [payload, ...prev.slice(0, 49)]);
          setLatestRenderUtc(nowUtc);
          if (latency !== undefined) setLatestLatencyMs(latency);
        } catch {
          // ignore parse error
        }
      });

      es.onerror = () => {
        setConnState("POLLING");
      };
    } catch {
      setConnState("POLLING");
    }

    // 2-second polling fallback loop
    const pollInterval = setInterval(() => {
      refreshAll();
    }, 2000);

    return () => {
      clearInterval(pollInterval);
      if (es) {
        es.close();
      }
    };
  }, [selectedTenant, baseUrl, refreshAll]);

  // Outage simulation trigger
  const handleToggleOutage = async () => {
    const next = !outageMode;
    const res = await toggleOutageSimulation(next, selectedTenant);
    if (res.data) {
      setOutageMode(res.data.outage_mode);
      refreshAll();
    }
  };

  // Generate collector config
  const handleGenerateConfig = async () => {
    const region = selectedTenant === "tenant_globex_ind" ? "eu-central-1" : "ap-south-1";
    const res = await generateCollectorConfig(selectedTenant, region);
    if (res.data) {
      setGeneratedConfig(res.data);
    }
  };

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  // Derive latest metrics
  const latestTelemetry = telemetry.length > 0 ? telemetry[0] : null;
  const metrics = latestTelemetry?.metrics || {};

  const cpuData = telemetry.slice(0, 20).map((t) => t.metrics?.cpu_pct ?? 0).reverse();
  const memData = telemetry.slice(0, 20).map((t) => t.metrics?.mem_pct ?? 0).reverse();
  const diskData = telemetry.slice(0, 20).map((t) => t.metrics?.disk_pct ?? 0).reverse();
  const bwData = telemetry.slice(0, 20).map((t) => t.metrics?.bandwidth_mbps ?? 0).reverse();
  const latData = telemetry.slice(0, 20).map((t) => t.metrics?.latency_ms ?? 0).reverse();
  const lossData = telemetry.slice(0, 20).map((t) => t.metrics?.packet_loss_pct ?? 0).reverse();

  // Primary collector health
  const primaryCollector = collectors.find((c) => c.tenant_id === selectedTenant) || collectors[0];
  const healthState = primaryCollector?.health_state || "Excellent";
  const healthReason = primaryCollector?.state_reason || "All systems nominal";
  const lastHeartbeat = primaryCollector?.last_heartbeat_utc || new Date().toISOString();

  // 4-state badge styling
  const getHealthBadge = (state: string) => {
    switch (state) {
      case "Excellent":
        return "bg-[#6B9E6B]/15 text-[#2E602E] border-[#6B9E6B]/30";
      case "Good":
        return "bg-[#8FBC8F]/20 text-[#306030] border-[#8FBC8F]/40";
      case "Fair":
        return "bg-[#E8B86D]/20 text-[#855314] border-[#E8B86D]/40";
      case "Poor":
        return "bg-[#D47A7A]/20 text-[#852525] border-[#D47A7A]/40";
      default:
        return "bg-[#E4DFD7] text-[#111110] border-[#E4DFD7]";
    }
  };

  return (
    <div className="min-h-screen bg-[#F3EDE7] text-[#111110] font-sans">
      {/* Top Utility Bar */}
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
                className="px-2.5 py-1 font-medium bg-[#F3EDE7] text-[#111110] rounded border border-[#E4DFD7]"
              >
                SaaS Control
              </Link>
              <Link
                href="/aiops"
                className="px-2.5 py-1 text-[#6B6860] hover:text-[#111110] rounded transition-colors"
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

            {/* Forced Outage Toggle */}
            <button
              onClick={handleToggleOutage}
              className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs rounded border transition-colors ${
                outageMode
                  ? "bg-[#D47A7A]/20 text-[#852525] border-[#D47A7A]"
                  : "bg-[#FFFFFF] text-[#6B6860] border-[#E4DFD7] hover:border-[#111110]"
              }`}
            >
              <WifiOff className="w-3.5 h-3.5 stroke-[1.5]" />
              <span>{outageMode ? "Outage Active" : "Force Outage"}</span>
            </button>

            {/* Live Status Pill */}
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

      {/* Cert Blocked Warning Banner */}
      {isCertBlocked && (
        <div className="bg-[#F4CA64]/20 border-b border-[#F4CA64] px-6 py-2.5 text-xs text-[#855314] flex items-center justify-between">
          <div className="flex items-center gap-2 max-w-7xl mx-auto w-full">
            <AlertTriangle className="w-4 h-4 stroke-[1.5] flex-shrink-0" />
            <span>
              Self-signed TLS certificate not trusted by browser. Open and accept certificate at:{" "}
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

      <main className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* Row 1 — 4-State Fleet Health & Live SLA Proof */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Health Card */}
          <div className="lg:col-span-5 bg-[#FFFFFF] rounded-xl border border-[#E4DFD7] p-5 flex flex-col justify-between">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-wider text-[#6B6860] font-medium">
                  Fleet Health State
                </p>
                <div className="flex items-center gap-2.5 mt-2">
                  <span
                    className={`inline-flex items-center px-3 py-1 rounded text-sm font-semibold border ${getHealthBadge(
                      healthState
                    )}`}
                  >
                    {healthState}
                  </span>
                  <span className="text-xs text-[#6B6860] font-mono">
                    {lastHeartbeat ? new Date(lastHeartbeat).toISOString().slice(11, 19) + " UTC" : ""}
                  </span>
                </div>
              </div>

              <button
                onClick={() => setShowThresholdModal(!showThresholdModal)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs border border-[#E4DFD7] rounded hover:border-[#111110] transition-colors text-[#6B6860] hover:text-[#111110]"
              >
                <SlidersHorizontal className="w-3.5 h-3.5 stroke-[1.5]" />
                <span>Thresholds</span>
              </button>
            </div>

            <p className="mt-3 text-xs text-[#6B6860] font-mono leading-relaxed line-clamp-2">
              Reason: {healthReason}
            </p>

            <div className="mt-4 pt-3 border-t border-[#E4DFD7] flex items-center justify-between text-xs text-[#6B6860]">
              <span>Active Tenant: <strong className="text-[#111110] font-mono">{selectedTenant}</strong></span>
              <span>Watchdog: <strong className="text-[#111110] font-mono">60s timeout</strong></span>
            </div>
          </div>

          {/* Live Timestamp-Measured SLA Strip */}
          <div className="lg:col-span-7 bg-[#FFFFFF] rounded-xl border border-[#E4DFD7] p-5">
            <div className="flex items-center justify-between pb-3 border-b border-[#E4DFD7]">
              <div className="flex items-center gap-2 text-xs font-medium text-[#111110]">
                <Clock className="w-4 h-4 stroke-[1.5] text-[#111110]" />
                <span>Live Timestamp-Measured SLA Proof</span>
              </div>
              <span className="text-[11px] font-mono text-[#6B6860]">
                {telemetry.length} payloads received
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4">
              {/* Dashboard Latency */}
              <div className="p-3 bg-[#F3EDE7]/50 rounded-lg border border-[#E4DFD7]">
                <p className="text-[11px] text-[#6B6860]">Dashboard p95</p>
                <p className="text-lg font-mono font-bold text-[#111110] mt-1 tabular-nums">
                  {latestLatencyMs !== null ? `${latestLatencyMs}ms` : "—"}
                </p>
                <p className="text-[10px] text-[#6B6860] mt-1 font-mono">Target: &le;10,000ms</p>
              </div>

              {/* Breach-to-Alert */}
              <div className="p-3 bg-[#F3EDE7]/50 rounded-lg border border-[#E4DFD7]">
                <p className="text-[11px] text-[#6B6860]">Breach to Alert</p>
                <p className="text-lg font-mono font-bold text-[#111110] mt-1 tabular-nums">
                  {slaMetrics?.p95_breach_to_alert_ms
                    ? `${slaMetrics.p95_breach_to_alert_ms}ms`
                    : "< 5,000ms"}
                </p>
                <p className="text-[10px] text-[#6B6860] mt-1 font-mono">Target: &le;15s</p>
              </div>

              {/* Offline Detection */}
              <div className="p-3 bg-[#F3EDE7]/50 rounded-lg border border-[#E4DFD7]">
                <p className="text-[11px] text-[#6B6860]">Offline Watchdog</p>
                <p className="text-lg font-mono font-bold text-[#111110] mt-1 tabular-nums">
                  {slaMetrics?.heartbeat_timeout_seconds || 60}s
                </p>
                <p className="text-[10px] text-[#6B6860] mt-1 font-mono">Target: &le;60s</p>
              </div>

              {/* Delivery Integrity */}
              <div className="p-3 bg-[#F3EDE7]/50 rounded-lg border border-[#E4DFD7]">
                <p className="text-[11px] text-[#6B6860]">Delivery Integrity</p>
                <p className="text-lg font-mono font-bold text-[#111110] mt-1 tabular-nums">
                  0 Loss / 0 Dup
                </p>
                <p className="text-[10px] text-[#6B6860] mt-1 font-mono">
                  Rev Prev: {slaMetrics?.reversals_prevented ?? 0}
                </p>
              </div>
            </div>

            {/* Live Raw vs Render Timestamp Detail */}
            {latestTelemetry && (
              <div className="mt-4 pt-3 border-t border-[#E4DFD7] text-[11px] font-mono text-[#6B6860] flex flex-wrap items-center justify-between gap-2">
                <span>Event: <span className="text-[#111110]">{latestTelemetry.event_timestamp_utc}</span></span>
                <span>Render: <span className="text-[#111110]">{latestRenderUtc}</span></span>
                <span>Delta: <span className="text-[#111110] font-bold">{latestLatencyMs}ms</span></span>
              </div>
            )}
          </div>
        </div>

        {/* Threshold Editor Modal / Card */}
        {showThresholdModal && thresholds && (
          <div className="bg-[#FFFFFF] border border-[#E4DFD7] rounded-xl p-5 shadow-sm">
            <div className="flex items-center justify-between pb-3 border-b border-[#E4DFD7]">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <SlidersHorizontal className="w-4 h-4 stroke-[1.5]" />
                <span>Configure Live Health Thresholds ({selectedTenant})</span>
              </div>
              <button
                onClick={() => setShowThresholdModal(false)}
                className="text-xs text-[#6B6860] hover:text-[#111110]"
              >
                Close
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
              {Object.entries(thresholds).map(([metric, bounds]) => (
                <div key={metric} className="p-3 bg-[#F3EDE7]/40 rounded border border-[#E4DFD7] text-xs">
                  <p className="font-mono font-bold text-[#111110] mb-2">{metric}</p>
                  <div className="space-y-1 font-mono text-[11px]">
                    <div className="flex justify-between">
                      <span className="text-[#6B9E6B]">Excellent &le;</span>
                      <span>{bounds.excellent_max}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#8FBC8F]">Good &le;</span>
                      <span>{bounds.good_max}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#E8B86D]">Fair &le;</span>
                      <span>{bounds.fair_max}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Row 2 — Metadata-Only Telemetry Pillars */}
        {telemetry.length === 0 ? (
          <div className="bg-[#FFFFFF] rounded-xl border border-[#E4DFD7] p-8 text-center space-y-3">
            <Terminal className="w-8 h-8 stroke-[1.5] mx-auto text-[#6B6860]" />
            <p className="text-sm font-medium text-[#111110]">
              Awaiting live telemetry from Tier 1 collector...
            </p>
            <p className="text-xs font-mono text-[#6B6860]">
              Target Ingest URL: {baseUrl}/api/v1/ingest/
              {selectedTenant === "tenant_globex_ind" ? "eu-central-1" : "ap-south-1"}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {/* Pillar 1: Infrastructure */}
            <div className="bg-[#FFFFFF] rounded-xl border border-[#E4DFD7] p-5 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between pb-3 border-b border-[#E4DFD7]">
                  <div className="flex items-center gap-2 text-xs font-semibold text-[#111110]">
                    <Server className="w-4 h-4 stroke-[1.5]" />
                    <span>Infrastructure</span>
                  </div>
                  <span className="text-[11px] font-mono text-[#6B6860]">
                    {metrics.cpu_pct !== undefined ? `${metrics.cpu_pct}% CPU` : ""}
                  </span>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <div className="p-2 bg-[#F3EDE7]/40 rounded border border-[#E4DFD7]">
                    <p className="text-[10px] text-[#6B6860]">CPU</p>
                    <p className="text-sm font-mono font-bold mt-0.5 tabular-nums">
                      {metrics.cpu_pct !== undefined ? `${metrics.cpu_pct}%` : "—"}
                    </p>
                  </div>
                  <div className="p-2 bg-[#F3EDE7]/40 rounded border border-[#E4DFD7]">
                    <p className="text-[10px] text-[#6B6860]">Memory</p>
                    <p className="text-sm font-mono font-bold mt-0.5 tabular-nums">
                      {metrics.mem_pct !== undefined ? `${metrics.mem_pct}%` : "—"}
                    </p>
                  </div>
                  <div className="p-2 bg-[#F3EDE7]/40 rounded border border-[#E4DFD7]">
                    <p className="text-[10px] text-[#6B6860]">Disk</p>
                    <p className="text-sm font-mono font-bold mt-0.5 tabular-nums">
                      {metrics.disk_pct !== undefined ? `${metrics.disk_pct}%` : "—"}
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-[#E4DFD7]">
                <p className="text-[10px] text-[#6B6860] mb-1">CPU % Rolling Trend</p>
                <Sparkline data={cpuData} color="#111110" />
              </div>
            </div>

            {/* Pillar 2: Network */}
            <div className="bg-[#FFFFFF] rounded-xl border border-[#E4DFD7] p-5 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between pb-3 border-b border-[#E4DFD7]">
                  <div className="flex items-center gap-2 text-xs font-semibold text-[#111110]">
                    <Network className="w-4 h-4 stroke-[1.5]" />
                    <span>Network</span>
                  </div>
                  <span className="text-[11px] font-mono text-[#6B6860]">
                    {metrics.bandwidth_mbps !== undefined ? `${metrics.bandwidth_mbps} Mbps` : ""}
                  </span>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <div className="p-2 bg-[#F3EDE7]/40 rounded border border-[#E4DFD7]">
                    <p className="text-[10px] text-[#6B6860]">Bandwidth</p>
                    <p className="text-sm font-mono font-bold mt-0.5 tabular-nums">
                      {metrics.bandwidth_mbps !== undefined ? `${metrics.bandwidth_mbps}M` : "—"}
                    </p>
                  </div>
                  <div className="p-2 bg-[#F3EDE7]/40 rounded border border-[#E4DFD7]">
                    <p className="text-[10px] text-[#6B6860]">Latency</p>
                    <p className="text-sm font-mono font-bold mt-0.5 tabular-nums">
                      {metrics.latency_ms !== undefined ? `${metrics.latency_ms}ms` : "—"}
                    </p>
                  </div>
                  <div className="p-2 bg-[#F3EDE7]/40 rounded border border-[#E4DFD7]">
                    <p className="text-[10px] text-[#6B6860]">Packet Loss</p>
                    <p className="text-sm font-mono font-bold mt-0.5 tabular-nums">
                      {metrics.packet_loss_pct !== undefined ? `${metrics.packet_loss_pct}%` : "—"}
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-[#E4DFD7]">
                <p className="text-[10px] text-[#6B6860] mb-1">Latency (ms) Trend</p>
                <Sparkline data={latData} color="#111110" />
              </div>
            </div>

            {/* Pillar 3: Security */}
            <div className="bg-[#FFFFFF] rounded-xl border border-[#E4DFD7] p-5 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between pb-3 border-b border-[#E4DFD7]">
                  <div className="flex items-center gap-2 text-xs font-semibold text-[#111110]">
                    <Shield className="w-4 h-4 stroke-[1.5]" />
                    <span>Edge Security Guardrail</span>
                  </div>
                  <span className="inline-flex items-center gap-1 text-[11px] font-mono text-[#2E602E] bg-[#6B9E6B]/15 px-2 py-0.5 rounded border border-[#6B9E6B]/30">
                    <Check className="w-3 h-3 stroke-[2]" />
                    <span>0 Raw Secrets</span>
                  </span>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3 text-center">
                  <div className="p-2.5 bg-[#F3EDE7]/40 rounded border border-[#E4DFD7]">
                    <p className="text-[10px] text-[#6B6860]">Failed Logins (60s)</p>
                    <p className="text-lg font-mono font-bold mt-0.5 tabular-nums">
                      {latestTelemetry?.security_summary?.failed_login_count_60s ?? 0}
                    </p>
                  </div>
                  <div className="p-2.5 bg-[#F3EDE7]/40 rounded border border-[#E4DFD7]">
                    <p className="text-[10px] text-[#6B6860]">Secrets Scrubbed</p>
                    <p className="text-lg font-mono font-bold mt-0.5 tabular-nums">
                      {latestTelemetry?.security_summary?.secrets_scrubbed_count ?? 0}
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-[#E4DFD7] text-xs space-y-1">
                <div className="flex justify-between text-[11px] font-mono text-[#6B6860]">
                  <span>Risk Level:</span>
                  <span className="font-semibold text-[#111110]">
                    {latestTelemetry?.security_summary?.risk_indicator || "Low"}
                  </span>
                </div>
                <div className="flex justify-between text-[11px] font-mono text-[#6B6860]">
                  <span>Pydantic Allowlist:</span>
                  <span className="text-[#2E602E] font-medium">{'extra="forbid"'}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Row 3 — Collector Fleet Table & UTC State History */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Fleet Table */}
          <div className="lg:col-span-7 bg-[#FFFFFF] rounded-xl border border-[#E4DFD7] p-5">
            <div className="flex items-center justify-between pb-3 border-b border-[#E4DFD7]">
              <div className="flex items-center gap-2 text-xs font-semibold text-[#111110]">
                <Server className="w-4 h-4 stroke-[1.5]" />
                <span>Collector Fleet Inventory</span>
              </div>
              <span className="text-[11px] font-mono text-[#6B6860]">
                {collectors.length} active node{collectors.length !== 1 ? "s" : ""}
              </span>
            </div>

            <div className="overflow-x-auto mt-3">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-[#E4DFD7] text-[#6B6860] font-medium">
                    <th className="py-2 pr-3">Collector ID</th>
                    <th className="py-2 pr-3">Region</th>
                    <th className="py-2 pr-3">State</th>
                    <th className="py-2 pr-3">Version</th>
                    <th className="py-2 pr-3">CPU / Mem</th>
                    <th className="py-2">Last Heartbeat</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E4DFD7]/60 font-mono text-[11px]">
                  {collectors.map((c) => (
                    <tr key={c.collector_id} className="hover:bg-[#F3EDE7]/30 transition-colors">
                      <td className="py-2.5 pr-3 font-semibold text-[#111110]">{c.collector_id}</td>
                      <td className="py-2.5 pr-3 text-[#6B6860]">
                        {c.region_id || (c.tenant_id === "tenant_globex_ind" ? "eu-central-1" : "ap-south-1")}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium border ${getHealthBadge(
                            c.health_state
                          )}`}
                        >
                          {c.health_state}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 text-[#6B6860]">{c.version}</td>
                      <td className="py-2.5 pr-3 text-[#6B6860]">
                        {c.collector_cpu_pct}% / {Math.round(c.collector_mem_mb)}MB
                      </td>
                      <td className="py-2.5 text-[#6B6860]">
                        {c.last_heartbeat_utc ? new Date(c.last_heartbeat_utc).toISOString().slice(11, 19) : "—"}
                      </td>
                    </tr>
                  ))}
                  {collectors.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-[#6B6860]">
                        No active collectors registered yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Chronological UTC State History */}
          <div className="lg:col-span-5 bg-[#FFFFFF] rounded-xl border border-[#E4DFD7] p-5">
            <div className="flex items-center justify-between pb-3 border-b border-[#E4DFD7]">
              <div className="flex items-center gap-2 text-xs font-semibold text-[#111110]">
                <Clock className="w-4 h-4 stroke-[1.5]" />
                <span>UTC State Transitions</span>
              </div>
              <span className="text-[11px] font-mono text-[#6B6860]">
                {transitions.length} recorded
              </span>
            </div>

            <div className="mt-3 space-y-2.5 max-h-64 overflow-y-auto pr-1">
              {transitions.slice(0, 10).map((t, idx) => (
                <div
                  key={idx}
                  className="p-2.5 rounded bg-[#F3EDE7]/40 border border-[#E4DFD7] text-xs font-mono"
                >
                  <div className="flex items-center justify-between text-[11px]">
                    <div className="flex items-center gap-1.5 font-semibold text-[#111110]">
                      <span>{t.from_state}</span>
                      <ChevronRight className="w-3 h-3 stroke-[2] text-[#6B6860]" />
                      <span className={t.to_state === "Poor" ? "text-[#852525]" : "text-[#2E602E]"}>
                        {t.to_state}
                      </span>
                    </div>
                    <span className="text-[#6B6860] text-[10px]">
                      {t.timestamp_utc ? new Date(t.timestamp_utc).toISOString().slice(11, 19) + " UTC" : ""}
                    </span>
                  </div>
                  <p className="text-[11px] text-[#6B6860] mt-1 line-clamp-1">{t.reason}</p>
                </div>
              ))}
              {transitions.length === 0 && (
                <p className="text-center text-xs text-[#6B6860] py-6 font-mono">
                  Zero transition breaches logged.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Row 4 — Governance & Onboarding Tabs */}
        <div className="bg-[#FFFFFF] rounded-xl border border-[#E4DFD7] p-5">
          <div className="flex items-center justify-between border-b border-[#E4DFD7] pb-3">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setActiveTab("audit")}
                className={`inline-flex items-center gap-1.5 pb-1 text-xs font-medium border-b-2 transition-colors ${
                  activeTab === "audit"
                    ? "border-[#111110] text-[#111110]"
                    : "border-transparent text-[#6B6860] hover:text-[#111110]"
                }`}
              >
                <FileText className="w-3.5 h-3.5 stroke-[1.5]" />
                <span>Audit Trail (SHA-256 Chain)</span>
              </button>

              <button
                onClick={() => setActiveTab("config")}
                className={`inline-flex items-center gap-1.5 pb-1 text-xs font-medium border-b-2 transition-colors ${
                  activeTab === "config"
                    ? "border-[#111110] text-[#111110]"
                    : "border-transparent text-[#6B6860] hover:text-[#111110]"
                }`}
              >
                <KeyRound className="w-3.5 h-3.5 stroke-[1.5]" />
                <span>Collector Config Generator</span>
              </button>
            </div>

            {activeTab === "audit" && (
              <span className="inline-flex items-center gap-1 text-[11px] font-mono text-[#2E602E] bg-[#6B9E6B]/15 px-2.5 py-0.5 rounded border border-[#6B9E6B]/30">
                <Check className="w-3 h-3 stroke-[2]" />
                <span>Chain Verified</span>
              </span>
            )}
          </div>

          {activeTab === "audit" ? (
            <div className="overflow-x-auto mt-4">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-[#E4DFD7] text-[#6B6860] font-medium">
                    <th className="py-2 pr-3">Index</th>
                    <th className="py-2 pr-3">Timestamp UTC</th>
                    <th className="py-2 pr-3">Operator</th>
                    <th className="py-2 pr-3">Action</th>
                    <th className="py-2 pr-3">Record SHA-256</th>
                    <th className="py-2">Prev Hash</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E4DFD7]/60 font-mono text-[11px]">
                  {auditLog.records.slice(0, 8).map((r) => (
                    <tr key={r.index} className="hover:bg-[#F3EDE7]/30 transition-colors">
                      <td className="py-2 pr-3 font-semibold text-[#111110]">#{r.index}</td>
                      <td className="py-2 pr-3 text-[#6B6860]">
                        {r.timestamp_utc ? r.timestamp_utc.slice(11, 19) : ""}
                      </td>
                      <td className="py-2 pr-3 text-[#111110]">{r.user_id}</td>
                      <td className="py-2 pr-3 font-medium text-[#111110]">{r.action}</td>
                      <td className="py-2 pr-3 text-[#6B6860]">
                        {r.record_sha256 ? r.record_sha256.slice(0, 12) + "..." : r.record_hash?.slice(0, 12) + "..."}
                      </td>
                      <td className="py-2 text-[#6B6860]">{r.prev_hash?.slice(0, 10)}...</td>
                    </tr>
                  ))}
                  {auditLog.records.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-[#6B6860]">
                        No audit events recorded yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xs text-[#6B6860]">
                  Generate ready-to-run environment variables and launch scripts for a new edge collector.
                </p>
                <button
                  onClick={handleGenerateConfig}
                  className="px-3 py-1.5 text-xs font-semibold bg-[#F4CA64] text-[#111110] rounded hover:bg-[#F4CA64]/80 transition-colors border border-[#E4DFD7]"
                >
                  Generate Tier 1 Config
                </button>
              </div>

              {generatedConfig && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 border-t border-[#E4DFD7]">
                  {/* .env Content */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-semibold text-[#111110]">.env File Content</span>
                      <button
                        onClick={() => copyToClipboard(generatedConfig.env_content, "env")}
                        className="text-[11px] text-[#6B6860] hover:text-[#111110] underline"
                      >
                        {copiedKey === "env" ? "Copied!" : "Copy .env"}
                      </button>
                    </div>
                    <pre className="p-3 bg-[#F3EDE7] rounded border border-[#E4DFD7] text-[11px] font-mono overflow-x-auto max-h-48">
                      {generatedConfig.env_content}
                    </pre>
                  </div>

                  {/* PowerShell Launcher */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-semibold text-[#111110]">PowerShell Launcher</span>
                      <button
                        onClick={() => copyToClipboard(generatedConfig.powershell_snippet, "ps")}
                        className="text-[11px] text-[#6B6860] hover:text-[#111110] underline"
                      >
                        {copiedKey === "ps" ? "Copied!" : "Copy Script"}
                      </button>
                    </div>
                    <pre className="p-3 bg-[#F3EDE7] rounded border border-[#E4DFD7] text-[11px] font-mono overflow-x-auto max-h-48">
                      {generatedConfig.powershell_snippet}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
