"use client";

import { useState, useEffect, useCallback } from "react";
import { AppShell } from "@/components/AppShell";
import { SaasDashboard } from "@/components/SaasDashboard";

export default function SaasPage() {
  return (
    <AppShell
      tenantId="tenant_acme_corp"
      tenantName="Acme Corp"
    >
      <SaasDashboard tenantId="tenant_acme_corp" />
    </AppShell>
  );
}