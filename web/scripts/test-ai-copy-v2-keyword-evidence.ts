import assert from "node:assert/strict";
import {
  buildKeywordEvidence,
  resolveKeywordProvenance,
  type KeywordEvidenceAdapterInput,
} from "../src/lib/ai-copy/v2/keywordEvidence";
import type {
  KeywordEvidence,
  KeywordCandidate,
  KeywordProvenance,
} from "../src/lib/ai-copy/v2/types";
import type {
  KeywordRow,
  KeywordContextInput,
} from "../src/lib/ai-copy/keywordContext";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

const livingRoomContext: KeywordContextInput = {
  imageSummary: "A modern living room corner with a bright yellow armchair, gold floor lamp, framed abstract wall art, a side table, an area rug and light wood flooring.",
  visibleObjects: ["yellow armchair", "gold floor lamp", "framed abstract art", "side table", "area rug", "media console"],
  style: "modern minimalist",
  boardName: "Living Room Ideas",
  category: "home-decor",
};

function makeRow(keyword: string, opts: Partial<KeywordRow> = {}): KeywordRow {
  return {
    id: `kw_${keyword.toLowerCase().replace(/\s+/g, "_")}`,
    keyword,
    category: "home-decor",
    search_volume_level: "high",
    ...opts,
  };
}

// 1. Provenance honesty: official vs estimated vs unknown
test("provenance honesty: only exact data_quality='official' maps to official, scored/derived to estimated, missing/unusable to unknown", () => {
  // Exact official
  assert.equal(resolveKeywordProvenance(makeRow("official kw", { data_quality: "official" })), "official");

  // Non-exact official strings must NOT map to official
  assert.notEqual(resolveKeywordProvenance(makeRow("upper kw", { data_quality: "OFFICIAL" as any })), "official");
  assert.notEqual(resolveKeywordProvenance(makeRow("api kw", { data_quality: "official_api" as any })), "official");

  // Explicit estimated / derived
  assert.equal(resolveKeywordProvenance(makeRow("est kw", { data_quality: "estimated" })), "estimated");
  assert.equal(resolveKeywordProvenance(makeRow("der kw", { data_quality: "derived" as any })), "estimated");

  // Scored / derived fields without official quality
  assert.equal(resolveKeywordProvenance(makeRow("vol kw", { search_volume_level: "high" })), "estimated");
  assert.equal(resolveKeywordProvenance(makeRow("score kw", { volume_score: 4 })), "estimated");
  assert.equal(resolveKeywordProvenance(makeRow("signal kw", { volume_signal: "very_high" })), "estimated");
  assert.equal(resolveKeywordProvenance(makeRow("prio kw", { priority_score: 80 })), "estimated");

  // Missing data quality and missing usable scores -> unknown
  assert.equal(resolveKeywordProvenance(makeRow("no quality kw", { search_volume_level: undefined, volume_score: undefined, priority_score: undefined })), "unknown");
  assert.equal(resolveKeywordProvenance(makeRow("unscored kw", { search_volume_level: "unscored", volume_score: null, priority_score: null })), "unknown");
  assert.equal(resolveKeywordProvenance(makeRow("explicit unknown kw", { data_quality: "unknown" as any, search_volume_level: "high" })), "unknown");
});

// 2. Sole demand provenance: trend_keywords is sole demand source
test("sole demand provenance: trend_keywords is sole demand source, user/product/page/image/board are relevance evidence only", () => {
  const rows = [
    makeRow("living room decor ideas", { data_quality: "official", search_volume_level: "high" }),
    makeRow("modern armchair styling", { data_quality: "estimated", search_volume_level: "medium" }),
  ];

  const evidence = buildKeywordEvidence({
    rows,
    context: {
      ...livingRoomContext,
      productTitle: "Yellow Velvet Armchair",
      productType: "armchair",
      productTags: ["accent chair"],
    },
    userInput: "best comfy chair for living room",
    pageMetadata: {
      title: "Designer Modern Living Room Furniture",
      description: "Explore living room decor ideas and chairs",
    },
  });

  // Candidates only correspond to the trend_keywords rows
  assert.equal(evidence.candidates.length, 2);
  for (const c of evidence.candidates) {
    // Demand provenance is strictly from the keyword row, never from user/product/page/board
    assert.ok(c.provenance === "official" || c.provenance === "estimated");
    assert.notEqual(c.provenance, "user_input" as any);
    assert.notEqual(c.provenance, "product_catalog" as any);
  }
});

