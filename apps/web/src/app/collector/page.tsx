"use client";

import { AppShell } from "@/components/AppShell";
import { CollectorDashboard } from "@/components/CollectorDashboard";

export default function CollectorPage() {
  return (
    <AppShell
      tenantId="tenant_acme_corp"
      tenantName="Acme Corp"
    >
      <CollectorDashboard tenantId="tenant_acme_corp" />
    </AppShell>
  );
}