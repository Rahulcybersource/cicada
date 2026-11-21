"use client";

import React, { useState, useRef, useMemo, useCallback } from "react";
import { formatTimeLabel, MetricSeries, ThresholdLine, TimeRange, getTimeRangeConfig } from "@/lib/metrics-data";
import { AlertCircle, Eye, EyeOff } from "lucide-react";

interface TimeSeriesChartProps {
  id: string;
  title: string;
  subtitle?: string;
  category?: string;
  series: MetricSeries[];
  unit: string;
  yMin?: number;
  yMax?: number;
  thresholds?: ThresholdLine[];
  timeRange: TimeRange;
  loading?: boolean;
  empty?: boolean;
  height?: number;
}

export function TimeSeriesChart({
  id,
  title,
  subtitle,
  category,
  series,
  unit,
  yMin = 0,
  yMax,
  thresholds = [],
  timeRange,
  loading = false,
  empty = false,
  height = 250,
}: TimeSeriesChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hiddenSeries, setHiddenSeries] = useState<Record<string, boolean>>({});

  // SVG Dimension Constants
  const svgWidth = 800;
  const svgHeight = height;
  const margin = { top: 22, right: 30, bottom: 32, left: 56 };
  const plotWidth = svgWidth - margin.left - margin.right;
  const plotHeight = svgHeight - margin.top - margin.bottom;

  // Toggle series visibility
  const toggleSeries = (seriesId: string) => {
    setHiddenSeries((prev) => ({
      ...prev,
      [seriesId]: !prev[seriesId],
    }));
  };

  // Active series
  const activeSeries = useMemo(() => {
    return series.filter((s) => !hiddenSeries[s.id]);
  }, [series, hiddenSeries]);

  // Compute domain bounds
  const { minTime, maxTime, calculatedYMin, calculatedYMax } = useMemo(() => {
    let minT = Infinity;
    let maxT = -Infinity;
    let minV = yMin !== undefined ? yMin : Infinity;
    let maxV = yMax !== undefined ? yMax : -Infinity;

    series.forEach((s) => {
      s.data.forEach((p) => {
        if (p.timestamp < minT) minT = p.timestamp;
        if (p.timestamp > maxT) maxT = p.timestamp;
        if (yMin === undefined && p.value < minV) minV = p.value;
        if (yMax === undefined && p.value > maxV) maxV = p.value;
      });
    });

    if (minT === Infinity) minT = Date.now() - 3600000;
    if (maxT === -Infinity) maxT = Date.now();

    // Include thresholds in max calculation if threshold is higher
    thresholds.forEach((th) => {
      if (yMax === undefined && th.value > maxV) {
        maxV = th.value * 1.1;
      }
    });

    if (yMin === undefined) {
      minV = Math.max(0, Math.floor(minV * 0.9));
    }
    if (yMax === undefined) {
      maxV = maxV <= 0 ? 10 : Math.ceil(maxV * 1.15);
    } else {
      maxV = yMax;
    }

    return { minTime: minT, maxTime: maxT, calculatedYMin: minV, calculatedYMax: maxV };
  }, [series, yMin, yMax, thresholds]);

  // Scale functions
  const scaleX = useCallback(
    (timestamp: number) => {
      if (maxTime === minTime) return margin.left + plotWidth / 2;
      const ratio = (timestamp - minTime) / (maxTime - minTime);
      return margin.left + ratio * plotWidth;
    },
    [minTime, maxTime, margin.left, plotWidth]
  );

  const scaleY = useCallback(
    (value: number) => {
      if (calculatedYMax === calculatedYMin) return margin.top + plotHeight / 2;
      const ratio = (value - calculatedYMin) / (calculatedYMax - calculatedYMin);
      const clampedRatio = Math.max(0, Math.min(1.05, ratio));
      return margin.top + (1 - clampedRatio) * plotHeight;
    },
    [calculatedYMin, calculatedYMax, margin.top, plotHeight]
  );

  // Generate Y-axis grid ticks (4 intervals)
  const yTicks = useMemo(() => {
    const ticks: number[] = [];
    const count = 4;
    const step = (calculatedYMax - calculatedYMin) / count;
    for (let i = 0; i <= count; i++) {
      const val = calculatedYMin + i * step;
      ticks.push(Number(val.toFixed(val > 10 ? 0 : 1)));
    }
    return ticks;
  }, [calculatedYMin, calculatedYMax]);

  // Generate X-axis time ticks (5 intervals)
  const timeConfig = getTimeRangeConfig(timeRange);
  const xTicks = useMemo(() => {
    const ticks: number[] = [];
    const count = 5;
    const step = (maxTime - minTime) / count;
    for (let i = 0; i <= count; i++) {
      ticks.push(minTime + i * step);
    }
    return ticks;
  }, [minTime, maxTime]);

  // Generate smooth cubic Bezier path string
  const generateSmoothPath = (points: { x: number; y: number }[]) => {
    if (points.length === 0) return "";
    if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
    let path = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i === 0 ? 0 : i - 1];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2 < points.length ? i + 2 : i + 1];

      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;

      path += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }
    return path;
  };

  // Generate area path that seals to bottom axis
  const generateAreaPath = (points: { x: number; y: number }[]) => {
    if (points.length < 2) return "";
    const bottomY = margin.top + plotHeight;
    const linePath = generateSmoothPath(points);
    const firstX = points[0].x.toFixed(1);
    const lastX = points[points.length - 1].x.toFixed(1);
    return `${linePath} L ${lastX} ${bottomY} L ${firstX} ${bottomY} Z`;
  };

  // Handle Mouse Hover / Crosshair calculation
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!containerRef.current || series.length === 0 || series[0].data.length === 0) return;
    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const relativeX = (mouseX / rect.width) * svgWidth;

    if (relativeX < margin.left || relativeX > margin.left + plotWidth) {
      setHoverIndex(null);
      return;
    }

    const firstSeries = series[0].data;
    let closestIndex = 0;
    let minDiff = Infinity;

    for (let i = 0; i < firstSeries.length; i++) {
      const pointX = scaleX(firstSeries[i].timestamp);
      const diff = Math.abs(pointX - relativeX);
      if (diff < minDiff) {
        minDiff = diff;
        closestIndex = i;
      }
    }

    setHoverIndex(closestIndex);
  };

  const handleMouseLeave = () => {
    setHoverIndex(null);
  };

  // Reference hovered data point
  const hoveredTimestamp =
    hoverIndex !== null && series[0]?.data[hoverIndex]
      ? series[0].data[hoverIndex].timestamp
      : null;

  const hoveredX = hoveredTimestamp !== null ? scaleX(hoveredTimestamp) : null;

  return (
    <div className="card-base p-5 flex flex-col justify-between transition-all duration-200">
      {/* Chart Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-3 mb-2 border-b border-[#ECE7E2]">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-display font-semibold text-base text-[#18181B] tracking-tight">
              {title}
            </h3>
            {category && (
              <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded-full bg-[#F8F6F3] text-[#78716C] border border-[#ECE7E2]">
                {category}
              </span>
            )}
          </div>
          {subtitle && (
            <p className="text-xs text-[#78716C] mt-0.5 leading-relaxed">
              {subtitle}
            </p>
          )}
        </div>

        {/* Legend pills */}
        <div className="flex items-center gap-2 flex-wrap">
          {series.map((s) => {
            const isHidden = hiddenSeries[s.id];
            const latestVal = s.data.length > 0 ? s.data[s.data.length - 1].value : 0;
            return (
              <button
                key={s.id}
                onClick={() => toggleSeries(s.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-xs font-mono transition-all border ${
                  isHidden
                    ? "bg-[#F8F6F3] text-[#A8A29E] border-[#ECE7E2] line-through opacity-60"
                    : "bg-white text-[#18181B] border-[#ECE7E2] hover:border-[#C7BBB8] shadow-sm"
                }`}
                title={`Click to ${isHidden ? "show" : "hide"} ${s.name}`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: s.color }}
                />
                <span className="font-sans font-medium text-[11px] text-[#78716C]">
                  {s.name}:
                </span>
                <span className="font-semibold text-[#18181B]">
                  {latestVal}
                  <span className="text-[10px] text-[#A8A29E] ml-0.5 font-normal">{unit}</span>
                </span>
                {isHidden ? (
                  <EyeOff className="w-3 h-3 text-[#A8A29E] ml-0.5" />
                ) : (
                  <Eye className="w-3 h-3 text-[#78716C] ml-0.5 opacity-40 hover:opacity-100" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* SVG Container */}
      <div
        ref={containerRef}
        className="relative w-full select-none"
        style={{ height }}
      >
        {loading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#F9F7F4]/80 backdrop-blur-[1px] rounded-[8px] z-10">
            <div className="w-6 h-6 border-2 border-[#18181B] border-t-transparent rounded-full animate-spin mb-2" />
            <span className="text-xs font-medium text-[#78716C]">
              Syncing telemetry signals...
            </span>
          </div>
        ) : empty || series.length === 0 || series[0].data.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6">
            <AlertCircle className="w-8 h-8 text-[#A8A29E] mb-2" />
            <p className="text-sm font-medium text-[#18181B]">No signal data available</p>
            <p className="text-xs text-[#78716C] mt-0.5">
              No telemetry events recorded for this tenant within the {timeRange} window.
            </p>
          </div>
        ) : null}

        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="w-full h-full overflow-visible"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          <defs>
            {/* Area Gradients for each series */}
            {series.map((s) => (
              <linearGradient
                key={`grad_${s.id}`}
                id={`grad_${id}_${s.id}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="0%"
                  stopColor={s.gradientFrom || s.color}
                  stopOpacity="0.32"
                />
                <stop
                  offset="100%"
                  stopColor={s.gradientTo || s.gradientFrom || "#FFFFFF"}
                  stopOpacity="0.02"
                />
              </linearGradient>
            ))}
            {/* Filter for subtle drop-shadow on tooltip */}
            <filter id={`shadow_${id}`} x="-10%" y="-10%" width="120%" height="120%">
              <feDropShadow dx="0" dy="2" stdDeviation="3" floodOpacity="0.08" floodColor="#18181B" />
            </filter>
          </defs>

          {/* Plot Background Area */}
          <rect
            x={margin.left}
            y={margin.top}
            width={plotWidth}
            height={plotHeight}
            fill="#FFFFFF"
            rx="4"
          />

          {/* Horizontal Y-Gridlines & Tick Labels */}
          {yTicks.map((val, idx) => {
            const y = scaleY(val);
            return (
              <g key={`y_tick_${idx}`}>
                <line
                  x1={margin.left}
                  y1={y}
                  x2={margin.left + plotWidth}
                  y2={y}
                  stroke="#ECE7E2"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                />
                <text
                  x={margin.left - 8}
                  y={y + 3.5}
                  textAnchor="end"
                  fontSize="10"
                  fontFamily="JetBrains Mono, monospace"
                  fill="#78716C"
                >
                  {val}{idx === yTicks.length - 1 ? unit : ""}
                </text>
              </g>
            );
          })}

          {/* Threshold Lines */}
          {thresholds.map((th, idx) => {
            if (th.value < calculatedYMin || th.value > calculatedYMax) return null;
            const y = scaleY(th.value);
            return (
              <g key={`thresh_${idx}`}>
                <line
                  x1={margin.left}
                  y1={y}
                  x2={margin.left + plotWidth}
                  y2={y}
                  stroke={th.color}
                  strokeWidth="1.2"
                  strokeDasharray="4 4"
                />
                <rect
                  x={margin.left + plotWidth - 85}
                  y={y - 8}
                  width="80"
                  height="16"
                  rx="3"
                  fill="#FFFFFF"
                  stroke={th.color}
                  strokeWidth="0.8"
                />
                <text
                  x={margin.left + plotWidth - 45}
                  y={y + 3.5}
                  textAnchor="middle"
                  fontSize="9"
                  fontFamily="JetBrains Mono, monospace"
                  fontWeight="600"
                  fill={th.color}
                >
                  {th.label}
                </text>
              </g>
            );
          })}

          {/* Vertical X-Time Gridlines & Labels */}
          {xTicks.map((timestamp, idx) => {
            const x = scaleX(timestamp);
            const label = formatTimeLabel(timestamp, timeConfig.format as "time" | "datetime" | "date");
            return (
              <g key={`x_tick_${idx}`}>
                <line
                  x1={x}
                  y1={margin.top}
                  x2={x}
                  y2={margin.top + plotHeight}
                  stroke="#ECE7E2"
                  strokeWidth="0.8"
                />
                <text
                  x={x}
                  y={margin.top + plotHeight + 16}
                  textAnchor="middle"
                  fontSize="10"
                  fontFamily="JetBrains Mono, monospace"
                  fill="#78716C"
                >
                  {label}
                </text>
              </g>
            );
          })}

          {/* Render Area Fills for Active Series */}
          {activeSeries.map((s) => {
            if (s.data.length < 2) return null;
            const points = s.data.map((p) => ({
              x: scaleX(p.timestamp),
              y: scaleY(p.value),
            }));
            const areaPath = generateAreaPath(points);
            return (
              <path
                key={`area_${s.id}`}
                d={areaPath}
                fill={`url(#grad_${id}_${s.id})`}
                opacity="0.9"
              />
            );
          })}

          {/* Render Line Strokes for Active Series */}
          {activeSeries.map((s) => {
            if (s.data.length < 2) return null;
            const points = s.data.map((p) => ({
              x: scaleX(p.timestamp),
              y: scaleY(p.value),
            }));
            const linePath = generateSmoothPath(points);
            return (
              <path
                key={`line_${s.id}`}
                d={linePath}
                fill="none"
                stroke={s.color}
                strokeWidth={s.strokeWidth || 2}
                strokeDasharray={s.dashed ? "4 4" : undefined}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          })}

          {/* Interactive Hover Crosshair & Indicators */}
          {hoveredX !== null && hoverIndex !== null && (
            <g>
              {/* Vertical Crosshair Line */}
              <line
                x1={hoveredX}
                y1={margin.top}
                x2={hoveredX}
                y2={margin.top + plotHeight}
                stroke="#18181B"
                strokeWidth="1"
                strokeDasharray="2 2"
                opacity="0.6"
              />

              {/* Series Points */}
              {activeSeries.map((s) => {
                const point = s.data[hoverIndex];
                if (!point) return null;
                const ptX = scaleX(point.timestamp);
                const ptY = scaleY(point.value);
                return (
                  <g key={`hover_pt_${s.id}`}>
                    <circle
                      cx={ptX}
                      cy={ptY}
                      r="5"
                      fill="#FFFFFF"
                      stroke={s.color}
                      strokeWidth="2.5"
                    />
                    <circle
                      cx={ptX}
                      cy={ptY}
                      r="2"
                      fill={s.color}
                    />
                  </g>
                );
              })}
            </g>
          )}
        </svg>

        {/* HTML Tooltip (Positioned dynamically) */}
        {hoveredX !== null && hoverIndex !== null && hoveredTimestamp !== null && (
          <div
            className="pointer-events-none absolute z-20 bg-white/95 backdrop-blur-sm border border-[#ECE7E2] rounded-[8px] p-2.5 shadow-elevated transition-transform duration-75 text-xs font-sans"
            style={{
              left: `${Math.min(
                Math.max(10, (hoveredX / svgWidth) * 100),
                75
              )}%`,
              top: "12px",
            }}
          >
            <div className="flex items-center justify-between gap-3 pb-1.5 mb-1.5 border-b border-[#ECE7E2]">
              <span className="font-mono text-[11px] font-semibold text-[#18181B]">
                {formatTimeLabel(
                  hoveredTimestamp,
                  timeConfig.format === "date" ? "datetime" : "time"
                )}
              </span>
              <span className="text-[10px] text-[#78716C] font-mono">
                {timeRange} window
              </span>
            </div>
            <div className="space-y-1">
              {activeSeries.map((s) => {
                const pt = s.data[hoverIndex];
                if (!pt) return null;
                return (
                  <div
                    key={`tip_${s.id}`}
                    className="flex items-center justify-between gap-4 text-[11px]"
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: s.color }}
                      />
                      <span className="text-[#78716C]">{s.name}</span>
                    </div>
                    <span className="font-mono font-semibold text-[#18181B]">
                      {pt.value}
                      <span className="text-[10px] font-normal text-[#78716C] ml-0.5">
                        {unit}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
