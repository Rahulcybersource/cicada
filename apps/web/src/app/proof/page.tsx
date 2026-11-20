"use client";

import { AppShell } from "@/components/AppShell";
import { ProofDashboard } from "@/components/ProofDashboard";

export default function ProofPage() {
  return (
    <AppShell
      tenantId="tenant_acme_corp"
      tenantName="Acme Corp"
    >
      <ProofDashboard tenantId="tenant_acme_corp" />
    </AppShell>
  );
}