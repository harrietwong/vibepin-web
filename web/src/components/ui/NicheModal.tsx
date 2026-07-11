"use client";
import { useState } from "react";
import { Check, X } from "lucide-react";
import { NICHES, type NicheId } from "@/lib/niches";

interface NicheModalProps {
  initial?: NicheId[];
  onSave: (niches: NicheId[]) => void;
  onClose: () => void;
}

export function NicheModal({ initial = [], onSave, onClose }: NicheModalProps) {
  const [draft, setDraft] = useState<NicheId[]>(initial);

  function toggle(id: NicheId) {
    setDraft((prev) =>
      prev.includes(id) ? prev.filter((n) => n !== id) : [...prev, id],
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-md rounded-2xl bg-white shadow-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 rounded-full p-1.5 hover:bg-gray-100 transition-colors"
        >
          <X className="w-4 h-4 text-gray-400" />
        </button>

        <div className="mb-5">
          <h2 className="text-[17px] font-black text-gray-900">Choose your niches</h2>
          <p className="text-[12px] text-gray-500 mt-1 leading-relaxed">
            VibePin will personalize opportunities, viral pins, and product signals around your focus.
          </p>
        </div>

        <div className="flex flex-wrap gap-2 mb-6">
          {NICHES.map((niche) => {
            const active = draft.includes(niche.id);
            return (
              <button
                key={niche.id}
                type="button"
                onClick={() => toggle(niche.id)}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[12px] font-medium border transition-all"
                style={
                  active
                    ? { background: "rgba(192,38,211,0.08)", color: "#C026D3", borderColor: "rgba(192,38,211,0.3)" }
                    : { background: "#F9FAFB", color: "#6B7280", borderColor: "#E5E7EB" }
                }
              >
                {active && <Check className="w-3 h-3 shrink-0" />}
                {niche.label}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => draft.length > 0 && onSave(draft)}
          disabled={draft.length === 0}
          className="w-full py-3 rounded-full text-[13px] font-bold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-105"
          style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}
        >
          Save and personalize
        </button>

        {draft.length === 0 && (
          <p className="text-center text-[10px] text-gray-400 mt-2">Select at least one niche to continue</p>
        )}
      </div>
    </div>
  );
}
