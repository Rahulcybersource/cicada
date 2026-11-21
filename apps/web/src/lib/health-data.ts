export type SystemStatus = "Healthy" | "Degraded" | "Critical";
export type ServiceHealthStatus = "Healthy" | "Warning" | "Critical" | "Offline";
export type IncidentSeverity = "Critical" | "High" | "Medium" | "Low";
export type IncidentStatus = "Active" | "Investigating" | "Mitigated" | "Resolved";

export interface SystemOverview {
  overallStatus: SystemStatus;
  totalServices: number;
  healthyServices: number;
  unhealthyServices: number;
  activeIncidents: number;
  avgUptimePct: number;
  avgResponseTimeMs: number;
}

export interface SystemService {
  id: string;
  name: string;
  tier: "Tier 1: Edge Collector" | "Tier 2: Control Plane" | "Tier 3: Observability" | "Infra & Storage";
  status: ServiceHealthStatus;
  cpuUsagePct: number;
  memoryUsagePct: number;
  responseTimeMs: number;
  lastHeartbeat: string;
  lastHeartbeatMs: number;
  uptimePct: number;
  version: string;
  instances: number;
  endpoint: string;
  description: string;
  dependencies: string[];
  recentEvents: string[];
}

export interface IncidentRecord {
  id: string;
  title: string;
  severity: IncidentSeverity;
  affectedService: string;
  startTime: string;
  startTimeMs: number;
  status: IncidentStatus;
  summary: string;
  leadResponder?: string;
}

