"use client";

import React from "react";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Cpu,
  Activity,
  HardDrive,
  Network,
  Clock,
  Wifi,
} from "lucide-react";
import { KpiMetric } from "@/lib/metrics-data";

interface MetricKpiCardProps {
  metric: KpiMetric;
}

const ICON_MAP: Record<string, React.ReactNode> = {
  cpu: <Cpu className="w-4 h-4 text-[#78716C]" />,
  memory: <Activity className="w-4 h-4 text-[#78716C]" />,
  disk: <HardDrive className="w-4 h-4 text-[#78716C]" />,
  network: <Network className="w-4 h-4 text-[#78716C]" />,
  latency: <Clock className="w-4 h-4 text-[#78716C]" />,
  packet_loss: <Wifi className="w-4 h-4 text-[#78716C]" />,
};

export function MetricKpiCard({ metric }: MetricKpiCardProps) {
  const {
    id,
    title,
    value,
    unit,
    trendDirection,
    trendPercentage,
    isPositive,
    comparisonText,
    subtitle,
    sparkline,
  } = metric;

  // Render Trend Indicator
  const renderTrendIcon = () => {
    if (trendDirection === "up") {
      return <TrendingUp className="w-3.5 h-3.5 shrink-0" />;
    }
    if (trendDirection === "down") {
      return <TrendingDown className="w-3.5 h-3.5 shrink-0" />;
    }
    return <Minus className="w-3.5 h-3.5 shrink-0" />;
  };

  const trendColorClass = isPositive
    ? "text-[#2E7D32] bg-[#E8F5E9] border-[#C8E6C9]"
    : trendDirection === "flat"
    ? "text-[#78716C] bg-[#F8F6F3] border-[#ECE7E2]"
    : "text-[#C2410C] bg-[#FFF7ED] border-[#FFEDD5]";

  // SVG Sparkline calculation
  const sparkWidth = 72;
  const sparkHeight = 26;
  const minV = Math.min(...sparkline);
  const maxV = Math.max(...sparkline);
  const range = maxV === minV ? 1 : maxV - minV;

  const points = sparkline.map((val, idx) => {
    const x = (idx / (sparkline.length - 1)) * sparkWidth;
    const y = sparkHeight - ((val - minV) / range) * (sparkHeight - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const polylineStr = points.join(" ");

  return (
    <div className="card-base p-4 flex flex-col justify-between hover:border-[#C7BBB8] transition-all duration-200">
      {/* Top row: Title and Icon */}
      <div className="flex items-center justify-between text-xs text-[#78716C] mb-2">
        <span className="font-medium tracking-tight truncate max-w-[80%]">
          {title}
        </span>
        <div className="p-1.5 rounded-[6px] bg-[#F8F6F3] border border-[#ECE7E2]">
          {ICON_MAP[id] || <Activity className="w-4 h-4 text-[#78716C]" />}
        </div>
      </div>

      {/* Main Metric Value and Sparkline */}
      <div className="flex items-baseline justify-between gap-2 my-1">
        <div className="text-2xl font-bold font-display tracking-tight text-[#18181B]">
          {value}
        </div>

        {/* Mini Sparkline */}
        {sparkline.length > 1 && (
          <div className="shrink-0 flex items-center">
            <svg
              width={sparkWidth}
              height={sparkHeight}
              className="overflow-visible"
              aria-hidden="true"
            >
              <polyline
                fill="none"
                stroke={isPositive ? "#6B9E6B" : "#D97757"}
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={polylineStr}
              />
            </svg>
          </div>
        )}
      </div>

      {/* Bottom context and trend pill */}
      <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-[#ECE7E2]/70 text-xs">
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] border text-[11px] font-mono font-medium ${trendColorClass}`}
          >
            {renderTrendIcon()}
            {trendPercentage}
          </span>
          <span className="text-[11px] text-[#A8A29E] hidden sm:inline">
            {comparisonText}
          </span>
        </div>

        <span className="text-[11px] text-[#78716C] font-mono truncate text-right">
          {subtitle}
        </span>
      </div>
    </div>
  );
}
