"use client";

import { useState } from "react";
import {
  ArrowRight,
  Bookmark,
  CalendarDays,
  Sparkles,
  Wand2,
} from "lucide-react";
import {
  TESTIMONIALS_ENABLED,
  WORKFLOW_STORIES,
  WORKFLOW_TABS,
  type WorkflowPersona,
  type WorkflowStory,
} from "@/lib/landing/conversionData";
import { CONTAINER, GradientText, SECTION, SectionLabel } from "./shared";

function WorkflowPreview() {
  const tiles = [
    { icon: Bookmark, label: "Pin Ideas", color: "#E879F9" },
    { icon: Wand2, label: "Create Pins", color: "#FF4D8D" },
    { icon: CalendarDays, label: "Weekly Plan", color: "#38BDF8" },
    { icon: Sparkles, label: "Scheduled", color: "#10B981" },
  ];
  return (
    <div className="rounded-xl border p-4" style={{ background: "#0A0E16", borderColor: "rgba(255,255,255,0.08)" }}>
      <div className="grid grid-cols-2 gap-2 mb-3">
        {tiles.slice(0, 3).map(t => (
          <div
            key={t.label}
            className="relative rounded-lg overflow-hidden flex flex-col items-center justify-center gap-1"
            style={{ aspectRatio: "2/3", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
          >
            <t.icon className="w-4 h-4" style={{ color: t.color }} />
            <span className="text-[8px] font-semibold" style={{ color: "#6B7280" }}>{t.label}</span>
          </div>
        ))}
        <div
          className="rounded-lg flex flex-col items-center justify-center gap-1 col-span-1"
          style={{ background: "rgba(16,185,129,0.10)", border: "1px solid rgba(16,185,129,0.25)" }}
        >
          <Sparkles className="w-4 h-4" style={{ color: "#10B981" }} />
          <span className="text-[8px] font-bold" style={{ color: "#10B981" }}>Auto-Publish</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {tiles.map(t => (
          <span
            key={t.label}
            className="rounded-full px-2 py-0.5 text-[9px] font-semibold"
            style={{ background: "rgba(255,255,255,0.04)", color: "#6B7280", border: "1px solid rgba(255,255,255,0.06)" }}
          >
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function FeaturedStoryCard({ story }: { story: WorkflowStory }) {
  return (
    <div
      className="rounded-2xl border p-6 sm:p-8 grid lg:grid-cols-[1fr_minmax(0,280px)] gap-8 items-center"
      style={{
        background: "linear-gradient(135deg,#0E1018,#120E1E)",
        borderColor: "rgba(168,85,247,0.24)",
        boxShadow: "0 24px 80px rgba(0,0,0,0.22)",
      }}
    >
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] mb-2" style={{ color: "#E879F9" }}>
          {story.label}
        </p>
        <p className="text-[17px] sm:text-[19px] font-semibold text-white leading-relaxed mb-5">
          {story.statement}
        </p>
        <div className="flex flex-wrap items-center gap-2 mb-4 text-[11px] font-semibold" style={{ color: "#8B93A1" }}>
          {story.steps.map((step, i) => (
            <span key={step} className="flex items-center gap-2">
              {i > 0 && <ArrowRight className="w-3 h-3" style={{ color: "#4B5563" }} />}
              <span style={{ color: i === story.steps.length - 1 ? "#10B981" : "#C8CDD6" }}>{step}</span>
            </span>
          ))}
        </div>
        <p className="text-[12px] font-bold" style={{ color: "#A855F7" }}>{story.result}</p>
      </div>
      <WorkflowPreview />
    </div>
  );
}

function SecondaryStoryCard({ story }: { story: WorkflowStory }) {
  return (
    <div
      className="rounded-xl border p-5 h-full transition-transform hover:-translate-y-0.5"
      style={{ background: "#0C1018", borderColor: "rgba(255,255,255,0.08)" }}
    >
      <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: "#6B7280" }}>
        {story.label}
      </p>
      <p className="text-[13px] leading-relaxed mb-3" style={{ color: "#C8CDD6" }}>
        {story.statement}
      </p>
      <p className="text-[11px] font-semibold" style={{ color: "#A855F7" }}>{story.result}</p>
    </div>
  );
}

export function WorkflowStoriesSection() {
  const [tab, setTab] = useState<WorkflowPersona>("all");

  const filtered =
    tab === "all" ? WORKFLOW_STORIES : WORKFLOW_STORIES.filter(s => s.persona === tab);
  const featured = filtered[0] ?? WORKFLOW_STORIES[0];
  const secondary = WORKFLOW_STORIES.filter(s => s.id !== featured.id).slice(0, 3);

  if (TESTIMONIALS_ENABLED) {
    return null;
  }

  return (
    <section className={SECTION} style={{ borderColor: "rgba(255,255,255,0.06)" }}>
      <div className={CONTAINER}>
        <div className="text-center max-w-[680px] mx-auto mb-10">
          <SectionLabel>WORKFLOWS FOR EVERY KIND OF PINTEREST GROWER</SectionLabel>
          <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight leading-[1.08] mb-4">
            See how VibePin fits <GradientText>the way you work.</GradientText>
          </h2>
          <p className="text-[14px] leading-relaxed" style={{ color: "#8B93A1" }}>
            From opportunity research to auto-publishing, VibePin adapts to creators, sellers,
            affiliate marketers, and Pinterest managers.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2 mb-8">
          {WORKFLOW_TABS.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className="rounded-full px-4 py-2 text-[12px] font-semibold transition-all"
              style={
                tab === t.id
                  ? { background: "linear-gradient(135deg,#D946EF,#7C3AED)", color: "#fff" }
                  : {
                      background: "rgba(255,255,255,0.04)",
                      color: "#9097A0",
                      border: "1px solid rgba(255,255,255,0.08)",
                    }
              }
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="mb-5">
          <FeaturedStoryCard story={featured} />
        </div>
        <div className="grid sm:grid-cols-3 gap-4">
          {secondary.map(s => (
            <SecondaryStoryCard key={s.id} story={s} />
          ))}
        </div>
      </div>
    </section>
  );
}