// 3. Evidence source separation
test("evidence source separation: structured relevance entries reflect actual matches and omit non-matches", () => {
  const rows = [
    makeRow("living room decor ideas", { data_quality: "official" }),
  ];

  const evidence = buildKeywordEvidence({
    rows,
    context: {
      ...livingRoomContext,
      boardName: "Living Room Ideas",
      productTitle: "Nordic Ceramic Vase", // no overlap with "living room decor ideas"
    },
    userInput: "looking for room decor inspiration",
    pageMetadata: {
      title: "Catalog",
      description: "Shop home goods",
    },
  });

  const candidate = evidence.candidates[0];
  assert.ok(candidate);
  const sources = candidate.relevanceEvidence.map(e => e.source);

  // image_observed matches ("living room", "decor")
  assert.ok(sources.includes("image_observed"), "image_observed should match living room context");
  // board_context matches ("living room ideas")
  assert.ok(sources.includes("board_context"), "board_context should match living room");
  // user_input matches ("room decor")
  assert.ok(sources.includes("user_input"), "user_input should match room decor");

  // product_catalog and page_metadata had no real match with "living room decor ideas" -> MUST be omitted
  assert.ok(!sources.includes("product_catalog"), "non-matching product_catalog must be omitted");
  assert.ok(!sources.includes("page_metadata"), "non-matching page_metadata must be omitted");

  // Every relevance evidence entry must have valid source and matchedText
  for (const entry of candidate.relevanceEvidence) {
    assert.ok(["user_input", "product_catalog", "page_metadata", "image_observed", "board_context"].includes(entry.source));
    assert.ok(entry.matchedText && entry.matchedText.length > 0);
  }
});

// 4. Maximum 5 selected keyword IDs
test("selection limit: at most 5 keywords selected for model input", () => {
  // Provide 8 relevant living room keywords
  const rows = [
    makeRow("living room decor ideas", { priority_score: 100 }),
    makeRow("modern living room design", { priority_score: 95 }),
    makeRow("minimalist living room ideas", { priority_score: 90 }),
    makeRow("yellow armchair living room", { priority_score: 85 }),
    makeRow("area rug living room modern", { priority_score: 80 }),
    makeRow("side table living room decor", { priority_score: 75 }),
    makeRow("floor lamp living room modern", { priority_score: 70 }),
    makeRow("abstract wall art living room", { priority_score: 65 }),
  ];

  const evidence = buildKeywordEvidence({
    rows,
    context: livingRoomContext,
  });

  // Exactly at most 5 selected
  assert.ok(evidence.selectedKeywordIds.length <= 5, "selectedKeywordIds must not exceed 5");
  assert.equal(evidence.selectedKeywordIds.length, 5);

  // Selected candidates have status: "accepted" and no rejectionCode
  for (const id of evidence.selectedKeywordIds) {
    const c = evidence.candidates.find(item => item.id === id);
    assert.ok(c, `selected candidate ${id} must exist`);
    assert.equal(c!.status, "accepted");
    assert.equal(c!.rejectionCode, undefined);
  }

  // Candidates not in selectedKeywordIds must be marked "rejected" with rejectionCode: "not_selected"
  const unselected = evidence.candidates.filter(c => !evidence.selectedKeywordIds.includes(c.id));
  assert.ok(unselected.length > 0);
  for (const c of unselected) {
    assert.equal(c.status, "rejected");
    assert.equal(c.rejectionCode, "not_selected");
  }
});

