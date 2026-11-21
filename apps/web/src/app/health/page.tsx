"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  getSystemHealthData,
  SystemService,
  IncidentRecord,
  ServiceHealthStatus,
  IncidentSeverity,
  IncidentStatus,
} from "@/lib/health-data";
import { api } from "@/lib/api";
import {
  ShieldCheck,
  Server,
  Activity,
  CheckCircle,
  AlertTriangle,
  AlertOctagon,
  Clock,
  Layers,
  Search,
  Filter,
  ArrowUpDown,
  RefreshCw,
  Sparkles,
  ExternalLink,
  ChevronRight,
  Database,
  FileText,
  X,
  Cpu,
  HardDrive,
  Network,
  Zap,
  Info,
  Check,
  AlertCircle,
  Boxes,
} from "lucide-react";

export default function HealthPage() {
  const [tenantId, setTenantId] = useState("tenant_acme_corp");
  const [healthData, setHealthData] = useState(() => getSystemHealthData());
  const [selectedService, setSelectedService] = useState<SystemService | null>(null);
  const [isLiveBackend, setIsLiveBackend] = useState(false);

  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"responseTime" | "cpu" | "memory" | "uptime" | "name">("responseTime");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  // Refresh & Timing state
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [timeAgoText, setTimeAgoText] = useState("Just now");

  useEffect(() => {
    setLastUpdated(new Date());
  }, []);

  // Update relative time
  useEffect(() => {
    if (!lastUpdated) return;
    const interval = setInterval(() => {
      const seconds = Math.floor((Date.now() - lastUpdated.getTime()) / 1000);
      if (seconds < 5) setTimeAgoText("Just now");
      else if (seconds < 60) setTimeAgoText(`${seconds}s ago`);
      else setTimeAgoText(`${Math.floor(seconds / 60)}m ago`);
    }, 5000);
    return () => clearInterval(interval);
  }, [lastUpdated]);

  // Probe live backend endpoints
  const fetchHealth = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const [t2Health, t1Health, fleetRes, incRes] = await Promise.all([
        api.checkTier2Health(),
        api.checkTier1Health(),
        api.getFleetHealth(tenantId),
        api.getIncidents(tenantId, 10),
      ]);

      const anyLive = t2Health.isLive || t1Health.isLive || fleetRes.isLive;
      setIsLiveBackend(anyLive);

      const baseData = getSystemHealthData();

      if (anyLive) {
        // Overlay real health states onto service matrix
        const updatedServices = baseData.services.map((s) => {
          if (s.id === "svc_ingestion_hub") {
            return {
              ...s,
              status: (t2Health.isLive ? "Healthy" : "Critical") as ServiceHealthStatus,
              details: t2Health.isLive
                ? "Tier 2 SaaS API responded healthy on port 8000"
                : "Tier 2 SaaS connection refused on port 8000",
            };
          }
          if (s.id === "svc_edge_collector") {
            return {
              ...s,
              status: (t1Health.isLive ? "Healthy" : "Warning") as ServiceHealthStatus,
              details: t1Health.isLive
                ? "Tier 1 Collector daemon online on port 8001"
                : "Tier 1 Collector daemon offline on port 8001",
            };
          }
          return s;
        });

        // Overlay live incidents if returned
        let updatedIncidents = baseData.incidents;
        if (incRes.isLive && incRes.data && incRes.data.length > 0) {
          updatedIncidents = incRes.data.map((inc) => ({
            id: inc.incident_id,
            title: inc.reasoning_path ? inc.reasoning_path.split("\n")[0] : `Incident ${inc.incident_id}`,
            severity: (inc.severity === "critical" ? "Critical" : inc.severity === "warning" ? "High" : "Low") as IncidentSeverity,
            affectedService: inc.source_id,
            startTime: inc.first_alert_time_utc,
            startTimeMs: new Date(inc.first_alert_time_utc).getTime(),
            status: (inc.status === "active" ? "Active" : inc.status === "acknowledged" ? "Investigating" : "Resolved") as IncidentStatus,
            summary: inc.reasoning_path || "Incident triaged by AIOps inference engine.",
          }));
        }

        const healthyCount = updatedServices.filter((s) => s.status === "Healthy").length;
        const unhealthyCount = updatedServices.length - healthyCount;

        setHealthData({
          overview: {
            ...baseData.overview,
            overallStatus: unhealthyCount > 2 ? "Critical" : unhealthyCount > 0 ? "Degraded" : "Healthy",
            healthyServices: healthyCount,
            unhealthyServices: unhealthyCount,
            activeIncidents: updatedIncidents.filter((i) => i.status === "Active" || i.status === "Investigating").length,
          },
          services: updatedServices,
          incidents: updatedIncidents,
        });
      } else {
        setHealthData(baseData);
      }

      setLastUpdated(new Date());
      setTimeAgoText("Just now");
    } catch {
      setIsLiveBackend(false);
      setHealthData(getSystemHealthData());
    } finally {
      setIsRefreshing(false);
    }
  }, [tenantId]);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  const handleRefresh = useCallback(() => {
    fetchHealth();
  }, [fetchHealth]);

  // Status visual badge helper
  const getServiceStatusBadge = (status: ServiceHealthStatus) => {
    switch (status) {
      case "Healthy":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] font-semibold bg-[#ECFDF5] text-[#059669] border border-[#A7F3D0]">
            <CheckCircle className="w-3 h-3 text-[#059669]" />
            Healthy
          </span>
        );
      case "Warning":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] font-semibold bg-[#FEF3C7] text-[#D97706] border border-[#FDE68A]">
            <AlertTriangle className="w-3 h-3 text-[#D97706]" />
            Warning
          </span>
        );
      case "Critical":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] font-bold bg-[#FFF1F2] text-[#E11D48] border border-[#FECDD3]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#E11D48] animate-pulse" />
            Critical
          </span>
        );
      case "Offline":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] font-semibold bg-[#F8F6F3] text-[#78716C] border border-[#ECE7E2]">
            <Clock className="w-3 h-3 text-[#A8A29E]" />
            Offline
          </span>
        );
    }
  };

  const getIncidentSeverityBadge = (severity: IncidentSeverity) => {
    switch (severity) {
      case "Critical":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono text-[10px] font-bold bg-[#FDE8E8] text-[#C53030] border border-[#FED7D7]">
            <AlertOctagon className="w-3 h-3" />
            Critical
          </span>
        );
      case "High":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono text-[10px] font-bold bg-[#FFF5F0] text-[#C2410C] border border-[#FFEDD5]">
            <AlertTriangle className="w-3 h-3" />
            High
          </span>
        );
      case "Medium":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono text-[10px] font-semibold bg-[#FEF9C3] text-[#A16207] border border-[#FEF08A]">
            <AlertCircle className="w-3 h-3" />
            Medium
          </span>
        );
      case "Low":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono text-[10px] font-medium bg-[#F0F9FF] text-[#0369A1] border border-[#BAE6FD]">
            <Info className="w-3 h-3" />
            Low
          </span>
        );
    }
  };

  const getIncidentStatusBadge = (status: IncidentStatus) => {
    switch (status) {
      case "Active":
        return (
          <span className="font-mono text-[10px] font-semibold text-[#E11D48] bg-[#FFF1F2] px-2 py-0.5 rounded-full border border-[#FECDD3]">
            Active
          </span>
        );
      case "Investigating":
        return (
          <span className="font-mono text-[10px] font-semibold text-[#D97706] bg-[#FEF3C7] px-2 py-0.5 rounded-full border border-[#FDE68A]">
            Investigating
          </span>
        );
      case "Mitigated":
        return (
          <span className="font-mono text-[10px] font-semibold text-[#0284C7] bg-[#F0F9FF] px-2 py-0.5 rounded-full border border-[#BAE6FD]">
            Mitigated
          </span>
        );
      case "Resolved":
        return (
          <span className="font-mono text-[10px] font-semibold text-[#059669] bg-[#ECFDF5] px-2 py-0.5 rounded-full border border-[#A7F3D0]">
            Resolved
          </span>
        );
    }
  };

  // Filter & Sort Services
  const filteredServices = useMemo(() => {
    return healthData.services
      .filter((s) => {
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          const matchesName = s.name.toLowerCase().includes(q);
          const matchesTier = s.tier.toLowerCase().includes(q);
          const matchesDesc = s.description.toLowerCase().includes(q);
          const matchesEndpoint = s.endpoint.toLowerCase().includes(q);
          if (!matchesName && !matchesTier && !matchesDesc && !matchesEndpoint) {
            return false;
          }
        }

        if (statusFilter !== "all" && s.status !== statusFilter) {
          return false;
        }

        return true;
      })
      .sort((a, b) => {
        let diff = 0;
        if (sortBy === "responseTime") diff = a.responseTimeMs - b.responseTimeMs;
        else if (sortBy === "cpu") diff = a.cpuUsagePct - b.cpuUsagePct;
        else if (sortBy === "memory") diff = a.memoryUsagePct - b.memoryUsagePct;
        else if (sortBy === "uptime") diff = a.uptimePct - b.uptimePct;
        else if (sortBy === "name") diff = a.name.localeCompare(b.name);

        return sortOrder === "desc" ? -diff : diff;
      });
  }, [healthData.services, searchQuery, statusFilter, sortBy, sortOrder]);

  const { overview } = healthData;

  return (
    <AppShell tenantId={tenantId} onTenantChange={setTenantId}>
      {/* Page Header */}
      <PageHeader
        title="System Health & Subsystem Architecture"
        subtitle="End-to-end telemetry pipeline topology, microservice heartbeats, response latencies, and active operational incidents."
        breadcrumbs={[
          { label: "Solarius Ops", href: "/dashboard" },
          { label: "System Health" },
        ]}
        badge={
          isLiveBackend ? (
            <span className="badge-pill bg-[#ECFDF5] text-[#059669] font-medium border border-[#A7F3D0]">
              <Sparkles className="w-3 h-3 text-[#059669]" />
              Live Health Ingest
            </span>
          ) : (
            <span className="badge-pill gradient-cream-apricot text-[#18181B] font-medium border border-[#ECE7E2]">
              <ShieldCheck className="w-3 h-3 text-[#D97706]" />
              Pipeline {overview.overallStatus} (Simulated)
            </span>
          )
        }
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-xs text-[#78716C] font-mono bg-[#F8F6F3] px-2.5 py-1.5 rounded-[6px] border border-[#ECE7E2]">
              <Clock className="w-3.5 h-3.5 text-[#A8A29E]" />
              <span className="hidden sm:inline">Sync:</span>
              <strong className="text-[#18181B] font-semibold">{timeAgoText}</strong>
            </div>

            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="btn-secondary text-xs flex items-center gap-1.5 py-1.5 px-3"
              title="Refresh system health metrics"
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
                  ? "Connected to Live Microservice Health Checks"
                  : "Operating in Fallback Simulation Mode"}
              </span>
              <span
                className={`badge-pill text-[10px] py-0 px-1.5 font-mono ${
                  isLiveBackend
                    ? "bg-[#ECFDF5] text-[#059669] border border-[#A7F3D0]"
                    : "bg-[#FDF2F8] text-[#9D174D] border border-[#FBCFE8]"
                }`}
              >
                {isLiveBackend ? "LIVE HEALTH PROBE (/health)" : "DEMO DATA"}
              </span>
            </div>
            <p className="text-xs text-[#78716C] mt-0.5">
              {isLiveBackend
                ? `Probing live endpoints at ${api.getTier2BaseUrl()} and ${api.getTier1BaseUrl()}.`
                : `Backend hosts ${api.getTier2BaseUrl()} / ${api.getTier1BaseUrl()} are currently offline. Displaying simulated microservice heartbeats.`}
            </p>
          </div>
        </div>
        <div className="text-xs font-mono text-[#78716C] shrink-0">
          Uptime Mean: <strong className="text-[#18181B]">{overview.avgUptimePct}%</strong>
        </div>
      </div>

      {/* 1. System Overview Stat Cards Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5 mb-6">
        <div className="card-base p-4">
          <div className="flex items-center justify-between text-xs text-[#78716C] mb-1">
            <span>Overall Status</span>
            <Activity className="w-4 h-4 text-[#78716C]" />
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span
              className={`text-xl font-bold font-display ${
                overview.overallStatus === "Healthy"
                  ? "text-[#059669]"
                  : overview.overallStatus === "Degraded"
                  ? "text-[#D97706]"
                  : "text-[#E11D48]"
              }`}
            >
              {overview.overallStatus}
            </span>
          </div>
          <span className="text-[11px] text-[#78716C] font-mono mt-1 block">
            {overview.healthyServices} / {overview.totalServices} services operational
          </span>
        </div>

        <div className="card-base p-4">
          <div className="flex items-center justify-between text-xs text-[#78716C] mb-1">
            <span>Total Services</span>
            <Boxes className="w-4 h-4 text-[#78716C]" />
          </div>
          <div className="text-2xl font-bold font-display text-[#18181B]">
            {overview.totalServices}
          </div>
          <span className="text-[11px] text-[#78716C] font-mono mt-1 block">
            Across 3 architecture tiers
          </span>
        </div>

        <div className="card-base p-4">
          <div className="flex items-center justify-between text-xs text-[#78716C] mb-1">
            <span className="text-[#059669]">Healthy Services</span>
            <CheckCircle className="w-4 h-4 text-[#059669]" />
          </div>
          <div className="text-2xl font-bold font-display text-[#18181B]">
            {overview.healthyServices}
          </div>
          <span className="text-[11px] text-[#059669] font-mono mt-1 block">
            Passing all heartbeat checks
          </span>
        </div>

        <div className="card-base p-4">
          <div className="flex items-center justify-between text-xs text-[#78716C] mb-1">
            <span className="text-[#E11D48]">Unhealthy Services</span>
            <AlertTriangle className="w-4 h-4 text-[#E11D48]" />
          </div>
          <div className="text-2xl font-bold font-display text-[#18181B]">
            {overview.unhealthyServices}
          </div>
          <span className="text-[11px] text-[#78716C] font-mono mt-1 block">
            1 Warning • 1 Critical
          </span>
        </div>

        <div className="card-base p-4 col-span-2 sm:col-span-1">
          <div className="flex items-center justify-between text-xs text-[#78716C] mb-1">
            <span className="text-[#C2410C]">Active Incidents</span>
            <AlertOctagon className="w-4 h-4 text-[#C2410C]" />
          </div>
          <div className="text-2xl font-bold font-display text-[#18181B]">
            {overview.activeIncidents}
          </div>
          <span className="text-[11px] text-[#78716C] font-mono mt-1 block">
            In active triage queue
          </span>
        </div>
      </div>

      {/* 2. Service Health Table & Details Drawer */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="font-display font-semibold text-base text-[#18181B] tracking-tight">
              Service Health Matrix
            </h2>
            <p className="text-xs text-[#78716C] mt-0.5">
              Live daemon heartbeats, CPU/memory consumption, and response times across all pipeline tiers.
            </p>
          </div>
          <span className="text-xs font-mono text-[#78716C] hidden sm:inline">
            Mean Response: <strong className="text-[#18181B]">{overview.avgResponseTimeMs} ms</strong>
          </span>
        </div>

        {/* Search, Filter & Sort Controls */}
        <div className="card-base p-3 mb-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-[#A8A29E] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search services by name, tier, or endpoint..."
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
                <option value="Healthy">Healthy</option>
                <option value="Warning">Warning</option>
                <option value="Critical">Critical</option>
                <option value="Offline">Offline</option>
              </select>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-mono text-[#A8A29E] hidden sm:inline">
                Sort:
              </span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="input-base text-xs py-1.5 px-2.5 w-auto bg-white border-[#ECE7E2]"
              >
                <option value="responseTime">Response Time</option>
                <option value="cpu">CPU Usage</option>
                <option value="memory">Memory Usage</option>
                <option value="uptime">Uptime %</option>
                <option value="name">Service Name</option>
              </select>
            </div>

            <button
              onClick={() => setSortOrder(sortOrder === "desc" ? "asc" : "desc")}
              className="btn-secondary text-xs py-1.5 px-2.5 flex items-center gap-1"
              title={`Sort: ${sortOrder === "desc" ? "High to Low" : "Low to High"}`}
            >
              <ArrowUpDown className="w-3 h-3 text-[#18181B]" />
              <span className="font-mono text-[11px]">
                {sortOrder === "desc" ? "Desc" : "Asc"}
              </span>
            </button>
          </div>
        </div>

        {/* Service Table and Side Inspector Layout */}
        <div className="flex flex-col xl:flex-row gap-5 items-start">
          <div className={`w-full transition-all duration-200 ${selectedService ? "xl:w-7/12" : "w-full"}`}>
            <div className="card-base overflow-hidden border border-[#ECE7E2]">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-[#F8F6F3] border-b border-[#ECE7E2] text-[#78716C] font-mono">
                      <th className="py-2.5 px-3.5 font-medium whitespace-nowrap">Service Name</th>
                      <th className="py-2.5 px-3 font-medium whitespace-nowrap">Status</th>
                      <th className="py-2.5 px-3 font-medium whitespace-nowrap">CPU</th>
                      <th className="py-2.5 px-3 font-medium whitespace-nowrap">Memory</th>
                      <th className="py-2.5 px-3 font-medium whitespace-nowrap">Response Time</th>
                      <th className="py-2.5 px-3 font-medium whitespace-nowrap">Last Heartbeat</th>
                      <th className="py-2.5 px-3.5 font-medium whitespace-nowrap text-right">Uptime</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#ECE7E2]">
                    {filteredServices.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-12 text-center text-[#78716C]">
                          <Server className="w-6 h-6 text-[#A8A29E] mx-auto mb-2" />
                          <p className="text-sm font-medium text-[#18181B]">No services match filter criteria</p>
                          <p className="text-xs text-[#78716C] mt-0.5">
                            Try resetting search query or selecting &quot;All Statuses&quot;.
                          </p>
                        </td>
                      </tr>
                    ) : (
                      filteredServices.map((svc) => {
                        const isSelected = selectedService?.id === svc.id;
                        return (
                          <tr
                            key={svc.id}
                            onClick={() => setSelectedService(isSelected ? null : svc)}
                            className={`cursor-pointer transition-colors duration-100 ${
                              isSelected ? "bg-[#F3E2DB]/40 font-medium" : "hover:bg-[#F8F6F3]"
                            }`}
                          >
                            <td className="py-3 px-3.5">
                              <div className="flex flex-col">
                                <span className="font-display font-semibold text-xs text-[#18181B]">
                                  {svc.name}
                                </span>
                                <span className="text-[11px] text-[#78716C] font-mono mt-0.5">
                                  {svc.tier}
                                </span>
                              </div>
                            </td>

                            <td className="py-3 px-3 whitespace-nowrap">
                              {getServiceStatusBadge(svc.status)}
                            </td>

                            <td className="py-3 px-3 whitespace-nowrap">
                              <div className="w-24">
                                <span className="font-mono text-[11px] font-semibold text-[#18181B]">
                                  {svc.cpuUsagePct}%
                                </span>
                                <div className="w-full bg-[#F8F6F3] h-1.5 rounded-full overflow-hidden mt-1 border border-[#ECE7E2]">
                                  <div
                                    className={`h-full rounded-full ${
                                      svc.cpuUsagePct > 70 ? "bg-[#D47A7A]" : "bg-[#6B9E6B]"
                                    }`}
                                    style={{ width: `${Math.min(100, svc.cpuUsagePct)}%` }}
                                  />
                                </div>
                              </div>
                            </td>

                            <td className="py-3 px-3 whitespace-nowrap">
                              <div className="w-24">
                                <span className="font-mono text-[11px] font-semibold text-[#18181B]">
                                  {svc.memoryUsagePct}%
                                </span>
                                <div className="w-full bg-[#F8F6F3] h-1.5 rounded-full overflow-hidden mt-1 border border-[#ECE7E2]">
                                  <div
                                    className={`h-full rounded-full ${
                                      svc.memoryUsagePct > 75 ? "bg-[#D47A7A]" : "bg-[#7C3AED]"
                                    }`}
                                    style={{ width: `${Math.min(100, svc.memoryUsagePct)}%` }}
                                  />
                                </div>
                              </div>
                            </td>

                            <td className="py-3 px-3 whitespace-nowrap font-mono text-[11px]">
                              <span
                                className={`font-semibold ${
                                  svc.responseTimeMs > 200
                                    ? "text-[#C53030]"
                                    : svc.responseTimeMs > 40
                                    ? "text-[#D97706]"
                                    : "text-[#18181B]"
                                }`}
                              >
                                {svc.responseTimeMs} ms
                              </span>
                            </td>

                            <td className="py-3 px-3 whitespace-nowrap font-mono text-[11px] text-[#78716C]">
                              {svc.lastHeartbeat}
                            </td>

                            <td className="py-3 px-3.5 whitespace-nowrap text-right font-mono text-[11px] font-semibold text-[#18181B]">
                              {svc.uptimePct}%
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              <div className="bg-[#F8F6F3] p-2.5 px-4 border-t border-[#ECE7E2] flex items-center justify-between text-xs text-[#78716C] font-mono">
                <span>Showing {filteredServices.length} services</span>
                <span className="text-[11px]">Click any service row for configuration &amp; dependency inspection</span>
              </div>
            </div>
          </div>

          {/* Service Details Drawer */}
          {selectedService && (
            <div className="w-full xl:w-5/12 card-base p-5 border border-[#C7BBB8] bg-white shadow-elevated transition-all">
              <div className="flex items-start justify-between pb-3 border-b border-[#ECE7E2] mb-4 gap-2">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    {getServiceStatusBadge(selectedService.status)}
                    <span className="font-mono text-[10px] text-[#78716C] bg-[#F8F6F3] px-2 py-0.5 rounded border border-[#ECE7E2]">
                      {selectedService.tier}
                    </span>
                  </div>
                  <h3 className="font-display font-semibold text-base text-[#18181B]">
                    {selectedService.name}
                  </h3>
                </div>
                <button
                  onClick={() => setSelectedService(null)}
                  className="btn-ghost p-1 text-[#78716C] hover:text-[#18181B]"
                  title="Close service details"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-3.5 text-xs font-sans">
                <p className="text-xs text-[#78716C] leading-relaxed">
                  {selectedService.description}
                </p>

                <div className="grid grid-cols-2 gap-2.5">
                  <div className="bg-[#F8F6F3] p-2.5 rounded-[6px] border border-[#ECE7E2]">
                    <span className="text-[10px] font-mono text-[#A8A29E] block">Response Latency</span>
                    <strong className="font-mono text-sm text-[#18181B]">{selectedService.responseTimeMs} ms</strong>
                  </div>
                  <div className="bg-[#F8F6F3] p-2.5 rounded-[6px] border border-[#ECE7E2]">
                    <span className="text-[10px] font-mono text-[#A8A29E] block">Uptime Target</span>
                    <strong className="font-mono text-sm text-[#059669]">{selectedService.uptimePct}%</strong>
                  </div>
                  <div className="bg-[#F8F6F3] p-2.5 rounded-[6px] border border-[#ECE7E2]">
                    <span className="text-[10px] font-mono text-[#A8A29E] block">Build Version</span>
                    <strong className="font-mono text-xs text-[#18181B]">{selectedService.version}</strong>
                  </div>
                  <div className="bg-[#F8F6F3] p-2.5 rounded-[6px] border border-[#ECE7E2]">
                    <span className="text-[10px] font-mono text-[#A8A29E] block">Instances / Replicas</span>
                    <strong className="font-mono text-xs text-[#18181B]">{selectedService.instances} Active Pods</strong>
                  </div>
                </div>

                <div className="bg-[#F8F6F3] p-2.5 rounded-[6px] border border-[#ECE7E2]">
                  <span className="text-[10px] font-mono text-[#A8A29E] block mb-0.5">
                    Internal Endpoint Target
                  </span>
                  <code className="font-mono text-[11px] text-[#18181B] select-all break-all">
                    {selectedService.endpoint}
                  </code>
                </div>

                {selectedService.dependencies.length > 0 && (
                  <div>
                    <label className="text-[11px] font-mono uppercase text-[#A8A29E] block mb-1">
                      Direct Downstream Dependencies
                    </label>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {selectedService.dependencies.map((dep, idx) => (
                        <span
                          key={idx}
                          className="px-2 py-0.5 rounded-[4px] bg-[#F8F6F3] font-mono text-[11px] text-[#18181B] border border-[#ECE7E2]"
                        >
                          {dep}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <label className="text-[11px] font-mono uppercase text-[#A8A29E] block mb-1">
                    Recent Diagnostic Logs &amp; Events
                  </label>
                  <div className="space-y-1.5 font-mono text-[11px]">
                    {selectedService.recentEvents.map((ev, idx) => (
                      <div
                        key={idx}
                        className="p-2 rounded-[4px] bg-[#F9F7F4] border border-[#ECE7E2] text-[#18181B] leading-relaxed"
                      >
                        {ev}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-[#ECE7E2] flex items-center justify-between gap-2">
                <Link
                  href={`/logs?service=${encodeURIComponent(selectedService.name)}`}
                  className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
                >
                  <FileText className="w-3.5 h-3.5 text-[#78716C]" />
                  <span>View Service Logs</span>
                  <ExternalLink className="w-3 h-3 text-[#A8A29E]" />
                </Link>
                <Link
                  href="/alerts"
                  className="btn-primary text-xs py-1.5 px-3"
                >
                  Triage Incidents
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 3. Operational Incident Information Section */}
      <div className="card-base p-5">
        <div className="flex items-center justify-between pb-3 border-b border-[#ECE7E2] mb-4">
          <div className="flex items-center gap-2">
            <AlertOctagon className="w-4 h-4 text-[#C2410C]" />
            <h3 className="font-display font-semibold text-base text-[#18181B]">
              Active &amp; Recent Pipeline Incidents
            </h3>
          </div>
          <Link
            href="/alerts"
            className="text-xs font-mono text-[#78716C] hover:text-[#18181B] flex items-center gap-1"
          >
            <span>Full Incident Triage Queue</span>
            <ExternalLink className="w-3 h-3" />
          </Link>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-[#F8F6F3] border-b border-[#ECE7E2] text-[#78716C] font-mono">
                <th className="py-2.5 px-3.5 font-medium whitespace-nowrap">Incident ID &amp; Title</th>
                <th className="py-2.5 px-3 font-medium whitespace-nowrap">Severity</th>
                <th className="py-2.5 px-3 font-medium whitespace-nowrap">Affected Service</th>
                <th className="py-2.5 px-3 font-medium whitespace-nowrap">Start Time</th>
                <th className="py-2.5 px-3 font-medium whitespace-nowrap">Status</th>
                <th className="py-2.5 px-3.5 font-medium whitespace-nowrap text-right">Lead Responder</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#ECE7E2]">
              {healthData.incidents.map((inc) => (
                <tr key={inc.id} className="hover:bg-[#F8F6F3] transition-colors">
                  <td className="py-3 px-3.5">
                    <div className="flex flex-col">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono font-bold text-[11px] text-[#18181B]">
                          {inc.id}:
                        </span>
                        <span className="font-semibold text-xs text-[#18181B]">
                          {inc.title}
                        </span>
                      </div>
                      <span className="text-[11px] text-[#78716C] mt-0.5 line-clamp-1">
                        {inc.summary}
                      </span>
                    </div>
                  </td>

                  <td className="py-3 px-3 whitespace-nowrap">
                    {getIncidentSeverityBadge(inc.severity)}
                  </td>

                  <td className="py-3 px-3 whitespace-nowrap font-mono text-[11px] text-[#18181B]">
                    <span className="px-1.5 py-0.5 rounded bg-[#F8F6F3] border border-[#ECE7E2]">
                      {inc.affectedService}
                    </span>
                  </td>

                  <td className="py-3 px-3 whitespace-nowrap font-mono text-[11px] text-[#78716C]">
                    <div className="flex flex-col">
                      <span>{new Date(inc.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      <span className="text-[10px] text-[#A8A29E]">
                        {Math.floor((Date.now() - inc.startTimeMs) / 60000)}m ago
                      </span>
                    </div>
                  </td>

                  <td className="py-3 px-3 whitespace-nowrap">
                    {getIncidentStatusBadge(inc.status)}
                  </td>

                  <td className="py-3 px-3.5 whitespace-nowrap text-right font-mono text-[11px] text-[#78716C]">
                    {inc.leadResponder || "Auto-Remediation"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
