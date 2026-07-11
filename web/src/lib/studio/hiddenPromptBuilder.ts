// Hidden technical prompt builder (Creative Direction V2).
//
// This prompt is intentionally structured. Products define WHAT appears.
// References define HOW it is photographed when referenceInfluenceMode is strong.
// The backend passes creative_direction_v2 through without enhancer rewriting.

import type { CreativeDirectionRecommendation } from "./creativeDirections";
import type { ProductAnalysis, ProductSetAnalysis } from "./productAnalysis";
import type { ReferenceContext, ReferenceType } from "./referenceAnalysis";
import type { CreativeIntent } from "./creativeIntent";
import type { CategoryPlaybook } from "./categoryPlaybooks";
import type { SelectedCreativeTag } from "./creativeControls";

export type ReferenceInfluenceMode =
  | "layout_scene_strong"
  | "style_mood_balanced"
  | "product_only"
  | "none";

export type HiddenPromptControls = {
  goal?: string;
  subject?: string;
  framing?: string;
  scene?: string;
  style?: string;
  productEmphasis?: string;
  referenceStrength?: string;
  textOverlay?: string;
};

export type HiddenPromptInput = {
  direction: CreativeDirectionRecommendation | null;
  productSet: ProductSetAnalysis;
  references: ReferenceContext;
  intent: CreativeIntent;
  playbook: CategoryPlaybook;
  controls: HiddenPromptControls;
  refinement?: string;
  directionBrief?: string;
  selectedTags?: SelectedCreativeTag[];
  primaryFormatTag?: string;
  opportunityKeyword?: string;
  format?: string;
};

const STRUCTURAL_FASHION_REFERENCE_TYPES: ReferenceType[] = [
  "outfit_on_model",
  "street_style",
  "editorial",
  "mirror_selfie",
  "lifestyle",
];

function clean(s?: string): string {
  return (s ?? "").trim();
}

function hasText(s: string | undefined, pattern: RegExp): boolean {
  return pattern.test(clean(s).toLowerCase());
}

function formatRole(role: string): string {
  return role.replace(/_/g, " ");
}

function productLabel(product: ProductAnalysis): string {
  const role = formatRole(product.role);
  return `${product.title}/${role}`;
}

export function inferReferenceInfluenceMode(input: HiddenPromptInput): ReferenceInfluenceMode {
  const dom = input.references.dominant;
  if (!dom) return "none";

  const directionTitle = `${input.direction?.title ?? ""} ${input.direction?.summary ?? ""}`;
  const refStrength = clean(input.controls.referenceStrength).toLowerCase();

  if (input.direction?.kind === "product_focused") {
    return refStrength === "subtle" ? "product_only" : "style_mood_balanced";
  }

  if (
    input.playbook.id === "fashion" &&
    STRUCTURAL_FASHION_REFERENCE_TYPES.includes(dom.referenceType) &&
    !hasText(directionTitle, /flat\s*lay|product\s*only|catalog|studio/)
  ) {
    return "layout_scene_strong";
  }

  if (refStrength === "strong") return "layout_scene_strong";
  if (refStrength === "subtle") return "product_only";
  return "style_mood_balanced";
}

function fashionPrimarySubject(input: HiddenPromptInput, mode: ReferenceInfluenceMode): string {
  if (input.playbook.id !== "fashion") {
    return input.productSet.hasProducts
      ? `Create a Pinterest-native ${input.playbook.label} image featuring the selected products.`
      : `Create a Pinterest-native ${input.playbook.label} image.`;
  }

  if (input.productSet.hasProducts && mode === "layout_scene_strong") {
    return "Create an original model wearing the selected products together as one coherent outfit.";
  }

  if (input.productSet.hasProducts) {
    return "Create a Pinterest-native fashion image featuring the selected apparel and accessories clearly.";
  }

  return "Create a Pinterest-native fashion image.";
}

function productRequirements(products: ProductAnalysis[]): string[] {
  if (!products.length) return ["No product image was selected; do not invent a specific product."];
  return products.map(p => {
    const notes = [
      `Preserve the selected ${productLabel(p)}.`,
      p.color ? `Keep its ${p.color} color recognizable.` : "",
      p.material ? `Keep its ${p.material} material/texture recognizable.` : "",
      "Keep silhouette, proportion, and key product details visible.",
    ].filter(Boolean);
    return notes.join(" ");
  });
}

