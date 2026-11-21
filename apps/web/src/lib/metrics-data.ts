export type TimeRange = "15m" | "1h" | "6h" | "24h" | "7d";
export type MetricCategory = "all" | "compute" | "network" | "storage";

export interface DataPoint {
  timestamp: number;
  value: number;
}

export interface MetricSeries {
  id: string;
  name: string;
  color: string;
  gradientFrom?: string;
  gradientTo?: string;
  data: DataPoint[];
  strokeWidth?: number;
  dashed?: boolean;
}

export interface ThresholdLine {
  value: number;
  label: string;
  color: string;
  dashed?: boolean;
}

export interface MetricChartConfig {
  id: string;
  title: string;
  subtitle: string;
  category: "compute" | "network" | "storage";
  unit: string;
  yMin?: number;
  yMax?: number;
  thresholds?: ThresholdLine[];
  series: MetricSeries[];
}

export interface KpiMetric {
  id: string;
  title: string;
  value: string;
  numericValue: number;
  unit: string;
  trendDirection: "up" | "down" | "flat";
  trendPercentage: string;
  isPositive: boolean; // whether "up" is desirable or undesirable
  comparisonText: string;
  subtitle: string;
  category: "compute" | "network" | "storage";
  sparkline: number[];
}

// Pseudo-random deterministic generator with seed for smooth, realistic telemetry waveforms
function createNoiseGenerator(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function getTimeRangeConfig(range: TimeRange) {
  switch (range) {
    case "15m":
      return { durationMs: 15 * 60 * 1000, stepMs: 30 * 1000, points: 30, format: "time" };
    case "1h":
      return { durationMs: 60 * 60 * 1000, stepMs: 2 * 60 * 1000, points: 30, format: "time" };
    case "6h":
      return { durationMs: 6 * 60 * 60 * 1000, stepMs: 10 * 60 * 1000, points: 36, format: "time" };
    case "24h":
      return { durationMs: 24 * 60 * 60 * 1000, stepMs: 30 * 60 * 1000, points: 48, format: "datetime" };
    case "7d":
      return { durationMs: 7 * 24 * 60 * 60 * 1000, stepMs: 3 * 60 * 60 * 1000, points: 56, format: "date" };
  }
}

export function formatTimeLabel(timestamp: number, format: "time" | "datetime" | "date"): string {
  const d = new Date(timestamp);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());

  if (format === "time") {
    return `${hours}:${minutes}`;
  }

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[d.getMonth()];
  const date = d.getDate();

  if (format === "date") {
    return `${month} ${date}`;
  }

  return `${month} ${date} ${hours}:${minutes}`;
}

