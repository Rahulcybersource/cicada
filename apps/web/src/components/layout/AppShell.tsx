"use client";

import { useState, useEffect, ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Menu,
  X,
  Wifi,
  WifiOff,
  Sun,
  Shield,
} from "lucide-react";
import { TenantSelector } from "./TenantSelector";
import { ConnectionStatus } from "./ConnectionStatus";
import { SidebarNav, MAIN_NAV_ITEMS } from "./SidebarNav";

export interface AppShellProps {
  children: ReactNode;
  tenantId?: string;
  tenantName?: string;
  sseConnected?: boolean;
  outageMode?: boolean;
  onTenantChange?: (tenantId: string) => void;
  onToggleOutage?: () => void;
}

export function AppShell({
  children,
  tenantId = "tenant_acme_corp",
  tenantName = "Acme Corp",
  sseConnected = true,
  outageMode = false,
  onTenantChange,
  onToggleOutage,
}: AppShellProps) {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  return (
    <div className="shell bg-[#F9F7F4] text-[#18181B]">
      {/* Mobile Drawer Overlay */}
      {mobileMenuOpen && (
        <div
          className="shell-mobile-overlay"
          onClick={() => setMobileMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Mobile Drawer */}
      <aside
        className={`shell-mobile-sidebar ${
          mobileMenuOpen ? "open" : "closed"
        }`}
        aria-label="Mobile navigation drawer"
      >
        <div className="shell-sidebar-header flex items-center justify-between bg-[#F8F6F3]">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-[8px] gradient-sage-mist flex items-center justify-center border border-[#ECE7E2]">
              <Sun className="w-4 h-4 text-[#18181B]" />
            </div>
            <div>
              <span className="font-display font-bold text-sm tracking-tight text-[#18181B]">
                SOLARIUS OPS
              </span>
              <span className="block text-[10px] text-[#78716C] -mt-0.5">
                AIOps Observability
              </span>
            </div>
          </div>
          <button
            onClick={() => setMobileMenuOpen(false)}
            className="btn-ghost p-1.5"
            aria-label="Close navigation"
          >
            <X className="w-5 h-5 text-[#78716C]" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <SidebarNav onItemClick={() => setMobileMenuOpen(false)} />
        </div>
      </aside>

      {/* Top Header Bar */}
      <header className="shell-header" role="banner">
        <div className="shell-nav">
          <div className="flex items-center gap-3">
            {/* Hamburger for mobile */}
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden btn-ghost p-2 text-[#18181B]"
              aria-label="Open navigation menu"
              aria-expanded={mobileMenuOpen}
            >
              <Menu className="w-5 h-5" />
            </button>

            {/* Solarius Brand Mark */}
            <Link
              href="/dashboard"
              className="flex items-center gap-2.5 group"
            >
              <div className="w-8 h-8 rounded-[10px] gradient-sage-mist flex items-center justify-center border border-[#ECE7E2] shadow-sm transition-transform group-hover:scale-105">
                <Sun className="w-4.5 h-4.5 text-[#18181B]" />
              </div>
              <div className="hidden sm:block">
                <div className="flex items-center gap-1.5">
                  <span className="font-display font-bold text-base tracking-tight text-[#18181B]">
                    SOLARIUS
                  </span>
                  <span className="text-[11px] font-semibold px-1.5 py-0.2 rounded bg-[#F3E2DB] text-[#18181B] font-mono">
                    OPS
                  </span>
                </div>
                <span className="text-[10px] text-[#78716C] block leading-none">
                  AIOps Observability Control Plane
                </span>
              </div>
            </Link>
          </div>

          {/* Desktop Top Nav Tabs (Fast Switching) */}
          <nav
            className="hidden xl:flex items-center gap-1"
            role="navigation"
            aria-label="Quick Navigation"
          >
            {MAIN_NAV_ITEMS.map((item) => {
              const isActive =
                pathname === item.href ||
                (item.href === "/dashboard" && pathname === "/");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`px-3 py-1.5 text-xs font-medium rounded-[8px] transition-colors ${
                    isActive
                      ? "gradient-blush-sand text-[#18181B] shadow-card font-semibold"
                      : "text-[#78716C] hover:text-[#18181B] hover:bg-[#F8F6F3]"
                  }`}
                  aria-current={isActive ? "page" : undefined}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {/* Top Actions: Tenant Selector, Connection Badge, Outage Simulation */}
          <div className="shell-nav-actions">
            <TenantSelector
              currentTenantId={tenantId}
              onTenantChange={onTenantChange}
            />

            <div className="hidden md:block">
              <ConnectionStatus connected={sseConnected} />
            </div>

            {/* Outage Simulation Trigger */}
            <button
              onClick={onToggleOutage}
              className={`btn-secondary text-xs px-2.5 py-1.5 rounded-[8px] flex items-center gap-1.5 transition-colors ${
                outageMode
                  ? "bg-[#FDE8E8] text-[#D47A7A] border-[#D47A7A]"
                  : "text-[#78716C] hover:text-[#18181B]"
              }`}
              title={
                outageMode
                  ? "Ingestion outage active. Click to restore."
                  : "Simulate edge-to-SaaS ingestion outage"
              }
            >
              {outageMode ? (
                <>
                  <WifiOff className="w-3.5 h-3.5 text-[#D47A7A]" />
                  <span className="font-mono text-[11px] font-semibold">Outage ON</span>
                </>
              ) : (
                <>
                  <Wifi className="w-3.5 h-3.5 text-[#6B9E6B]" />
                  <span className="font-mono text-[11px] hidden sm:inline">Simulate Outage</span>
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Main Workspace Frame */}
      <div className="shell-main">
        {/* Left Desktop Sidebar */}
        <aside className="shell-sidebar bg-[#F8F6F3]" aria-label="Main sidebar navigation">
          <SidebarNav />
        </aside>

        {/* Content Canvas */}
        <main className="shell-content" role="main">
          {children}
        </main>
      </div>

      {/* Footer */}
      <footer className="shell-footer" role="contentinfo">
        <div className="max-w-full mx-auto flex items-center justify-between text-xs text-[#78716C]">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-[#18181B]">SOLARIUS OPS</span>
            <span>•</span>
            <span>Warm Pastel Editorial Observability Platform</span>
          </div>
          <div className="flex items-center gap-3 font-mono text-[11px]">
            <span>Hybrid Z-Score + Explainable LLM RCA</span>
            <span>•</span>
            <span className="text-[#6B9E6B]">Privacy Preserving Egress</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
