"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  generateInitialAlerts,
  AlertItem,
  AlertSeverity,
  AlertStatus,
} from "@/lib/logs-alerts-data";
import { api, BackendIncident } from "@/lib/api";
import {
  AlertTriangle,
  FileText,
  Search,
  Filter,
  CheckCircle,
  Clock,
  Sparkles,
  ShieldAlert,
  AlertOctagon,
  AlertCircle,
  Info,
  CheckCheck,
  RotateCcw,
  RefreshCw,
  X,
  ExternalLink,
  ChevronRight,
  Server,
  Building2,
  Brain,
  Wrench,
  Check,
  Wifi,
  WifiOff,
} from "lucide-react";

// Pure mapping helper defined outside component
function mapBackendIncident(inc: BackendIncident, fallbackTenantId: string): AlertItem {
  const sevMap: Record<string, AlertSeverity> = {
    critical: "Critical",
    warning: "High",
    info: "Low",
  };
  const statMap: Record<string, AlertStatus> = {
    active: "Active",
    acknowledged: "Acknowledged",
    resolved: "Resolved",
    suppressed: "Resolved",
  };

  const firstZScoreKey = Object.keys(inc.z_scores || {})[0];
  const zScoreVal = firstZScoreKey ? inc.z_scores[firstZScoreKey] : undefined;

  return {
    id: inc.incident_id,
    title: inc.reasoning_path ? inc.reasoning_path.split("\n")[0] : `Incident ${inc.incident_id}`,
    severity: sevMap[inc.severity] || "High",
    affectedService: inc.source_id || inc.event_category || "telemetry-service",
    tenant: inc.tenant_id || fallbackTenantId,
    timestamp: inc.first_alert_time_utc || new Date().toISOString(),
    timestampMs: inc.first_alert_time_utc ? new Date(inc.first_alert_time_utc).getTime() : Date.now(),
    status: statMap[inc.status] || "Active",
    description: inc.reasoning_path || "Multivariate drift detected across monitored telemetry signals.",
    zScore: zScoreVal,
    driftMetric: inc.contributing_signals?.join(", ") || firstZScoreKey,
    recommendedRemediation: inc.recommended_action || "Investigate telemetry logs and verify node resources.",
    affectedNodes: [inc.source_id],
    aiConfidence: inc.confidence,
  };
}