export function generateMetricsData(timeRange: TimeRange, tenantId: string = "tenant_acme_corp", nowMs: number = Date.now()) {
  const config = getTimeRangeConfig(timeRange);
  const startTime = nowMs - config.durationMs;

  // Tenant-specific variance multipliers
  const tenantSeeds: Record<string, number> = {
    tenant_acme_corp: 42,
    tenant_fintech_labs: 88,
    tenant_retail_mesh: 137,
    tenant_health_net: 256,
  };
  const baseSeed = (tenantSeeds[tenantId] || 42) + (timeRange.length * 17);
  const rng = createNoiseGenerator(baseSeed);

  // Generate continuous time points
  const timestamps: number[] = [];
  for (let i = 0; i < config.points; i++) {
    timestamps.push(startTime + i * config.stepMs);
  }

  // Baseline profiles for different tenants
  const tenantBias = tenantId === "tenant_fintech_labs" ? 1.15 : tenantId === "tenant_retail_mesh" ? 0.92 : 1.0;

  // 1. CPU Telemetry Series
  const cpuAvgData: DataPoint[] = [];
  const cpuPeakData: DataPoint[] = [];
  let prevCpu = 38 * tenantBias;
  for (let i = 0; i < timestamps.length; i++) {
    const timeRatio = i / timestamps.length;
    // Periodic diurnal wave + stochastic walk
    const diurnal = Math.sin(timeRatio * Math.PI * 2) * 8;
    const noise = (rng() - 0.48) * 6;
    prevCpu = Math.max(18, Math.min(84, prevCpu + noise + (diurnal * 0.1)));
    const peak = Math.min(96, prevCpu + 10 + rng() * 12);
    cpuAvgData.push({ timestamp: timestamps[i], value: Number(prevCpu.toFixed(1)) });
    cpuPeakData.push({ timestamp: timestamps[i], value: Number(peak.toFixed(1)) });
  }

  // 2. Memory Telemetry Series
  const memUsedData: DataPoint[] = [];
  const memHeapData: DataPoint[] = [];
  let prevMem = 62 * tenantBias;
  for (let i = 0; i < timestamps.length; i++) {
    const creep = (i / timestamps.length) * 3; // slight upward memory allocation
    const noise = (rng() - 0.48) * 2;
    prevMem = Math.max(45, Math.min(85, prevMem + noise + (creep * 0.05)));
    const heap = prevMem * 0.72 + (rng() - 0.5) * 3;
    memUsedData.push({ timestamp: timestamps[i], value: Number(prevMem.toFixed(1)) });
    memHeapData.push({ timestamp: timestamps[i], value: Number(heap.toFixed(1)) });
  }

  // 3. Disk Space Utilization Series
  const diskVarLogData: DataPoint[] = [];
  const diskDataPoolData: DataPoint[] = [];
  let prevDisk = 58.2;
  for (let i = 0; i < timestamps.length; i++) {
    // Disk grows steadily with occasional compacting drops
    const grow = 0.04;
    const compact = i === Math.floor(timestamps.length * 0.6) ? -1.8 : 0;
    prevDisk = Math.max(30, Math.min(88, prevDisk + grow + compact + (rng() - 0.49) * 0.15));
    const dataPool = 46.5 + (i / timestamps.length) * 1.5 + (rng() - 0.5) * 0.2;
    diskVarLogData.push({ timestamp: timestamps[i], value: Number(prevDisk.toFixed(1)) });
    diskDataPoolData.push({ timestamp: timestamps[i], value: Number(dataPool.toFixed(1)) });
  }

  // 4. Network Traffic (Incoming & Outgoing Dual Series)
  const netInData: DataPoint[] = [];
  const netOutData: DataPoint[] = [];
  let prevIn = 8.4 * tenantBias;
  let prevOut = 5.9 * tenantBias;
  for (let i = 0; i < timestamps.length; i++) {
    const burst = (rng() > 0.85 ? rng() * 4.5 : 0);
    prevIn = Math.max(2.1, Math.min(18.5, prevIn * 0.85 + (7.8 + (rng() - 0.5) * 3 + burst) * 0.15));
    prevOut = Math.max(1.5, Math.min(14.0, prevOut * 0.88 + (5.2 + (rng() - 0.5) * 2.5 + burst * 0.7) * 0.12));
    netInData.push({ timestamp: timestamps[i], value: Number(prevIn.toFixed(2)) });
    netOutData.push({ timestamp: timestamps[i], value: Number(prevOut.toFixed(2)) });
  }

  // 5. Application Latency Series (p50 and p95)
  const latP50Data: DataPoint[] = [];
  const latP95Data: DataPoint[] = [];
  let prevLat = 32 * (tenantId === "tenant_fintech_labs" ? 0.75 : 1.0);
  for (let i = 0; i < timestamps.length; i++) {
    const jitter = (rng() - 0.48) * 4;
    const spike = (rng() > 0.92 ? rng() * 48 : 0);
    prevLat = Math.max(12, Math.min(95, prevLat * 0.8 + (30 + jitter) * 0.2));
    const p95 = prevLat * 2.8 + spike + (rng() * 12);
    latP50Data.push({ timestamp: timestamps[i], value: Number(prevLat.toFixed(1)) });
    latP95Data.push({ timestamp: timestamps[i], value: Number(p95.toFixed(1)) });
  }

  // 6. Packet Loss Series (%)
  const lossData: DataPoint[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    // Normal is near zero, with rare micro-anomalies
    const isAnomaly = rng() > 0.93;
    const val = isAnomaly ? (rng() * 0.45 + 0.05) : (rng() * 0.03);
    lossData.push({ timestamp: timestamps[i], value: Number(val.toFixed(3)) });
  }

  // Calculate Averages & KPIs
  const calcAvg = (arr: DataPoint[]) =>
    arr.reduce((acc, p) => acc + p.value, 0) / arr.length;
  const calcLast = (arr: DataPoint[]) => arr[arr.length - 1].value;

  const avgCpu = calcAvg(cpuAvgData);
  const avgMem = calcAvg(memUsedData);
  const avgDisk = calcLast(diskVarLogData);
  const avgNetIn = calcAvg(netInData);
  const avgNetOut = calcAvg(netOutData);
  const totalNet = avgNetIn + avgNetOut;
  const avgLat = calcAvg(latP50Data);
  const avgLoss = calcAvg(lossData);

  // Sparklines (subset of 12 points)
  const getSparkline = (arr: DataPoint[]) => {
    const step = Math.max(1, Math.floor(arr.length / 12));
    return arr.filter((_, idx) => idx % step === 0).slice(0, 12).map((p) => p.value);
  };

  const kpis: KpiMetric[] = [
    {
      id: "cpu",
      title: "Average CPU Utilization",
      value: `${avgCpu.toFixed(1)}%`,
      numericValue: avgCpu,
      unit: "%",
      trendDirection: "up",
      trendPercentage: "+1.8%",
      isPositive: false, // higher CPU utilization is generally caution
      comparisonText: `vs previous ${timeRange}`,
      subtitle: "16 vCPUs active across 4 nodes",
      category: "compute",
      sparkline: getSparkline(cpuAvgData),
    },
    {
      id: "memory",
      title: "Average Memory Utilization",
      value: `${avgMem.toFixed(1)}%`,
      numericValue: avgMem,
      unit: "%",
      trendDirection: "down",
      trendPercentage: "-0.6%",
      isPositive: true, // lower is good
      comparisonText: `vs previous ${timeRange}`,
      subtitle: "24.6 GB / 38.4 GB heap allocated",
      category: "compute",
      sparkline: getSparkline(memUsedData),
    },
    {
      id: "disk",
      title: "Disk Space Utilization",
      value: `${avgDisk.toFixed(1)}%`,
      numericValue: avgDisk,
      unit: "%",
      trendDirection: "flat",
      trendPercentage: "+0.1%",
      isPositive: true,
      comparisonText: `vs previous ${timeRange}`,
      subtitle: "1.8 TB WAL storage remaining",
      category: "storage",
      sparkline: getSparkline(diskVarLogData),
    },
    {
      id: "network",
      title: "Network Throughput",
      value: `${totalNet.toFixed(1)} MB/s`,
      numericValue: totalNet,
      unit: "MB/s",
      trendDirection: "up",
      trendPercentage: "+3.2%",
      isPositive: true,
      comparisonText: `vs previous ${timeRange}`,
      subtitle: `In: ${avgNetIn.toFixed(1)} MB/s • Out: ${avgNetOut.toFixed(1)} MB/s`,
      category: "network",
      sparkline: getSparkline(netInData),
    },
    {
      id: "latency",
      title: "Average Latency (p50)",
      value: `${avgLat.toFixed(1)} ms`,
      numericValue: avgLat,
      unit: "ms",
      trendDirection: "down",
      trendPercentage: "-3.8 ms",
      isPositive: true, // lower latency is good
      comparisonText: `vs previous ${timeRange}`,
      subtitle: "p95 tail target < 200 ms",
      category: "storage",
      sparkline: getSparkline(latP50Data),
    },
    {
      id: "packet_loss",
      title: "Packet Loss Rate",
      value: `${avgLoss.toFixed(2)}%`,
      numericValue: avgLoss,
      unit: "%",
      trendDirection: "flat",
      trendPercentage: "0.00%",
      isPositive: true,
      comparisonText: `vs previous ${timeRange}`,
      subtitle: "Zero dropped frames on primary mesh",
      category: "network",
      sparkline: getSparkline(lossData),
    },
  ];

  // 6 Chart Configs
  const charts: MetricChartConfig[] = [
    {
      id: "chart_cpu",
      title: "CPU Utilization",
      subtitle: "Fleet-wide core load with drift baseline and warning envelope",
      category: "compute",
      unit: "%",
      yMin: 0,
      yMax: 100,
      thresholds: [
        { value: 70, label: "Warning 70%", color: "#E8B86D", dashed: true },
        { value: 85, label: "Critical 85%", color: "#D47A7A", dashed: true },
      ],
      series: [
        {
          id: "cpu_avg",
          name: "Fleet Average",
          color: "#4A5568", // Charcoal / Ink
          gradientFrom: "#C7BBB8",
          gradientTo: "#E6ECE4",
          data: cpuAvgData,
          strokeWidth: 2,
        },
        {
          id: "cpu_peak",
          name: "Peak Core",
          color: "#D97706", // Amber / Warm Accent
          data: cpuPeakData,
          strokeWidth: 1.5,
          dashed: true,
        },
      ],
    },
    {
      id: "chart_mem",
      title: "Memory Allocation",
      subtitle: "Committed physical RAM and runtime garbage collector heap",
      category: "compute",
      unit: "%",
      yMin: 0,
      yMax: 100,
      thresholds: [
        { value: 80, label: "Warning 80%", color: "#E8B86D", dashed: true },
      ],
      series: [
        {
          id: "mem_used",
          name: "Physical Memory",
          color: "#7C3AED", // Soft Muted Purple / Editorial
          gradientFrom: "#F0EBF5",
          gradientTo: "#FFFFFF",
          data: memUsedData,
          strokeWidth: 2,
        },
        {
          id: "mem_heap",
          name: "Active Heap Pool",
          color: "#A78BFA",
          data: memHeapData,
          strokeWidth: 1.5,
        },
      ],
    },
    {
      id: "chart_disk",
      title: "Disk Utilization",
      subtitle: "Persistent storage partitions and durable SQLite WAL buffer",
      category: "storage",
      unit: "%",
      yMin: 0,
      yMax: 100,
      thresholds: [
        { value: 75, label: "Threshold 75%", color: "#E8B86D", dashed: true },
        { value: 90, label: "Capacity Limit 90%", color: "#D47A7A", dashed: true },
      ],
      series: [
        {
          id: "disk_wal",
          name: "WAL & Journal Cache (/var)",
          color: "#9A3412", // Soft rust/terracotta
          gradientFrom: "#F8EBDC",
          gradientTo: "#FFFFFF",
          data: diskVarLogData,
          strokeWidth: 2,
        },
        {
          id: "disk_pool",
          name: "Primary Storage Pool (/data)",
          color: "#78716C",
          data: diskDataPoolData,
          strokeWidth: 1.5,
        },
      ],
    },
    {
      id: "chart_net",
      title: "Network Traffic (Ingress / Egress)",
      subtitle: "Differential privacy LDP encrypted wire transfer rate",
      category: "network",
      unit: "MB/s",
      yMin: 0,
      yMax: Math.ceil(Math.max(...netInData.map((d) => d.value), ...netOutData.map((d) => d.value)) * 1.25),
      series: [
        {
          id: "net_in",
          name: "Incoming (Ingress)",
          color: "#059669", // Emerald / Sage green
          gradientFrom: "#E8F2EB",
          gradientTo: "#FFFFFF",
          data: netInData,
          strokeWidth: 2,
        },
        {
          id: "net_out",
          name: "Outgoing (Egress)",
          color: "#EA580C", // Warm Peach / Terracotta
          gradientFrom: "#FBECE7",
          gradientTo: "#FFFFFF",
          data: netOutData,
          strokeWidth: 2,
        },
      ],
    },
    {
      id: "chart_lat",
      title: "Application Latency",
      subtitle: "Median response time and tail percentile latency envelope",
      category: "storage",
      unit: "ms",
      yMin: 0,
      yMax: Math.ceil(Math.max(...latP95Data.map((d) => d.value)) * 1.2),
      thresholds: [
        { value: 200, label: "SLA Max 200 ms", color: "#D47A7A", dashed: true },
      ],
      series: [
        {
          id: "lat_p50",
          name: "Average (p50)",
          color: "#2563EB", // Soft blue
          gradientFrom: "#EFF6FF",
          gradientTo: "#FFFFFF",
          data: latP50Data,
          strokeWidth: 2,
        },
        {
          id: "lat_p95",
          name: "p95 Tail Spike",
          color: "#DC2626", // Muted red
          data: latP95Data,
          strokeWidth: 1.5,
          dashed: true,
        },
      ],
    },
    {
      id: "chart_loss",
      title: "Packet Loss Rate",
      subtitle: "Network socket drop ratio across inter-node gossip mesh",
      category: "network",
      unit: "%",
      yMin: 0,
      yMax: 1.0,
      thresholds: [
        { value: 0.5, label: "Max Tolerance 0.5%", color: "#E8B86D", dashed: true },
      ],
      series: [
        {
          id: "packet_loss",
          name: "Observed Loss",
          color: "#0D9488", // Teal / Slate
          gradientFrom: "#CCFBF1",
          gradientTo: "#FFFFFF",
          data: lossData,
          strokeWidth: 2,
        },
      ],
    },
  ];

  return {
    kpis,
    charts,
    timeRange,
    tenantId,
    generatedAt: nowMs,
  };
}
