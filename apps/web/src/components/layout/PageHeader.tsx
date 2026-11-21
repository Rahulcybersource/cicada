"use client";

import React, { ReactNode } from "react";

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  breadcrumbs?: { label: string; href?: string }[];
  actions?: ReactNode;
}

export function PageHeader({
  title,
  subtitle,
  badge,
  breadcrumbs,
  actions,
}: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-[#ECE7E2] pb-5">
      <div>
        {breadcrumbs && breadcrumbs.length > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-[#78716C] mb-1.5 font-medium">
            {breadcrumbs.map((b, idx) => (
              <React.Fragment key={idx}>
                {b.href ? (
                  <a
                    href={b.href}
                    className="hover:text-[#18181B] transition-colors"
                  >
                    {b.label}
                  </a>
                ) : (
                  <span>{b.label}</span>
                )}
                {idx < breadcrumbs.length - 1 && (
                  <span className="text-[#A8A29E]">/</span>
                )}
              </React.Fragment>
            ))}
          </div>
        )}
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="font-display text-2xl md:text-3xl font-bold tracking-tight text-[#18181B]">
            {title}
          </h1>
          {badge && <div className="flex items-center">{badge}</div>}
        </div>
        {subtitle && (
          <p className="text-sm text-[#78716C] mt-1.5 max-w-3xl leading-relaxed">
            {subtitle}
          </p>
        )}
      </div>

      {actions && (
        <div className="flex items-center gap-2.5 shrink-0 self-start sm:self-center">
          {actions}
        </div>
      )}
    </div>
  );
}