// 5. No-keyword degraded mode
test("degraded mode: returns no_keyword_demand_data when no reliable demand keywords remain", () => {
  // Empty rows
  const emptyEvidence = buildKeywordEvidence({
    rows: [],
    context: livingRoomContext,
  });
  assert.equal(emptyEvidence.degradedMode, "no_keyword_demand_data");
  assert.deepEqual(emptyEvidence.selectedKeywordIds, []);

  // All rows have unknown provenance
  const unknownRows = [
    makeRow("living room decor ideas", { data_quality: "unknown" as any, search_volume_level: null }),
  ];
  const unknownEvidence = buildKeywordEvidence({
    rows: unknownRows,
    context: livingRoomContext,
  });
  assert.equal(unknownEvidence.degradedMode, "no_keyword_demand_data");
  assert.deepEqual(unknownEvidence.selectedKeywordIds, []);
  assert.equal(unknownEvidence.candidates[0].status, "rejected");
  assert.equal(unknownEvidence.candidates[0].rejectionCode, "unreliable_provenance");

  // Valid rows with normal demand signal -> degradedMode is "none"
  const validEvidence = buildKeywordEvidence({
    rows: [makeRow("living room decor ideas", { priority_score: 100 })],
    context: livingRoomContext,
  });
  assert.equal(validEvidence.degradedMode, "none");
  assert.ok(validEvidence.selectedKeywordIds.length > 0);
});

// 6. Non-English locale guard
test("non-English locale guard: rejects unlabelled and English rows; accepts matching labelled non-English rows", () => {
  const spanishRows: KeywordRow[] = [
    // Unlabelled row (missing language/locale)
    makeRow("decoracion salon moderno", {
      id: "unlabelled_1",
      data_quality: "official",
      language: undefined,
      locale: undefined,
    }),
    // English labelled row
    makeRow("living room decor ideas", {
      id: "en_row_1",
      data_quality: "official",
      language: "en",
      locale: "en-US",
    }),
    // Matching Spanish labelled row
    makeRow("ideas decoracion salon", {
      id: "es_row_1",
      data_quality: "official",
      language: "es",
      locale: "es-ES",
    }),
  ];

  const spanishContext: KeywordContextInput = {
    imageSummary: "Un salon moderno con decoracion elegante, sillon amarillo y lampara dorada.",
    visibleObjects: ["sillon amarillo", "lampara dorada", "mesa auxiliar", "decoracion salon"],
    style: "moderno minimalista",
    boardName: "Decoracion Salon",
    category: "home-decor",
    language: "es",
  };

  const evidence = buildKeywordEvidence({
    rows: spanishRows,
    context: spanishContext,
    targetLocale: "es-ES",
  });

  const unlabelled = evidence.candidates.find(c => c.id === "unlabelled_1");
  assert.ok(unlabelled);
  assert.equal(unlabelled.status, "rejected");
  assert.equal(unlabelled.rejectionCode, "locale_mismatch");

  const enRow = evidence.candidates.find(c => c.id === "en_row_1");
  assert.ok(enRow);
  assert.equal(enRow.status, "rejected");
  assert.equal(enRow.rejectionCode, "locale_mismatch");

  const esRow = evidence.candidates.find(c => c.id === "es_row_1");
  assert.ok(esRow);
  assert.equal(esRow.status, "accepted");
  assert.ok(evidence.selectedKeywordIds.includes("es_row_1"));
  assert.equal(evidence.degradedMode, "none");

  // English backward compatibility check: unlabelled rows work for English requests
  const englishEvidence = buildKeywordEvidence({
    rows: [makeRow("living room decor ideas", { language: undefined, locale: undefined })],
    context: livingRoomContext,
    targetLocale: "en-US",
  });
  assert.equal(englishEvidence.candidates[0].status, "accepted");
  assert.equal(englishEvidence.degradedMode, "none");
});

// 7. Irrelevant high-demand term rejected
test("relevance floor: irrelevant high-demand term is rejected and never selected", () => {
  const rows = [
    // Irrelevant but very high volume
    makeRow("christmas decor ideas for living room", {
      id: "kw_christmas",
      category: "holidays-seasonal",
      search_volume_level: "very_high",
      volume_score: 5,
    }),
    makeRow("wedding table decor", {
      id: "kw_wedding",
      category: "wedding",
      search_volume_level: "very_high",
      volume_score: 5,
    }),
    // Relevant moderate volume
    makeRow("living room decor ideas", {
      id: "kw_living_room",
      search_volume_level: "medium",
      volume_score: 3,
    }),
  ];

  const evidence = buildKeywordEvidence({
    rows,
    context: livingRoomContext,
  });

  const christmas = evidence.candidates.find(c => c.id === "kw_christmas");
  assert.ok(christmas);
  assert.equal(christmas.status, "rejected");
  assert.ok(christmas.rejectionCode === "low_coverage" || christmas.rejectionCode === "low_relevance");

  const wedding = evidence.candidates.find(c => c.id === "kw_wedding");
  assert.ok(wedding);
  assert.equal(wedding.status, "rejected");
  assert.equal(wedding.rejectionCode, "low_relevance");

  // Only the relevant keyword is selected
  assert.deepEqual(evidence.selectedKeywordIds, ["kw_living_room"]);
  assert.ok(!evidence.selectedKeywordIds.includes("kw_christmas"));
  assert.ok(!evidence.selectedKeywordIds.includes("kw_wedding"));
});

