/**
 * Create Pins detector — pure.
 *
 * Produces real, data-driven findings for the Studio generation setup from a small
 * normalized input the page computes from its live state (products, references,
 * creative direction). Kept free of the heavy SelectedCreativeAsset types so it stays
 * easy to unit-test; the Studio page feeds it (optionally via analyzeProductSet /
 * analyzeReferences) from `web/src/lib/studio/*`.
 */
import type { AssistantFinding } from "../types";

export type CreatePinsInput = {
  creativeDirection: string;
  productCount: number;
  /** Products with no usable destination/source link. */
  productsMissingLink: number;
  referenceCount: number;
  /** Smallest side (px) among reference images, when known. */
  smallestReferenceMinDim?: number | null;
};

const DIRECTION_MIN_WORDS = 6;
const REFERENCE_MIN_DIM = 600;

function words(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export function detectCreatePins(input: CreatePinsInput): AssistantFinding[] {
  const out: AssistantFinding[] = [];
  const hasSetup = input.productCount > 0 || input.referenceCount > 0;

  // Weak / incomplete setup — nothing to generate from yet.
  if (!hasSetup) {
    out.push({
      id: "create:setup",
      severity: "suggestion",
      proactive: true,
      title: "Generation setup looks incomplete",
      detail: "Add at least one product or reference image so I can help shape the creative.",
      actions: [{ kind: "explain", label: "Explain", explanation: "Pinterest performs best with a clear subject. Add a product photo or a reference image to anchor the generation." }],
    });
  }

  // Missing product links — a real, actionable problem.
  if (input.productsMissingLink > 0) {
    const n = input.productsMissingLink;
    out.push({
      id: "create:missing-links",
      severity: "issue",
      proactive: true,
      title: `${n} product${n === 1 ? " is" : "s are"} missing links`,
      detail: "Pins without a destination link can't drive traffic. Add a link before generating.",
      actions: [
        { kind: "review", label: "Review", explanation: "Open the product setup to add the missing destination links." },
        { kind: "explain", label: "Explain", explanation: "A product link becomes the Pin's destination URL — without it the Pin has nowhere to send clicks." },
      ],
    });
  }

  // Creative direction too short.
  if (hasSetup && words(input.creativeDirection) < DIRECTION_MIN_WORDS) {
    out.push({
      id: "create:direction-short",
      severity: "suggestion",
      proactive: true,
      title: "Creative direction is too short",
      detail: "A richer brief (style, mood, setting, audience) produces stronger, more on-brand Pins.",
      actions: [
        { kind: "review", label: "Review", explanation: "Expand your creative direction with style, mood, and setting cues." },
        { kind: "explain", label: "Explain", explanation: "The creative direction steers the image model. One or two vivid sentences beat a few words." },
      ],
    });
  }

  // Reference image may be too small.
  if (input.referenceCount > 0 && typeof input.smallestReferenceMinDim === "number" && input.smallestReferenceMinDim < REFERENCE_MIN_DIM) {
    out.push({
      id: "create:ref-small",
      severity: "suggestion",
      proactive: true,
      title: "Reference image may be too small",
      detail: `A reference is under ${REFERENCE_MIN_DIM}px on its shortest side, which can weaken style transfer.`,
      actions: [{ kind: "explain", label: "Explain", explanation: "Low-resolution references give the model less detail to imitate. Use a larger source image where possible." }],
    });
  }

  // Optional creative help — hidden until the user asks for angles/ideas in chat.
  out.push({
    id: "create:angles",
    severity: "suggestion",
    proactive: false,
    triggers: ["angle", "idea", "content", "suggest", "pinterest"],
    title: "Try 3 Pinterest-friendly angles",
    detail: hasSetup
      ? "Get three content angles tailored to your products and niche."
      : "Add products to get angles tailored to them.",
    actions: [{ kind: "explain", label: "Explain", explanation: "Pinterest rewards specific, benefit-led angles (e.g. \"styling ideas\", \"gift guide\", \"before & after\"). I can suggest three that fit your setup." }],
  });

  return out;
}
