export type LogLevel = "INFO" | "WARNING" | "ERROR" | "CRITICAL";

export interface LogEntry {
  id: string;
  timestamp: string;
  timestampMs: number;
  severity: LogLevel;
  service: string;
  tenant: string;
  source: string;
  message: string;
  traceId?: string;
  spanId?: string;
  metadata?: Record<string, any>;
  rawPayload?: string;
}

export type AlertSeverity = "Critical" | "High" | "Medium" | "Low";
export type AlertStatus = "Active" | "Acknowledged" | "Resolved";

export interface AlertItem {
  id: string;
  title: string;
  severity: AlertSeverity;
  affectedService: string;
  tenant: string;
  timestamp: string;
  timestampMs: number;
  status: AlertStatus;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  description: string;
  zScore?: number;
  driftMetric?: string;
  recommendedRemediation?: string;
  affectedNodes?: string[];
  aiConfidence?: number;
}

// Generate realistic simulated log entries
export function generateInitialLogs(baseTimeMs: number = Date.now()): LogEntry[] {
  const m = (minutesAgo: number) => baseTimeMs - minutesAgo * 60 * 1000;
  const iso = (ms: number) => new Date(ms).toISOString();

  return [
    {
      id: "log_901",
      timestamp: iso(m(1)),
      timestampMs: m(1),
      severity: "CRITICAL",
      service: "wal-outbox",
      tenant: "tenant_acme_corp",
      source: "host-collector-01",
      message: "SQLite WAL outbox buffer reached 92% capacity threshold; batch flushing stalled due to egress socket backpressure",
      traceId: "trc_9a8b7c6d5e4f3a21",
      spanId: "spn_wal_flush_01",
      metadata: {
        buffer_bytes_used: 48921400,
        buffer_capacity_bytes: 52428800,
        wal_mode: "PERSIST",
        dropped_batches: 0,
        retry_count: 5,
      },
      rawPayload: JSON.stringify(
        {
          event: "WAL_BUFFER_SATURATION",
          buffer_pct: 92.4,
          file: "/var/lib/cicada/outbox.db-wal",
          active_locks: 3,
          backpressure_wait_ms: 2450,
        },
        null,
        2
      ),
    },
    {
      id: "log_902",
      timestamp: iso(m(3)),
      timestampMs: m(3),
      severity: "ERROR",
      service: "aiops-engine",
      tenant: "tenant_fintech_labs",
      source: "pod-worker-az2",
      message: "Multivariate Z-Score drift +3.84σ detected on telemetry signal 'api_p95_latency' exceeding SLA limit (200ms)",
      traceId: "trc_1b2c3d4e5f6a7b8c",
      spanId: "spn_zscore_eval",
      metadata: {
        metric: "api_p95_latency",
        observed_value_ms: 385,
        baseline_mean_ms: 32.4,
        z_score: 3.84,
        anomaly_window: "600s",
      },
      rawPayload: JSON.stringify(
        {
          algorithm: "Multivariate Gaussian Covariance Drift",
          evaluated_signals: ["cpu", "memory", "latency", "net_in"],
          confidence: 0.94,
          outlier_indices: [24, 25, 26],
        },
        null,
        2
      ),
    },
    {
      id: "log_903",
      timestamp: iso(m(5)),
      timestampMs: m(5),
      severity: "WARNING",
      service: "egress-scrubber",
      tenant: "tenant_acme_corp",
      source: "host-collector-01",
      message: "Pseudonymization filter intercepted 14 unredacted Bearer tokens matching pattern /Bearer\\s+[A-Za-z0-9-_]+/; SHA-256 mask applied",
      traceId: "trc_3c4d5e6f7a8b9c0d",
      spanId: "spn_scrub_regex",
      metadata: {
        filter_rule: "SECRET_PATTERN_BEARER_AUTH",
        redaction_target: "Authorization",
        sanitized_count: 14,
        hash_salt_id: "salt_v2_active",
      },
      rawPayload: JSON.stringify(
        {
          component: "regex_scrubber",
          rules_evaluated: 28,
          matches: 14,
          action: "REPLACE_WITH_PSEUDONYM_HASH",
        },
        null,
        2
      ),
    },
    {
      id: "log_904",
      timestamp: iso(m(7)),
      timestampMs: m(7),
      severity: "INFO",
      service: "telemetry-pipeline",
      tenant: "tenant_retail_mesh",
      source: "edge-gateway-eu",
      message: "Successfully synchronized 1,240 metric samples with Tier-2 ingestion buffer under Differential Privacy noise ε=0.5",
      traceId: "trc_5e6f7a8b9c0d1e2f",
      spanId: "spn_batch_sync",
      metadata: {
        batch_id: "batch_20261121_0921",
        record_count: 1240,
        dp_epsilon: 0.5,
        compression_ratio: "0.28x",
      },
      rawPayload: JSON.stringify(
        {
          status: "SUCCESS",
          ingest_time_ms: 142,
          egress_ip: "10.0.12.44",
          protocol: "HTTP/2 + TLS1.3",
        },
        null,
        2
      ),
    },
    {
      id: "log_905",
      timestamp: iso(m(11)),
      timestampMs: m(11),
      severity: "ERROR",
      service: "auth-gateway",
      tenant: "tenant_acme_corp",
      source: "k8s-node-04",
      message: "JWT signature validation failure on endpoint /api/v1/telemetry: KeyID 'rsa_2025_exp' expired or revoked",
      traceId: "trc_7a8b9c0d1e2f3a4b",
      spanId: "spn_jwt_verify",
      metadata: {
        caller_ip: "192.168.1.108",
        token_kid: "rsa_2025_exp",
        error_code: "TOKEN_EXPIRED",
      },
      rawPayload: JSON.stringify(
        {
          auth_type: "Bearer",
          kid: "rsa_2025_exp",
          exp: 1763683200,
          now: 1763708890,
          status: 401,
        },
        null,
        2
      ),
    },
    {
      id: "log_906",
      timestamp: iso(m(15)),
      timestampMs: m(15),
      severity: "CRITICAL",
      service: "anomaly-detector",
      tenant: "tenant_fintech_labs",
      source: "pod-worker-az2",
      message: "Cascading microservice failure probability 87.2%: dependent service 'transaction-settler' unresponsive for > 4500ms",
      traceId: "trc_8b9c0d1e2f3a4b5c",
      spanId: "spn_cascade_check",
      metadata: {
        unresponsive_service: "transaction-settler",
        timeout_threshold_ms: 4500,
        impact_level: "P1",
      },
      rawPayload: JSON.stringify(
        {
          blast_radius: ["order-router", "account-validator", "reporting-sink"],
          circuit_breaker: "OPEN",
          failed_attempts: 12,
        },
        null,
        2
      ),
    },
    {
      id: "log_907",
      timestamp: iso(m(22)),
      timestampMs: m(22),
      severity: "WARNING",
      service: "tenant-router",
      tenant: "tenant_retail_mesh",
      source: "edge-gateway-eu",
      message: "Rate limit throttling applied to client ID 'retail-mobile-app': current request velocity 1,420 req/s exceeds quota (1,000 req/s)",
      traceId: "trc_9c0d1e2f3a4b5c6d",
      spanId: "spn_ratelimit_bucket",
      metadata: {
        client_id: "retail-mobile-app",
        current_rate_rps: 1420,
        quota_rps: 1000,
        throttle_window_s: 60,
      },
      rawPayload: JSON.stringify(
        {
          algorithm: "Token Bucket Leaky Rate",
          tokens_remaining: 0,
          retry_after_seconds: 14,
        },
        null,
        2
      ),
    },
    {
      id: "log_908",
      timestamp: iso(m(35)),
      timestampMs: m(35),
      severity: "INFO",
      service: "egress-scrubber",
      tenant: "tenant_acme_corp",
      source: "host-collector-01",
      message: "Outbound schema allow-list validation passed 100% of 450 emitted events against schema 'cicada.telemetry.v1alpha'",
      traceId: "trc_0d1e2f3a4b5c6d7e",
      spanId: "spn_schema_check",
      metadata: {
        schema_version: "v1alpha",
        records_validated: 450,
        rejected_fields: 0,
      },
      rawPayload: JSON.stringify(
        {
          schema_id: "cicada.telemetry.v1alpha",
          validation_engine: "FastSchemaValidator",
          elapsed_us: 380,
        },
        null,
        2
      ),
    },
    {
      id: "log_909",
      timestamp: iso(m(45)),
      timestampMs: m(45),
      severity: "INFO",
      service: "aiops-engine",
      tenant: "system_internal",
      source: "k8s-node-04",
      message: "Periodic LLM root cause analysis inference complete; Groq Llama-3-70b latency 412ms, cache hit ratio 78.4%",
      traceId: "trc_1e2f3a4b5c6d7e8f",
      spanId: "spn_llm_rca",
      metadata: {
        model: "groq/llama-3-70b-versatile",
        latency_ms: 412,
        tokens_prompt: 1840,
        tokens_completion: 210,
      },
      rawPayload: JSON.stringify(
        {
          provider: "Groq Cloud API",
          temperature: 0.1,
          finish_reason: "stop",
        },
        null,
        2
      ),
    },
    {
      id: "log_910",
      timestamp: iso(m(60)),
      timestampMs: m(60),
      severity: "WARNING",
      service: "wal-outbox",
      tenant: "tenant_acme_corp",
      source: "host-collector-01",
      message: "Exponential backoff retry attempt #3 triggered for egress payload uuid: 8f24b01c-6d91-4d92-bb8a-129481928341",
      traceId: "trc_2f3a4b5c6d7e8f9a",
      spanId: "spn_outbox_retry",
      metadata: {
        payload_uuid: "8f24b01c-6d91-4d92-bb8a-129481928341",
        retry_interval_ms: 4000,
        attempt: 3,
        max_attempts: 10,
      },
      rawPayload: JSON.stringify(
        {
          error_response: "ECONNRESET by peer",
          next_retry_ms: 8000,
          durable_queue_status: "HEALTHY",
        },
        null,
        2
      ),
    },
    {
      id: "log_911",
      timestamp: iso(m(90)),
      timestampMs: m(90),
      severity: "INFO",
      service: "telemetry-pipeline",
      tenant: "tenant_fintech_labs",
      source: "pod-worker-az2",
      message: "Gossip protocol health check succeeded across 4 Tier-1 nodes; quorum verified with consensus term 41",
      traceId: "trc_3a4b5c6d7e8f9a0b",
      spanId: "spn_gossip_ping",
      metadata: {
        cluster_size: 4,
        leader_id: "k8s-node-04",
        term: 41,
        active_peers: ["host-collector-01", "pod-worker-az2", "edge-gateway-eu", "k8s-node-04"],
      },
      rawPayload: JSON.stringify(
        {
          protocol: "Raft Consensus Lightweight",
          rtt_avg_ms: 1.8,
          packet_drop_pct: 0.0,
        },
        null,
        2
      ),
    },
    {
      id: "log_912",
      timestamp: iso(m(120)),
      timestampMs: m(120),
      severity: "ERROR",
      service: "tenant-router",
      tenant: "tenant_retail_mesh",
      source: "edge-gateway-eu",
      message: "TLS handshake failed for incoming collector connection from edge host: UNKNOWN_CA_CERTIFICATE",
      traceId: "trc_4b5c6d7e8f9a0b1c",
      spanId: "spn_tls_handshake",
      metadata: {
        client_cn: "collector-edge-retail-store-44",
        ca_hash: "3b8a1c92d",
        rejection_reason: "UNTRUSTED_ROOT",
      },
      rawPayload: JSON.stringify(
        {
          cipher: "TLS_AES_256_GCM_SHA384",
          remote_port: 54128,
          cert_fingerprint: "SHA256:4f8e...39ab",
        },
        null,
        2
      ),
    },
  ];
}

