export type TenantStatus = "Healthy" | "Warning" | "Critical" | "Offline";

export interface TenantServiceHealth {
  name: string;
  status: "Healthy" | "Degraded" | "Failed" | "Standby";
  version: string;
  uptimePct: number;
  details: string;
}

export interface TenantMetrics {
  cpuUsagePct: number;
  cpuCores: number;
  memoryUsagePct: number;
  memoryUsedGb: number;
  memoryTotalGb: number;
  diskUsagePct: number;
  diskUsedGb: number;
  diskTotalGb: number;
  networkThroughputMbps: number;
  activeConnections: number;
}

export interface TenantRecord {
  id: string;
  name: string;
  region: string;
  status: TenantStatus;
  metrics: TenantMetrics;
  activeAlertsCount: number;
  lastActivity: string;
  lastActivityMs: number;
  connectedNodes: number;
  complianceTier: string;
  privacyProfile: string;
  egressSlaTargetMs: number;
  services: TenantServiceHealth[];
}

export function getInitialTenants(nowMs: number = Date.now()): TenantRecord[] {
  const m = (minutesAgo: number) => nowMs - minutesAgo * 60 * 1000;

  return [
    {
      id: "tenant_acme_corp",
      name: "Acme Corp",
      region: "ap-south-1 (Mumbai)",
      status: "Warning",
      metrics: {
        cpuUsagePct: 42.8,
        cpuCores: 16,
        memoryUsagePct: 64.2,
        memoryUsedGb: 24.6,
        memoryTotalGb: 38.4,
        diskUsagePct: 58.9,
        diskUsedGb: 1130,
        diskTotalGb: 1920,
        networkThroughputMbps: 118.4,
        activeConnections: 4820,
      },
      activeAlertsCount: 2,
      lastActivity: "Just now",
      lastActivityMs: m(0.5),
      connectedNodes: 12,
      complianceTier: "ISO 27001 / SOC 2 Type II",
      privacyProfile: "Full LDP (ε=0.5, δ=1e-5)",
      egressSlaTargetMs: 200,
      services: [
        {
          name: "Edge Telemetry Collector",
          status: "Healthy",
          version: "v1.4.2",
          uptimePct: 99.98,
          details: "12/12 collectors emitting via durable WAL buffer",
        },
        {
          name: "SQLite WAL Outbox Queue",
          status: "Degraded",
          version: "v2.1.0",
          uptimePct: 98.40,
          details: "Outbox capacity at 92.4%; backpressure throttling",
        },
        {
          name: "Egress Secret Scrubber",
          status: "Healthy",
          version: "v1.2.0",
          uptimePct: 100.0,
          details: "Pseudonymization active; 14 tokens masked with salt hash",
        },
        {
          name: "AIOps Inference Engine",
          status: "Healthy",
          version: "v3.0.1",
          uptimePct: 99.95,
          details: "Multivariate Gaussian Covariance model evaluating 6 signals",
        },
      ],
    },
    {
      id: "tenant_fintech_labs",
      name: "FinTech Labs Global",
      region: "us-east-1 (N. Virginia)",
      status: "Critical",
      metrics: {
        cpuUsagePct: 78.4,
        cpuCores: 32,
        memoryUsagePct: 81.6,
        memoryUsedGb: 52.2,
        memoryTotalGb: 64.0,
        diskUsagePct: 72.1,
        diskUsedGb: 2884,
        diskTotalGb: 4000,
        networkThroughputMbps: 246.0,
        activeConnections: 12400,
      },
      activeAlertsCount: 2,
      lastActivity: "1m ago",
      lastActivityMs: m(1),
      connectedNodes: 18,
      complianceTier: "PCI-DSS v4.0 / SOC 2",
      privacyProfile: "Deterministic Pseudonymization + Strict Masking",
      egressSlaTargetMs: 150,
      services: [
        {
          name: "Edge Telemetry Collector",
          status: "Healthy",
          version: "v1.4.2",
          uptimePct: 99.92,
          details: "18/18 nodes online across 3 availability zones",
        },
        {
          name: "AIOps Inference Engine",
          status: "Failed",
          version: "v3.0.1",
          uptimePct: 94.10,
          details: "p95 API latency spike (+3.84σ drift) exceeding SLA limit",
        },
        {
          name: "Transaction Anomaly Detector",
          status: "Degraded",
          version: "v2.0.4",
          uptimePct: 97.50,
          details: "Circuit breaker OPEN on transaction-settler endpoint",
        },
        {
          name: "Egress Secret Scrubber",
          status: "Healthy",
          version: "v1.2.0",
          uptimePct: 100.0,
          details: "Zero PII leaks detected; 100% schema allow-list validation",
        },
      ],
    },
    {
      id: "tenant_globex_ind",
      name: "Globex Industries",
      region: "eu-central-1 (Frankfurt)",
      status: "Healthy",
      metrics: {
        cpuUsagePct: 24.1,
        cpuCores: 8,
        memoryUsagePct: 41.5,
        memoryUsedGb: 13.2,
        memoryTotalGb: 32.0,
        diskUsagePct: 38.0,
        diskUsedGb: 380,
        diskTotalGb: 1000,
        networkThroughputMbps: 45.2,
        activeConnections: 1840,
      },
      activeAlertsCount: 0,
      lastActivity: "3m ago",
      lastActivityMs: m(3),
      connectedNodes: 8,
      complianceTier: "GDPR Compliant / BSI C5",
      privacyProfile: "Full LDP (ε=0.3, δ=1e-6) + Hardware Enclave",
      egressSlaTargetMs: 250,
      services: [
        {
          name: "Edge Telemetry Collector",
          status: "Healthy",
          version: "v1.4.2",
          uptimePct: 100.0,
          details: "All 8 factory telemetry gateways emitting normally",
        },
        {
          name: "SQLite WAL Outbox Queue",
          status: "Healthy",
          version: "v2.1.0",
          uptimePct: 100.0,
          details: "Outbox capacity at 18.2%; zero dropped records",
        },
        {
          name: "Egress Secret Scrubber",
          status: "Healthy",
          version: "v1.2.0",
          uptimePct: 100.0,
          details: "GDPR privacy rules compliant; EU sovereignty verified",
        },
        {
          name: "AIOps Inference Engine",
          status: "Healthy",
          version: "v3.0.1",
          uptimePct: 99.99,
          details: "Z-score drift baseline within normal bounds (mean +0.12σ)",
        },
      ],
    },
    {
      id: "tenant_retail_mesh",
      name: "Retail Mesh Global",
      region: "us-west-2 (Oregon)",
      status: "Warning",
      metrics: {
        cpuUsagePct: 56.2,
        cpuCores: 24,
        memoryUsagePct: 52.0,
        memoryUsedGb: 25.0,
        memoryTotalGb: 48.0,
        diskUsagePct: 61.4,
        diskUsedGb: 1842,
        diskTotalGb: 3000,
        networkThroughputMbps: 184.8,
        activeConnections: 9200,
      },
      activeAlertsCount: 1,
      lastActivity: "Just now",
      lastActivityMs: m(0.8),
      connectedNodes: 14,
      complianceTier: "PCI-DSS / SOC 1 Type II",
      privacyProfile: "Differential Privacy with Leaky Token Rate Limiting",
      egressSlaTargetMs: 200,
      services: [
        {
          name: "Edge Telemetry Collector",
          status: "Healthy",
          version: "v1.4.2",
          uptimePct: 99.85,
          details: "14 store mesh collectors active; 2 rotating TLS certs",
        },
        {
          name: "Tenant Rate Limiter",
          status: "Degraded",
          version: "v1.1.4",
          uptimePct: 98.90,
          details: "Burst traffic throttled (1,420 req/s > 1,000 quota limit)",
        },
        {
          name: "Egress Secret Scrubber",
          status: "Healthy",
          version: "v1.2.0",
          uptimePct: 100.0,
          details: "Cardholder data patterns masked; zero unmasked PANs",
        },
        {
          name: "AIOps Inference Engine",
          status: "Healthy",
          version: "v3.0.1",
          uptimePct: 99.90,
          details: "Z-score anomaly rate 1.95σ; automated scaling queued",
        },
      ],
    },
    {
      id: "tenant_health_net",
      name: "HealthNet Systems",
      region: "us-east-2 (Ohio)",
      status: "Healthy",
      metrics: {
        cpuUsagePct: 31.5,
        cpuCores: 16,
        memoryUsagePct: 48.2,
        memoryUsedGb: 15.4,
        memoryTotalGb: 32.0,
        diskUsagePct: 44.8,
        diskUsedGb: 896,
        diskTotalGb: 2000,
        networkThroughputMbps: 68.0,
        activeConnections: 3100,
      },
      activeAlertsCount: 0,
      lastActivity: "6m ago",
      lastActivityMs: m(6),
      connectedNodes: 10,
      complianceTier: "HIPAA Security Rule / HITECH",
      privacyProfile: "Zero-Knowledge Enclave + Strict De-identification",
      egressSlaTargetMs: 200,
      services: [
        {
          name: "Edge Telemetry Collector",
          status: "Healthy",
          version: "v1.4.2",
          uptimePct: 100.0,
          details: "10 hospital cluster gateways reporting with MTLS v1.3",
        },
        {
          name: "Egress Secret Scrubber",
          status: "Healthy",
          version: "v1.2.0",
          uptimePct: 100.0,
          details: "HIPAA Safe Harbor 18-element identifier stripper verified",
        },
        {
          name: "SQLite WAL Outbox Queue",
          status: "Healthy",
          version: "v2.1.0",
          uptimePct: 100.0,
          details: "Outbox capacity at 24.5%; synchronous journal enabled",
        },
        {
          name: "AIOps Inference Engine",
          status: "Healthy",
          version: "v3.0.1",
          uptimePct: 100.0,
          details: "Zero drift incidents; SLA compliance 99.99%",
        },
      ],
    },
    {
      id: "tenant_demo",
      name: "Demo Sandbox Tenant",
      region: "us-west-1 (N. California)",
      status: "Offline",
      metrics: {
        cpuUsagePct: 0.0,
        cpuCores: 4,
        memoryUsagePct: 0.0,
        memoryUsedGb: 0.0,
        memoryTotalGb: 16.0,
        diskUsagePct: 12.0,
        diskUsedGb: 60,
        diskTotalGb: 500,
        networkThroughputMbps: 0.0,
        activeConnections: 0,
      },
      activeAlertsCount: 0,
      lastActivity: "2h ago",
      lastActivityMs: m(120),
      connectedNodes: 0,
      complianceTier: "Sandbox / Developer Preview",
      privacyProfile: "Deterministic Test Fallback",
      egressSlaTargetMs: 500,
      services: [
        {
          name: "Edge Telemetry Collector",
          status: "Standby",
          version: "v1.4.2",
          uptimePct: 0.0,
          details: "Collector daemon paused in sandbox sleep mode",
        },
        {
          name: "SQLite WAL Outbox Queue",
          status: "Standby",
          version: "v2.1.0",
          uptimePct: 0.0,
          details: "Durable WAL queue empty and unmounted",
        },
      ],
    },
  ];
}
