import { PERSONAS } from "@/lib/landing/conversionData";
import type { LandingAsset } from "@/lib/landingAssets";
import { CONTAINER, GradientText, SECTION, SectionLabel } from "./shared";
import { PersonaCard } from "./PersonaCard";

export function LandingAudienceSection({ pinSamples, products }: { pinSamples: LandingAsset[]; products: LandingAsset[] }) {
  return (
    <section id="audience" className={SECTION} style={{ borderColor: "rgba(255,255,255,0.06)" }}>
      <div className={CONTAINER}>
        <div className="text-center max-w-[720px] mx-auto mb-14">
          <SectionLabel>BUILT FOR PINTEREST GROWTH</SectionLabel>
          <h2 className="text-4xl lg:text-5xl font-black text-white tracking-tight leading-[1.08] mb-5">
            Built for the way <br className="hidden sm:block" />
            <GradientText>you grow on Pinterest.</GradientText>
          </h2>
          <p className="text-[15px] leading-relaxed" style={{ color: "#8B93A1" }}>
            Whether you create content, sell products, promote affiliate offers, or manage
            accounts, VibePin connects research, creation, scheduling, and publishing in one
            workflow.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
          {PERSONAS.map(p => (
            <PersonaCard key={p.id} data={p} pinSamples={pinSamples} products={products} />
          ))}
        </div>
      </div>
    </section>
  );
}
