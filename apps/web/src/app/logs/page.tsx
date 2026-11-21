"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  generateInitialLogs,
  LogEntry,
  LogLevel,
} from "@/lib/logs-alerts-data";
import { api, BackendTelemetryItem, BackendRawLog } from "@/lib/api";
import {
  FileText,
  AlertTriangle,
  Search,
  Filter,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Clock,
  Building2,
  Server,
  Layers,
  X,
  Copy,
  Check,
  Sparkles,
  ExternalLink,
  RefreshCw,
  SlidersHorizontal,
  ChevronRight,
  Database,
  Terminal,
  CheckCircle,
} from "lucide-react";

// Convert backend telemetry items to frontend LogEntry models
function mapBackendTelemetryToLogs(
  telemList: BackendTelemetryItem[],
  rawList: BackendRawLog[]
): LogEntry[] {
  const mappedTelem: LogEntry[] = telemList.map((t) => {
    const sev = t.severity.toUpperCase() as LogLevel;
    const validSev: LogLevel = ["CRITICAL", "ERROR", "WARNING", "INFO"].includes(sev)
      ? sev
      : "INFO";

    const metricsSummary = t.metrics
      ? Object.entries(t.metrics)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")
      : "";

    return {
      id: t.payload_id,
      timestamp: t.event_timestamp_utc,
      timestampMs: new Date(t.event_timestamp_utc).getTime(),
      severity: validSev,
      service: t.source_id || t.event_category || "telemetry-worker",
      tenant: t.tenant_id,
      source: t.collector_meta?.seq_num ? `collector-seq-${t.collector_meta.seq_num}` : "host-collector",
      message:
        t.alert_context ||
        t.collector_meta?.parsed_template ||
        `Telemetry event: ${metricsSummary || t.event_category}`,
      traceId: t.collector_meta?.frame_sha256 ? `trc_${t.collector_meta.frame_sha256}` : undefined,
      spanId: t.collector_meta?.template_id ? `spn_${t.collector_meta.template_id}` : undefined,
      metadata: t.metrics,
      rawPayload: JSON.stringify(t, null, 2),
    };
  });

  const mappedRaw: LogEntry[] = rawList.map((r) => ({
    id: `raw_${r.id}`,
    timestamp: r.event_timestamp_utc,
    timestampMs: new Date(r.event_timestamp_utc).getTime(),
    severity: r.redacted_fields_count > 0 ? "WARNING" : "INFO",
    service: r.source_id || "edge-collector",
    tenant: r.tenant_id,
    source: r.collector_id,
    message: `Raw log scraped: ${JSON.stringify(r.raw_payload).slice(0, 140)}... (Redactions: ${r.redacted_fields_count})`,
    metadata: { redacted_count: r.redacted_fields_count, types: r.redaction_types },
    rawPayload: JSON.stringify(r.raw_payload, null, 2),
  }));

  return [...mappedTelem, ...mappedRaw].sort((a, b) => b.timestampMs - a.timestampMs);
}

