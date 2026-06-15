import { LandingAudienceSection } from "./LandingAudienceSection";
import { SupportedNichesStrip } from "./SupportedNichesStrip";
import { WorkflowStoriesSection } from "./WorkflowStoriesSection";
import { PricingSection } from "./PricingSection";
import { FaqSection } from "./FaqSection";
import { FinalConversionCTA } from "./FinalConversionCTA";
import { LandingFooter } from "./LandingFooter";

export function LandingConversionBlock() {
  return (
    <>
      <LandingAudienceSection />
      <SupportedNichesStrip />
      <WorkflowStoriesSection />
      <PricingSection />
      <FaqSection />
      <FinalConversionCTA />
      <LandingFooter />
    </>
  );
}
