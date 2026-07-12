export const NICHES = [
  {
    id: "home",
    label: "Home Decor",
    match: [
      "home", "home decor", "decor", "room", "bedroom", "living room",
      "apartment", "interior", "shelf", "wall decor", "furniture", "lighting",
      "kitchen", "bathroom", "entryway", "aesthetic room", "cozy", "boho home",
      "accent", "rug", "sofa", "curtain", "plant", "candle", "mirror",
    ],
  },
  {
    id: "beauty",
    label: "Beauty / Nails",
    match: [
      "beauty", "nails", "nail", "makeup", "skincare", "skin care", "hair",
      "lip", "eyelash", "blush", "foundation", "cosmetic", "glow", "self care",
      "serum", "eyeshadow", "mascara", "concealer", "toner", "spa", "face",
      "brow", "contour", "lash", "glam",
    ],
  },
  {
    id: "fashion",
    label: "Fashion",
    match: [
      "fashion", "outfit", "streetwear", "minimalist outfit", "boho", "clothing",
      "clothes", "shoes", "bag", "style", "wardrobe", "women", "dress", "jeans",
      "tops", "blazer", "coat", "sneaker", "handbag", "accessory", "ootd",
      "aesthetic fashion", "neutral outfit",
    ],
  },
  {
    id: "jewelry",
    label: "Jewelry",
    match: [
      "jewelry", "jewellery", "ring", "necklace", "bracelet", "earring",
      "gem", "diamond", "gold", "silver", "pendant", "charm", "dainty",
      "stacking ring", "gold chain",
    ],
  },
  {
    id: "lifestyle",
    label: "Lifestyle",
    match: [
      "lifestyle", "travel", "fitness", "health", "wellness", "routine",
      "morning", "productivity", "mindfulness", "yoga", "gym", "workout",
      "self improvement", "motivation", "journaling",
    ],
  },
  {
    id: "food",
    label: "Food",
    match: [
      "food", "recipe", "cooking", "baking", "kitchen", "meal", "dinner",
      "lunch", "breakfast", "snack", "dessert", "cake", "smoothie", "drink",
      "coffee", "matcha", "aesthetic food",
    ],
  },
  {
    id: "art",
    label: "Art",
    match: [
      "art", "craft", "diy", "painting", "drawing", "sketch", "illustration",
      "design", "print", "handmade", "creative", "watercolor", "acrylic",
      "digital art", "printable",
    ],
  },
  {
    id: "gifts",
    label: "Gifts",
    match: [
      "gifts", "gift", "holiday", "seasonal", "christmas", "birthday",
      "present", "valentine", "mothers day", "gift guide", "gift idea",
      "stocking stuffer", "white elephant",
    ],
  },
] as const;

export type NicheId = (typeof NICHES)[number]["id"];
export type Scope = "for_you" | "all_trends";

export const STORAGE_KEY = "vibepin_selected_niches";
export const SCOPE_KEY = "vibepin_scope";
export const ONBOARDING_KEY = "vibepin_onboarding_done";
/** Timestamp for the combined niches doc (selected niches + onboarding), for account sync LWW. */
export const NICHES_UPDATED_AT_KEY = "vibepin_niches_updated_at";
export const NICHES_EVENT = "vp:niches_updated";

function stampNichesUpdated(): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(NICHES_UPDATED_AT_KEY, new Date().toISOString());
  window.dispatchEvent(new Event(NICHES_EVENT));
}

// ── Niche selection ───────────────────────────────────────────────────────────
export function getSelectedNiches(): NicheId[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as string[];
    const validIds = NICHES.map((n) => n.id) as string[];
    return parsed.filter((id) => validIds.includes(id)) as NicheId[];
  } catch {
    return [];
  }
}

export function saveSelectedNiches(niches: NicheId[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(niches));
  stampNichesUpdated();
}

export function hasSelectedNiches(): boolean {
  return getSelectedNiches().length > 0;
}

// ── Scope ─────────────────────────────────────────────────────────────────────
export function getScope(defaultForYou = false): Scope {
  if (typeof window === "undefined") return defaultForYou ? "for_you" : "all_trends";
  try {
    const raw = localStorage.getItem(SCOPE_KEY);
    if (raw === "for_you" || raw === "all_trends") return raw;
    return defaultForYou ? "for_you" : "all_trends";
  } catch {
    return defaultForYou ? "for_you" : "all_trends";
  }
}

export function saveScope(scope: Scope): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(SCOPE_KEY, scope);
}

