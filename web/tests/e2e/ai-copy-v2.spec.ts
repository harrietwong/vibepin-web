import { expect, test } from "@playwright/test";

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

test("AI Copy v2 keeps evidence honest and legacy discovery routes reachable", async ({ page }) => {
  let analyzeBody: Record<string, unknown> = {};
  let analyzeCount = 0;
  let generateCount = 0;
  let releaseGenerate: () => void = () => {};
  const generateGate = new Promise<void>(resolve => { releaseGenerate = resolve; });

  await page.addInitScript(({ pixel }) => {
    const now = new Date().toISOString();
    localStorage.setItem("vibepin-locale-prefs", JSON.stringify({ appLanguage: "en", contentLanguage: "same", pinterestRegion: "DE" }));
    localStorage.setItem("vp:pin_drafts:v1", JSON.stringify({ drafts: {
      "v2-e2e-draft": {
        id: "v2-e2e-draft", imageUrl: pixel, keyword: "reading corner", category: "home-decor",
        title: "Existing title", description: "Existing description", altText: "Existing alt",
        destinationUrl: "", boardId: "", boardName: "", weeklyPlanItemId: "", generationSessionId: "e2e",
        scheduledDate: "", status: "needs_review", source: "uploaded_image", planningStatus: "needs_review",
        createdAt: now, updatedAt: now,
        imageAnalysisStatus: "ready", keywordStatus: "ready", imageSummary: "A white reading lamp beside a chair",
        visibleObjects: ["lamp", "chair"], colors: ["white"], style: "minimal", ocrText: "", imageCategory: "home-decor",
        recommendedKeywords: ["reading corner ideas"], keywordSource: "pinterest_high_search",
      },
    } }));
    sessionStorage.setItem("vp:studio:filter", "unscheduled");
  }, { pixel: PIXEL });

  await page.route("**/rest/v1/**", route => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/pin-drafts**", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ drafts: [], nextCursor: null, accepted: [] }) }));
  await page.route("**/api/user-store**", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ documents: [], nextCursor: null, accepted: [] }) }));
  await page.route("**/api/pinterest/boards**", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], bookmark: null }) }));
  await page.route("**/api/pinterest/status**", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connected: false }) }));
  await page.route("**/api/ai-copy/v2/analyze", async route => {
    analyzeCount += 1;
    analyzeBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      ok: true, sessionId: "session-e2e",
      factCard: { version: "fact-card-v1", sessionId: "session-e2e", draftId: "v2-e2e-draft", locale: "en", facts: [
        { id: "fact-1", key: "image_summary", value: "A white reading lamp beside a chair", source: "image_observed", trustLevel: "observed", claimPolicy: "description_only" },
      ] },
      keywordEvidence: { keywordSetId: "ks-e2e", sessionId: "session-e2e", draftId: "v2-e2e-draft", candidates: [
        { id: "kw-used", phrase: "reading corner ideas", provenance: "official", relevanceEvidence: [], status: "accepted" },
        { id: "kw-unused", phrase: "cozy library", provenance: "estimated", relevanceEvidence: [], status: "accepted" },
      ], selectedKeywordIds: ["kw-used", "kw-unused"], degradedMode: "none" },
    }) });
  });
  await page.route("**/api/ai-copy/v2/generate", async route => {
    generateCount += 1;
    await generateGate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      ok: true, result: {
        generationId: "generation-e2e", sessionId: "session-e2e", draftId: "v2-e2e-draft", angleId: "default", keywordSetId: "ks-e2e",
        title: "Reading Corner Ideas", description: "Create a calm reading nook around a white lamp and chair.", altText: "White lamp beside a reading chair",
        usedKeywordIds: ["kw-used"], factSummary: [{ factId: "fact-1", key: "image_summary", value: "A white reading lamp beside a chair", source: "image_observed", trustLevel: "observed" }],
        degradedMode: "none", validationReport: { valid: true, issues: [] },
      },
    }) });
  });

  await page.goto("/app/studio", { waitUntil: "networkidle" });
  await expect(page.getByTestId("nav-keyword-trends")).toHaveCount(0);
  await expect(page.getByTestId("nav-viral-pins")).toHaveCount(0);

  const card = page.getByTestId("pin-board-card").first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  const shortcut = card.getByTestId("title-ai-copy-generate");
  await expect(shortcut).toHaveAccessibleName("Generate copy");
  await expect(card.getByTestId("ai-copy-generate")).toBeVisible();
  await shortcut.click();
  await expect(page.getByTestId("ai-copy-replace-confirm")).toBeVisible();
  await page.getByTestId("ai-copy-replace-confirm-btn").click();
  await expect.poll(() => generateCount).toBe(1);
  await expect(card.getByTestId("ai-copy-generate")).toBeDisabled();
  // The shortcut delegates to the panel's existing busy guard. Rapid extra
  // activations while the shared request is in flight must not start new calls.
  await shortcut.dblclick();
  await expect.poll(() => generateCount).toBe(1);
  releaseGenerate();
  await expect(card.getByTestId("board-card-title")).toHaveValue("Reading Corner Ideas");
  expect(analyzeCount).toBe(1);
  expect(generateCount).toBe(1);
  expect(analyzeBody.country).toBe("DE");

  await card.getByTestId("ai-copy-context-toggle").click();
  const evidence = card.getByTestId("ai-copy-v2-evidence");
  await expect(evidence).toBeVisible();
  await expect(evidence.getByText("reading corner ideas", { exact: true })).toBeVisible();
  await expect(evidence.getByText("cozy library", { exact: true })).toHaveCount(0);
  await expect(card.getByTestId("ai-copy-v2-validation")).toContainText("Validation passed");

  const trends = await page.request.get("/app/trends");
  const discover = await page.request.get("/app/discover");
  expect(trends.status()).toBe(200);
  expect(discover.status()).toBe(200);
});