export default function AlertsPage() {
  const [tenantId, setTenantId] = useState("tenant_acme_corp");
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [selectedAlert, setSelectedAlert] = useState<AlertItem | null>(null);
  const [isLiveBackend, setIsLiveBackend] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);

  // Filter States
  const [searchQuery, setSearchQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  // Fetch alerts from backend or fallback to demo
  const fetchAlerts = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const res = await api.getIncidents(tenantId, 100, severityFilter);
      if (res.isLive && res.data && res.data.length > 0) {
        setIsLiveBackend(true);
        setAlerts(res.data.map((item) => mapBackendIncident(item, tenantId)));
      } else {
        setIsLiveBackend(false);
        setAlerts(generateInitialAlerts());
      }
    } catch {
      setIsLiveBackend(false);
      setAlerts(generateInitialAlerts());
    } finally {
      setIsRefreshing(false);
    }
  }, [tenantId, severityFilter]);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  // Connect SSE for live incident updates
  useEffect(() => {
    const sse = api.connectSSE(
      tenantId,
      (newInc) => {
        const item = mapBackendIncident(newInc, tenantId);
        setAlerts((prev) => {
          const idx = prev.findIndex((a) => a.id === item.id);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = item;
            return updated;
          }
          return [item, ...prev];
        });
        showFeedback(`New live incident received: #${item.id}`);
      },
      (connected) => setSseConnected(connected)
    );

    return () => sse.disconnect();
  }, [tenantId]);

  const showFeedback = (msg: string) => {
    setActionFeedback(msg);
    setTimeout(() => setActionFeedback(null), 3500);
  };

  // User Actions: Acknowledge and Resolve
  const handleAcknowledge = async (alertId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const nowIso = new Date().toISOString();

    if (isLiveBackend) {
      await api.remediateIncident(tenantId, alertId, "approve");
    }

    setAlerts((prev) =>
      prev.map((a) =>
        a.id === alertId
          ? {
              ...a,
              status: "Acknowledged",
              acknowledgedBy: "operator-oncall",
              acknowledgedAt: nowIso,
            }
          : a
      )
    );
    if (selectedAlert?.id === alertId) {
      setSelectedAlert((prev) =>
        prev
          ? {
              ...prev,
              status: "Acknowledged",
              acknowledgedBy: "operator-oncall",
              acknowledgedAt: nowIso,
            }
          : null
      );
    }
    showFeedback(`Alert #${alertId} acknowledged successfully`);
  };

  const handleResolve = async (alertId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const nowIso = new Date().toISOString();

    if (isLiveBackend) {
      await api.remediateIncident(tenantId, alertId, "rollback");
    }

    setAlerts((prev) =>
      prev.map((a) =>
        a.id === alertId
          ? {
              ...a,
              status: "Resolved",
              resolvedBy: "operator-oncall",
              resolvedAt: nowIso,
            }
          : a
      )
    );
    if (selectedAlert?.id === alertId) {
      setSelectedAlert((prev) =>
        prev
          ? {
              ...prev,
              status: "Resolved",
              resolvedBy: "operator-oncall",
              resolvedAt: nowIso,
            }
          : null
      );
    }
    showFeedback(`Alert #${alertId} marked as resolved`);
  };

  // Severity counts for Summary Cards
  const summaryCounts = useMemo(() => {
    const counts = { Critical: 0, High: 0, Medium: 0, Low: 0, Active: 0 };
    alerts.forEach((a) => {
      if (a.severity === "Critical") counts.Critical++;
      if (a.severity === "High") counts.High++;
      if (a.severity === "Medium") counts.Medium++;
      if (a.severity === "Low") counts.Low++;
      if (a.status === "Active") counts.Active++;
    });
    return counts;
  }, [alerts]);

  // Filtered Alerts
  const filteredAlerts = useMemo(() => {
    return alerts.filter((alert) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesTitle = alert.title.toLowerCase().includes(q);
        const matchesSvc = alert.affectedService.toLowerCase().includes(q);
        const matchesTenant = alert.tenant.toLowerCase().includes(q);
        const matchesDesc = alert.description.toLowerCase().includes(q);
        if (!matchesTitle && !matchesSvc && !matchesTenant && !matchesDesc) {
          return false;
        }
      }

      if (severityFilter !== "all" && alert.severity !== severityFilter) {
        return false;
      }

      if (statusFilter !== "all" && alert.status !== statusFilter) {
        return false;
      }

      return true;
    });
  }, [alerts, searchQuery, severityFilter, statusFilter]);

  // Severity badge helper
  const getSeverityBadge = (severity: AlertSeverity) => {
    switch (severity) {
      case "Critical":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] font-mono text-[10px] font-bold bg-[#FDE8E8] text-[#C53030] border border-[#FED7D7]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#C53030] animate-pulse" />
            Critical
          </span>
        );
      case "High":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] font-mono text-[10px] font-bold bg-[#FFF5F0] text-[#C2410C] border border-[#FFEDD5]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#EA580C]" />
            High
          </span>
        );
      case "Medium":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] font-mono text-[10px] font-bold bg-[#FEF9C3] text-[#A16207] border border-[#FEF08A]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#CA8A04]" />
            Medium
          </span>
        );
      case "Low":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] font-mono text-[10px] font-semibold bg-[#F0F9FF] text-[#0369A1] border border-[#BAE6FD]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#0284C7]" />
            Low
          </span>
        );
    }
  };

  // Status badge helper
  const getStatusBadge = (status: AlertStatus) => {
    switch (status) {
      case "Active":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] font-semibold bg-[#FFF1F2] text-[#E11D48] border border-[#FECDD3]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#E11D48]" />
            Active
          </span>
        );
      case "Acknowledged":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] font-semibold bg-[#FEF3C7] text-[#D97706] border border-[#FDE68A]">
            <Clock className="w-3 h-3 text-[#D97706]" />
            Acknowledged
          </span>
        );
      case "Resolved":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] font-semibold bg-[#ECFDF5] text-[#059669] border border-[#A7F3D0]">
            <Check className="w-3 h-3 text-[#059669]" />
            Resolved
          </span>
        );
    }
  };

  const formatTs = (isoStr: string) => {
    const d = new Date(isoStr);
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;
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
        title="Alerts & Incident Queue"
        subtitle="Correlated multivariate telemetry anomalies with explainable AI root-cause analysis and operator triage actions."
        breadcrumbs={[
          { label: "Solarius Ops", href: "/dashboard" },
          { label: "Alerts" },
        ]}
        badge={
          isLiveBackend ? (
            <span className="badge-pill bg-[#ECFDF5] text-[#059669] font-medium border border-[#A7F3D0]">
              <Sparkles className="w-3 h-3 text-[#059669]" />
              Live AIOps Feed
            </span>
          ) : (
            <span className="badge-pill gradient-cream-apricot text-[#18181B] font-medium border border-[#ECE7E2]">
              <AlertTriangle className="w-3 h-3 text-[#E8B86D]" />
              AIOps Simulation
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
              onClick={fetchAlerts}
              disabled={isRefreshing}
              className="btn-secondary text-xs flex items-center gap-1.5 py-1.5 px-3"
              title="Refresh incident queue"
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

      {/* Action Notification Toast */}
      {actionFeedback && (
        <div className="mb-4 p-2.5 px-4 rounded-[8px] bg-[#18181B] text-white text-xs font-medium flex items-center justify-between shadow-elevated">
          <div className="flex items-center gap-2">
            <CheckCheck className="w-4 h-4 text-[#8FBC8F]" />
            <span>{actionFeedback}</span>
          </div>
          <button
            onClick={() => setActionFeedback(null)}
            className="text-[#A8A29E] hover:text-white"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

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
                  ? "Connected to Live AIOps Incident API"
                  : "Operating in Fallback Simulation Mode"}
              </span>
              <span
                className={`badge-pill text-[10px] py-0 px-1.5 font-mono ${
                  isLiveBackend
                    ? "bg-[#ECFDF5] text-[#059669] border border-[#A7F3D0]"
                    : "bg-[#FDF2F8] text-[#9D174D] border border-[#FBCFE8]"
                }`}
              >
                {isLiveBackend ? "LIVE API (/api/v1/incidents)" : "DEMO DATA"}
              </span>
            </div>
            <p className="text-xs text-[#78716C] mt-0.5">
              {isLiveBackend
                ? `Querying real-time incidents from ${api.getTier2BaseUrl()}/api/v1/incidents for tenant ${tenantId}.`
                : `Tier 2 SaaS API at ${api.getTier2BaseUrl()} is offline. Displaying realistic simulated triage queue.`}
            </p>
          </div>
        </div>
        <div className="text-xs font-mono text-[#78716C] shrink-0">
          <strong className="text-[#18181B]">{summaryCounts.Active} Active</strong> alerts requiring triage
        </div>
      </div>

      {/* Subnavigation Tabs: Alerts vs Logs */}
      <div className="flex items-center gap-2 mb-5 border-b border-[#ECE7E2] pb-3">
        <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-[8px] text-xs font-semibold bg-white text-[#18181B] shadow-sm border border-[#ECE7E2]">
          <AlertTriangle className="w-3.5 h-3.5 text-[#E8B86D]" />
          <span>Active Alerts Queue</span>
          <span className="px-1.5 py-0.2 rounded-full bg-[#F8F6F3] text-[10px] font-mono border border-[#ECE7E2]">
            {summaryCounts.Active} Active
          </span>
        </div>
        <Link
          href="/logs"
          className="flex items-center gap-2 px-3.5 py-1.5 rounded-[8px] text-xs font-medium text-[#78716C] hover:text-[#18181B] hover:bg-[#F8F6F3] transition-colors"
        >
          <FileText className="w-3.5 h-3.5 text-[#78716C]" />
          <span>System Logs Stream</span>
        </Link>
      </div>

      {/* Summary Stat Cards Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5 mb-5">
        <button
          onClick={() =>
            setSeverityFilter(severityFilter === "Critical" ? "all" : "Critical")
          }
          className={`card-base p-4 text-left transition-all duration-150 ${
            severityFilter === "Critical"
              ? "ring-2 ring-[#C53030] bg-[#FFF5F5]"
              : "hover:border-[#C7BBB8]"
          }`}
        >
          <div className="flex items-center justify-between text-xs text-[#78716C] mb-1">
            <span className="font-medium text-[#C53030]">Critical Alerts</span>
            <AlertOctagon className="w-4 h-4 text-[#C53030]" />
          </div>
          <div className="text-2xl font-bold font-display text-[#18181B]">
            {summaryCounts.Critical}
          </div>
          <div className="text-[11px] text-[#78716C] mt-1 flex items-center justify-between">
            <span>SLA Impact Risk</span>
            <span className="font-mono text-[10px] text-[#A8A29E]">Filter</span>
          </div>
        </button>

        <button
          onClick={() =>
            setSeverityFilter(severityFilter === "High" ? "all" : "High")
          }
          className={`card-base p-4 text-left transition-all duration-150 ${
            severityFilter === "High"
              ? "ring-2 ring-[#EA580C] bg-[#FFF9F5]"
              : "hover:border-[#C7BBB8]"
          }`}
        >
          <div className="flex items-center justify-between text-xs text-[#78716C] mb-1">
            <span className="font-medium text-[#C2410C]">High Priority</span>
            <AlertTriangle className="w-4 h-4 text-[#EA580C]" />
          </div>
          <div className="text-2xl font-bold font-display text-[#18181B]">
            {summaryCounts.High}
          </div>
          <div className="text-[11px] text-[#78716C] mt-1 flex items-center justify-between">
            <span>Elevated Z-Score</span>
            <span className="font-mono text-[10px] text-[#A8A29E]">Filter</span>
          </div>
        </button>

        <button
          onClick={() =>
            setSeverityFilter(severityFilter === "Medium" ? "all" : "Medium")
          }
          className={`card-base p-4 text-left transition-all duration-150 ${
            severityFilter === "Medium"
              ? "ring-2 ring-[#CA8A04] bg-[#FEFCE8]"
              : "hover:border-[#C7BBB8]"
          }`}
        >
          <div className="flex items-center justify-between text-xs text-[#78716C] mb-1">
            <span className="font-medium text-[#A16207]">Medium Severity</span>
            <AlertCircle className="w-4 h-4 text-[#CA8A04]" />
          </div>
          <div className="text-2xl font-bold font-display text-[#18181B]">
            {summaryCounts.Medium}
          </div>
          <div className="text-[11px] text-[#78716C] mt-1 flex items-center justify-between">
            <span>Warning Drift</span>
            <span className="font-mono text-[10px] text-[#A8A29E]">Filter</span>
          </div>
        </button>

        <button
          onClick={() =>
            setSeverityFilter(severityFilter === "Low" ? "all" : "Low")
          }
          className={`card-base p-4 text-left transition-all duration-150 ${
            severityFilter === "Low"
              ? "ring-2 ring-[#0284C7] bg-[#F0F9FF]"
              : "hover:border-[#C7BBB8]"
          }`}
        >
          <div className="flex items-center justify-between text-xs text-[#78716C] mb-1">
            <span className="font-medium text-[#0369A1]">Low / Informational</span>
            <Info className="w-4 h-4 text-[#0284C7]" />
          </div>
          <div className="text-2xl font-bold font-display text-[#18181B]">
            {summaryCounts.Low}
          </div>
          <div className="text-[11px] text-[#78716C] mt-1 flex items-center justify-between">
            <span>Operational Info</span>
            <span className="font-mono text-[10px] text-[#A8A29E]">Filter</span>
          </div>
        </button>
      </div>

      {/* Filter and Search Bar */}
      <div className="card-base p-3 mb-5 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="w-4 h-4 text-[#A8A29E] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search alerts by title, affected service, or description..."
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
              Status:
            </span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="input-base text-xs py-1.5 px-2.5 w-auto bg-white border-[#ECE7E2]"
            >
              <option value="all">All Statuses</option>
              <option value="Active">Active Only</option>
              <option value="Acknowledged">Acknowledged</option>
              <option value="Resolved">Resolved</option>
            </select>
          </div>

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
              <option value="Critical">Critical</option>
              <option value="High">High</option>
              <option value="Medium">Medium</option>
              <option value="Low">Low</option>
            </select>
          </div>

          {(severityFilter !== "all" || statusFilter !== "all" || searchQuery) && (
            <button
              onClick={() => {
                setSeverityFilter("all");
                setStatusFilter("all");
                setSearchQuery("");
              }}
              className="btn-secondary text-xs py-1.5 px-2.5"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Main Alerts Table & Detail Panel Layout */}
      <div className="flex flex-col xl:flex-row gap-5 items-start">
        <div className={`w-full transition-all duration-200 ${selectedAlert ? "xl:w-7/12" : "w-full"}`}>
          <div className="card-base overflow-hidden border border-[#ECE7E2]">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-[#F8F6F3] border-b border-[#ECE7E2] text-[#78716C] font-mono">
                    <th className="py-2.5 px-3.5 font-medium whitespace-nowrap">Alert Title</th>
                    <th className="py-2.5 px-3 font-medium whitespace-nowrap">Severity</th>
                    <th className="py-2.5 px-3 font-medium whitespace-nowrap">Service</th>
                    <th className="py-2.5 px-3 font-medium whitespace-nowrap">Tenant</th>
                    <th className="py-2.5 px-3 font-medium whitespace-nowrap">Timestamp</th>
                    <th className="py-2.5 px-3 font-medium whitespace-nowrap">Status</th>
                    <th className="py-2.5 px-3.5 font-medium whitespace-nowrap text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#ECE7E2]">
                  {filteredAlerts.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-12 text-center text-[#78716C]">
                        <div className="flex flex-col items-center justify-center">
                          <CheckCircle className="w-6 h-6 text-[#6B9E6B] mb-2" />
                          <p className="text-sm font-medium text-[#18181B]">No alerts match active filters</p>
                          <p className="text-xs text-[#78716C] mt-0.5">
                            All systems operating normally within selected criteria.
                          </p>
                          <button
                            onClick={() => {
                              setSearchQuery("");
                              setSeverityFilter("all");
                              setStatusFilter("all");
                            }}
                            className="btn-secondary text-xs mt-3 py-1 px-3"
                          >
                            Reset Filters
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filteredAlerts.map((alert) => {
                      const isSelected = selectedAlert?.id === alert.id;
                      return (
                        <tr
                          key={alert.id}
                          onClick={() => setSelectedAlert(isSelected ? null : alert)}
                          className={`cursor-pointer transition-colors duration-100 ${
                            isSelected
                              ? "bg-[#F3E2DB]/40 font-medium"
                              : "hover:bg-[#F8F6F3]"
                          }`}
                        >
                          <td className="py-3 px-3.5">
                            <div className="flex flex-col">
                              <span className="font-display font-semibold text-xs text-[#18181B] line-clamp-1">
                                {alert.title}
                              </span>
                              <span className="text-[11px] text-[#78716C] font-mono mt-0.5 line-clamp-1">
                                {alert.description}
                              </span>
                            </div>
                          </td>

                          <td className="py-3 px-3 whitespace-nowrap">
                            {getSeverityBadge(alert.severity)}
                          </td>

                          <td className="py-3 px-3 whitespace-nowrap font-mono text-[11px] text-[#18181B]">
                            <span className="px-1.5 py-0.5 rounded bg-[#F8F6F3] border border-[#ECE7E2]">
                              {alert.affectedService}
                            </span>
                          </td>

                          <td className="py-3 px-3 whitespace-nowrap font-mono text-[11px] text-[#78716C]">
                            {alert.tenant}
                          </td>

                          <td className="py-3 px-3 whitespace-nowrap font-mono text-[11px] text-[#78716C]">
                            <div className="flex flex-col">
                              <span>{formatTs(alert.timestamp)}</span>
                              <span className="text-[10px] text-[#A8A29E]">{getRelativeTime(alert.timestampMs)}</span>
                            </div>
                          </td>

                          <td className="py-3 px-3 whitespace-nowrap">
                            {getStatusBadge(alert.status)}
                          </td>

                          <td className="py-3 px-3.5 whitespace-nowrap text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              {alert.status === "Active" && (
                                <button
                                  onClick={(e) => handleAcknowledge(alert.id, e)}
                                  className="btn-secondary text-[11px] py-1 px-2.5 font-medium"
                                  title="Acknowledge this alert"
                                >
                                  Ack
                                </button>
                              )}
                              {alert.status !== "Resolved" && (
                                <button
                                  onClick={(e) => handleResolve(alert.id, e)}
                                  className="btn-primary text-[11px] py-1 px-2.5 font-medium"
                                  title="Mark alert as resolved"
                                >
                                  Resolve
                                </button>
                              )}
                              {alert.status === "Resolved" && (
                                <span className="text-[10px] font-mono text-[#6B9E6B] flex items-center gap-1 justify-end">
                                  <Check className="w-3 h-3" /> Resolved
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="bg-[#F8F6F3] p-2.5 px-4 border-t border-[#ECE7E2] flex items-center justify-between text-xs text-[#78716C] font-mono">
              <span>Showing {filteredAlerts.length} alerts</span>
              <span className="text-[11px]">Click any alert row for AIOps root-cause details</span>
            </div>
          </div>
        </div>

        {/* Selected Alert Details Inspection Drawer */}
        {selectedAlert && (
          <div className="w-full xl:w-5/12 card-base p-5 border border-[#C7BBB8] bg-white shadow-elevated transition-all">
            <div className="flex items-start justify-between pb-3 border-b border-[#ECE7E2] mb-4 gap-2">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  {getSeverityBadge(selectedAlert.severity)}
                  {getStatusBadge(selectedAlert.status)}
                </div>
                <h3 className="font-display font-semibold text-base text-[#18181B] leading-tight">
                  {selectedAlert.title}
                </h3>
              </div>
              <button
                onClick={() => setSelectedAlert(null)}
                className="btn-ghost p-1 text-[#78716C] hover:text-[#18181B] shrink-0"
                title="Close drawer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 text-xs font-sans">
              <div className="grid grid-cols-2 gap-2.5">
                <div className="bg-[#F8F6F3] p-2.5 rounded-[6px] border border-[#ECE7E2]">
                  <span className="text-[10px] font-mono text-[#A8A29E] block">Affected Service</span>
                  <strong className="font-mono text-xs text-[#18181B]">{selectedAlert.affectedService}</strong>
                </div>
                <div className="bg-[#F8F6F3] p-2.5 rounded-[6px] border border-[#ECE7E2]">
                  <span className="text-[10px] font-mono text-[#A8A29E] block">Target Tenant</span>
                  <strong className="font-mono text-xs text-[#18181B]">{selectedAlert.tenant}</strong>
                </div>
                <div className="bg-[#F8F6F3] p-2.5 rounded-[6px] border border-[#ECE7E2]">
                  <span className="text-[10px] font-mono text-[#A8A29E] block">Detected At</span>
                  <strong className="font-mono text-[11px] text-[#18181B]">
                    {formatTs(selectedAlert.timestamp)}
                  </strong>
                </div>
                <div className="bg-[#F8F6F3] p-2.5 rounded-[6px] border border-[#ECE7E2]">
                  <span className="text-[10px] font-mono text-[#A8A29E] block">Affected Node(s)</span>
                  <strong className="font-mono text-[11px] text-[#18181B]">
                    {selectedAlert.affectedNodes?.join(", ") || "Cluster Mesh"}
                  </strong>
                </div>
              </div>

              <div className="p-3 rounded-[8px] bg-[#F8F6F3] border border-[#ECE7E2]">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-display font-semibold text-xs text-[#18181B] flex items-center gap-1.5">
                    <Brain className="w-3.5 h-3.5 text-[#7C3AED]" />
                    Explainable AI Root Cause Analysis
                  </span>
                  {selectedAlert.aiConfidence && (
                    <span className="font-mono text-[10px] text-[#7C3AED] bg-[#F3E8FF] px-1.5 py-0.5 rounded border border-[#E9D5FF]">
                      Confidence: {(selectedAlert.aiConfidence * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
                <p className="text-xs text-[#18181B] leading-relaxed">
                  {selectedAlert.description}
                </p>

                {selectedAlert.zScore && (
                  <div className="mt-2.5 pt-2 border-t border-[#ECE7E2] flex items-center justify-between text-[11px] font-mono">
                    <span className="text-[#78716C]">Anomaly Z-Score:</span>
                    <span className="font-bold text-[#C53030]">+{selectedAlert.zScore.toFixed(2)}σ</span>
                    <span className="text-[#78716C]">Drift Metric:</span>
                    <code className="bg-white px-1 py-0.5 rounded border border-[#ECE7E2] text-[#18181B]">
                      {selectedAlert.driftMetric}
                    </code>
                  </div>
                )}
              </div>

              {selectedAlert.recommendedRemediation && (
                <div className="p-3 rounded-[8px] bg-gradient-to-br from-[#FFFBEB] to-[#FEF3C7]/40 border border-[#FDE68A]">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[#92400E] mb-1">
                    <Wrench className="w-3.5 h-3.5" />
                    Recommended Remediation Plan
                  </div>
                  <p className="text-xs text-[#78350F] leading-relaxed">
                    {selectedAlert.recommendedRemediation}
                  </p>
                </div>
              )}

              {(selectedAlert.acknowledgedBy || selectedAlert.resolvedBy) && (
                <div className="p-2.5 rounded-[6px] bg-[#F8F6F3] border border-[#ECE7E2] space-y-1 text-[11px] font-mono text-[#78716C]">
                  {selectedAlert.acknowledgedBy && (
                    <div className="flex items-center justify-between">
                      <span>Acknowledged by:</span>
                      <span className="text-[#18181B] font-semibold">{selectedAlert.acknowledgedBy}</span>
                    </div>
                  )}
                  {selectedAlert.resolvedBy && (
                    <div className="flex items-center justify-between">
                      <span>Resolved by:</span>
                      <span className="text-[#18181B] font-semibold">{selectedAlert.resolvedBy}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="mt-5 pt-3 border-t border-[#ECE7E2] flex items-center justify-between gap-2 flex-wrap">
              <Link
                href={`/logs?service=${encodeURIComponent(selectedAlert.affectedService)}`}
                className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
              >
                <FileText className="w-3.5 h-3.5 text-[#78716C]" />
                <span>Correlated Logs</span>
                <ExternalLink className="w-3 h-3 text-[#A8A29E]" />
              </Link>

              <div className="flex items-center gap-2">
                {selectedAlert.status === "Active" && (
                  <button
                    onClick={() => handleAcknowledge(selectedAlert.id)}
                    className="btn-secondary text-xs py-1.5 px-3"
                  >
                    Acknowledge
                  </button>
                )}
                {selectedAlert.status !== "Resolved" && (
                  <button
                    onClick={() => handleResolve(selectedAlert.id)}
                    className="btn-primary text-xs py-1.5 px-3"
                  >
                    Mark as Resolved
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
