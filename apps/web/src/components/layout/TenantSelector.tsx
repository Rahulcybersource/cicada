"use client";

import { useState } from "react";
import { Building2, ChevronDown, CheckCircle } from "lucide-react";

export interface Tenant {
  id: string;
  name: string;
  region: string;
}

export const DEFAULT_TENANTS: Tenant[] = [
  { id: "tenant_acme_corp", name: "Acme Corp", region: "ap-south-1" },
  { id: "tenant_globex_ind", name: "Globex Industries", region: "eu-central-1" },
  { id: "tenant_demo", name: "Demo Tenant", region: "us-east-1" },
];

export interface TenantSelectorProps {
  tenants?: Tenant[];
  currentTenantId?: string;
  onTenantChange?: (tenantId: string) => void;
}

export function TenantSelector({
  tenants = DEFAULT_TENANTS,
  currentTenantId = "tenant_acme_corp",
  onTenantChange,
}: TenantSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const activeTenant =
    tenants.find((t) => t.id === currentTenantId) || tenants[0];

  const handleSelect = (id: string) => {
    onTenantChange?.(id);
    setIsOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="tenant-badge flex items-center gap-2 hover:opacity-95 transition-all cursor-pointer select-none"
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-label={`Current tenant: ${activeTenant.name}`}
      >
        <Building2 className="w-3.5 h-3.5 text-[#18181B] shrink-0" aria-hidden="true" />
        <span className="text-xs font-semibold tracking-wide text-[#18181B] hidden sm:inline">
          {activeTenant.name}
        </span>
        <span className="dot hidden sm:inline-block" aria-hidden="true" />
        <ChevronDown
          className={`w-3.5 h-3.5 text-[#78716C] transition-transform duration-150 ${
            isOpen ? "rotate-180" : ""
          }`}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute right-0 top-full mt-2 z-50 card-base shadow-elevated rounded-[12px] min-w-[240px] py-2 animate-fade-in border border-[#ECE7E2] bg-white" role="listbox" aria-label="Tenants">
            <div className="px-3 py-1.5 border-b border-[#ECE7E2] mb-1">
              <span className="text-[11px] font-semibold text-[#A8A29E] uppercase tracking-wider">
                Select Active Tenant
              </span>
            </div>
            {tenants.map((t) => {
              const isSelected = t.id === currentTenantId;
              return (
                <button
                  key={t.id}
                  onClick={() => handleSelect(t.id)}
                  className={`w-full px-3.5 py-2 text-left text-sm flex items-center gap-3 transition-colors ${
                    isSelected
                      ? "gradient-blush-sand text-[#18181B] font-medium"
                      : "text-[#78716C] hover:bg-[#F8F6F3] hover:text-[#18181B]"
                  }`}
                  role="option"
                  aria-selected={isSelected}
                >
                  <Building2 className="w-4 h-4 shrink-0 text-[#78716C]" aria-hidden="true" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{t.name}</div>
                    <div className="text-[11px] text-[#A8A29E] font-mono">{t.region}</div>
                  </div>
                  {isSelected && (
                    <CheckCircle className="w-4 h-4 text-[#6B9E6B] shrink-0" aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