function referenceRequirements(input: HiddenPromptInput, mode: ReferenceInfluenceMode): string[] {
  const dom = input.references.dominant;
  if (!dom || mode === "none") return [];

  if (mode === "layout_scene_strong") {
    const requirements = [
      "Use the final input image as the visual reference. Use it as the main guide for scene, framing, composition, and pose energy.",
      "Use the reference image as the main guide for scene type.",
      "Use the reference image to control framing, composition, and pose energy.",
      "Use similar camera distance/framing from the reference.",
      "Use similar candid/editorial pose energy and natural movement.",
      "Use similar Pinterest-native composition and real-world context.",
      "Generate an original person if a person appears; do not copy the reference person's identity, face, likeness, or distinctive personal features.",
    ];
    if (input.playbook.id === "fashion") {
      requirements.splice(
        2,
        0,
        "Use an outdoor urban/street-style setting when the reference indicates street, outdoor, city, lifestyle, or editorial fashion context.",
        "Use full-body or three-quarter fashion framing when the reference is on-model, street-style, mirror, editorial, or lifestyle fashion.",
      );
    }
    return requirements;
  }

  if (mode === "style_mood_balanced") {
    return [
      "Use the final input image as the visual reference.",
      "Use it for composition rhythm, lighting, styling, palette, and mood.",
      "Keep product fidelity stronger than scene matching.",
      "Do not copy any person's identity, face, likeness, or distinctive personal features.",
    ];
  }

  return [
    "Use the reference only as light styling context.",
    "Product fidelity is the priority.",
    "Do not copy any person's identity, face, likeness, or distinctive personal features.",
  ];
}

function avoidList(input: HiddenPromptInput, mode: ReferenceInfluenceMode): string[] {
  const avoids = new Set<string>([
    "watermarks",
    "logos unless already visible on a selected product",
    "illegible text",
    "copying the reference person's identity or face",
  ]);

  for (const item of input.playbook.avoid) avoids.add(item);

  if (input.playbook.id === "fashion") {
    if (mode === "layout_scene_strong") {
      [
        "plain white wall",
        "plain studio backdrop",
        "beige studio backdrop",
        "ecommerce catalog photography",
        "ecommerce catalog pose",
        "isolated product photography",
        "isolated product shot",
        "product listing imagery",
        "generic beige wall",
        "flat lay",
        "mannequin styling",
        "mannequin",
        "seamless paper background",
        "sterile white-background product photography",
        "home-decor or bedroom/living-room staging",
      ].forEach(a => avoids.add(a));
    } else if (mode !== "product_only") {
      avoids.add("flat lay unless the user selected flat lay or the reference is flat lay");
      avoids.add("home-decor or interior staging");
    }
  }

  return [...avoids];
}

function section(title: string, body: string | string[]): string {
  const content = Array.isArray(body)
    ? body.filter(Boolean).map(line => `- ${line}`).join("\n")
    : body;
  return `${title}:\n${content}`;
}

function creativeTagBlock(tags: SelectedCreativeTag[] | undefined, primaryFormatTag: string | undefined): string[] {
  const selected = tags ?? [];
  const byGroup = (group: SelectedCreativeTag["group"]) => selected
    .filter(tag => tag.group === group)
    .map(tag => tag.label)
    .filter(Boolean)
    .join(", ");
  const out = [
    primaryFormatTag ? `Primary format: ${primaryFormatTag}.` : "",
    byGroup("scene") ? `Scene tags: ${byGroup("scene")}.` : "",
    byGroup("composition") ? `Composition tags: ${byGroup("composition")}.` : "",
    byGroup("mood") ? `Mood tags: ${byGroup("mood")}.` : "",
  ].filter(Boolean);
  if (!out.length && byGroup("format")) out.push(`Primary format: ${byGroup("format")}.`);
  return out;
}

