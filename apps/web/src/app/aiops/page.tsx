"use client";

import { useState, useEffect, useCallback } from "react";
import { AppShell } from "@/components/AppShell";
import { AiopsDashboard } from "@/components/AiopsDashboard";

export default function AiopsPage() {
  return (
    <AppShell
      tenantId="tenant_acme_corp"
      tenantName="Acme Corp"
    >
      <AiopsDashboard tenantId="tenant_acme_corp" />
    </AppShell>
  );
}