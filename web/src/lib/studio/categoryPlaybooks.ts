// Category playbooks (Creative Intelligence V1).
//
// Deterministic per-category rules that ground the 3 creative directions and the
// hidden prompt. Physical-product categories emphasise scene / lifestyle / fidelity;
// digital products emphasise information hierarchy / mockup / benefit — never a
// purely decorative photo that fails to communicate the product.

import type { CategoryPlaybookId } from "./creativeDirections";

export type PlaybookControls = {
  goal?: string;
  subject?: string;
  framing?: string;
  scene?: string;
  style?: string;
  productEmphasis?: string;
  referenceStrength?: string;
  textOverlay?: string;
};

export type CategoryPlaybook = {
  id: CategoryPlaybookId;
  label: string;
  isDigital: boolean;
  subjectTypes: string[];
  pinterestFormats: string[];
  /** category-specific Subject control options shown in Fine Tune */
  subjectOptions: string[];
  productRoleRule: string;
  referenceInterpretation: string;
  defaultControls: PlaybookControls;
  hiddenPromptGuidance: string[];
  avoid: string[];
};

const PLAYBOOKS: Record<CategoryPlaybookId, CategoryPlaybook> = {
  fashion: {
    id: "fashion",
    label: "Fashion",
    isDigital: false,
    subjectTypes: ["on-model outfit", "editorial outfit", "flat lay", "mirror outfit"],
    pinterestFormats: ["street-style portrait", "editorial outfit showcase", "creator lookbook", "mirror outfit pin"],
    subjectOptions: ["On-model", "Product only", "Flat lay", "Lifestyle scene"],
    productRoleRule: "Show the selected apparel/accessories worn together when they form an outfit; every item must stay clearly visible and recognizable.",
    referenceInterpretation: "Use a person reference for pose, framing, street-style atmosphere and styling only — never copy identity or face.",
    defaultControls: { goal: "Saves", subject: "On-model", referenceStrength: "Balanced", productEmphasis: "Balanced", textOverlay: "None" },
    hiddenPromptGuidance: [
      "Generate an ORIGINAL model (no identity/face copied from any reference).",
      "Dress the model in the selected products together where it forms a coherent outfit.",
      "Keep each product clearly visible; preserve color, material, and silhouette.",
    ],
    avoid: ["flat lay unless explicitly requested", "home-decor / interior staging", "candles, vases, bottles as the subject"],
  },
  "home-decor": {
    id: "home-decor",
    label: "Home Decor",
    isDigital: false,
    subjectTypes: ["styled room scene", "product vignette", "moodboard", "before/after"],
    pinterestFormats: ["styled room scene", "product-visible interior vignette", "room moodboard", "before/after concept"],
    subjectOptions: ["Full room", "Product vignette", "Moodboard", "Before/after"],
    productRoleRule: "Place the selected decor/furniture coherently in a room or vignette at believable scale; products are the hero, props support them.",
    referenceInterpretation: "Borrow the reference's room composition, decor density, palette, and interior mood.",
    defaultControls: { goal: "Saves", subject: "Full room", referenceStrength: "Balanced", productEmphasis: "Balanced", textOverlay: "None" },
    hiddenPromptGuidance: [
      "Stage the selected products in a coherent interior scene or styled vignette.",
      "Keep product scale and placement realistic; products remain recognizable.",
      "Do NOT apply fashion / on-model / person logic.",
    ],
    avoid: ["on-model or person-centric framing", "isolated product-on-white catalog shots"],
  },
  beauty: {
    id: "beauty",
    label: "Beauty",
    isDigital: false,
    subjectTypes: ["application close-up", "product + face/hand", "routine shelfie", "glossy editorial"],
    pinterestFormats: ["on-model application close-up", "product + face/hand composition", "routine / tips pin", "glossy product editorial"],
    subjectOptions: ["Product only", "On-face", "On-hand", "Routine", "Application"],
    productRoleRule: "Show packaging and/or application context clearly; the product must be visible and legible.",
    referenceInterpretation: "Borrow the reference's framing, texture detail, lighting and application angle.",
    defaultControls: { goal: "Saves", subject: "Application", referenceStrength: "Balanced", productEmphasis: "Product first", textOverlay: "None" },
    hiddenPromptGuidance: [
      "Keep product packaging clearly visible and recognizable.",
      "If showing application, use an original model; realistic skin and anatomy.",
      "Avoid unsafe or exaggerated beauty claims.",
    ],
    avoid: ["home-decor staging", "unrealistic anatomy", "illegible packaging"],
  },
  "food-and-drink": {
    id: "food-and-drink",
    label: "Food & Drink",
    isDigital: false,
    subjectTypes: ["food/recipe scene", "hero dish/drink", "ingredient layout", "step-by-step"],
    pinterestFormats: ["recipe or food scene", "hero dish/drink close-up", "step-by-step recipe layout", "ingredient flat lay"],
    subjectOptions: ["Plated dish", "Drink hero", "Ingredient layout", "Recipe steps"],
    productRoleRule: "Feature the selected food/drink/packaging as the appetizing hero; props are serving context.",
    referenceInterpretation: "Borrow the reference's serving composition, table styling, palette and appetite appeal.",
    defaultControls: { goal: "Saves", subject: "Plated dish", referenceStrength: "Balanced", productEmphasis: "Balanced", textOverlay: "None" },
    hiddenPromptGuidance: [
      "Style the food/drink to look fresh and appetizing.",
      "Keep packaged products legible when packaging is the subject.",
      "Do NOT default to fashion or home-decor logic.",
    ],
    avoid: ["fashion / on-model logic", "interior room staging"],
  },
  "digital-products": {
    id: "digital-products",
    label: "Digital Products",
    isDigital: true,
    subjectTypes: ["information layout", "product mockup", "checklist/feature breakdown"],
    pinterestFormats: ["information-rich layout", "product mockup showcase", "checklist / benefit-led pin"],
    subjectOptions: ["Mockup", "Information graphic", "Checklist", "Product preview"],
    productRoleRule: "Represent the digital asset as a clear mockup/preview (screen, page, printable) with a readable benefit-led hierarchy.",
    referenceInterpretation: "Follow the reference's information hierarchy and layout — NOT a lifestyle photo.",
    defaultControls: { goal: "Clicks", subject: "Mockup", referenceStrength: "Balanced", productEmphasis: "Product first", textOverlay: "Information-rich" },
    hiddenPromptGuidance: [
      "Show a clear device/printable mockup or preview of the digital product.",
      "Use a readable, mobile-legible information hierarchy that communicates the benefit.",
      "Text overlay should explain the product; do NOT create a purely decorative image.",
    ],
    avoid: ["decorative lifestyle photo that fails to explain the product", "treating the file as a physical decor object"],
  },
  "diy-crafts": {
    id: "diy-crafts",
    label: "DIY & Crafts",
    isDigital: false,
    subjectTypes: ["finished project", "materials flat lay", "step-by-step"],
    pinterestFormats: ["finished project hero", "materials & supplies flat lay", "step-by-step tutorial"],
    subjectOptions: ["Finished project", "Materials flat lay", "Tutorial steps"],
    productRoleRule: "Feature the handmade item or supplies as recognizable subjects; keep handmade texture visible.",
    referenceInterpretation: "Borrow the reference's crafting layout and instructional clarity.",
    defaultControls: { goal: "Saves", subject: "Finished project", referenceStrength: "Balanced", productEmphasis: "Balanced", textOverlay: "Light" },
    hiddenPromptGuidance: [
      "Show the craft item or supplies with handmade detail and texture.",
      "For tutorials, arrange clear sequential steps.",
    ],
    avoid: ["sterile catalog shots", "home-decor room staging unless the project is decor"],
  },
  travel: {
    id: "travel",
    label: "Travel",
    isDigital: false,
    subjectTypes: ["destination scene", "travel detail", "guide board"],
    pinterestFormats: ["aspirational destination scene", "evocative travel detail", "travel guide board"],
    subjectOptions: ["Destination scene", "Travel detail", "Guide board"],
    productRoleRule: "Lead with the destination as hero; place any selected items naturally in the travel scene.",
    referenceInterpretation: "Borrow the reference's destination mood, scenic framing and lighting.",
    defaultControls: { goal: "Saves", subject: "Destination scene", referenceStrength: "Balanced", productEmphasis: "Aesthetic first", textOverlay: "Light" },
    hiddenPromptGuidance: [
      "Lead with an aspirational, scenic destination composition.",
      "Keep any selected travel items naturally placed in context.",
    ],
    avoid: ["generic stock blandness", "indoor room-decor staging"],
  },
  generic: {
    id: "generic",
    label: "General Lifestyle",
    isDigital: false,
    subjectTypes: ["styled product scene", "editorial flat lay", "lifestyle showcase"],
    pinterestFormats: ["styled product scene", "editorial flat lay", "aspirational lifestyle showcase"],
    subjectOptions: ["Product scene", "Flat lay", "Lifestyle scene"],
    productRoleRule: "The selected products are the primary subjects; design the scene to feature them clearly.",
    referenceInterpretation: "Borrow the reference's palette, mood and lighting; adapt composition to fit the products.",
    defaultControls: { goal: "Saves", subject: "Product scene", referenceStrength: "Balanced", productEmphasis: "Balanced", textOverlay: "None" },
    hiddenPromptGuidance: [
      "Feature the selected products as the clear hero subjects.",
      "Do NOT default to bedroom/living-room staging unless the products are home decor.",
    ],
    avoid: ["interior room staging for non-home products", "defaulting to home-decor aesthetics"],
  },
};

export function getCategoryPlaybook(id: CategoryPlaybookId): CategoryPlaybook {
  return PLAYBOOKS[id] ?? PLAYBOOKS.generic;
}