// 8. Rejection codes are stable finite machine codes without numbers or colons
test("rejection codes: stable finite machine codes without scores or colons", () => {
  const rows = [
    makeRow("home decor", { id: "generic_1" }), // generic bare
    makeRow("unrelated topic xyz", { id: "irrelevant_1" }), // low relevance
    makeRow("christmas decor ideas for living room", { id: "coverage_1" }), // low coverage
  ];

  const evidence = buildKeywordEvidence({
    rows,
    context: livingRoomContext,
  });

  const ALLOWED_CODES = new Set([
    "locale_mismatch",
    "unreliable_provenance",
    "low_relevance",
    "low_coverage",
    "too_generic",
    "not_selected",
  ]);

  for (const c of evidence.candidates) {
    if (c.status === "rejected") {
      assert.ok(c.rejectionCode, "rejected candidate must have a rejectionCode");
      assert.ok(ALLOWED_CODES.has(c.rejectionCode), `code ${c.rejectionCode} must be in allowed machine codes`);
      assert.ok(!c.rejectionCode.includes(":"), "rejectionCode must not contain colons");
      assert.ok(!/\d/.test(c.rejectionCode), "rejectionCode must not contain score digits");
    }
  }
});

// 9. Contract safety: no score or exact volume fields in runtime objects
test("contract safety: no score or exact volume fields in KeywordEvidence runtime objects", () => {
  const rows = [
    makeRow("living room decor ideas", {
      data_quality: "official",
      volume_score: 4.5,
      search_volume_level: "very_high",
      priority_score: 99,
    }),
  ];

  const evidence = buildKeywordEvidence({
    rows,
    context: livingRoomContext,
  });

  const FORBIDDEN_PROPERTIES = [
    "score",
    "relevanceScore",
    "finalScore",
    "normalizedVolume",
    "volumeScore",
    "volume_score",
    "search_volume_level",
    "searchVolume",
    "exactVolume",
    "seoScore",
    "seo_score",
    "clusterId",
    "cluster_id",
  ];

  // Inspect evidence object
  for (const prop of FORBIDDEN_PROPERTIES) {
    assert.ok(!(prop in evidence), `KeywordEvidence must not have property '${prop}'`);
  }

  // Inspect candidate objects
  for (const c of evidence.candidates) {
    for (const prop of FORBIDDEN_PROPERTIES) {
      assert.ok(!(prop in c), `KeywordCandidate must not have property '${prop}'`);
    }
  }

  // Serialize to JSON and parse back, verify keys
  const serialized = JSON.stringify(evidence);
  for (const prop of FORBIDDEN_PROPERTIES) {
    assert.ok(!serialized.includes(`"${prop}":`), `Serialized evidence must not contain '${prop}'`);
  }
});

// 10. Deterministic keywordSetId
test("keywordSetId: deterministic derivation and explicit override", () => {
  const rows = [makeRow("living room decor ideas")];

  const explicit = buildKeywordEvidence({
    rows,
    context: livingRoomContext,
    keywordSetId: "custom_set_123",
  });
  assert.equal(explicit.keywordSetId, "custom_set_123");

  const derived1 = buildKeywordEvidence({
    rows,
    context: livingRoomContext,
  });
  const derived2 = buildKeywordEvidence({
    rows,
    context: livingRoomContext,
  });
  assert.ok(derived1.keywordSetId.startsWith("kwset_"));
  assert.equal(derived1.keywordSetId, derived2.keywordSetId, "derived keywordSetId must be deterministic");
});

console.log(`\nAll ${passed} keyword evidence tests passed.`);