// Generate realistic simulated alerts
export function generateInitialAlerts(baseTimeMs: number = Date.now()): AlertItem[] {
  const m = (minutesAgo: number) => baseTimeMs - minutesAgo * 60 * 1000;
  const iso = (ms: number) => new Date(ms).toISOString();

  return [
    {
      id: "alert_001",
      title: "SQLite WAL Outbox Buffer Saturation (>90%)",
      severity: "Critical",
      affectedService: "wal-outbox",
      tenant: "tenant_acme_corp",
      timestamp: iso(m(4)),
      timestampMs: m(4),
      status: "Active",
      description: "Tier 1 local SQLite WAL queue is at 92.4% capacity. Network backpressure on Tier 2 ingress is stalling outbox delivery.",
      zScore: 3.42,
      driftMetric: "outbox_buffer_depth",
      recommendedRemediation: "Trigger immediate compaction batch or temporarily scale Tier 2 receiver ingress pool to relieve backpressure.",
      affectedNodes: ["host-collector-01"],
      aiConfidence: 0.96,
    },
    {
      id: "alert_002",
      title: "Elevated p95 API Latency (+3.8σ Anomaly)",
      severity: "Critical",
      affectedService: "aiops-engine",
      tenant: "tenant_fintech_labs",
      timestamp: iso(m(8)),
      timestampMs: m(8),
      status: "Active",
      description: "Application latency spiked to 385ms against historical baseline mean of 32ms. Tail distribution indicates database query lock contention.",
      zScore: 3.84,
      driftMetric: "api_p95_latency",
      recommendedRemediation: "Inspect active Postgres connection pool locks and restart stale worker instances in availability zone az-2.",
      affectedNodes: ["pod-worker-az2", "k8s-node-04"],
      aiConfidence: 0.92,
    },
    {
      id: "alert_003",
      title: "Unredacted Bearer Token Interception Spike",
      severity: "High",
      affectedService: "egress-scrubber",
      tenant: "tenant_acme_corp",
      timestamp: iso(m(25)),
      timestampMs: m(25),
      status: "Acknowledged",
      acknowledgedBy: "secops-engineer",
      acknowledgedAt: iso(m(20)),
      description: "Pseudonymization filter intercepted 14 unredacted Authorization headers within a 2-minute window. Tokens were masked with salted SHA-256 before disk persistence.",
      zScore: 2.75,
      driftMetric: "scrubbed_token_count",
      recommendedRemediation: "Audit upstream client SDK logging configuration to disable HTTP header dumping in debug mode.",
      affectedNodes: ["host-collector-01"],
      aiConfidence: 0.88,
    },
    {
      id: "alert_004",
      title: "Tenant API Quota Exceeded (Velocity > 1400 req/s)",
      severity: "Medium",
      affectedService: "tenant-router",
      tenant: "tenant_retail_mesh",
      timestamp: iso(m(42)),
      timestampMs: m(42),
      status: "Active",
      description: "Retail client application burst traffic exceeded configured contract quota of 1,000 req/s. 429 Too Many Requests response headers dispatched.",
      zScore: 1.95,
      driftMetric: "tenant_ingress_rps",
      recommendedRemediation: "Review tenant contract limits or configure client retry exponential backoff with jitter.",
      affectedNodes: ["edge-gateway-eu"],
      aiConfidence: 0.84,
    },
    {
      id: "alert_005",
      title: "Inter-Node Heartbeat Latency Elevation",
      severity: "Medium",
      affectedService: "telemetry-pipeline",
      tenant: "tenant_acme_corp",
      timestamp: iso(m(65)),
      timestampMs: m(65),
      status: "Acknowledged",
      acknowledgedBy: "oncall-sre",
      acknowledgedAt: iso(m(55)),
      description: "Mesh gossip ping round-trip latency rose from 1.2ms to 18.4ms between EU gateway and US-East cluster.",
      zScore: 1.82,
      driftMetric: "gossip_rtt_ms",
      recommendedRemediation: "Check cross-region WAN transit link provider status and verify MTU routing tables.",
      affectedNodes: ["edge-gateway-eu", "k8s-node-04"],
      aiConfidence: 0.79,
    },
    {
      id: "alert_006",
      title: "Expired TLS Certificate Negotiation on Edge Node",
      severity: "Low",
      affectedService: "tenant-router",
      tenant: "tenant_retail_mesh",
      timestamp: iso(m(110)),
      timestampMs: m(110),
      status: "Resolved",
      acknowledgedBy: "secops-engineer",
      acknowledgedAt: iso(m(100)),
      resolvedBy: "cert-manager-bot",
      resolvedAt: iso(m(85)),
      description: "Client connection rejected due to expired intermediary CA certificate on edge retail node store-44. Cert-manager rotated credentials successfully.",
      zScore: 1.12,
      driftMetric: "tls_handshake_failures",
      recommendedRemediation: "Certificates automatically renewed. Verify revocation list synchronization across edge distribution points.",
      affectedNodes: ["edge-gateway-eu"],
      aiConfidence: 0.98,
    },
    {
      id: "alert_007",
      title: "Collector SQLite Vacuum & Reindex Completed",
      severity: "Low",
      affectedService: "wal-outbox",
      tenant: "tenant_acme_corp",
      timestamp: iso(m(180)),
      timestampMs: m(180),
      status: "Resolved",
      resolvedBy: "system-cron",
      resolvedAt: iso(m(175)),
      description: "Automated vacuum compacting reclaimed 142 MB from historical telemetry journal. Normal operation resumed.",
      zScore: 0.35,
      driftMetric: "disk_reclaimed_mb",
      recommendedRemediation: "Maintenance completed successfully. No operator action required.",
      affectedNodes: ["host-collector-01"],
      aiConfidence: 1.0,
    },
  ];
}