export function getSystemHealthData(nowMs: number = Date.now()) {
  const m = (minutesAgo: number) => nowMs - minutesAgo * 60 * 1000;
  const iso = (ms: number) => new Date(ms).toISOString();

  const services: SystemService[] = [
    {
      id: "svc_edge_collector",
      name: "Tier 1 Edge Collector Daemon",
      tier: "Tier 1: Edge Collector",
      status: "Healthy",
      cpuUsagePct: 14.2,
      memoryUsagePct: 22.4,
      responseTimeMs: 4,
      lastHeartbeat: "1s ago",
      lastHeartbeatMs: m(0.02),
      uptimePct: 99.99,
      version: "v1.4.2",
      instances: 12,
      endpoint: "http://localhost:8001/local/telemetry",
      description: "Low-overhead host telemetry collector scraping procfs, cgroups, and network interfaces with zero external network dependencies.",
      dependencies: ["SQLite WAL Outbox Queue", "Egress Secret Scrubber"],
      recentEvents: [
        "Collector thread pool healthy; 12/12 workers responding",
        "Scrape cycle completed in 2.8ms across 48 virtual cores",
      ],
    },
    {
      id: "svc_wal_outbox",
      name: "SQLite WAL Durable Outbox Buffer",
      tier: "Tier 1: Edge Collector",
      status: "Warning",
      cpuUsagePct: 38.6,
      memoryUsagePct: 64.2,
      responseTimeMs: 48,
      lastHeartbeat: "3s ago",
      lastHeartbeatMs: m(0.05),
      uptimePct: 98.40,
      version: "v2.1.0",
      instances: 4,
      endpoint: "http://localhost:8001/local/outbox/stats",
      description: "Crash-resilient local WAL storage queue with exponential backoff delivery. Currently operating at 92.4% buffer watermark due to egress socket backpressure.",
      dependencies: ["Tier 2 Telemetry Ingestion Hub"],
      recentEvents: [
        "Backpressure warning: queue watermark exceeded 90% (48.9 MB / 52.4 MB)",
        "Outbox batch retry attempt #3 scheduled with 4000ms delay",
      ],
    },
    {
      id: "svc_secret_scrubber",
      name: "Egress Secret Scrubber & Privacy Enclave",
      tier: "Tier 1: Edge Collector",
      status: "Healthy",
      cpuUsagePct: 18.5,
      memoryUsagePct: 31.0,
      responseTimeMs: 6,
      lastHeartbeat: "2s ago",
      lastHeartbeatMs: m(0.03),
      uptimePct: 100.0,
      version: "v1.2.0",
      instances: 4,
      endpoint: "http://localhost:8001/local/scrubber",
      description: "Fast in-memory regex secret masking and Local Differential Privacy (LDP) Laplace noise generator. Intercepts Bearer tokens, private keys, and passwords.",
      dependencies: ["Tier 1 Edge Collector Daemon"],
      recentEvents: [
        "Zero unredacted PII or secrets emitted in trailing 24 hours",
        "Salt hash rotation completed successfully (version salt_v2_active)",
      ],
    },
    {
      id: "svc_ingestion_hub",
      name: "Tier 2 Telemetry Ingestion Hub",
      tier: "Tier 2: Control Plane",
      status: "Healthy",
      cpuUsagePct: 42.1,
      memoryUsagePct: 55.8,
      responseTimeMs: 12,
      lastHeartbeat: "1s ago",
      lastHeartbeatMs: m(0.02),
      uptimePct: 99.95,
      version: "v2.8.4",
      instances: 6,
      endpoint: "http://localhost:8000/api/v1/telemetry",
      description: "High-throughput asynchronous ingest receiver for Tier 1 collector bundles. Enforces tenant rate quotas, schema allow-lists, and distributed WAL persistence.",
      dependencies: ["Durable Storage & Timescale Partition Pool", "AIOps Inference Engine"],
      recentEvents: [
        "Synchronized 4,820 eps with zero rejected schema violations",
        "HTTP/2 multiplexed streams active: 84 concurrent connections",
      ],
    },
    {
      id: "svc_aiops_engine",
      name: "AIOps Inference Engine (Z-Score & LLM)",
      tier: "Tier 2: Control Plane",
      status: "Critical",
      cpuUsagePct: 78.4,
      memoryUsagePct: 82.0,
      responseTimeMs: 385,
      lastHeartbeat: "4s ago",
      lastHeartbeatMs: m(0.06),
      uptimePct: 94.10,
      version: "v3.0.1",
      instances: 3,
      endpoint: "http://localhost:8000/api/v1/incidents",
      description: "Continuous multivariate Gaussian covariance anomaly detector coupled with Groq Llama-3-70b explainable RCA synthesizer. p95 response time spike active.",
      dependencies: ["Tier 2 Telemetry Ingestion Hub", "Durable Storage & Timescale Partition Pool"],
      recentEvents: [
        "Multivariate Z-Score drift +3.84σ triggered on signal api_p95_latency",
        "LLM explanation generated: Postgres lock contention in availability zone az-2",
      ],
    },
    {
      id: "svc_tenant_router",
      name: "Multi-Tenant Partition Manager",
      tier: "Tier 2: Control Plane",
      status: "Healthy",
      cpuUsagePct: 16.0,
      memoryUsagePct: 34.5,
      responseTimeMs: 8,
      lastHeartbeat: "2s ago",
      lastHeartbeatMs: m(0.03),
      uptimePct: 99.98,
      version: "v1.6.0",
      instances: 4,
      endpoint: "http://localhost:8000/api/v1/tenants",
      description: "Cryptographic tenant isolation manager ensuring zero cross-tenant memory or storage leakage. Validates tenant JWT boundaries and resource quotas.",
      dependencies: ["Durable Storage & Timescale Partition Pool"],
      recentEvents: [
        "Tenant boundary audit clean; 6 enterprise tenants isolated",
        "Rate limit bucket replenishment cycle executed within SLA",
      ],
    },
    {
      id: "svc_sse_broker",
      name: "SSE Real-Time Event Stream Broker",
      tier: "Tier 3: Observability",
      status: "Healthy",
      cpuUsagePct: 21.4,
      memoryUsagePct: 38.2,
      responseTimeMs: 14,
      lastHeartbeat: "1s ago",
      lastHeartbeatMs: m(0.01),
      uptimePct: 99.96,
      version: "v2.0.2",
      instances: 4,
      endpoint: "http://localhost:8000/api/v1/stream",
      description: "Low-latency Server-Sent Events (SSE) pub/sub pipeline dispatching live multivariate telemetry curves and incident notifications to frontend clients.",
      dependencies: ["Tier 2 Telemetry Ingestion Hub"],
      recentEvents: [
        "12 client browser sessions connected via persistent SSE channel",
        "Ping heartbeat broadcast interval: 15 seconds",
      ],
    },
    {
      id: "svc_timescale_db",
      name: "Durable Storage & Timescale Partition Pool",
      tier: "Infra & Storage",
      status: "Healthy",
      cpuUsagePct: 29.2,
      memoryUsagePct: 48.0,
      responseTimeMs: 18,
      lastHeartbeat: "2s ago",
      lastHeartbeatMs: m(0.03),
      uptimePct: 99.99,
      version: "PostgreSQL 16 + TimescaleDB 2.14",
      instances: 3,
      endpoint: "postgres://db.cluster.internal:5432/cicada_telemetry",
      description: "Distributed relational storage engine with automated hypertable chunk compression, retention policies, and read-replica failover.",
      dependencies: [],
      recentEvents: [
        "Automated chunk compression reclaimed 1.4 GB historical telemetry",
        "WAL archiving latency 120ms; standby replication synchronous",
      ],
    },
  ];

  const incidents: IncidentRecord[] = [
    {
      id: "INC-801",
      title: "Elevated p95 API Latency (+3.84σ Multivariate Drift)",
      severity: "Critical",
      affectedService: "AIOps Inference Engine (Z-Score & LLM)",
      startTime: iso(m(8)),
      startTimeMs: m(8),
      status: "Active",
      summary: "Database connection pool lock contention in availability zone az-2 causing tail request latency to exceed 200ms SLA target.",
      leadResponder: "secops-oncall",
    },
    {
      id: "INC-802",
      title: "SQLite WAL Outbox Buffer Watermark (>90%)",
      severity: "High",
      affectedService: "SQLite WAL Durable Outbox Buffer",
      startTime: iso(m(25)),
      startTimeMs: m(25),
      status: "Investigating",
      summary: "Egress socket backpressure on Tier 1 host-collector-01 stalled delivery; buffer storage reached 92.4% watermark.",
      leadResponder: "sre-cluster-admin",
    },
    {
      id: "INC-803",
      title: "Client Request Velocity Throttled (1,420 req/s > Quota)",
      severity: "Medium",
      affectedService: "Tier 2 Telemetry Ingestion Hub",
      startTime: iso(m(55)),
      startTimeMs: m(55),
      status: "Mitigated",
      summary: "Retail client application burst exceeded tenant contract quota; token bucket algorithm issued 429 backoff headers.",
      leadResponder: "tenant-ops",
    },
    {
      id: "INC-804",
      title: "Automated Edge Collector TLS Certificate Rotation",
      severity: "Low",
      affectedService: "Tier 1 Edge Collector Daemon",
      startTime: iso(m(180)),
      startTimeMs: m(180),
      status: "Resolved",
      summary: "Cert-manager successfully rotated expiring intermediary CA certificates across 14 edge telemetry hosts.",
      leadResponder: "cert-manager-bot",
    },
  ];

  // System Overview calculations
  const totalServices = services.length;
  const healthyServices = services.filter((s) => s.status === "Healthy").length;
  const unhealthyServices = services.filter(
    (s) => s.status === "Warning" || s.status === "Critical" || s.status === "Offline"
  ).length;
  const activeIncidents = incidents.filter(
    (i) => i.status === "Active" || i.status === "Investigating"
  ).length;

  const avgUptimePct = Number(
    (services.reduce((acc, s) => acc + s.uptimePct, 0) / totalServices).toFixed(2)
  );
  const avgResponseTimeMs = Math.round(
    services.reduce((acc, s) => acc + s.responseTimeMs, 0) / totalServices
  );

  const overallStatus: SystemStatus =
    services.some((s) => s.status === "Critical")
      ? "Critical"
      : services.some((s) => s.status === "Warning")
      ? "Degraded"
      : "Healthy";

  const overview: SystemOverview = {
    overallStatus,
    totalServices,
    healthyServices,
    unhealthyServices,
    activeIncidents,
    avgUptimePct,
    avgResponseTimeMs,
  };

  return {
    overview,
    services,
    incidents,
  };
}
