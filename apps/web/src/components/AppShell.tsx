"use client";

import { useState, useEffect, ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  AlertTriangle,
  Server,
  Database,
  Users,
  Shield,
  ChevronLeft,
  ChevronRight,
  Menu,
  X,
  Wifi,
  WifiOff,
  Bell,
  BellOff,
  Settings,
  Building2,
  ChevronDown,
  CheckCircle,
} from "lucide-react";

interface AppShellProps {
  children: ReactNode;
  tenantId?: string;
  tenantName?: string;
  sseConnected?: boolean;
  outageMode?: boolean;
  onTenantChange?: (tenantId: string) => void;
  onToggleOutage?: () => void;
}

const TENANTS = [
  { id: "tenant_acme_corp", name: "Acme Corp", region: "ap-south-1" },
  { id: "tenant_globex_ind", name: "Globex Industries", region: "eu-central-1" },
  { id: "tenant_demo", name: "Demo Tenant", region: "us-east-1" },
];

const NAV_ITEMS = [
  { href: "/saas", label: "SaaS Dashboard", icon: LayoutDashboard, description: "Fleet overview & SLA metrics" },
  { href: "/aiops", label: "AIOps Engine", icon: AlertTriangle, description: "Incidents & explainable RCA" },
  { href: "/collector", label: "Collector", icon: Server, description: "Tier 1 local collector status" },
  { href: "/proof", label: "Egress Proof", icon: Shield, description: "Side-by-side raw vs redacted" },
];

