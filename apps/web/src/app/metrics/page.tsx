"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/layout/PageHeader";
import { TimeSeriesChart } from "@/components/metrics/TimeSeriesChart";
import { MetricKpiCard } from "@/components/metrics/MetricKpiCard";
import {
  generateMetricsData,
  TimeRange,
  MetricCategory,
} from "@/lib/metrics-data";
import { api, BackendTelemetryItem } from "@/lib/api";
import {
  Activity,
  RefreshCw,
  Sparkles,
  Info,
  Clock,
  Layers,
  Cpu,
  Network,
  HardDrive,
  CheckCircle2,
  CheckCircle,
} from "lucide-react";

const TIME_RANGES: { label: string; value: TimeRange }[] = [
  { label: "15 min", value: "15m" },
  { label: "1 hour", value: "1h" },
  { label: "6 hours", value: "6h" },
  { label: "24 hours", value: "24h" },
  { label: "7 days", value: "7d" },
];

const CATEGORIES: { label: string; value: MetricCategory; icon: any }[] = [
  { label: "All Signals", value: "all", icon: Layers },
  { label: "Compute", value: "compute", icon: Cpu },
  { label: "Network", value: "network", icon: Network },
  { label: "Storage & System", value: "storage", icon: HardDrive },
];

export default function MetricsPage() {
  const [tenantId, setTenantId] = useState("tenant_acme_corp");
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");
  const [category, setCategory] = useState<MetricCategory>("all");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [timeAgoText, setTimeAgoText] = useState("Just now");
  const [nowTimestamp, setNowTimestamp] = useState<number>(Date.now());
  const [isLiveBackend, setIsLiveBackend] = useState(false);

  // Set initial client-side timestamp to prevent hydration mismatch
  useEffect(() => {
    setLastUpdated(new Date());
    setNowTimestamp(Date.now());
  }, []);

  // Update "time ago" relative string every 5 seconds
  useEffect(() => {
    if (!lastUpdated) return;
    const interval = setInterval(() => {
      const seconds = Math.floor((Date.now() - lastUpdated.getTime()) / 1000);
      if (seconds < 5) {
        setTimeAgoText("Just now");
      } else if (seconds < 60) {
        setTimeAgoText(`${seconds}s ago`);
      } else {
        const mins = Math.floor(seconds / 60);
        setTimeAgoText(`${mins}m ago`);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [lastUpdated]);

  // Probe live backend API
  const fetchLiveTelemetry = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const res = await api.getTelemetry(tenantId, { limit: 100 });
      if (res.isLive && res.data && res.data.length > 0) {
        setIsLiveBackend(true);
      } else {
        setIsLiveBackend(false);
      }
      setNowTimestamp(Date.now());
      setLastUpdated(new Date());
      setTimeAgoText("Just now");
    } catch {
      setIsLiveBackend(false);
    } finally {
      setIsRefreshing(false);
    }
  }, [tenantId]);

  useEffect(() => {
    fetchLiveTelemetry();
  }, [fetchLiveTelemetry]);

  // Handle Manual Refresh
  const handleRefresh = useCallback(() => {
    fetchLiveTelemetry();
  }, [fetchLiveTelemetry]);

  // Generate Telemetry Dataset based on active Time Range and Tenant
  const metricsData = useMemo(() => {
    return generateMetricsData(timeRange, tenantId, nowTimestamp);
  }, [timeRange, tenantId, nowTimestamp]);

  // Filtered KPIs according to category
  const filteredKpis = useMemo(() => {
    if (category === "all") return metricsData.kpis;
    return metricsData.kpis.filter((k) => k.category === category);
  }, [metricsData.kpis, category]);

  // Filtered Charts according to category
  const filteredCharts = useMemo(() => {
    if (category === "all") return metricsData.charts;
    return metricsData.charts.filter((c) => c.category === category);
  }, [metricsData.charts, category]);

  return (
    <AppShell tenantId={tenantId} onTenantChange={setTenantId}>
      {/* Page Header */}
      <PageHeader
        title="Metrics & Signals"
        subtitle="Continuous telemetry monitoring across 6 multivariate system signals: CPU, memory, network throughput, disk WAL, latency, and packet loss."
        breadcrumbs={[
          { label: "Solarius Ops", href: "/dashboard" },
          { label: "Metrics & Signals" },
        ]}
        badge={
          isLiveBackend ? (
            <span className="badge-pill bg-[#ECFDF5] text-[#059669] font-medium border border-[#A7F3D0]">
              <Sparkles className="w-3 h-3 text-[#059669]" />
              Live Ingest Stream
            </span>
          ) : (
            <span className="badge-pill gradient-sage-mist text-[#18181B] font-medium border border-[#ECE7E2]">
              <Activity className="w-3 h-3 text-[#6B9E6B]" />
              Continuous Telemetry (Simulation)
            </span>
          )
        }
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 text-xs text-[#78716C] font-mono bg-[#F8F6F3] px-2.5 py-1.5 rounded-[6px] border border-[#ECE7E2]">
              <Clock className="w-3.5 h-3.5 text-[#A8A29E]" />
              <span className="hidden sm:inline">Updated:</span>
              <strong className="text-[#18181B] font-semibold">{timeAgoText}</strong>
            </div>

            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="btn-secondary text-xs flex items-center gap-1.5 py-1.5 px-3"
              title="Refresh telemetry signals"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 text-[#18181B] ${
                  isRefreshing ? "animate-spin" : ""
                }`}
              />
              <span>{isRefreshing ? "Refreshing..." : "Refresh"}</span>
            </button>
          </div>
        }
      />

      {/* Live / Demo Data Banner */}
      <div className="mb-6 p-3.5 rounded-[10px] bg-gradient-to-r from-[#F8F6F3] via-white to-[#F9F7F4] border border-[#ECE7E2] flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-sm">
        <div className="flex items-start sm:items-center gap-2.5">
          <div
            className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 border border-[#ECE7E2] ${
              isLiveBackend ? "bg-[#ECFDF5]" : "gradient-cream-apricot"
            }`}
          >
            {isLiveBackend ? (
              <CheckCircle className="w-3.5 h-3.5 text-[#059669]" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 text-[#9A3412]" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-[#18181B]">
                {isLiveBackend
                  ? "Connected to Live Telemetry Endpoint"
                  : "Telemetry Simulation Active"}
              </span>
              <span
                className={`badge-pill text-[10px] py-0 px-1.5 font-mono ${
                  isLiveBackend
                    ? "bg-[#ECFDF5] text-[#059669] border border-[#A7F3D0]"
                    : "bg-[#E8F2EB] text-[#2E7D32] border border-[#C8E6C9]"
                }`}
              >
                {isLiveBackend ? "LIVE API (/api/v1/telemetry)" : "SYNTHETIC INGEST"}
              </span>
            </div>
            <p className="text-xs text-[#78716C] mt-0.5 leading-relaxed">
              {isLiveBackend
                ? `Ingesting live time-series frames for tenant ${tenantId} from ${api.getTier2BaseUrl()}/api/v1/telemetry.`
                : `Displaying simulated multivariate cluster signals with Local Differential Privacy (LDP) noise for tenant ${tenantId}.`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs text-[#78716C] shrink-0 font-mono">
          <CheckCircle2 className="w-3.5 h-3.5 text-[#6B9E6B]" />
          <span>4 Tier-1 Nodes Active</span>
        </div>
      </div>

      {/* Control Bar: Category Filters & Time Range Selectors */}
      <div className="mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-[#F8F6F3] p-2 rounded-[10px] border border-[#ECE7E2]">
        <div className="flex items-center gap-1 overflow-x-auto pb-1 md:pb-0">
          {CATEGORIES.map((cat) => {
            const Icon = cat.icon;
            const isActive = category === cat.value;
            return (
              <button
                key={cat.value}
                onClick={() => setCategory(cat.value)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-xs font-medium whitespace-nowrap transition-all duration-150 ${
                  isActive
                    ? "bg-white text-[#18181B] shadow-sm border border-[#ECE7E2]"
                    : "text-[#78716C] hover:text-[#18181B] hover:bg-white/50"
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${isActive ? "text-[#18181B]" : "text-[#78716C]"}`} />
                <span>{cat.label}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1 self-start md:self-auto bg-white/70 p-1 rounded-[8px] border border-[#ECE7E2]">
          <span className="text-[11px] font-mono text-[#A8A29E] px-2 hidden lg:inline">
            Range:
          </span>
          {TIME_RANGES.map((r) => {
            const isActive = timeRange === r.value;
            return (
              <button
                key={r.value}
                onClick={() => setTimeRange(r.value)}
                className={`px-2.5 py-1 rounded-[6px] text-xs font-mono font-medium transition-all ${
                  isActive
                    ? "bg-[#18181B] text-white shadow-sm"
                    : "text-[#78716C] hover:text-[#18181B] hover:bg-white"
                }`}
              >
                {r.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Section 1: KPI Summary Cards Grid */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display font-semibold text-sm text-[#18181B] tracking-tight flex items-center gap-2">
            <span>Signal Vital Stats</span>
            <span className="text-xs font-normal text-[#78716C]">
              ({filteredKpis.length} metrics active)
            </span>
          </h2>
          <span className="text-xs font-mono text-[#A8A29E]">
            Aggregation: Mean &amp; Peak
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3.5">
          {filteredKpis.map((metric) => (
            <MetricKpiCard key={metric.id} metric={metric} />
          ))}
        </div>
      </div>

      {/* Section 2: Interactive Time-Series Charts Grid */}
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display font-semibold text-base text-[#18181B] tracking-tight">
              Telemetry Waveforms &amp; Drift Envelopes
            </h2>
            <p className="text-xs text-[#78716C] mt-0.5">
              Hover over curves to inspect exact timestamp and multi-series values. Click series pills to toggle visibility.
            </p>
          </div>
          <span className="text-xs font-mono text-[#78716C] hidden sm:inline">
            Interpolation: Cubic Bezier
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {filteredCharts.map((chart) => (
            <TimeSeriesChart
              key={chart.id}
              id={chart.id}
              title={chart.title}
              subtitle={chart.subtitle}
              category={chart.category}
              series={chart.series}
              unit={chart.unit}
              yMin={chart.yMin}
              yMax={chart.yMax}
              thresholds={chart.thresholds}
              timeRange={timeRange}
              loading={isRefreshing}
              height={250}
            />
          ))}
        </div>
      </div>
    </AppShell>
  );
}
