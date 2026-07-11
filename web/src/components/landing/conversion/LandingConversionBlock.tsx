import { bohoReferences, bohoProducts } from "@/lib/landing/bohoLivingRoomDemo";
import { LandingAudienceSection } from "./LandingAudienceSection";
import { SupportedNichesStrip } from "./SupportedNichesStrip";
import { WorkflowStoriesSection } from "./WorkflowStoriesSection";
import { PricingSection } from "./PricingSection";
import { FaqSection } from "./FaqSection";
import { FinalConversionCTA } from "./FinalConversionCTA";
import { LandingFooter } from "./LandingFooter";

export function LandingConversionBlock() {
  const pinSamples = bohoReferences;
  const products = bohoProducts;
  return (
    <>
      <LandingAudienceSection pinSamples={pinSamples} products={products} />
      <SupportedNichesStrip />
      <WorkflowStoriesSection pinSamples={pinSamples} products={products} />
      <PricingSection />
      <FaqSection />
      <FinalConversionCTA pinSamples={pinSamples} products={products} />
      <LandingFooter />
    </>
  );
}
