"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  getInitialTenants,
  TenantRecord,
  TenantStatus,
  TenantServiceHealth,
} from "@/lib/tenants-data";
import {
  generateInitialLogs,
  generateInitialAlerts,
  LogEntry,
  AlertItem,
} from "@/lib/logs-alerts-data";
import { api, BackendCollectorHealth, BackendIncident } from "@/lib/api";
import {
  Building2,
  Users,
  ShieldCheck,
  CheckCircle,
  AlertTriangle,
  AlertOctagon,
  Clock,
  Layers,
  Search,
  Filter,
  ArrowUpDown,
  ArrowLeft,
  Server,
  Activity,
  HardDrive,
  Network,
  Cpu,
  Lock,
  ExternalLink,
  Sparkles,
  RefreshCw,
  X,
  Check,
  ShieldAlert,
  ChevronRight,
  Database,
  FileText,
} from "lucide-react";

export default function TenantsPage() {
  const [activeSessionTenant, setActiveSessionTenant] = useState("tenant_acme_corp");
  const [tenants, setTenants] = useState<TenantRecord[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [isLiveBackend, setIsLiveBackend] = useState(false);

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"name" | "cpu" | "memory" | "alerts">("alerts");
  const [sortDirection, setSortDirection] = useState<"desc" | "asc">("desc");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Fetch tenants with live fleet health overlay
  const fetchTenants = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const [fleetRes, incRes] = await Promise.all([
        api.getFleetHealth(activeSessionTenant),
        api.getIncidents(activeSessionTenant, 20),
      ]);

      const baseList = getInitialTenants();

      if (fleetRes.isLive && fleetRes.data) {
        setIsLiveBackend(true);
        const liveCollectors = fleetRes.data;
        const liveIncidents = incRes.data || [];

        // Overlay live backend data onto activeSessionTenant record
        const updated = baseList.map((t) => {
          if (t.id === activeSessionTenant) {
            const healthyCount = liveCollectors.filter(
              (c) => c.health_state === "Excellent" || c.health_state === "Good"
            ).length;
            const newStatus: TenantStatus =
              liveCollectors.some((c) => c.health_state === "Poor") || liveIncidents.some((i) => i.severity === "critical")
                ? "Critical"
                : liveCollectors.some((c) => c.health_state === "Fair") || liveIncidents.length > 0
                ? "Warning"
                : "Healthy";

            return {
              ...t,
              connectedNodes: liveCollectors.length || t.connectedNodes,
              activeAlertsCount: liveIncidents.length,
              status: newStatus,
            };
          }
          return t;
        });

        setTenants(updated);
      } else {
        setIsLiveBackend(false);
        setTenants(baseList);
      }
    } catch {
      setIsLiveBackend(false);
      setTenants(getInitialTenants());
    } finally {
      setIsRefreshing(false);
    }
  }, [activeSessionTenant]);

  useEffect(() => {
    fetchTenants();
  }, [fetchTenants]);

  const handleRefresh = () => {
    fetchTenants();
    showMessage("Tenant metrics synchronized");
  };

  const showMessage = (msg: string) => {
    setStatusMessage(msg);
    setTimeout(() => setStatusMessage(null), 3000);
  };

  // Status badge styling
  const getStatusBadge = (status: TenantStatus) => {
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
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] font-semibold bg-[#FFF1F2] text-[#E11D48] border border-[#FECDD3]">
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

  // Filtered and sorted tenants
  const filteredTenants = useMemo(() => {
    return tenants
      .filter((t) => {
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          const matchesName = t.name.toLowerCase().includes(q);
          const matchesId = t.id.toLowerCase().includes(q);
          const matchesRegion = t.region.toLowerCase().includes(q);
          if (!matchesName && !matchesId && !matchesRegion) return false;
        }

        if (statusFilter !== "all" && t.status !== statusFilter) {
          return false;
        }

        return true;
      })
      .sort((a, b) => {
        let diff = 0;
        if (sortBy === "name") {
          diff = a.name.localeCompare(b.name);
        } else if (sortBy === "cpu") {
          diff = a.metrics.cpuUsagePct - b.metrics.cpuUsagePct;
        } else if (sortBy === "memory") {
          diff = a.metrics.memoryUsagePct - b.metrics.memoryUsagePct;
        } else if (sortBy === "alerts") {
          diff = a.activeAlertsCount - b.activeAlertsCount;
        }

        return sortDirection === "desc" ? -diff : diff;
      });
  }, [tenants, searchQuery, statusFilter, sortBy, sortDirection]);

  // Selected tenant data
  const selectedTenant = useMemo(() => {
    if (!selectedTenantId) return null;
    return tenants.find((t) => t.id === selectedTenantId) || null;
  }, [tenants, selectedTenantId]);

  // Correlated logs and alerts for the selected tenant
  const tenantLogs = useMemo(() => {
    if (!selectedTenant) return [];
    const allLogs = generateInitialLogs();
    const matches = allLogs.filter((l) => l.tenant === selectedTenant.id);
    return matches.length > 0 ? matches : allLogs.slice(0, 3);
  }, [selectedTenant]);

  const tenantAlerts = useMemo(() => {
    if (!selectedTenant) return [];
    const allAlerts = generateInitialAlerts();
    return allAlerts.filter((a) => a.tenant === selectedTenant.id);
  }, [selectedTenant]);

  return (
    <AppShell tenantId={activeSessionTenant} onTenantChange={setActiveSessionTenant}>
      {/* Page Header */}
      <PageHeader
        title={selectedTenant ? `${selectedTenant.name} Overview` : "Tenant Governance & Fleet Views"}
        subtitle={
          selectedTenant
            ? `Deep-dive telemetry signals, service health matrix, and active incidents for tenant ID ${selectedTenant.id}.`
            : "Multi-tenant isolation status, resource consumption telemetry, and individual tenant workload metrics."
        }
        breadcrumbs={[
          { label: "Solarius Ops", href: "/dashboard" },
          { label: "Tenants", href: selectedTenant ? "/tenants" : undefined },
          ...(selectedTenant ? [{ label: selectedTenant.name }] : []),
        ]}
        badge={
          isLiveBackend ? (
            <span className="badge-pill bg-[#ECFDF5] text-[#059669] font-medium border border-[#A7F3D0]">
              <Sparkles className="w-3 h-3 text-[#059669]" />
              Live Fleet Connected
            </span>
          ) : (
            <span className="badge-pill gradient-sage-mist text-[#18181B] font-medium border border-[#ECE7E2]">
              <Lock className="w-3 h-3 text-[#6B9E6B]" />
              Tenant Boundary Enforced
            </span>
          )
        }
        actions={
          <div className="flex items-center gap-2">
            {selectedTenant && (
              <button
                onClick={() => setSelectedTenantId(null)}
                className="btn-secondary text-xs flex items-center gap-1.5 py-1.5 px-3"
              >
                <ArrowLeft className="w-3.5 h-3.5 text-[#18181B]" />
                <span>All Tenants</span>
              </button>
            )}
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="btn-secondary text-xs flex items-center gap-1.5 py-1.5 px-3"
              title="Refresh tenant telemetry"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 text-[#18181B] ${
                  isRefreshing ? "animate-spin" : ""
                }`}
              />
              <span>{isRefreshing ? "Syncing..." : "Refresh"}</span>
            </button>
          </div>
        }
      />

      {/* Status Action Toast */}
      {statusMessage && (
        <div className="mb-4 p-2.5 px-4 rounded-[8px] bg-[#18181B] text-white text-xs font-medium flex items-center justify-between shadow-elevated">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-[#8FBC8F]" />
            <span>{statusMessage}</span>
          </div>
          <button onClick={() => setStatusMessage(null)} className="text-[#A8A29E] hover:text-white">
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
                  ? "Connected to Live Fleet Telemetry API"
                  : "Operating in Fallback Simulation Mode"}
              </span>
              <span
                className={`badge-pill text-[10px] py-0 px-1.5 font-mono ${
                  isLiveBackend
                    ? "bg-[#ECFDF5] text-[#059669] border border-[#A7F3D0]"
                    : "bg-[#FDF2F8] text-[#9D174D] border border-[#FBCFE8]"
                }`}
              >
                {isLiveBackend ? "LIVE API (/api/v1/fleet/health)" : "DEMO DATA"}
              </span>
            </div>
            <p className="text-xs text-[#78716C] mt-0.5">
              {isLiveBackend
                ? `Active workspace tenant is ${activeSessionTenant}. Live node counts and alerts synced from ${api.getTier2BaseUrl()}.`
                : `Backend API at ${api.getTier2BaseUrl()} is offline. Displaying simulated multi-tenant isolation matrix.`}
            </p>
          </div>
        </div>
        <div className="text-xs font-mono text-[#78716C] shrink-0">
          Showing <strong className="text-[#18181B]">{filteredTenants.length}</strong> of {tenants.length} tenants
        </div>
      </div>

      {/* DETAIL VIEW vs OVERVIEW LIST */}
      {selectedTenant ? (
        <div className="space-y-6">
          <div className="card-base p-5 bg-white border border-[#C7BBB8] shadow-sm">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-[#ECE7E2]">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-[10px] gradient-blush-sand flex items-center justify-center border border-[#ECE7E2]">
                  <Building2 className="w-6 h-6 text-[#18181B]" />
                </div>
                <div>
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <h2 className="font-display font-bold text-xl text-[#18181B]">
                      {selectedTenant.name}
                    </h2>
                    {getStatusBadge(selectedTenant.status)}
                    {activeSessionTenant === selectedTenant.id ? (
                      <span className="text-[10px] font-mono bg-[#ECFDF5] text-[#059669] px-2 py-0.5 rounded border border-[#A7F3D0] font-semibold">
                        ACTIVE SESSION TENANT
                      </span>
                    ) : (
                      <button
                        onClick={() => {
                          setActiveSessionTenant(selectedTenant.id);
                          showMessage(`Switched active workspace tenant to ${selectedTenant.name}`);
                        }}
                        className="btn-secondary text-[10px] font-mono py-0.5 px-2"
                      >
                        Set as Active Tenant
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-[#78716C] mt-1 font-mono flex-wrap">
                    <span>ID: <strong className="text-[#18181B]">{selectedTenant.id}</strong></span>
                    <span>•</span>
                    <span>Region: {selectedTenant.region}</span>
                    <span>•</span>
                    <span>Connected Nodes: {selectedTenant.connectedNodes}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3 self-start md:self-auto text-xs font-mono">
                <div className="text-right">
                  <span className="text-[10px] text-[#A8A29E] block">Compliance Standard</span>
                  <strong className="text-[#18181B]">{selectedTenant.complianceTier}</strong>
                </div>
              </div>
            </div>

            <div className="pt-3 flex items-center justify-between text-xs text-[#78716C] flex-wrap gap-2">
              <div className="flex items-center gap-1.5">
                <span className="text-[#A8A29E]">Privacy Profile:</span>
                <span className="font-mono text-[#18181B] bg-[#F8F6F3] px-2 py-0.5 rounded border border-[#ECE7E2]">
                  {selectedTenant.privacyProfile}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[#A8A29E]">Egress SLA Target:</span>
                <span className="font-mono font-semibold text-[#18181B]">
                  &lt; {selectedTenant.egressSlaTargetMs} ms
                </span>
              </div>
            </div>
          </div>

          {/* 4 KPI Metrics */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="card-base p-4">
              <div className="flex items-center justify-between text-xs text-[#78716C] mb-1">
                <span>CPU Utilization</span>
                <Cpu className="w-4 h-4 text-[#78716C]" />
              </div>
              <div className="text-2xl font-bold font-display text-[#18181B]">
                {selectedTenant.metrics.cpuUsagePct.toFixed(1)}%
              </div>
              <div className="w-full bg-[#F8F6F3] h-1.5 rounded-full overflow-hidden mt-2 border border-[#ECE7E2]">
                <div
                  className={`h-full rounded-full ${
                    selectedTenant.metrics.cpuUsagePct > 70 ? "bg-[#D47A7A]" : "bg-[#6B9E6B]"
                  }`}
                  style={{ width: `${Math.min(100, selectedTenant.metrics.cpuUsagePct)}%` }}
                />
              </div>
              <span className="text-[11px] text-[#78716C] font-mono mt-1.5 block">
                {selectedTenant.metrics.cpuCores} Allocated vCPUs
              </span>
            </div>

            <div className="card-base p-4">
              <div className="flex items-center justify-between text-xs text-[#78716C] mb-1">
                <span>Memory Allocation</span>
                <Activity className="w-4 h-4 text-[#78716C]" />
              </div>
              <div className="text-2xl font-bold font-display text-[#18181B]">
                {selectedTenant.metrics.memoryUsagePct.toFixed(1)}%
              </div>
              <div className="w-full bg-[#F8F6F3] h-1.5 rounded-full overflow-hidden mt-2 border border-[#ECE7E2]">
                <div
                  className={`h-full rounded-full ${
                    selectedTenant.metrics.memoryUsagePct > 75 ? "bg-[#D47A7A]" : "bg-[#7C3AED]"
                  }`}
                  style={{ width: `${Math.min(100, selectedTenant.metrics.memoryUsagePct)}%` }}
                />
              </div>
              <span className="text-[11px] text-[#78716C] font-mono mt-1.5 block">
                {selectedTenant.metrics.memoryUsedGb} GB / {selectedTenant.metrics.memoryTotalGb} GB
              </span>
            </div>

            <div className="card-base p-4">
              <div className="flex items-center justify-between text-xs text-[#78716C] mb-1">
                <span>Storage Buffer</span>
                <HardDrive className="w-4 h-4 text-[#78716C]" />
              </div>
              <div className="text-2xl font-bold font-display text-[#18181B]">
                {selectedTenant.metrics.diskUsagePct.toFixed(1)}%
              </div>
              <div className="w-full bg-[#F8F6F3] h-1.5 rounded-full overflow-hidden mt-2 border border-[#ECE7E2]">
                <div
                  className="h-full rounded-full bg-[#9A3412]"
                  style={{ width: `${Math.min(100, selectedTenant.metrics.diskUsagePct)}%` }}
                />
              </div>
              <span className="text-[11px] text-[#78716C] font-mono mt-1.5 block">
                {selectedTenant.metrics.diskUsedGb} GB / {selectedTenant.metrics.diskTotalGb} GB
              </span>
            </div>

            <div className="card-base p-4">
              <div className="flex items-center justify-between text-xs text-[#78716C] mb-1">
                <span>Network Throughput</span>
                <Network className="w-4 h-4 text-[#78716C]" />
              </div>
              <div className="text-2xl font-bold font-display text-[#18181B]">
                {selectedTenant.metrics.networkThroughputMbps.toFixed(1)} Mbps
              </div>
              <div className="w-full bg-[#F8F6F3] h-1.5 rounded-full overflow-hidden mt-2 border border-[#ECE7E2]">
                <div
                  className="h-full rounded-full bg-[#059669]"
                  style={{
                    width: `${Math.min(
                      100,
                      (selectedTenant.metrics.networkThroughputMbps / 300) * 100
                    )}%`,
                  }}
                />
              </div>
              <span className="text-[11px] text-[#78716C] font-mono mt-1.5 block">
                {selectedTenant.metrics.activeConnections.toLocaleString()} active sockets
              </span>
            </div>
          </div>

          {/* Service Health Matrix */}
          <div className="card-base p-5">
            <div className="flex items-center justify-between pb-3 border-b border-[#ECE7E2] mb-4">
              <div>
                <h3 className="font-display font-semibold text-base text-[#18181B]">
                  Dedicated Service Health &amp; Subsystem Matrix
                </h3>
                <p className="text-xs text-[#78716C] mt-0.5">
                  Tier-1 collector daemons, outbox storage queues, and pseudonymization scrubbers
                </p>
              </div>
              <span className="text-xs font-mono text-[#78716C]">
                {selectedTenant.services.length} Microservices
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {selectedTenant.services.map((svc, idx) => (
                <div
                  key={idx}
                  className="p-3.5 rounded-[8px] bg-[#F8F6F3] border border-[#ECE7E2] flex flex-col justify-between"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-semibold text-xs text-[#18181B]">
                      {svc.name}
                    </span>
                    <span
                      className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-semibold border ${
                        svc.status === "Healthy"
                          ? "bg-[#ECFDF5] text-[#059669] border-[#A7F3D0]"
                          : svc.status === "Degraded"
                          ? "bg-[#FEF3C7] text-[#D97706] border-[#FDE68A]"
                          : svc.status === "Failed"
                          ? "bg-[#FFF1F2] text-[#E11D48] border-[#FECDD3]"
                          : "bg-white text-[#78716C] border-[#ECE7E2]"
                      }`}
                    >
                      {svc.status}
                    </span>
                  </div>
                  <p className="text-xs text-[#78716C] mb-2 leading-relaxed">
                    {svc.details}
                  </p>
                  <div className="flex items-center justify-between text-[11px] font-mono text-[#A8A29E] pt-2 border-t border-[#ECE7E2]/70">
                    <span>Build: {svc.version}</span>
                    <span>Uptime: <strong className="text-[#18181B]">{svc.uptimePct}%</strong></span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Active Alerts */}
          <div className="card-base p-5">
            <div className="flex items-center justify-between pb-3 border-b border-[#ECE7E2] mb-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-[#E8B86D]" />
                <h3 className="font-display font-semibold text-sm text-[#18181B]">
                  Correlated Alerts for {selectedTenant.name}
                </h3>
              </div>
              <Link
                href="/alerts"
                className="text-xs font-mono text-[#78716C] hover:text-[#18181B] flex items-center gap-1"
              >
                <span>Full Alerts View</span>
                <ExternalLink className="w-3 h-3" />
              </Link>
            </div>

            {tenantAlerts.length === 0 ? (
              <div className="py-6 text-center text-xs text-[#78716C]">
                <CheckCircle className="w-5 h-5 text-[#6B9E6B] mx-auto mb-1.5" />
                <p className="font-medium text-[#18181B]">No active alerts for this tenant</p>
                <p className="text-[11px] text-[#A8A29E]">All telemetry signals within nominal drift bounds.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {tenantAlerts.map((alt) => (
                  <div
                    key={alt.id}
                    className="p-3 rounded-[6px] bg-[#F8F6F3] border border-[#ECE7E2] flex items-center justify-between gap-3 text-xs"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-[#18181B]">{alt.title}</span>
                        <span className="px-1.5 py-0.2 rounded font-mono text-[10px] bg-white border border-[#ECE7E2]">
                          {alt.affectedService}
                        </span>
                      </div>
                      <p className="text-[11px] text-[#78716C] mt-0.5">{alt.description}</p>
                    </div>
                    <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-white text-[#C53030] border border-[#FED7D7] font-bold shrink-0">
                      {alt.severity}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent Logs */}
          <div className="card-base p-5">
            <div className="flex items-center justify-between pb-3 border-b border-[#ECE7E2] mb-3">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-[#78716C]" />
                <h3 className="font-display font-semibold text-sm text-[#18181B]">
                  Recent Telemetry Events ({selectedTenant.name})
                </h3>
              </div>
              <Link
                href="/logs"
                className="text-xs font-mono text-[#78716C] hover:text-[#18181B] flex items-center gap-1"
              >
                <span>Full Log Stream</span>
                <ExternalLink className="w-3 h-3" />
              </Link>
            </div>

            <div className="space-y-2">
              {tenantLogs.map((log) => (
                <div
                  key={log.id}
                  className="p-2.5 rounded-[6px] bg-[#F8F6F3] border border-[#ECE7E2] flex items-center justify-between gap-3 text-xs font-mono"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${
                        log.severity === "CRITICAL"
                          ? "bg-[#FDE8E8] text-[#C53030]"
                          : log.severity === "ERROR"
                          ? "bg-[#FFF5F0] text-[#C2410C]"
                          : log.severity === "WARNING"
                          ? "bg-[#FEF9C3] text-[#A16207]"
                          : "bg-[#F0F9FF] text-[#0369A1]"
                      }`}
                    >
                      {log.severity}
                    </span>
                    <span className="text-[#18181B] truncate">{log.message}</span>
                  </div>
                  <span className="text-[10px] text-[#A8A29E] shrink-0">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        /* OVERVIEW TABLE */
        <div className="space-y-5">
          <div className="card-base p-3 flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="relative flex-1 min-w-[240px]">
              <Search className="w-4 h-4 text-[#A8A29E] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search tenants by name, ID, or region..."
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
                  Sort By:
                </span>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as any)}
                  className="input-base text-xs py-1.5 px-2.5 w-auto bg-white border-[#ECE7E2]"
                >
                  <option value="alerts">Active Alerts</option>
                  <option value="cpu">CPU Usage</option>
                  <option value="memory">Memory Usage</option>
                  <option value="name">Tenant Name</option>
                </select>
              </div>

              <button
                onClick={() =>
                  setSortDirection(sortDirection === "desc" ? "asc" : "desc")
                }
                className="btn-secondary text-xs py-1.5 px-2.5 flex items-center gap-1"
                title={`Sort: ${sortDirection === "desc" ? "High to Low" : "Low to High"}`}
              >
                <ArrowUpDown className="w-3 h-3 text-[#18181B]" />
                <span className="font-mono text-[11px]">
                  {sortDirection === "desc" ? "Desc" : "Asc"}
                </span>
              </button>
            </div>
          </div>

          <div className="card-base overflow-hidden border border-[#ECE7E2]">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-[#F8F6F3] border-b border-[#ECE7E2] text-[#78716C] font-mono">
                    <th className="py-3 px-4 font-medium whitespace-nowrap">Tenant Name &amp; ID</th>
                    <th className="py-3 px-3 font-medium whitespace-nowrap">Status</th>
                    <th className="py-3 px-3 font-medium whitespace-nowrap">CPU Usage</th>
                    <th className="py-3 px-3 font-medium whitespace-nowrap">Memory Usage</th>
                    <th className="py-3 px-3 font-medium whitespace-nowrap">Active Alerts</th>
                    <th className="py-3 px-3 font-medium whitespace-nowrap">Last Activity</th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#ECE7E2]">
                  {filteredTenants.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-12 text-center text-[#78716C]">
                        <Building2 className="w-6 h-6 text-[#A8A29E] mx-auto mb-2" />
                        <p className="text-sm font-medium text-[#18181B]">No tenants found</p>
                        <p className="text-xs text-[#78716C] mt-0.5">
                          Try adjusting your search query or status filter.
                        </p>
                      </td>
                    </tr>
                  ) : (
                    filteredTenants.map((t) => {
                      const isActiveSession = activeSessionTenant === t.id;
                      return (
                        <tr
                          key={t.id}
                          onClick={() => setSelectedTenantId(t.id)}
                          className="hover:bg-[#F8F6F3] cursor-pointer transition-colors duration-100"
                        >
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-2.5">
                              <div className="w-8 h-8 rounded-[6px] gradient-blush-sand flex items-center justify-center shrink-0 border border-[#ECE7E2]">
                                <Building2 className="w-4 h-4 text-[#18181B]" />
                              </div>
                              <div>
                                <div className="flex items-center gap-1.5">
                                  <span className="font-display font-semibold text-xs text-[#18181B]">
                                    {t.name}
                                  </span>
                                  {isActiveSession && (
                                    <span className="w-1.5 h-1.5 rounded-full bg-[#6B9E6B]" title="Active Session Tenant" />
                                  )}
                                </div>
                                <span className="font-mono text-[11px] text-[#78716C] block">
                                  {t.id}
                                </span>
                              </div>
                            </div>
                          </td>

                          <td className="py-3 px-3 whitespace-nowrap">
                            {getStatusBadge(t.status)}
                          </td>

                          <td className="py-3 px-3 whitespace-nowrap">
                            <div className="w-32">
                              <div className="flex justify-between text-[11px] font-mono mb-1">
                                <span className="font-semibold text-[#18181B]">{t.metrics.cpuUsagePct}%</span>
                                <span className="text-[#A8A29E]">{t.metrics.cpuCores}c</span>
                              </div>
                              <div className="w-full bg-[#F8F6F3] h-1.5 rounded-full overflow-hidden border border-[#ECE7E2]">
                                <div
                                  className={`h-full rounded-full ${
                                    t.metrics.cpuUsagePct > 70 ? "bg-[#D47A7A]" : "bg-[#6B9E6B]"
                                  }`}
                                  style={{ width: `${Math.min(100, t.metrics.cpuUsagePct)}%` }}
                                />
                              </div>
                            </div>
                          </td>

                          <td className="py-3 px-3 whitespace-nowrap">
                            <div className="w-32">
                              <div className="flex justify-between text-[11px] font-mono mb-1">
                                <span className="font-semibold text-[#18181B]">{t.metrics.memoryUsagePct}%</span>
                                <span className="text-[#A8A29E]">{t.metrics.memoryUsedGb}G</span>
                              </div>
                              <div className="w-full bg-[#F8F6F3] h-1.5 rounded-full overflow-hidden border border-[#ECE7E2]">
                                <div
                                  className={`h-full rounded-full ${
                                    t.metrics.memoryUsagePct > 75 ? "bg-[#D47A7A]" : "bg-[#7C3AED]"
                                  }`}
                                  style={{ width: `${Math.min(100, t.metrics.memoryUsagePct)}%` }}
                                />
                              </div>
                            </div>
                          </td>

                          <td className="py-3 px-3 whitespace-nowrap">
                            {t.activeAlertsCount > 0 ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] font-bold bg-[#FFF1F2] text-[#E11D48] border border-[#FECDD3]">
                                <AlertTriangle className="w-3 h-3 text-[#E11D48]" />
                                {t.activeAlertsCount} Active
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] font-medium bg-[#ECFDF5] text-[#059669]">
                                <Check className="w-3 h-3 text-[#059669]" />
                                0 Alerts
                              </span>
                            )}
                          </td>

                          <td className="py-3 px-3 whitespace-nowrap font-mono text-[11px] text-[#78716C]">
                            {t.lastActivity}
                          </td>

                          <td className="py-3 px-4 whitespace-nowrap text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedTenantId(t.id);
                                }}
                                className="btn-secondary text-[11px] py-1 px-2.5 font-medium flex items-center gap-1"
                              >
                                <span>Details</span>
                                <ChevronRight className="w-3 h-3 text-[#78716C]" />
                              </button>
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
              <span>Showing {filteredTenants.length} enterprise tenants</span>
              <span className="text-[11px]">Click any row to open comprehensive tenant telemetry console</span>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