test("in-flight AI copy blocks local, cross-card, and parent-driven card shape changes", async ({ page }) => {
  let analyzeCount = 0;
  let generateCount = 0;
  let releaseGenerate: () => void = () => {};
  let generateGate = new Promise<void>(resolve => { releaseGenerate = resolve; });

  await page.addInitScript(({ pixel }) => {
    const now = new Date().toISOString();
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    localStorage.setItem("vibepin-locale-prefs", JSON.stringify({ appLanguage: "en", contentLanguage: "same", pinterestRegion: "US" }));
    localStorage.setItem("vp:pin_drafts:v1", JSON.stringify({ drafts: {
      "v2-e2e-scheduled": {
        id: "v2-e2e-scheduled", imageUrl: pixel, keyword: "reading corner", category: "home-decor",
        title: "Scheduled title", description: "Scheduled description", altText: "Scheduled alt",
        destinationUrl: "", boardId: "", boardName: "", weeklyPlanItemId: "", generationSessionId: "e2e",
        scheduledDate: tomorrow, scheduledTime: "10:00", addedToPlanAt: now,
        status: "ready", source: "uploaded_image", planningStatus: "ready",
        createdAt: now, updatedAt: now,
        imageAnalysisStatus: "ready", keywordStatus: "ready", imageSummary: "A white reading lamp beside a chair",
        visibleObjects: ["lamp", "chair"], colors: ["white"], style: "minimal", ocrText: "", imageCategory: "home-decor",
        recommendedKeywords: ["reading corner ideas"], keywordSource: "pinterest_high_search",
      },
      "v2-e2e-scheduled-b": {
        id: "v2-e2e-scheduled-b", imageUrl: pixel, keyword: "desk lamp", category: "home-decor",
        title: "B".repeat(101), description: "Second scheduled description", altText: "Second scheduled alt",
        destinationUrl: "", boardId: "", boardName: "", weeklyPlanItemId: "", generationSessionId: "e2e-b",
        scheduledDate: tomorrow, scheduledTime: "11:00", addedToPlanAt: now,
        status: "ready", source: "uploaded_image", planningStatus: "ready",
        createdAt: now, updatedAt: now,
        imageAnalysisStatus: "ready", keywordStatus: "ready", imageSummary: "A black desk lamp",
        visibleObjects: ["lamp"], colors: ["black"], style: "minimal", ocrText: "", imageCategory: "home-decor",
        recommendedKeywords: ["desk lamp ideas"], keywordSource: "pinterest_high_search",
      },
    } }));
    sessionStorage.setItem("vp:studio:filter", "scheduled");
  }, { pixel: PIXEL });

  await page.route("**/rest/v1/**", route => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/pin-drafts**", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ drafts: [], nextCursor: null, accepted: [] }) }));
  await page.route("**/api/user-store**", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ documents: [], nextCursor: null, accepted: [] }) }));
  await page.route("**/api/pinterest/boards**", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], bookmark: null }) }));
  await page.route("**/api/pinterest/status**", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connected: false }) }));
  await page.route("**/api/ai-copy/v2/analyze", async route => {
    analyzeCount += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      ok: true, sessionId: "scheduled-session",
      factCard: { version: "fact-card-v1", sessionId: "scheduled-session", draftId: "v2-e2e-scheduled", locale: "en", facts: [] },
      keywordEvidence: { keywordSetId: "scheduled-ks", sessionId: "scheduled-session", draftId: "v2-e2e-scheduled", candidates: [], selectedKeywordIds: [], degradedMode: "no_keyword_demand_data" },
    }) });
  });
  await page.route("**/api/ai-copy/v2/generate", async route => {
    generateCount += 1;
    await generateGate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      ok: true, result: {
        generationId: "scheduled-generation", sessionId: "scheduled-session", draftId: "v2-e2e-scheduled", angleId: "default", keywordSetId: "scheduled-ks",
        title: "Updated scheduled title", description: "Updated scheduled description", altText: "Updated scheduled alt",
        usedKeywordIds: [], factSummary: [], degradedMode: "no_keyword_demand_data", validationReport: { valid: true, issues: [] },
      },
    }) });
  });

  await page.goto("/app/studio", { waitUntil: "networkidle" });
  const card = page.getByTestId("pin-board-card").first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toHaveAttribute("data-active", "false");
  const otherCard = page.getByTestId("pin-board-card").nth(1);
  await expect(otherCard).toBeVisible();

  await card.getByTestId("ai-copy-generate").click();
  await expect(page.getByTestId("ai-copy-replace-confirm")).toBeVisible();
  await page.getByTestId("ai-copy-replace-confirm-btn").click();
  await expect.poll(() => generateCount).toBe(1);
  await expect(card.getByTestId("ai-copy-generate")).toBeDisabled();

  await card.getByTestId("card-edit").click();
  await expect(card).toHaveAttribute("data-active", "false");
  expect(analyzeCount).toBe(1);
  expect(generateCount).toBe(1);

  releaseGenerate();
  await expect(card.getByTestId("ai-copy-generate")).toBeEnabled();
  await card.getByTestId("card-edit").click();
  await expect(card).toHaveAttribute("data-active", "true");
  await expect(card.getByTestId("title-ai-copy-generate")).toBeVisible();
  expect(analyzeCount).toBe(1);
  expect(generateCount).toBe(1);

  generateGate = new Promise<void>(resolve => { releaseGenerate = resolve; });
  await card.getByTestId("title-ai-copy-generate").click();
  await expect(page.getByTestId("ai-copy-replace-confirm")).toBeVisible();
  await page.getByTestId("ai-copy-replace-confirm-btn").click();
  await expect.poll(() => generateCount).toBe(2);
  await expect(card.getByTestId("ai-copy-generate")).toBeDisabled();

  await otherCard.getByTestId("card-edit").click();
  await expect(card).toHaveAttribute("data-active", "true");
  await expect(otherCard).toHaveAttribute("data-active", "false");
  await card.getByTestId("title-ai-copy-generate").dblclick();
  expect(analyzeCount).toBe(2);
  expect(generateCount).toBe(2);

  await otherCard.getByTestId("card-publish").click();
  await expect(card).toHaveAttribute("data-active", "true");
  await expect(otherCard).toHaveAttribute("data-active", "false");
  expect(analyzeCount).toBe(2);
  expect(generateCount).toBe(2);

  await card.getByTestId("card-collapse").click();
  await expect(card).toHaveAttribute("data-active", "true");
  expect(analyzeCount).toBe(2);
  expect(generateCount).toBe(2);

  releaseGenerate();
  await expect(card.getByTestId("ai-copy-generate")).toBeEnabled();
  await card.getByTestId("card-collapse").click();
  await expect(card).toHaveAttribute("data-active", "false");
});
