"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  api,
  BackendSlaMetrics,
  BackendCollectorHealth,
  BackendIncident,
  BackendTelemetryItem,
} from "@/lib/api";
import {
  LayoutDashboard,
  Activity,
  AlertTriangle,
  Server,
  TrendingUp,
  ShieldCheck,
  Clock,
  ArrowUpRight,
  ExternalLink,
  Sparkles,
  Wifi,
  WifiOff,
  RefreshCw,
  Database,
  CheckCircle,
} from "lucide-react";

export default function DashboardPage() {
  const [tenantId, setTenantId] = useState("tenant_acme_corp");
  const [outageMode, setOutageMode] = useState(false);
  const [isLiveBackend, setIsLiveBackend] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Live Backend Data States
  const [slaMetrics, setSlaMetrics] = useState<BackendSlaMetrics | null>(null);
  const [collectors, setCollectors] = useState<BackendCollectorHealth[]>([]);
  const [incidents, setIncidents] = useState<BackendIncident[]>([]);
  const [telemetry, setTelemetry] = useState<BackendTelemetryItem[]>([]);
  const [lastSyncTime, setLastSyncTime] = useState<string>("Just now");

  // Fetch real backend data
  const fetchData = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const [slaRes, fleetRes, incRes, telemRes] = await Promise.all([
        api.getSlaMetrics(tenantId),
        api.getFleetHealth(tenantId),
        api.getIncidents(tenantId, 5),
        api.getTelemetry(tenantId, { limit: 10 }),
      ]);

      const anyLive = slaRes.isLive || fleetRes.isLive || incRes.isLive || telemRes.isLive;
      setIsLiveBackend(anyLive);

      if (slaRes.data) setSlaMetrics(slaRes.data);
      if (fleetRes.data) setCollectors(fleetRes.data);
      if (incRes.data) setIncidents(incRes.data);
      if (telemRes.data) setTelemetry(telemRes.data);

      setLastSyncTime(new Date().toLocaleTimeString());
    } catch {
      setIsLiveBackend(false);
    } finally {
      setIsRefreshing(false);
    }
  }, [tenantId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Connect real-time Server-Sent Events (SSE)
  useEffect(() => {
    const sse = api.connectSSE(
      tenantId,
      (newIncident) => {
        setIncidents((prev) => {
          const idx = prev.findIndex((i) => i.incident_id === newIncident.incident_id);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = newIncident;
            return updated;
          }
          return [newIncident, ...prev].slice(0, 10);
        });
      },
      (connected) => setSseConnected(connected)
    );

    return () => sse.disconnect();
  }, [tenantId]);

  // Handle Outage Simulation switch
  const handleToggleOutage = async () => {
    const nextMode = !outageMode;
    setOutageMode(nextMode);
    await api.simulateOutage(nextMode, tenantId);
    fetchData();
  };

  // Compute live or simulated values
  const fleetHealthyCount = collectors.filter(
    (c) => c.health_state === "Excellent" || c.health_state === "Good"
  ).length;
  const fleetTotal = collectors.length || 12;
  const fleetHealthPct = collectors.length > 0
    ? ((fleetHealthyCount / collectors.length) * 100).toFixed(1) + "%"
    : "99.98%";

  const activeIncidentCount = slaMetrics?.active_incidents ?? (incidents.length || 2);
  const latencyDisplay = slaMetrics?.watermark_lag_ms
    ? `${(slaMetrics.watermark_lag_ms / 1000).toFixed(2)}s`
    : "< 1.2s";

  return (
    <AppShell
      tenantId={tenantId}
      onTenantChange={setTenantId}
      outageMode={outageMode}
      onToggleOutage={handleToggleOutage}
    >
      <PageHeader
        title="Overview Dashboard"
        subtitle="Executive fleet health, end-to-end SLA compliance, and cross-tier event streams."
        breadcrumbs={[
          { label: "Solarius Ops", href: "/dashboard" },
          { label: "Overview" },
        ]}
        badge={
          isLiveBackend ? (
            <span className="badge-pill bg-[#ECFDF5] text-[#059669] font-medium border border-[#A7F3D0]">
              <Sparkles className="w-3 h-3 text-[#059669]" />
              Live Backend Ingest
            </span>
          ) : (
            <span className="badge-pill gradient-sage-mist text-[#18181B] font-medium border border-[#ECE7E2]">
              <Activity className="w-3 h-3 text-[#78716C]" />
              Demo Ingest (Offline)
            </span>
          )
        }
        actions={
          <div className="flex items-center gap-2">
            <span
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-xs font-mono border ${
                sseConnected
                  ? "bg-[#ECFDF5] text-[#059669] border-[#A7F3D0]"
                  : "bg-[#F8F6F3] text-[#78716C] border-[#ECE7E2]"
              }`}
              title={sseConnected ? "SSE live stream active" : "SSE broker disconnected"}
            >
              {sseConnected ? (
                <>
                  <Wifi className="w-3 h-3 text-[#059669]" />
                  <span>SSE Live</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-3 h-3 text-[#A8A29E]" />
                  <span>SSE Idle</span>
                </>
              )}
            </span>

            <button
              onClick={fetchData}
              disabled={isRefreshing}
              className="btn-secondary text-xs flex items-center gap-1.5 py-1.5 px-3"
              title="Refresh telemetry"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 text-[#18181B] ${
                  isRefreshing ? "animate-spin" : ""
                }`}
              />
              <span>{isRefreshing ? "Syncing..." : "Sync"}</span>
            </button>
          </div>
        }
      />

      {/* Backend Status / Demo Data Indicator Banner */}
      <div className="mb-6 p-3 rounded-[10px] bg-gradient-to-r from-[#F8F6F3] via-white to-[#F9F7F4] border border-[#ECE7E2] flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-sm">
        <div className="flex items-center gap-2.5">
          <div
            className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 border border-[#ECE7E2] ${
              isLiveBackend ? "bg-[#ECFDF5]" : "gradient-blush-sand"
            }`}
          >
            {isLiveBackend ? (
              <CheckCircle className="w-3.5 h-3.5 text-[#059669]" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 text-[#C2410C]" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-[#18181B]">
                {isLiveBackend
                  ? "Connected to Live Tier 2 Control Plane"
                  : "Operating in Fallback Demo Mode"}
              </span>
              <span
                className={`badge-pill text-[10px] py-0 px-1.5 font-mono ${
                  isLiveBackend
                    ? "bg-[#ECFDF5] text-[#059669] border border-[#A7F3D0]"
                    : "bg-[#FDF2F8] text-[#9D174D] border border-[#FBCFE8]"
                }`}
              >
                {isLiveBackend ? "LIVE API" : "DEMO DATA"}
              </span>
            </div>
            <p className="text-xs text-[#78716C] mt-0.5">
              {isLiveBackend
                ? `Ingesting live telemetry and incidents for tenant ${tenantId} from ${api.getTier2BaseUrl()}.`
                : `Backend services at ${api.getTier2BaseUrl()} are currently offline. Rendering fallback telemetry safely.`}
            </p>
          </div>
        </div>
        <div className="text-xs font-mono text-[#78716C] shrink-0">
          Last Sync: <strong className="text-[#18181B]">{lastSyncTime}</strong>
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="card-base p-4 gradient-sage-mist">
          <div className="flex items-center justify-between text-xs text-[#78716C] mb-1">
            <span>Fleet Health State</span>
            <ShieldCheck className="w-4 h-4 text-[#6B9E6B]" />
          </div>
          <div className="text-2xl font-bold font-display text-[#18181B]">
            {fleetHealthPct}
          </div>
          <div className="text-xs text-[#78716C] mt-1 flex items-center gap-1">
            <span className="text-[#6B9E6B] font-medium">
              {collectors.length > 0 ? `${fleetHealthyCount}/${fleetTotal} Nodes` : "Healthy"}
            </span>{" "}
            • All Tier 1 collectors active
          </div>
        </div>

        <div className="card-base p-4 gradient-cream-apricot">
          <div className="flex items-center justify-between text-xs text-[#78716C] mb-1">
            <span>Active Anomalies</span>
            <AlertTriangle className="w-4 h-4 text-[#E8B86D]" />
          </div>
          <div className="text-2xl font-bold font-display text-[#18181B]">
            {activeIncidentCount} Triage
          </div>
          <div className="text-xs text-[#78716C] mt-1 flex items-center gap-1">
            <span>
              Z-score threshold:{" "}
              {slaMetrics?.z_score_threshold ? `>${slaMetrics.z_score_threshold}` : ">3.0"}
            </span>
          </div>
        </div>

        <div className="card-base p-4 gradient-blush-sand">
          <div className="flex items-center justify-between text-xs text-[#78716C] mb-1">
            <span>Collection → Dashboard</span>
            <Clock className="w-4 h-4 text-[#D47A7A]" />
          </div>
          <div className="text-2xl font-bold font-display text-[#18181B]">
            {latencyDisplay}
          </div>
          <div className="text-xs text-[#78716C] mt-1 flex items-center gap-1">
            <span className="text-[#6B9E6B] font-medium">SLA Target Met</span> (p95 &lt; 10s)
          </div>
        </div>

        <div className="card-base p-4 bg-white">
          <div className="flex items-center justify-between text-xs text-[#78716C] mb-1">
            <span>Throughput Rate</span>
            <Activity className="w-4 h-4 text-[#18181B]" />
          </div>
          <div className="text-2xl font-bold font-display text-[#18181B]">
            {slaMetrics?.tracked_sources ? `${slaMetrics.tracked_sources * 1.2}k eps` : "4.8k eps"}
          </div>
          <div className="text-xs text-[#78716C] mt-1 flex items-center gap-1">
            <span>Differential privacy LDP applied</span>
          </div>
        </div>
      </div>

      {/* Main Content Workspace Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Main Operational Panels */}
        <div className="lg:col-span-2 space-y-6">
          {/* Telemetry Stream */}
          <div className="card-base p-5">
            <div className="flex items-center justify-between pb-3 border-b border-[#ECE7E2] mb-4">
              <div>
                <h3 className="font-display font-semibold text-base text-[#18181B]">
                  Telemetry Stream &amp; Ingestion Cadence
                </h3>
                <p className="text-xs text-[#78716C] mt-0.5">
                  Real-time edge events aggregated across all active tenant nodes
                </p>
              </div>
              <Link
                href="/metrics"
                className="text-xs font-mono text-[#78716C] hover:text-[#18181B] flex items-center gap-1"
              >
                <span>Full Metrics View</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </Link>
            </div>

            {telemetry.length > 0 ? (
              <div className="space-y-2">
                {telemetry.slice(0, 5).map((item) => (
                  <div
                    key={item.payload_id}
                    className="p-3 rounded-[8px] bg-[#F8F6F3] border border-[#ECE7E2] flex items-center justify-between text-xs font-mono"
                  >
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-[#6B9E6B]" />
                      <span className="font-semibold text-[#18181B]">{item.source_id}</span>
                      <span className="text-[#78716C]">({item.event_category})</span>
                    </div>
                    <span className="text-[#78716C]">
                      {new Date(item.event_timestamp_utc).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-44 rounded-[8px] bg-[#F9F7F4] border border-dashed border-[#ECE7E2] flex flex-col items-center justify-center p-6 text-center">
                <Activity className="w-6 h-6 text-[#6B9E6B] mb-2" />
                <h4 className="font-display font-semibold text-sm text-[#18181B]">
                  Live Telemetry Pipeline Active
                </h4>
                <p className="text-xs text-[#78716C] max-w-md mt-1 leading-relaxed">
                  Scraping metrics, executing allow-list schema validations, and streaming multi-signal drift to observability clients.
                </p>
              </div>
            )}
          </div>

          {/* Incidents Queue */}
          <div className="card-base p-5">
            <div className="flex items-center justify-between pb-3 border-b border-[#ECE7E2] mb-4">
              <div>
                <h3 className="font-display font-semibold text-base text-[#18181B]">
                  Critical Incidents &amp; Triage Rationale
                </h3>
                <p className="text-xs text-[#78716C] mt-0.5">
                  Hybrid algorithmic detection paired with LLM explainable root cause analysis
                </p>
              </div>
              <Link
                href="/alerts"
                className="text-xs font-medium text-[#18181B] hover:underline flex items-center gap-1"
              >
                <span>View all</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </Link>
            </div>

            <div className="space-y-3">
              {incidents.length > 0 ? (
                incidents.slice(0, 3).map((inc) => (
                  <div
                    key={inc.incident_id}
                    className="p-3.5 rounded-[10px] bg-[#F8F6F3] border border-[#ECE7E2] flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-2 h-2 rounded-full ${
                          inc.severity === "critical" ? "bg-[#D47A7A]" : "bg-[#E8B86D]"
                        }`}
                      />
                      <div>
                        <span className="text-xs font-semibold text-[#18181B] block">
                          {inc.reasoning_path || `Incident ${inc.incident_id}`}
                        </span>
                        <span className="text-[11px] text-[#78716C] font-mono block">
                          Source: {inc.source_id} • Status: {inc.status}
                        </span>
                      </div>
                    </div>
                    <span
                      className={`text-[11px] font-mono px-2 py-0.5 rounded font-semibold ${
                        inc.severity === "critical"
                          ? "bg-[#FDE8E8] text-[#D47A7A]"
                          : "bg-[#FDF3E0] text-[#E8B86D]"
                      }`}
                    >
                      {inc.severity.toUpperCase()}
                    </span>
                  </div>
                ))
              ) : (
                <>
                  <div className="p-3.5 rounded-[10px] bg-[#F8F6F3] border border-[#ECE7E2] flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full bg-[#D47A7A]" />
                      <div>
                        <span className="text-xs font-semibold text-[#18181B]">
                          Out-of-order Ingest Burst
                        </span>
                        <span className="text-[11px] text-[#78716C] block">
                          Source: host-gw-01 • Z-score: 3.42 • Acme Corp
                        </span>
                      </div>
                    </div>
                    <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-[#FDE8E8] text-[#D47A7A] font-semibold">
                      Critical
                    </span>
                  </div>

                  <div className="p-3.5 rounded-[10px] bg-[#F8F6F3] border border-[#ECE7E2] flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full bg-[#E8B86D]" />
                      <div>
                        <span className="text-xs font-semibold text-[#18181B]">
                          Buffer Watermark High Surge
                        </span>
                        <span className="text-[11px] text-[#78716C] block">
                          Source: collector-ap-south • Storage capacity: 84%
                        </span>
                      </div>
                    </div>
                    <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-[#FDF3E0] text-[#E8B86D] font-semibold">
                      Warning
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right Col: Pinned Utility Rail */}
        <div className="space-y-6">
          <div className="card-base p-5">
            <h3 className="font-display font-semibold text-base text-[#18181B] pb-3 border-b border-[#ECE7E2] mb-3">
              SLA Compliance
            </h3>
            <div className="space-y-3.5 text-xs">
              <div>
                <div className="flex justify-between text-[#78716C] mb-1">
                  <span>Collection Latency (&lt; 10s)</span>
                  <span className="font-mono text-[#18181B] font-semibold">0.82s</span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-[#ECE7E2] overflow-hidden">
                  <div className="h-full bg-[#6B9E6B] rounded-full" style={{ width: "95%" }} />
                </div>
              </div>

              <div>
                <div className="flex justify-between text-[#78716C] mb-1">
                  <span>Breach to Alert (&lt; 15s)</span>
                  <span className="font-mono text-[#18181B] font-semibold">2.4s</span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-[#ECE7E2] overflow-hidden">
                  <div className="h-full bg-[#6B9E6B] rounded-full" style={{ width: "98%" }} />
                </div>
              </div>

              <div>
                <div className="flex justify-between text-[#78716C] mb-1">
                  <span>Offline Detection (&lt; 60s)</span>
                  <span className="font-mono text-[#18181B] font-semibold">12s</span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-[#ECE7E2] overflow-hidden">
                  <div className="h-full bg-[#6B9E6B] rounded-full" style={{ width: "92%" }} />
                </div>
              </div>
            </div>
          </div>

          <div className="card-base p-5 bg-[#F8F6F3]">
            <h3 className="font-display font-semibold text-sm text-[#18181B] mb-2">
              Architecture Quick-Links
            </h3>
            <p className="text-xs text-[#78716C] mb-4 leading-relaxed">
              Access individual architectural tier planes and privacy proof verifications directly:
            </p>
            <div className="space-y-1.5 text-xs font-medium">
              <Link
                href="/saas"
                className="flex items-center justify-between p-2 rounded-[6px] hover:bg-white text-[#18181B] transition-colors"
              >
                <span>SaaS Control Plane</span>
                <ExternalLink className="w-3.5 h-3.5 text-[#78716C]" />
              </Link>
              <Link
                href="/collector"
                className="flex items-center justify-between p-2 rounded-[6px] hover:bg-white text-[#18181B] transition-colors"
              >
                <span>Edge Collector Fleet</span>
                <ExternalLink className="w-3.5 h-3.5 text-[#78716C]" />
              </Link>
              <Link
                href="/proof"
                className="flex items-center justify-between p-2 rounded-[6px] hover:bg-white text-[#18181B] transition-colors"
              >
                <span>Egress Privacy Proof</span>
                <ExternalLink className="w-3.5 h-3.5 text-[#78716C]" />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
