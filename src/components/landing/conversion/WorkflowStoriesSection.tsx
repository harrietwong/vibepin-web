"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import {
  TESTIMONIALS_ENABLED,
  WORKFLOW_STORIES,
  WORKFLOW_TABS,
  type WorkflowPersona,
  type WorkflowStory,
} from "@/lib/landing/conversionData";
import { pickByCategory, take, type LandingAsset } from "@/lib/landingAssets";
import { CONTAINER, GradientText, SECTION, SectionLabel, AssetImg } from "./shared";

function MiniCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border p-3" style={{ background: "#101624", borderColor: "rgba(255,255,255,0.10)" }}>
      <p className="text-[8px] font-bold uppercase tracking-wider mb-2" style={{ color: "#6B7280" }}>{label}</p>
      {children}
    </div>
  );
}

function StatusRow({ title, status, color, bg }: { title: string; status: string; color: string; bg: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[9px] font-semibold text-white truncate">{title}</span>
      <span className="rounded-full px-1.5 py-0.5 text-[7px] font-bold shrink-0" style={{ background: bg, color }}>{status}</span>
    </div>
  );
}

function FourStepPreview({ pins }: { pins: LandingAsset[] }) {
  return (
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-2.5">
      {/* Pin Evidence */}
      <MiniCard label="Pin Evidence">
        <div className="grid grid-cols-2 gap-1 mb-2">{pins.slice(0, 2).map((a, i) => <div key={i} className="relative rounded-md overflow-hidden" style={{ aspectRatio: "3/4" }}><AssetImg asset={a} label="Pin" /></div>)}</div>
        <span className="rounded-full px-1.5 py-0.5 text-[7px] font-bold" style={{ background: "rgba(217,70,239,0.16)", color: "#E879F9" }}>High save potential</span>
      </MiniCard>
      {/* Create Pins */}
      <MiniCard label="Create Pins">
        <div className="grid grid-cols-2 gap-1 mb-2">{pins.slice(2, 6).map((a, i) => <div key={i} className="relative rounded-md overflow-hidden" style={{ aspectRatio: "1/1" }}><AssetImg asset={a} label="Pin" /></div>)}</div>
        <span className="text-[7px] font-semibold" style={{ color: "#FB7185" }}>7 drafts generated</span>
      </MiniCard>
      {/* Weekly Plan */}
      <MiniCard label="Weekly Plan">
        <div className="grid grid-cols-3 gap-1 mb-1">{["Mon", "Wed", "Fri"].map((d, i) => <div key={d}><p className="text-[6px] text-center mb-0.5" style={{ color: "#4B5563" }}>{d}</p><div className="relative rounded-md overflow-hidden" style={{ aspectRatio: "3/4" }}><AssetImg asset={pins[i + 6] ?? pins[i]} label="Pin" /></div></div>)}</div>
        <span className="text-[7px] font-semibold" style={{ color: "#38BDF8" }}>5 scheduled</span>
      </MiniCard>
      {/* Auto-Publish */}
      <MiniCard label="Auto-Publish">
        <div className="space-y-1.5 mb-1">
          <StatusRow title="Boho Living Room" status="Published" color="#10B981" bg="rgba(16,185,129,0.16)" />
          <StatusRow title="Summer Outfit" status="Scheduled" color="#38BDF8" bg="rgba(56,189,248,0.16)" />
          <StatusRow title="Product Roundup" status="Review" color="#9097A0" bg="rgba(148,151,160,0.16)" />
        </div>
      </MiniCard>
    </div>
  );
}

function FeaturedStoryCard({ story, pins }: { story: WorkflowStory; pins: LandingAsset[] }) {
  return (
    <div
      className="rounded-2xl border p-6 sm:p-8 grid lg:grid-cols-[0.82fr_1.18fr] gap-8 items-center"
      style={{ background: "linear-gradient(135deg,#0E1018,#120E1E)", borderColor: "rgba(168,85,247,0.24)", boxShadow: "0 24px 80px rgba(0,0,0,0.22)" }}
    >
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] mb-3" style={{ color: "#E879F9" }}>{story.label}</p>
        <p className="text-xl lg:text-2xl font-semibold text-white leading-relaxed mb-5">{story.statement}</p>
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {story.steps.map((step, i) => (
            <span key={step} className="flex items-center gap-2">
              {i > 0 && <ArrowRight className="w-3 h-3" style={{ color: "#4B5563" }} />}
              <span className="rounded-full px-2.5 py-1 text-[11px] font-semibold" style={{ background: i === story.steps.length - 1 ? "rgba(16,185,129,0.14)" : "rgba(255,255,255,0.05)", color: i === story.steps.length - 1 ? "#10B981" : "#C8CDD6", border: "1px solid rgba(255,255,255,0.08)" }}>{step}</span>
            </span>
          ))}
        </div>
        <p className="text-[12px] font-bold" style={{ color: "#A855F7" }}>{story.result}</p>
      </div>
      <FourStepPreview pins={pins} />
    </div>
  );
}

