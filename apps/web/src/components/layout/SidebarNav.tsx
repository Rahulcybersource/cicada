"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Activity,
  AlertTriangle,
  Building2,
  ShieldCheck,
  Server,
  Database,
  Shield,
  Layers,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
}

export const MAIN_NAV_ITEMS: NavItem[] = [
  {
    href: "/dashboard",
    label: "Overview",
    icon: LayoutDashboard,
    description: "Fleet overview & SLA compliance",
  },
  {
    href: "/metrics",
    label: "Metrics",
    icon: Activity,
    description: "Time-series signals & drift",
  },
  {
    href: "/alerts",
    label: "Logs & Alerts",
    icon: AlertTriangle,
    description: "Triage & explainable RCA",
  },
  {
    href: "/tenants",
    label: "Tenants",
    icon: Building2,
    description: "Tenant isolation & quotas",
  },
  {
    href: "/health",
    label: "System Health",
    icon: ShieldCheck,
    description: "Pipeline & node status",
  },
];

export const LEGACY_NAV_ITEMS: NavItem[] = [
  {
    href: "/saas",
    label: "SaaS Control Plane",
    icon: Database,
    description: "Tier 2 multi-tenant core",
  },
  {
    href: "/aiops",
    label: "AIOps Engine",
    icon: Layers,
    description: "Multivariate Z-score RCA",
  },
  {
    href: "/collector",
    label: "Edge Collector",
    icon: Server,
    description: "Tier 1 local telemetry",
  },
  {
    href: "/proof",
    label: "Egress Proof",
    icon: Shield,
    description: "Raw vs redacted logs",
  },
];

export interface SidebarNavProps {
  onItemClick?: () => void;
}

export function SidebarNav({ onItemClick }: SidebarNavProps) {
  const pathname = usePathname();

  return (
    <div className="flex flex-col h-full">
      {/* Primary 5 Solarius Sections */}
      <div className="px-3 pt-3 pb-2">
        <span className="text-[11px] font-semibold text-[#A8A29E] uppercase tracking-wider px-3 mb-2 block">
          Platform Views
        </span>
        <nav className="space-y-1" role="navigation" aria-label="Primary Solarius Navigation">
          {MAIN_NAV_ITEMS.map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href === "/dashboard" && pathname === "/") ||
              (item.href === "/alerts" && pathname === "/logs");
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onItemClick}
                className={`shell-sidebar-item ${isActive ? "active" : ""}`}
                aria-current={isActive ? "page" : undefined}
              >
                <item.icon className="icon" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium tracking-tight text-[#18181B] truncate">
                    {item.label}
                  </div>
                  <div className="text-[11px] text-[#78716C] truncate">
                    {item.description}
                  </div>
                </div>
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Platform Deep Dives (Backward Compatibility) */}
      <div className="px-3 pt-3 pb-4 border-t border-[#ECE7E2] mt-auto">
        <span className="text-[11px] font-semibold text-[#A8A29E] uppercase tracking-wider px-3 mb-2 block">
          Tier Deep Dives
        </span>
        <nav className="space-y-1" role="navigation" aria-label="Deep Dive Navigation">
          {LEGACY_NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onItemClick}
                className={`flex items-center gap-2.5 px-3 py-1.5 text-xs font-medium rounded-[8px] transition-colors ${
                  isActive
                    ? "gradient-blush-sand text-[#18181B] font-semibold shadow-card"
                    : "text-[#78716C] hover:text-[#18181B] hover:bg-white"
                }`}
                aria-current={isActive ? "page" : undefined}
              >
                <item.icon className="w-4 h-4 shrink-0 text-[#78716C]" />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
