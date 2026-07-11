"use client";

import useSWR from "swr";
import { Clock } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { NICHES, type NicheId, type Scope } from "@/lib/niches";

function fmtAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const h  = Math.floor(ms / 3_600_000);
  if (h < 1)  return "< 1h ago";
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function FreshnessTag() {
  const { data } = useSWR(
    "data-freshness",
    async () => {
      const { data } = await supabase
        .from("pin_samples")
        .select("scraped_at")
        .order("scraped_at", { ascending: false })
        .limit(1)
        .single();
      return (data as { scraped_at: string } | null)?.scraped_at ?? null;
    },
    { revalidateOnFocus: false, dedupingInterval: 300_000 },
  );

  if (!data) return null;

  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-gray-400">
      <Clock className="w-3 h-3" />
      Updated {fmtAgo(data)}
    </span>
  );
}

interface ScopeBarProps {
  scope: Scope;
  selectedNiches: NicheId[];
  onScopeChange: (s: Scope) => void;
  onEditNiches: () => void;
}

export function ScopeBar({ scope, selectedNiches, onScopeChange, onEditNiches }: ScopeBarProps) {
  const nicheLabels = selectedNiches
    .map((id) => NICHES.find((n) => n.id === id)?.label)
    .filter(Boolean) as string[];

  return (
    <div className="flex items-center gap-3 flex-wrap mb-5">
      {/* For You / All Trends toggle */}
      <div className="flex items-center gap-0.5 bg-gray-100 rounded-full p-0.5">
        {(["for_you", "all_trends"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onScopeChange(s)}
            className="px-3.5 py-1.5 rounded-full text-[12px] font-medium transition-all"
            style={
              scope === s
                ? { background: "#FFFFFF", color: "#C026D3", boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }
                : { color: "#9CA3AF" }
            }
          >
            {s === "for_you" ? "For You" : "All Trends"}
          </button>
        ))}
      </div>

      {/* Active niche labels */}
      {scope === "for_you" && nicheLabels.length > 0 && (
        <span className="text-[11px] text-gray-500">
          Showing:{" "}
          <span className="font-semibold text-gray-700">{nicheLabels.join(", ")}</span>
        </span>
      )}

      {scope === "for_you" && nicheLabels.length === 0 && (
        <span className="text-[11px] text-gray-400 italic">No niches selected — showing all</span>
      )}

      {/* Freshness */}
      <FreshnessTag />

      {/* Edit niches */}
      <button
        type="button"
        onClick={onEditNiches}
        className="ml-auto text-[11px] font-medium underline-offset-2 hover:underline transition-colors"
        style={{ color: "#C026D3" }}
      >
        Edit niches
      </button>
    </div>
  );
}