export function AppShell({
  children,
  tenantId = "tenant_acme_corp",
  tenantName = "Acme Corp",
  sseConnected = false,
  outageMode = false,
  onTenantChange,
  onToggleOutage,
}: AppShellProps) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [tenantMenuOpen, setTenantMenuOpen] = useState(false);

  const currentTenant = TENANTS.find(t => t.id === tenantId) || TENANTS[0];

  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [pathname]);

  const handleTenantChange = (newTenantId: string) => {
    onTenantChange?.(newTenantId);
    setTenantMenuOpen(false);
  };

  return (
    <div className="shell">
      {/* Mobile overlay */}
      {mobileSidebarOpen && (
        <div
          className="shell-mobile-overlay"
          onClick={() => setMobileSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Mobile sidebar */}
      <aside
        className={`shell-mobile-sidebar ${mobileSidebarOpen ? "open" : "closed"}`}
        aria-label="Mobile navigation"
      >
        <div className="shell-sidebar-header flex items-center justify-between">
          <span className="font-display font-semibold text-[#1A1918]">CICADA 2026</span>
          <button
            onClick={() => setMobileSidebarOpen(false)}
            className="btn-ghost p-2"
            aria-label="Close sidebar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <nav className="shell-sidebar-nav" role="navigation" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href;
            return (
              <button
                key={item.href}
                onClick={() => setMobileSidebarOpen(false)}
                className={`shell-sidebar-item w-full text-left ${isActive ? "active" : ""}`}
                aria-current={isActive ? "page" : undefined}
              >
                <item.icon className="icon" aria-hidden="true" />
                <div className="flex-1 text-left">
                  <div className="font-medium">{item.label}</div>
                  <div className="text-xs text-[#7A746E]">{item.description}</div>
                </div>
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Desktop sidebar */}
      <aside className="shell-sidebar" aria-label="Main navigation">
        <div className="shell-sidebar-header">
          <Link href="/saas" className="font-display font-semibold text-[#1A1918] flex items-center gap-2">
            <Database className="w-6 h-6 text-[#EFC2AE]" aria-hidden="true" />
            CICADA 2026
          </Link>
        </div>
        <nav className="shell-sidebar-nav" role="navigation" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`shell-sidebar-item ${isActive ? "active" : ""}`}
                aria-current={isActive ? "page" : undefined}
              >
                <item.icon className="icon" aria-hidden="true" />
                <div className="flex-1 text-left">
                  <div className="font-medium">{item.label}</div>
                  <div className="text-xs text-[#7A746E]">{item.description}</div>
                </div>
              </Link>
            );
          })}
        </nav>
        <div className="p-3 border-t border-[#ECE7E2]">
          <div className="text-xs text-[#7A746E] flex items-center gap-1">
            <Wifi className="w-3 h-3" aria-hidden="true" />
            SSE: {sseConnected ? "Connected" : "Disconnected"}
          </div>
          <div className="text-xs text-[#7A746E] flex items-center gap-1 mt-1">
            {outageMode ? (
              <>
                <WifiOff className="w-3 h-3 text-[#D47A7A]" aria-hidden="true" />
                Ingest: Outage Mode
              </>
            ) : (
              <>
                <Wifi className="w-3 h-3 text-[#6B9E6B]" aria-hidden="true" />
                Ingest: Healthy
              </>
            )}
          </div>
        </div>
      </aside>

      {/* Header */}
      <header className="shell-header" role="banner">
        <div className="shell-nav">
          {/* Mobile menu button */}
          <button
            onClick={() => setMobileSidebarOpen(true)}
            className="lg:hidden btn-ghost p-2"
            aria-label="Open navigation menu"
            aria-expanded={mobileSidebarOpen}
          >
            <Menu className="w-6 h-6" aria-hidden="true" />
          </button>

          {/* Brand - desktop only */}
          <Link href="/saas" className="shell-nav-brand hidden lg:flex">
            <Database className="w-6 h-6 text-[#EFC2AE]" aria-hidden="true" />
            <span>CICADA 2026</span>
          </Link>

          {/* Desktop nav links */}
          <nav className="shell-nav-links" role="navigation" aria-label="Primary navigation">
            {NAV_ITEMS.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`shell-nav-link ${isActive ? "active" : ""}`}
                  aria-current={isActive ? "page" : undefined}
                >
                  <div className="flex items-center gap-1.5">
                    <item.icon className="w-4 h-4" aria-hidden="true" />
                    <span>{item.label}</span>
                  </div>
                </Link>
              );
            })}
          </nav>

          {/* Header actions */}
          <div className="shell-nav-actions flex items-center gap-3">
            {/* Tenant switcher */}
            <div className="relative">
              <button
                onClick={() => setTenantMenuOpen(!tenantMenuOpen)}
                className="tenant-badge flex items-center gap-2"
                aria-haspopup="true"
                aria-expanded={tenantMenuOpen}
                aria-label={`Current tenant: ${currentTenant.name}`}
              >
                <Building2 className="w-4 h-4" aria-hidden="true" />
                <span className="hidden sm:inline">{currentTenant.name}</span>
                <span className="dot hidden sm:inline-block" aria-hidden="true" />
                <ChevronDown className="w-4 h-4" aria-hidden="true" />
              </button>

              {tenantMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setTenantMenuOpen(false)}
                    aria-hidden="true"
                  />
                  <div className="absolute right-0 top-full mt-2 z-50 card-base shadow-elevated rounded-[12px] min-w-[220px] py-2">
                    {TENANTS.map((tenant) => (
                      <button
                        key={tenant.id}
                        onClick={() => handleTenantChange(tenant.id)}
                        className={`w-full px-4 py-2 text-left text-sm flex items-center gap-3 ${
                          tenant.id === tenantId ? "gradient-blush-sand text-[#1A1918]" : "text-[#7A746E] hover:bg-[#F0EDE8]"
                        }`}
                        role="menuitem"
                        aria-selected={tenant.id === tenantId}
                      >
                        <Building2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                        <div className="flex-1 text-left">
                          <div className="font-medium">{tenant.name}</div>
                          <div className="text-xs text-[#7A746E] font-mono">{tenant.region}</div>
                        </div>
                        {tenant.id === tenantId && (
                          <CheckCircle className="w-4 h-4 text-[#6B9E6B]" aria-hidden="true" />
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Connection status */}
            <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 card-base rounded-full">
              {sseConnected ? (
                <Wifi className="w-4 h-4 text-[#6B9E6B]" aria-hidden="true" />
              ) : (
                <WifiOff className="w-4 h-4 text-[#D47A7A]" aria-hidden="true" />
              )}
              <span className="text-sm font-medium text-[#1A1918]">
                {sseConnected ? "Live" : "Offline"}
              </span>
            </div>

            {/* Outage toggle */}
            <button
              onClick={onToggleOutage}
              className={`btn-secondary px-3 py-1.5 ${outageMode ? "bg-[#FDE8E8] text-[#D47A7A] border-[#FDE8E8]" : ""}`}
              aria-pressed={outageMode}
            >
              {outageMode ? (
                <>
                  <WifiOff className="w-4 h-4" aria-hidden="true" />
                  <span>Outage Mode</span>
                </>
              ) : (
                <>
                  <Wifi className="w-4 h-4" aria-hidden="true" />
                  <span>Simulate Outage</span>
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="shell-main" role="main">
        {children}
      </main>

      {/* Footer */}
      <footer className="shell-footer" role="contentinfo">
        <div className="max-w-full mx-auto flex items-center justify-between">
          <span>CICADA 2026 — Secure AIOps Control Plane</span>
          <span className="font-mono text-xs">Hybrid Z-Score + LLM RCA</span>
        </div>
      </footer>
    </div>
  );
}