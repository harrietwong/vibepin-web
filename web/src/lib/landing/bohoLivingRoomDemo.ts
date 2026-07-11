import type { LandingAsset } from "@/lib/landingAssets";

/**
 * Curated "Boho Living Room" landing demo assets.
 *
 * One coherent opportunity, multiple creative directions. Files live in
 *   public/landing/boho-living-room/products
 *   public/landing/boho-living-room/references
 * Paths below match the exact filenames + extensions on disk (mixed jpg/png/webp).
 * Titles / directions / objectPosition are editable here — the single source of truth.
 */

const P = "/landing/boho-living-room/products/";
const R = "/landing/boho-living-room/references/";

export type LandingProductAsset = { id: string; title: string; imageUrl: string; category?: string };
export type LandingReferenceAsset = { id: string; title: string; direction: string; imageUrl: string; objectPosition?: string };

// ── Products (exact filenames) ────────────────────────────────────────────────
const PRODUCTS: LandingProductAsset[] = [
  { id: "rattan-pendant-light",  title: "Rattan Pendant Light",  imageUrl: P + "product-rattan-pendant-light.png" },
  { id: "rattan-accent-chair",   title: "Rattan Accent Chair",   imageUrl: P + "product-rattan-accent-chair.png" },
  { id: "natural-woven-rug",     title: "Natural Woven Rug",     imageUrl: P + "product-natural-woven-rug.png" },
  { id: "trailing-vine-plant",   title: "Trailing Vine Plant",   imageUrl: P + "product-trailing-vine-plant.webp" },
  { id: "striped-throw-pillow",  title: "Striped Throw Pillow",  imageUrl: P + "product-striped-throw-pillow.jpg" },
  { id: "wicker-storage-basket", title: "Wicker Storage Basket", imageUrl: P + "product-wicker-storage-basket.jpg" },
  { id: "cream-sofa",            title: "Cream Sofa",            imageUrl: P + "product-cream-sofa.jpg" },
  { id: "potted-greenery",       title: "Potted Greenery",       imageUrl: P + "product-potted-greenery.png" },
  { id: "square-wicker-basket",  title: "Square Wicker Basket",  imageUrl: P + "product-square-wicker-basket.jpg" },
];

// ── References (exact filenames + extensions for pin-ref-01..10) ───────────────
// Editable creative-direction labels; the photos are intentionally diverse.
const REF_FILES: { ext: string; direction: string }[] = [
  { ext: "jpg",  direction: "Neutral boho" },          // pin-ref-01
  { ext: "png",  direction: "Colorful eclectic" },     // pin-ref-02
  { ext: "webp", direction: "Cozy reading corner" },   // pin-ref-03
  { ext: "jpg",  direction: "Small-space decor" },     // pin-ref-04
  { ext: "png",  direction: "Warm maximalist" },       // pin-ref-05
  { ext: "jpg",  direction: "Modern organic" },        // pin-ref-06
  { ext: "png",  direction: "Natural rattan styling" },// pin-ref-07
  { ext: "jpg",  direction: "Layered textiles" },      // pin-ref-08
  { ext: "png",  direction: "Bright & airy" },         // pin-ref-09
  { ext: "png",  direction: "Warm editorial" },        // pin-ref-10
];

const REFERENCES: LandingReferenceAsset[] = REF_FILES.map((f, i) => {
  const n = String(i + 1).padStart(2, "0");
  return { id: `pin-ref-${n}`, title: `Boho Living Room Reference ${n}`, direction: f.direction, imageUrl: `${R}pin-ref-${n}.${f.ext}` };
});

export const bohoLivingRoomDemo = {
  opportunity: {
    id: "boho-living-room",
    title: "Boho Living Room",
    score: 94,
    demandGrowth: 210,
    highSavePins: 18,
    matchedProducts: 7,
    heroReferenceId: "pin-ref-01",
  },
  products: PRODUCTS,
  references: REFERENCES,
  // Representative generated-Pin previews (demo only — real refs reused, centralized here).
  generatedPins: REFERENCES.slice(4, 10),
};

// ── LandingAsset-shaped arrays for the existing landing components ─────────────
// Category "Home Decor" so the components' pickByCategory(...) selects them.
const heroId = bohoLivingRoomDemo.opportunity.heroReferenceId;

export const bohoReferences: LandingAsset[] = [
  // Hero reference first so components that take the first Home-Decor asset use it.
  ...REFERENCES.filter(r => r.id === heroId),
  ...REFERENCES.filter(r => r.id !== heroId),
].map(r => ({
  id: r.id,
  imageUrl: r.imageUrl,
  title: r.title,
  category: "Home Decor",
  sourceType: "pin_sample" as const,
  objectPosition: r.objectPosition,
}));

export const bohoProducts: LandingAsset[] = PRODUCTS.map((p, i) => ({
  id: p.id,
  imageUrl: p.imageUrl,
  title: p.title,
  category: "Home Decor",
  sourceType: "product_opportunity" as const,
  score: [94, 90, 88, 86, 84, 82, 80, 78, 76][i] ?? 80,
}));
