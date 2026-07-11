"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { FAQ_ITEMS } from "@/lib/landing/conversionData";
import { CONTAINER, GradientText, SECTION, SectionLabel } from "./shared";

export function FaqAccordionItem({
  question,
  answer,
  note,
  defaultOpen = false,
}: {
  question: string;
  answer: string;
  note?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className="rounded-xl border overflow-hidden transition-colors"
      style={{
        borderColor: open ? "rgba(217,70,239,0.30)" : "rgba(255,255,255,0.08)",
        background: open ? "rgba(217,70,239,0.04)" : "transparent",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-left text-[14px] font-semibold transition-colors hover:text-white"
        style={{ color: open ? "#E5E7EB" : "#D1D5DB" }}
      >
        {question}
        <span
          className={`ml-4 text-xl leading-none transition-transform duration-200 shrink-0 ${open ? "rotate-45" : ""}`}
          style={{ color: open ? "#E879F9" : "#4B5563" }}
        >
          +
        </span>
      </button>
      {open && (
        <div className="px-5 pb-5">
          <p className="text-[13px] leading-relaxed" style={{ color: "#8B93A1" }}>
            {answer}
          </p>
          {note && (
            <p className="text-[11px] mt-3 leading-relaxed" style={{ color: "#6B7280" }}>
              {note}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function FaqSection() {
  return (
    <section className={SECTION} style={{ borderColor: "rgba(255,255,255,0.06)" }}>
      <div className={CONTAINER}>
        <div className="grid lg:grid-cols-[35%_1fr] gap-10 lg:gap-16 items-start">
          <div>
            <SectionLabel>FREQUENTLY ASKED QUESTIONS</SectionLabel>
            <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight leading-[1.08] mb-4">
              Everything you need <GradientText>to start with confidence.</GradientText>
            </h2>
            <p className="text-[14px] leading-relaxed mb-6" style={{ color: "#8B93A1" }}>
              Learn how VibePin finds opportunities, uses Pinterest signals, creates Pins, and
              turns them into scheduled publishing plans.
            </p>
            <Link
              href="mailto:support@vibepin.co"
              className="inline-flex items-center gap-1.5 text-[13px] font-bold transition-opacity hover:opacity-80"
              style={{ color: "#E879F9" }}
            >
              Visit Help Center <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
          <div className="space-y-2.5">
            {FAQ_ITEMS.map((item, i) => (
              <FaqAccordionItem
                key={item.question}
                question={item.question}
                answer={item.answer}
                note={item.note}
                defaultOpen={i === 0}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
