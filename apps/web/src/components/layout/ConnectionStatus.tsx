"use client";

import { Wifi, WifiOff } from "lucide-react";

export interface ConnectionStatusProps {
  connected?: boolean;
  label?: string;
}

export function ConnectionStatus({
  connected = true,
  label,
}: ConnectionStatusProps) {
  const displayLabel = label || (connected ? "Live Stream" : "Disconnected");

  return (
    <div
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
        connected
          ? "bg-[#E8F2E8] text-[#6B9E6B] border-[#D5E8D8]"
          : "bg-[#FDE8E8] text-[#D47A7A] border-[#FCD2D2]"
      }`}
      role="status"
      aria-label={`System connection status: ${displayLabel}`}
    >
      {connected ? (
        <>
          <span className="w-1.5 h-1.5 rounded-full bg-[#6B9E6B] animate-pulse-soft" />
          <Wifi className="w-3.5 h-3.5" aria-hidden="true" />
        </>
      ) : (
        <>
          <span className="w-1.5 h-1.5 rounded-full bg-[#D47A7A]" />
          <WifiOff className="w-3.5 h-3.5" aria-hidden="true" />
        </>
      )}
      <span className="font-mono text-[11px]">{displayLabel}</span>
    </div>
  );
}
