import type { PersonaAccent } from "@/lib/landing/conversionData";
import type { LandingAsset } from "@/lib/landingAssets";

export const VibeBtn =
  "btn-cta rounded-full font-bold text-white transition-transform hover:scale-[1.03] active:scale-100";

/** Real VibePin asset thumbnail (pin_sample / product). Plain <img> so any CDN host
 *  loads; dark fallback tile when no asset is available. Parent must be relative. */
export function AssetImg({ asset, label }: { asset?: LandingAsset; label?: string }) {
  if (asset?.imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={asset.imageUrl} alt={asset.title} loading="lazy" className="absolute inset-0 w-full h-full object-cover" style={{ objectPosition: asset.objectPosition ?? "center" }} />;
  }
  return (
    <div className="absolute inset-0 flex items-center justify-center text-[7px] font-semibold uppercase tracking-wide" style={{ background: "linear-gradient(135deg,#141622,#0b0d15)", color: "#2A2F3E" }}>
      {label ?? "VibePin"}
    </div>
  );
}

export const SECTION = "py-24 lg:py-32 border-t";
export const CONTAINER = "max-w-[1280px] mx-auto px-6 lg:px-8";

export function GradientText({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        background: "linear-gradient(100deg,#FF4D8D,#D946EF 55%,#A855F7)",
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
      }}
    >
      {children}
    </span>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="text-[11px] font-bold uppercase tracking-[0.2em] mb-4"
      style={{ color: "#A855F7" }}
    >
      {children}
    </p>
  );
}

const ACCENT: Record<
  PersonaAccent,
  { icon: string; border: string; bg: string; text: string }
> = {
  pink: {
    icon: "rgba(217,70,239,0.16)",
    border: "rgba(217,70,239,0.22)",
    bg: "rgba(217,70,239,0.08)",
    text: "#E879F9",
  },
  green: {
    icon: "rgba(16,185,129,0.16)",
    border: "rgba(16,185,129,0.22)",
    bg: "rgba(16,185,129,0.08)",
    text: "#10B981",
  },
  purple: {
    icon: "rgba(168,85,247,0.16)",
    border: "rgba(168,85,247,0.22)",
    bg: "rgba(168,85,247,0.08)",
    text: "#C4B5FD",
  },
  blue: {
    icon: "rgba(56,189,248,0.16)",
    border: "rgba(56,189,248,0.22)",
    bg: "rgba(56,189,248,0.08)",
    text: "#38BDF8",
  },
};

export function accentStyle(accent: PersonaAccent) {
  return ACCENT[accent];
}