export function buildHiddenPrompt(input: HiddenPromptInput): string {
  const fmt = clean(input.format) || "2:3";
  const textOverlay = clean(input.controls.textOverlay);
  const wantsText = !!textOverlay && textOverlay.toLowerCase() !== "none";
  const mode = inferReferenceInfluenceMode(input);
  const dom = input.references.dominant;
  // When a reference should drive the photograph, it MUST be stated first so the
  // model treats scene/composition as the governing constraint — not products.
  const referenceLeads = !!dom && (mode === "layout_scene_strong" || mode === "style_mood_balanced");

  const referenceBlock = dom
    ? section(`REFERENCE REQUIREMENTS${referenceLeads ? " (HIGHEST PRIORITY)" : ""}`, [
        `referenceInfluenceMode: ${mode}`,
        `Reference type: ${dom.referenceType}; scene: ${dom.sceneType}; framing: ${dom.framing}; lighting: ${dom.lighting}; composition: ${dom.composition}.`,
        ...referenceRequirements(input, mode),
        mode === "layout_scene_strong"
          ? "The reference controls HOW the products are photographed. Treat its environment, location, composition, framing, camera angle, subject placement, and pose energy as MANDATORY guidance — not optional inspiration. The result must feel like it belongs in the same visual world as the reference."
          : "",
      ])
    : "";

  const primaryBlock = section("PRIMARY SUBJECT", fashionPrimarySubject(input, mode));

  const productBlock = section("PRODUCT REQUIREMENTS", [
    ...productRequirements(input.productSet.products),
    input.productSet.isCoherentSet ? `Present the selected products together as a ${input.productSet.setSummary}.` : "",
    "Products define WHAT appears (clothing, accessories, colors, silhouettes). They do NOT define the scene or framing.",
  ]);

  const blocks: string[] = [];

  // ── Order: reference-led when the reference governs the photograph ──────────
  if (referenceLeads && referenceBlock) blocks.push(referenceBlock);
  blocks.push(primaryBlock);
  blocks.push(productBlock);

  const userBrief = clean(input.directionBrief) || clean(input.refinement);
  const tagLines = creativeTagBlock(input.selectedTags, input.primaryFormatTag);
  if (tagLines.length) {
    blocks.push(section("CREATIVE TAGS", [
      ...tagLines,
      "Use these tags as compact creative controls for format, scene, composition, and mood.",
    ]));
  }

  const refine = userBrief;
  if (refine) {
    blocks.push(section("DIRECTION BRIEF", [
      refine,
      "Honor these instructions unless they conflict with product fidelity or safety.",
    ]));
  }

  if (input.direction) {
    blocks.push(section("SELECTED DIRECTION", [
      `${input.direction.title}: ${input.direction.shortDescription ?? input.direction.summary}`,
      ...(input.direction.promptHints ?? []).filter(Boolean),
    ]));
  }

  // product_only / none modes keep the reference as a later, lower-priority note.
  if (!referenceLeads && referenceBlock) blocks.push(referenceBlock);

  blocks.push(section("CATEGORY PLAYBOOK", [
    `${input.playbook.label}: ${input.playbook.hiddenPromptGuidance.join(" ")}`,
    `Product role rule: ${input.playbook.productRoleRule}`,
    `Reference interpretation: ${input.playbook.referenceInterpretation}`,
  ]));

  const kw = clean(input.opportunityKeyword);
  if (kw) blocks.push(section("OPPORTUNITY CONTEXT", `Market angle / keyword context: ${kw}.`));

  blocks.push(section("OUTPUT GOAL", [
    referenceLeads
      ? `Create an original Pinterest-native vertical ${fmt} image that FOLLOWS the reference's scene, location, framing, and composition while clearly showing the selected products.`
      : `A Pinterest-native vertical ${fmt} ${input.playbook.label} Pin.`,
    wantsText
      ? `If adding text overlay (${textOverlay}), keep it clean, mobile-legible, and Pinterest-native.`
      : "ZERO TEXT RULE: no text, words, letters, numbers, captions, watermarks, logos, or typography anywhere in the image.",
    input.playbook.isDigital
      ? "Digital product rule: show a clear mockup/preview with readable, benefit-led information hierarchy."
      : "",
    "The selected products remain the clear hero.",
  ]));

  blocks.push(section("STRICTLY AVOID", avoidList(input, mode)));

  return blocks.filter(Boolean).join("\n\n");
}