function SecondaryStoryCard({ story, pins, products }: { story: WorkflowStory; pins: LandingAsset[]; products: LandingAsset[] }) {
  const visual = () => {
    if (story.persona === "seller") {
      return (
        <div className="flex items-center gap-1.5">
          <div className="relative rounded-md overflow-hidden shrink-0" style={{ width: 34, height: 34 }}><AssetImg asset={products[0]} label="Product" /></div>
          <span className="rounded-full px-1.5 py-0.5 text-[8px] font-bold" style={{ background: "rgba(16,185,129,0.16)", color: "#10B981" }}>Score 86</span>
          <ArrowRight className="w-3 h-3" style={{ color: "#4B5563" }} />
          <div className="relative rounded-md overflow-hidden shrink-0" style={{ width: 26, height: 34 }}><AssetImg asset={pins[0]} label="Pin" /></div>
        </div>
      );
    }
    if (story.persona === "affiliate") {
      return (
        <div className="flex items-center gap-1.5">
          {products.slice(1, 3).map((a, i) => <div key={i} className="relative rounded-md overflow-hidden shrink-0" style={{ width: 30, height: 30 }}><AssetImg asset={a} label="Product" /></div>)}
          <span className="rounded-full px-1.5 py-0.5 text-[8px] font-bold" style={{ background: "rgba(168,85,247,0.16)", color: "#C4B5FD" }}>Low comp</span>
          <ArrowRight className="w-3 h-3" style={{ color: "#4B5563" }} />
          <div className="relative rounded-md overflow-hidden shrink-0" style={{ width: 24, height: 30 }}><AssetImg asset={pins[1]} label="Pin" /></div>
        </div>
      );
    }
    // manager
    return (
      <div className="flex items-center gap-1.5">
        {pins.slice(2, 5).map((a, i) => <div key={i} className="relative rounded-md overflow-hidden shrink-0" style={{ width: 24, height: 30 }}><AssetImg asset={a} label="Pin" /></div>)}
        <span className="rounded-full px-1.5 py-0.5 text-[8px] font-bold" style={{ background: "rgba(56,189,248,0.16)", color: "#38BDF8" }}>Scheduled</span>
      </div>
    );
  };
  return (
    <div className="rounded-xl border p-5 h-full flex flex-col transition-transform hover:-translate-y-0.5" style={{ background: "#0C1018", borderColor: "rgba(255,255,255,0.08)" }}>
      <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: "#6B7280" }}>{story.label}</p>
      <p className="text-[13px] leading-relaxed mb-3" style={{ color: "#C8CDD6" }}>{story.statement}</p>
      <div className="rounded-lg border p-2 mb-3 mt-auto" style={{ background: "#0A0E16", borderColor: "rgba(255,255,255,0.06)" }}>{visual()}</div>
      <p className="text-[11px] font-semibold" style={{ color: "#A855F7" }}>{story.result}</p>
    </div>
  );
}

export function WorkflowStoriesSection({ pinSamples, products }: { pinSamples: LandingAsset[]; products: LandingAsset[] }) {
  const [tab, setTab] = useState<WorkflowPersona>("all");
  const pins = pickByCategory(pinSamples, "Home Decor", 9, "Pin");
  const prods = take(products, 4, "Product");

  const filtered = tab === "all" ? WORKFLOW_STORIES : WORKFLOW_STORIES.filter(s => s.persona === tab);
  const featured = filtered[0] ?? WORKFLOW_STORIES[0];
  const secondary = WORKFLOW_STORIES.filter(s => s.id !== featured.id).slice(0, 3);

  if (TESTIMONIALS_ENABLED) return null;

  return (
    <section className={SECTION} style={{ borderColor: "rgba(255,255,255,0.06)" }}>
      <div className={CONTAINER}>
        <div className="text-center max-w-[680px] mx-auto mb-10">
          <SectionLabel>WORKFLOWS FOR EVERY KIND OF PINTEREST GROWER</SectionLabel>
          <h2 className="text-4xl lg:text-5xl font-black text-white tracking-tight leading-[1.08] mb-4">
            See how VibePin fits <GradientText>the way you work.</GradientText>
          </h2>
          <p className="text-[14px] leading-relaxed" style={{ color: "#8B93A1" }}>
            From opportunity research to auto-publishing, VibePin adapts to creators, sellers,
            affiliate marketers, and Pinterest managers.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2 mb-8">
          {WORKFLOW_TABS.map(t => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)} className="rounded-full px-4 py-2 text-[12px] font-semibold transition-all"
              style={tab === t.id ? { background: "linear-gradient(135deg,#D946EF,#7C3AED)", color: "#fff" } : { background: "rgba(255,255,255,0.04)", color: "#9097A0", border: "1px solid rgba(255,255,255,0.08)" }}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="mb-5"><FeaturedStoryCard story={featured} pins={pins} /></div>
        <div className="grid sm:grid-cols-3 gap-4">
          {secondary.map(s => <SecondaryStoryCard key={s.id} story={s} pins={pins} products={prods} />)}
        </div>
      </div>
    </section>
  );
}
