"use client";

import { useState } from "react";
import { AiopsDashboard } from "@/components/AiopsDashboard";

export default function AiopsPage() {
  const [tenantId, setTenantId] = useState("tenant_acme_corp");

  return <AiopsDashboard tenantId={tenantId} onTenantChange={setTenantId} />;
}
