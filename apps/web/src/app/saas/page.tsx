"use client";

import { useState } from "react";
import { SaasDashboard } from "@/components/SaasDashboard";

export default function SaasPage() {
  const [tenantId, setTenantId] = useState("tenant_acme_corp");

  return <SaasDashboard tenantId={tenantId} onTenantChange={setTenantId} />;
}