// ── Onboarding ────────────────────────────────────────────────────────────────
export function isOnboardingDone(): boolean {
  if (typeof window === "undefined") return true;
  return localStorage.getItem(ONBOARDING_KEY) === "true";
}

export function markOnboardingDone(): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(ONBOARDING_KEY, "true");
  stampNichesUpdated();
}

// ── Matching ──────────────────────────────────────────────────────────────────
// Accepts a single string or an array of strings (checks all fields against niche terms).
export function matchesNiche(
  field: string | (string | null | undefined)[],
  niches: NicheId[],
): boolean {
  if (!niches.length) return true;
  const texts = (Array.isArray(field) ? field : [field])
    .filter(Boolean)
    .map((s) => s!.toLowerCase());
  if (!texts.length) return false;
  return niches.some((nicheId) => {
    const niche = NICHES.find((n) => n.id === nicheId);
    return niche?.match.some((term) => texts.some((text) => text.includes(term))) ?? false;
  });
}

// ── Account-level sync (WP-B) ────────────────────────────────────────────────
// The niches "prefs" are spread across two legacy localStorage keys
// (selected niches + onboarding flag). The sync layer treats them as ONE doc
// (docId "prefs") under storeKey `niches` with payload
// {selectedNiches, onboardingDone, updatedAt}, LWW on updatedAt. The two legacy
// getters/setters keep their exact signatures; both setters now stamp updatedAt
// and emit NICHES_EVENT.

export type NichesSyncDoc = {
  selectedNiches: NicheId[];
  onboardingDone: boolean;
  updatedAt: string;
};

const NICHES_EPOCH = "1970-01-01T00:00:00.000Z";

function nichesTsMs(v: string | null | undefined): number {
  const ms = v ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

function readNichesUpdatedAt(): string | null {
  if (typeof window === "undefined") return null;
  try { return localStorage.getItem(NICHES_UPDATED_AT_KEY); } catch { return null; }
}

/** True once any niche/onboarding write has happened (or legacy data exists). */
function nichesTouched(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      localStorage.getItem(NICHES_UPDATED_AT_KEY) !== null ||
      localStorage.getItem(STORAGE_KEY) !== null ||
      localStorage.getItem(ONBOARDING_KEY) !== null
    );
  } catch { return false; }
}

export const nichesSyncAdapter: import("./userStoreSync").StoreSyncAdapter<NichesSyncDoc> = {
  storeKey: "niches",
  eventName: NICHES_EVENT,
  getAll() {
    if (!nichesTouched()) return [];
    const doc: NichesSyncDoc = {
      selectedNiches: getSelectedNiches(),
      onboardingDone: isOnboardingDone(),
      updatedAt: readNichesUpdatedAt() ?? NICHES_EPOCH,
    };
    return [{ id: "prefs", updatedAt: doc.updatedAt, doc }];
  },
  mergeServer(live, deleted) {
    if (typeof window === "undefined") return;
    const localTs = nichesTouched() ? nichesTsMs(readNichesUpdatedAt() ?? NICHES_EPOCH) : -1;

    const incoming = (live[0] as NichesSyncDoc | undefined) ?? null;
    const incomingTs = incoming ? nichesTsMs(incoming.updatedAt ?? NICHES_EPOCH) : -1;
    const tomb = deleted.find((d) => d.id === "prefs") ?? deleted[0] ?? null;
    const tombTs = tomb ? nichesTsMs(tomb.deletedAt) : -1;

    let action: "none" | "write" | "delete" = "none";
    let bestTs = localTs;
    if (incoming && incomingTs > bestTs) { action = "write"; bestTs = incomingTs; }
    if (tomb && tombTs > bestTs) { action = "delete"; bestTs = tombTs; }

    if (action === "write" && incoming) {
      const validIds = NICHES.map((n) => n.id) as string[];
      const niches = Array.isArray(incoming.selectedNiches)
        ? (incoming.selectedNiches.filter((id) => validIds.includes(id as string)) as NicheId[])
        : [];
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(niches));
        if (incoming.onboardingDone) localStorage.setItem(ONBOARDING_KEY, "true");
        else localStorage.removeItem(ONBOARDING_KEY);
        localStorage.setItem(NICHES_UPDATED_AT_KEY, incoming.updatedAt ?? NICHES_EPOCH);
      } catch { return; }
      window.dispatchEvent(new Event(NICHES_EVENT));
    } else if (action === "delete") {
      try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(ONBOARDING_KEY);
        localStorage.removeItem(NICHES_UPDATED_AT_KEY);
      } catch { return; }
      window.dispatchEvent(new Event(NICHES_EVENT));
    }
  },
};
