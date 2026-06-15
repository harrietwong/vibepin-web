"use client";

import Link from "next/link";
import { ArrowRight, Check, PenLine, ShoppingBag, Target, Users } from "lucide-react";
import type { PersonaCardData } from "@/lib/landing/conversionData";
import { accentStyle } from "./shared";

const ICONS = {
  creators: PenLine,
  sellers: ShoppingBag,
  affiliate: Target,
  managers: Users,
} as const;

function PreviewMock({ accent }: { accent: PersonaCardData["accent"] }) {
  const c = accentStyle(accent);
  return (
    <div
      className="pointer-events-none absolute -right-4 -bottom-4 w-[55%] opacity-[0.14] select-none"
      aria-hidden
    >
      <div
        className="rounded-xl border p-2 space-y-1.5"
        style={{ background: "#0A0E16", borderColor: c.border }}
      >
        <div className="grid grid-cols-3 gap-1">
          {[0, 1, 2].map(i => (
            <div
              key={i}
              className="rounded-md"
              style={{ aspectRatio: "2/3", background: c.bg }}
            />
          ))}
        </div>
        <div className="h-1.5 rounded-full w-2/3" style={{ background: c.bg }} />
      </div>
    </div>
  );
}

export function PersonaCard({ data }: { data: PersonaCardData }) {
  const Icon = ICONS[data.id as keyof typeof ICONS] ?? PenLine;
  const c = accentStyle(data.accent);

  return (
    <article
      className="relative flex flex-col rounded-2xl border p-6 overflow-hidden transition-transform hover:-translate-y-1"
      style={{
        background: "linear-gradient(180deg,#0C1018,#0A0C14)",
        borderColor: "rgba(255,255,255,0.08)",
      }}
    >
      <PreviewMock accent={data.accent} />
      <span
        className="h-10 w-10 rounded-xl flex items-center justify-center mb-4"
        style={{ background: c.icon, color: c.text, border: `1px solid ${c.border}` }}
      >
        <Icon className="w-5 h-5" />
      </span>
      <p className="text-[11px] font-bold uppercase tracking-wider mb-1" style={{ color: c.text }}>
        {data.title}
      </p>
      <h3 className="text-[17px] font-black text-white tracking-tight mb-2 leading-snug">
        {data.outcome}
      </h3>
      <p className="text-[13px] leading-relaxed mb-4 flex-1" style={{ color: "#8B93A1" }}>
        {data.description}
      </p>
      <ul className="space-y-2 mb-4">
        {data.benefits.map(b => (
          <li key={b} className="flex items-start gap-2 text-[12px]" style={{ color: "#C8CDD6" }}>
            <Check className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: c.text }} />
            {b}
          </li>
        ))}
      </ul>
      <p
        className="text-[10px] font-semibold uppercase tracking-wider mb-3"
        style={{ color: "#4B5563" }}
      >
        {data.workflow}
      </p>
      <Link
        href={data.ctaHref}
        className="inline-flex items-center gap-1.5 text-[13px] font-bold transition-opacity hover:opacity-80"
        style={{ color: c.text }}
      >
        {data.cta} <ArrowRight className="w-3.5 h-3.5" />
      </Link>
    </article>
  );
}
