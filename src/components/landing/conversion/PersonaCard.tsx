"use client";

import Link from "next/link";
import { ArrowRight, Check, PenLine, ShoppingBag, Target, Users } from "lucide-react";
import type { PersonaCardData } from "@/lib/landing/conversionData";
import { pickByCategory, take, type LandingAsset } from "@/lib/landingAssets";
import { accentStyle, AssetImg } from "./shared";

const ICONS = {
  creators: PenLine,
  sellers: ShoppingBag,
  affiliate: Target,
  managers: Users,
} as const;

// ── Per-persona preview blocks (real assets) ──────────────────────────────────
function CreatorsPreview({ pins }: { pins: LandingAsset[] }) {
  return (
    <div className="rounded-xl border p-2.5" style={{ background: "#0A0E16", borderColor: "rgba(255,255,255,0.08)" }}>
      <div className="flex gap-1 mb-2">
        <span className="rounded-md px-1.5 py-0.5 text-[8px] font-bold" style={{ background: "rgba(217,70,239,0.16)", color: "#E879F9" }}>Trending topic</span>
        <span className="rounded-md px-1.5 py-0.5 text-[8px] font-semibold" style={{ background: "rgba(255,255,255,0.05)", color: "#9097A0" }}>Bedroom decor ideas</span>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {pins.slice(0, 3).map((a, i) => <div key={i} className="relative rounded-lg overflow-hidden" style={{ aspectRatio: "3/4" }}><AssetImg asset={a} label="Pin" /></div>)}
      </div>
    </div>
  );
}

function ProductPreview({ product, name, sub, score }: { product?: LandingAsset; name: string; sub: string; score: number }) {
  return (
    <div className="rounded-xl border p-2.5 flex items-center gap-3" style={{ background: "#0A0E16", borderColor: "rgba(255,255,255,0.08)" }}>
      <div className="relative rounded-lg overflow-hidden shrink-0" style={{ width: 56, height: 56 }}><AssetImg asset={product} label="Product" /></div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-bold text-white leading-tight truncate">{name}</p>
        <p className="text-[9px] mb-1" style={{ color: "#6B7280" }}>{sub}</p>
        <div className="flex items-center gap-2">
          <span><span className="text-[8px]" style={{ color: "#4B5563" }}>Score </span><span className="text-[13px] font-black" style={{ color: "#10B981", fontFamily: "'JetBrains Mono',monospace" }}>{score}</span></span>
          <span className="rounded-full px-1.5 py-0.5 text-[8px] font-bold" style={{ background: "rgba(16,185,129,0.16)", color: "#10B981" }}>● High</span>
        </div>
      </div>
    </div>
  );
}

function ManagersPreview({ pins }: { pins: LandingAsset[] }) {
  const days = ["Mon", "Tue", "Wed"];
  return (
    <div className="rounded-xl border p-2.5" style={{ background: "#0A0E16", borderColor: "rgba(255,255,255,0.08)" }}>
      <div className="grid grid-cols-3 gap-1.5">
        {days.map((d, i) => (
          <div key={d}>
            <p className="text-[8px] font-bold mb-1" style={{ color: "#6B7280" }}>{d}</p>
            <div className="relative rounded-lg overflow-hidden mb-1" style={{ aspectRatio: "3/4" }}><AssetImg asset={pins[i]} label="Pin" /></div>
            <span className="block rounded px-1 py-0.5 text-[7px] font-bold text-center" style={{ background: "rgba(56,189,248,0.16)", color: "#38BDF8" }}>Scheduled</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PersonaPreview({ id, pinSamples, products }: { id: string; pinSamples: LandingAsset[]; products: LandingAsset[] }) {
  const pins = pickByCategory(pinSamples, "Home Decor", 6, "Pin");
  const prod = take(products, 2, "Product");
  if (id === "creators") return <CreatorsPreview pins={pins} />;
  if (id === "sellers") return <ProductPreview product={prod[0]} name="Ceramic Stone Vase" sub="Neutral Beige" score={86} />;
  if (id === "affiliate") return <ProductPreview product={prod[1]} name="Portable Blender" sub="High-intent product" score={84} />;
  return <ManagersPreview pins={pins.slice(3, 6)} />;
}

export function PersonaCard({ data, pinSamples, products }: { data: PersonaCardData; pinSamples: LandingAsset[]; products: LandingAsset[] }) {
  const Icon = ICONS[data.id as keyof typeof ICONS] ?? PenLine;
  const c = accentStyle(data.accent);

  return (
    <article
      className="relative flex h-full flex-col rounded-2xl border p-5 xl:p-6 overflow-hidden transition-transform hover:-translate-y-1"
      style={{ background: "linear-gradient(180deg,#0d1220,#0A0C14)", borderColor: "rgba(255,255,255,0.08)" }}
    >
      <span className="pointer-events-none absolute -top-16 -right-16 h-40 w-40 rounded-full blur-3xl" style={{ background: c.bg }} aria-hidden />
      <div className="relative flex items-center gap-2.5 mb-3">
        <span className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: c.icon, color: c.text, border: `1px solid ${c.border}` }}><Icon className="w-4 h-4" /></span>
        <div>
          <p className="text-[12px] font-black text-white leading-tight">{data.title}</p>
          <p className="text-[11px]" style={{ color: c.text }}>{data.outcome}</p>
        </div>
      </div>

      <div className="relative mb-4"><PersonaPreview id={data.id} pinSamples={pinSamples} products={products} /></div>

      <ul className="relative space-y-2 mb-4">
        {data.benefits.map(b => (
          <li key={b} className="flex items-start gap-2 text-[12px]" style={{ color: "#C8CDD6" }}>
            <Check className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: c.text }} />
            {b}
          </li>
        ))}
      </ul>

      <div className="relative mt-auto pt-3 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: "#4B5563" }}>{data.workflow}</p>
        <Link href={data.ctaHref} className="inline-flex items-center gap-1.5 text-[13px] font-bold transition-opacity hover:opacity-80" style={{ color: c.text }}>
          {data.cta} <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
    </article>
  );
}
