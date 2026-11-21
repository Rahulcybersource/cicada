"use client";

// Re-export modular layout AppShell and subcomponents for backward compatibility
export { AppShell } from "./layout/AppShell";
export type { AppShellProps } from "./layout/AppShell";
export { PageHeader } from "./layout/PageHeader";
export type { PageHeaderProps } from "./layout/PageHeader";
export { TenantSelector, DEFAULT_TENANTS } from "./layout/TenantSelector";
export { ConnectionStatus } from "./layout/ConnectionStatus";
export { SidebarNav, MAIN_NAV_ITEMS, LEGACY_NAV_ITEMS } from "./layout/SidebarNav";