export default function LogsPage() {
  const [tenantId, setTenantId] = useState("tenant_acme_corp");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);
  const [isLiveBackend, setIsLiveBackend] = useState(false);

  // Filter States
  const [searchQuery, setSearchQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [timeRangeFilter, setTimeRangeFilter] = useState<string>("all");
  const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");

  // UI state
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [copiedTrace, setCopiedTrace] = useState(false);
  const [copiedPayload, setCopiedPayload] = useState(false);

  // Fetch real logs or fallback to simulated
  const fetchLogs = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const [telemRes, rawRes] = await Promise.all([
        api.getTelemetry(tenantId, { limit: 100 }),
        api.getRawLogs(50),
      ]);

      const hasTelem = telemRes.isLive && telemRes.data && telemRes.data.length > 0;
      const hasRaw = rawRes.isLive && rawRes.data && rawRes.data.length > 0;

      if (hasTelem || hasRaw) {
        setIsLiveBackend(true);
        const mapped = mapBackendTelemetryToLogs(telemRes.data || [], rawRes.data || []);
        setLogs(mapped);
      } else {
        setIsLiveBackend(false);
        setLogs(generateInitialLogs());
      }
    } catch {
      setIsLiveBackend(false);
      setLogs(generateInitialLogs());
    } finally {
      setIsRefreshing(false);
    }
  }, [tenantId]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Severity badge styling
  const getSeverityBadge = (severity: LogLevel) => {
    switch (severity) {
      case "CRITICAL":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] font-mono text-[10px] font-bold bg-[#FDE8E8] text-[#C53030] border border-[#FED7D7]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#C53030] animate-pulse" />
            CRITICAL
          </span>
        );
      case "ERROR":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] font-mono text-[10px] font-bold bg-[#FFF5F0] text-[#C2410C] border border-[#FFEDD5]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#EA580C]" />
            ERROR
          </span>
        );
      case "WARNING":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] font-mono text-[10px] font-bold bg-[#FEF9C3] text-[#A16207] border border-[#FEF08A]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#CA8A04]" />
            WARNING
          </span>
        );
      case "INFO":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] font-mono text-[10px] font-semibold bg-[#F0F9FF] text-[#0369A1] border border-[#BAE6FD]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#0284C7]" />
            INFO
          </span>
        );
    }
  };

  // Filtered & Sorted Logs
  const filteredLogs = useMemo(() => {
    const now = Date.now();
    return logs
      .filter((log) => {
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          const matchesMsg = log.message.toLowerCase().includes(q);
          const matchesSvc = log.service.toLowerCase().includes(q);
          const matchesSrc = log.source.toLowerCase().includes(q);
          const matchesTenant = log.tenant.toLowerCase().includes(q);
          if (!matchesMsg && !matchesSvc && !matchesSrc && !matchesTenant) {
            return false;
          }
        }

        if (severityFilter !== "all" && log.severity !== severityFilter) {
          return false;
        }

        if (tenantFilter !== "all" && log.tenant !== tenantFilter) {
          return false;
        }

        if (timeRangeFilter !== "all") {
          const diffMs = now - log.timestampMs;
          if (timeRangeFilter === "15m" && diffMs > 15 * 60 * 1000) return false;
          if (timeRangeFilter === "1h" && diffMs > 60 * 60 * 1000) return false;
          if (timeRangeFilter === "6h" && diffMs > 6 * 60 * 60 * 1000) return false;
          if (timeRangeFilter === "24h" && diffMs > 24 * 60 * 60 * 1000) return false;
        }

        return true;
      })
      .sort((a, b) => {
        if (sortOrder === "desc") {
          return b.timestampMs - a.timestampMs;
        }
        return a.timestampMs - b.timestampMs;
      });
  }, [logs, searchQuery, severityFilter, tenantFilter, timeRangeFilter, sortOrder]);

  const handleCopy = (text: string, type: "trace" | "payload") => {
    if (navigator?.clipboard) {
      navigator.clipboard.writeText(text);
      if (type === "trace") {
        setCopiedTrace(true);
        setTimeout(() => setCopiedTrace(false), 2000);
      } else {
        setCopiedPayload(true);
        setTimeout(() => setCopiedPayload(false), 2000);
      }
    }
  };

  const formatTs = (isoStr: string) => {
    const d = new Date(isoStr);
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const getRelativeTime = (timestampMs: number) => {
    const diff = Math.floor((Date.now() - timestampMs) / 1000);
    if (diff < 60) return `${diff}s ago`;
    const mins = Math.floor(diff / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ago`;
  };

  return (
    <AppShell tenantId={tenantId} onTenantChange={setTenantId}>
      {/* Page Header */}
      <PageHeader
        title="Logs & Telemetry Explorer"
        subtitle="Multi-tenant structured log stream with pseudonymization filter verification and instant severity filtering."
        breadcrumbs={[
          { label: "Solarius Ops", href: "/dashboard" },
          { label: "Logs" },
        ]}
        badge={
          isLiveBackend ? (
            <span className="badge-pill bg-[#ECFDF5] text-[#059669] font-medium border border-[#A7F3D0]">
              <Sparkles className="w-3 h-3 text-[#059669]" />
              Live Ingest Stream
            </span>
          ) : (
            <span className="badge-pill gradient-sage-mist text-[#18181B] font-medium border border-[#ECE7E2]">
              <FileText className="w-3 h-3 text-[#2E7D32]" />
              Log Stream (Simulated)
            </span>
          )
        }
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={fetchLogs}
              disabled={isRefreshing}
              className="btn-secondary text-xs flex items-center gap-1.5 py-1.5 px-3"
              title="Refresh log stream"
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
      <div className="mb-5 p-3 rounded-[10px] bg-gradient-to-r from-[#F8F6F3] via-white to-[#F9F7F4] border border-[#ECE7E2] flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-sm">
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
                  ? "Connected to Live Telemetry & Collector Logs"
                  : "Operating in Fallback Simulation Mode"}
              </span>
              <span
                className={`badge-pill text-[10px] py-0 px-1.5 font-mono ${
                  isLiveBackend
                    ? "bg-[#ECFDF5] text-[#059669] border border-[#A7F3D0]"
                    : "bg-[#FDF2F8] text-[#9D174D] border border-[#FBCFE8]"
                }`}
              >
                {isLiveBackend ? "LIVE API (/api/v1/telemetry & /local/raw-logs)" : "DEMO DATA"}
              </span>
            </div>
            <p className="text-xs text-[#78716C] mt-0.5">
              {isLiveBackend
                ? `Streaming live events for tenant ${tenantId} from ${api.getTier2BaseUrl()} and ${api.getTier1BaseUrl()}.`
                : `Backend APIs at ${api.getTier2BaseUrl()} / ${api.getTier1BaseUrl()} are currently offline. Showing synthetic scrubbed logs.`}
            </p>
          </div>
        </div>
        <div className="text-xs font-mono text-[#78716C] shrink-0">
          Showing <strong className="text-[#18181B]">{filteredLogs.length}</strong> of {logs.length} events
        </div>
      </div>

      {/* Subnavigation Tabs: Alerts vs Logs */}
      <div className="flex items-center gap-2 mb-5 border-b border-[#ECE7E2] pb-3">
        <Link
          href="/alerts"
          className="flex items-center gap-2 px-3.5 py-1.5 rounded-[8px] text-xs font-medium text-[#78716C] hover:text-[#18181B] hover:bg-[#F8F6F3] transition-colors"
        >
          <AlertTriangle className="w-3.5 h-3.5 text-[#E8B86D]" />
          <span>Active Alerts Queue</span>
          <span className="px-1.5 py-0.2 rounded-full bg-[#F8F6F3] text-[10px] font-mono border border-[#ECE7E2]">
            Triage
          </span>
        </Link>
        <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-[8px] text-xs font-semibold bg-white text-[#18181B] shadow-sm border border-[#ECE7E2]">
          <FileText className="w-3.5 h-3.5 text-[#18181B]" />
          <span>System Logs Stream</span>
          <span className="w-2 h-2 rounded-full bg-[#6B9E6B] animate-pulse" />
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="card-base p-3 mb-5 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="w-4 h-4 text-[#A8A29E] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by log message, service, source, or tenant..."
            className="input-base pl-9 pr-8 py-1.5 text-xs w-full bg-[#F9F7F4] focus:bg-white border-[#ECE7E2]"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#A8A29E] hover:text-[#18181B]"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-mono text-[#A8A29E] hidden sm:inline">
              Severity:
            </span>
            <select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              className="input-base text-xs py-1.5 px-2.5 w-auto bg-white border-[#ECE7E2]"
            >
              <option value="all">All Severities</option>
              <option value="CRITICAL">CRITICAL</option>
              <option value="ERROR">ERROR</option>
              <option value="WARNING">WARNING</option>
              <option value="INFO">INFO</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-mono text-[#A8A29E] hidden sm:inline">
              Tenant:
            </span>
            <select
              value={tenantFilter}
              onChange={(e) => setTenantFilter(e.target.value)}
              className="input-base text-xs py-1.5 px-2.5 w-auto bg-white border-[#ECE7E2]"
            >
              <option value="all">All Tenants</option>
              <option value="tenant_acme_corp">Acme Corp</option>
              <option value="tenant_fintech_labs">FinTech Labs</option>
              <option value="tenant_retail_mesh">Retail Mesh</option>
              <option value="system_internal">System Internal</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-mono text-[#A8A29E] hidden sm:inline">
              Window:
            </span>
            <select
              value={timeRangeFilter}
              onChange={(e) => setTimeRangeFilter(e.target.value)}
              className="input-base text-xs py-1.5 px-2.5 w-auto bg-white border-[#ECE7E2]"
            >
              <option value="all">All Time</option>
              <option value="15m">Last 15m</option>
              <option value="1h">Last 1h</option>
              <option value="6h">Last 6h</option>
              <option value="24h">Last 24h</option>
            </select>
          </div>

          <button
            onClick={() => setSortOrder(sortOrder === "desc" ? "asc" : "desc")}
            className="btn-secondary text-xs py-1.5 px-2.5 flex items-center gap-1.5"
            title={`Sort order: ${sortOrder === "desc" ? "Newest First" : "Oldest First"}`}
          >
            {sortOrder === "desc" ? (
              <ArrowDown className="w-3.5 h-3.5 text-[#18181B]" />
            ) : (
              <ArrowUp className="w-3.5 h-3.5 text-[#18181B]" />
            )}
            <span className="font-mono text-[11px]">
              {sortOrder === "desc" ? "Newest" : "Oldest"}
            </span>
          </button>
        </div>
      </div>

      {/* Main Content Layout: Table & Detail Drawer */}
      <div className="flex flex-col xl:flex-row gap-5 items-start">
        <div className={`w-full transition-all duration-200 ${selectedLog ? "xl:w-7/12" : "w-full"}`}>
          <div className="card-base overflow-hidden border border-[#ECE7E2]">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-[#F8F6F3] border-b border-[#ECE7E2] text-[#78716C] font-mono">
                    <th className="py-2.5 px-3.5 font-medium whitespace-nowrap">Timestamp</th>
                    <th className="py-2.5 px-3 font-medium whitespace-nowrap">Severity</th>
                    <th className="py-2.5 px-3 font-medium whitespace-nowrap">Service</th>
                    <th className="py-2.5 px-3 font-medium whitespace-nowrap">Tenant</th>
                    <th className="py-2.5 px-3 font-medium whitespace-nowrap hidden md:table-cell">Source</th>
                    <th className="py-2.5 px-4 font-medium">Message</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#ECE7E2]">
                  {filteredLogs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center text-[#78716C]">
                        <div className="flex flex-col items-center justify-center">
                          <Search className="w-6 h-6 text-[#A8A29E] mb-2" />
                          <p className="text-sm font-medium text-[#18181B]">No matching log records found</p>
                          <p className="text-xs text-[#78716C] mt-0.5">
                            Try adjusting your search criteria or resetting filters.
                          </p>
                          <button
                            onClick={() => {
                              setSearchQuery("");
                              setSeverityFilter("all");
                              setTenantFilter("all");
                              setTimeRangeFilter("all");
                            }}
                            className="btn-secondary text-xs mt-3 py-1 px-3"
                          >
                            Reset All Filters
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filteredLogs.map((log) => {
                      const isSelected = selectedLog?.id === log.id;
                      return (
                        <tr
                          key={log.id}
                          onClick={() => setSelectedLog(isSelected ? null : log)}
                          className={`cursor-pointer transition-colors duration-100 ${
                            isSelected
                              ? "bg-[#F3E2DB]/40 font-medium"
                              : "hover:bg-[#F8F6F3]"
                          }`}
                        >
                          <td className="py-2.5 px-3.5 whitespace-nowrap font-mono text-[11px] text-[#78716C]">
                            <div className="flex flex-col">
                              <span className="text-[#18181B] font-semibold">{formatTs(log.timestamp)}</span>
                              <span className="text-[10px] text-[#A8A29E]">{getRelativeTime(log.timestampMs)}</span>
                            </div>
                          </td>

                          <td className="py-2.5 px-3 whitespace-nowrap">
                            {getSeverityBadge(log.severity)}
                          </td>

                          <td className="py-2.5 px-3 whitespace-nowrap font-mono text-[11px] text-[#18181B]">
                            <span className="px-1.5 py-0.5 rounded bg-[#F8F6F3] border border-[#ECE7E2]">
                              {log.service}
                            </span>
                          </td>

                          <td className="py-2.5 px-3 whitespace-nowrap text-[11px] font-mono text-[#78716C]">
                            {log.tenant}
                          </td>

                          <td className="py-2.5 px-3 whitespace-nowrap text-[11px] font-mono text-[#78716C] hidden md:table-cell">
                            {log.source}
                          </td>

                          <td className="py-2.5 px-4 font-mono text-[11px] text-[#18181B] max-w-md truncate">
                            {log.message}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="bg-[#F8F6F3] p-2.5 px-4 border-t border-[#ECE7E2] flex items-center justify-between text-xs text-[#78716C] font-mono">
              <span>Showing {filteredLogs.length} events</span>
              <span className="text-[11px]">Click any row to inspect structured payload &amp; trace context</span>
            </div>
          </div>
        </div>

        {/* Selected Log Details Drawer */}
        {selectedLog && (
          <div className="w-full xl:w-5/12 card-base p-5 border border-[#C7BBB8] bg-white shadow-elevated transition-all">
            <div className="flex items-center justify-between pb-3 border-b border-[#ECE7E2] mb-4">
              <div className="flex items-center gap-2">
                {getSeverityBadge(selectedLog.severity)}
                <span className="font-display font-semibold text-sm text-[#18181B]">
                  Log Event Inspection
                </span>
              </div>
              <button
                onClick={() => setSelectedLog(null)}
                className="btn-ghost p-1 text-[#78716C] hover:text-[#18181B]"
                title="Close inspector"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 mb-4 text-xs font-sans">
              <div>
                <label className="text-[11px] font-mono uppercase text-[#A8A29E] block mb-1">
                  Message
                </label>
                <p className="font-mono text-xs text-[#18181B] bg-[#F9F7F4] p-2.5 rounded-[6px] border border-[#ECE7E2] leading-relaxed break-words">
                  {selectedLog.message}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div className="bg-[#F8F6F3] p-2 rounded-[6px] border border-[#ECE7E2]">
                  <span className="text-[10px] font-mono text-[#A8A29E] block">Service</span>
                  <strong className="font-mono text-xs text-[#18181B]">{selectedLog.service}</strong>
                </div>
                <div className="bg-[#F8F6F3] p-2 rounded-[6px] border border-[#ECE7E2]">
                  <span className="text-[10px] font-mono text-[#A8A29E] block">Tenant</span>
                  <strong className="font-mono text-xs text-[#18181B]">{selectedLog.tenant}</strong>
                </div>
                <div className="bg-[#F8F6F3] p-2 rounded-[6px] border border-[#ECE7E2]">
                  <span className="text-[10px] font-mono text-[#A8A29E] block">Source Host / Pod</span>
                  <strong className="font-mono text-xs text-[#18181B]">{selectedLog.source}</strong>
                </div>
                <div className="bg-[#F8F6F3] p-2 rounded-[6px] border border-[#ECE7E2]">
                  <span className="text-[10px] font-mono text-[#A8A29E] block">Timestamp</span>
                  <strong className="font-mono text-[11px] text-[#18181B]">
                    {formatTs(selectedLog.timestamp)}
                  </strong>
                </div>
              </div>

              {selectedLog.traceId && (
                <div className="bg-[#F8F6F3] p-2.5 rounded-[6px] border border-[#ECE7E2] flex items-center justify-between">
                  <div>
                    <span className="text-[10px] font-mono text-[#A8A29E] block">
                      OpenTelemetry Distributed Trace ID
                    </span>
                    <span className="font-mono text-xs font-semibold text-[#18181B]">
                      {selectedLog.traceId}
                    </span>
                    {selectedLog.spanId && (
                      <span className="text-[10px] text-[#78716C] ml-2">
                        (Span: {selectedLog.spanId})
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => handleCopy(selectedLog.traceId!, "trace")}
                    className="btn-secondary text-[11px] py-1 px-2 flex items-center gap-1"
                    title="Copy Trace ID"
                  >
                    {copiedTrace ? (
                      <Check className="w-3 h-3 text-[#2E7D32]" />
                    ) : (
                      <Copy className="w-3 h-3 text-[#18181B]" />
                    )}
                    <span>{copiedTrace ? "Copied" : "Copy"}</span>
                  </button>
                </div>
              )}

              {selectedLog.rawPayload && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[11px] font-mono uppercase text-[#A8A29E]">
                      Raw Structured Telemetry Payload (JSON)
                    </label>
                    <button
                      onClick={() => handleCopy(selectedLog.rawPayload!, "payload")}
                      className="text-[11px] font-mono text-[#78716C] hover:text-[#18181B] flex items-center gap-1"
                    >
                      {copiedPayload ? (
                        <Check className="w-3 h-3 text-[#2E7D32]" />
                      ) : (
                        <Copy className="w-3 h-3 text-[#78716C]" />
                      )}
                      <span>{copiedPayload ? "Copied" : "Copy JSON"}</span>
                    </button>
                  </div>
                  <pre className="font-mono text-[11px] text-[#18181B] bg-[#F9F7F4] p-3 rounded-[6px] border border-[#ECE7E2] overflow-x-auto max-h-56 leading-relaxed">
                    {selectedLog.rawPayload}
                  </pre>
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-[#ECE7E2] flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setSearchQuery(selectedLog.service)}
                className="btn-secondary text-[11px] py-1 px-2.5"
              >
                Filter service: {selectedLog.service}
              </button>
              <button
                onClick={() => setTenantFilter(selectedLog.tenant)}
                className="btn-secondary text-[11px] py-1 px-2.5"
              >
                Filter tenant: {selectedLog.tenant}
              </button>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
