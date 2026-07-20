// Create Pin Studio — Opportunity-first flow + AI Creative Direction panel.
// Namespace: "studioCreative.*"
// Covers OpportunityFirstStudio.tsx and CreativeDirectionPanel.tsx.
// This file is spread into the main en.ts catalog by the i18n coordinator.
export const studioCreativeMessages = {
  // ── Opportunity badges ──
  "studioCreative.badge.steady": "Steady",
  "studioCreative.badge.competitive": "Competitive",

  // ── Left panel: opportunity list ──
  "studioCreative.oppPanel.title": "1. Pin Opportunity",
  "studioCreative.oppPanel.subtitle": "Select the opportunity to create Pins for",
  "studioCreative.oppPanel.searchPlaceholder": "Search opportunities…",
  "studioCreative.oppPanel.empty": "No opportunities found",

  // ── Step indicator ──
  "studioCreative.step.opportunity": "Opportunity",
  "studioCreative.step.settings": "Settings",
  "studioCreative.step.generate": "Generate",
  "studioCreative.history": "History",

  // ── Page header ──
  "studioCreative.pageTitle": "Create Pin Studio",
  "studioCreative.pageSubtitle.withKeyword": "Turn this opportunity into Pinterest-native Pins that get saved.",
  "studioCreative.pageSubtitle.empty": "Select an opportunity from the left to get started.",

  // ── Opportunity summary bar ──
  "studioCreative.summaryBar.opportunity": "Opportunity",
  "studioCreative.summaryBar.category": "Category",
  "studioCreative.summaryBar.trend": "Trend",
  "studioCreative.summaryBar.priority": "Priority",

  // ── Section 2: Style references ──
  "studioCreative.refs.heading": "2. Style References",
  "studioCreative.refs.headingHint": "(for visual direction)",
  "studioCreative.refs.subtitle": "Select 1–5 Pins that match the style you want. Each reference creates a style group.",
  "studioCreative.refs.findViralPins": "Find Viral Pins",
  "studioCreative.refs.refIndex": "Ref {n}",
  "studioCreative.refs.uploaded": "Uploaded",
  "studioCreative.refs.uploadedAlt": "Uploaded reference",
  "studioCreative.refs.uploadLine1": "Upload",
  "studioCreative.refs.uploadLine2": "reference",
  "studioCreative.refs.selectedSummary_one": "{n} reference selected · Each reference will generate its own group of images.",
  "studioCreative.refs.selectedSummary_other": "{n} references selected · Each reference will generate its own group of images.",
  "studioCreative.refs.emptyNoOpportunity": "Select an opportunity to load style references.",

  // ── Section 3: Product images ──
  "studioCreative.products.heading": "3. Product Images",
  "studioCreative.products.headingHint": "(optional)",
  "studioCreative.products.subtitle": "Add 1–10 products to include in your Pins.",
  "studioCreative.products.imageAlt": "Product {n}",
  "studioCreative.products.addMoreLine1": "Add more",
  "studioCreative.products.addMoreLine2": "products",
  "studioCreative.products.upTo10": "Up to 10",
  "studioCreative.products.added_one": "{n} product added",
  "studioCreative.products.added_other": "{n} products added",

  // ── Section 5: Generation instructions ──
  "studioCreative.instructions.heading": "5. Generation Instructions",
  "studioCreative.instructions.headingHint": "(optional)",
  "studioCreative.instructions.subtitle": "Add any specific direction for the AI.",
  "studioCreative.instructions.placeholder": "Example: More cozy lighting, natural materials, minimalist styling, Pinterest aesthetic…",
  "studioCreative.instructions.quickIdeas": "Quick ideas",
  "studioCreative.instructions.idea.cozyLighting": "Cozy lighting",
  "studioCreative.instructions.idea.naturalMaterials": "Natural materials",
  "studioCreative.instructions.idea.minimalistStyling": "Minimalist styling",
  "studioCreative.instructions.idea.warmNeutrals": "Warm neutrals",
  "studioCreative.instructions.idea.editorialLook": "Editorial look",
  "studioCreative.instructions.idea.earthyTones": "Earthy tones",

  // ── Generated pins ──
  "studioCreative.generated.heading": "Generated Pins ({n})",
  "studioCreative.generated.refGroup": "Reference group {n}",
  "studioCreative.generated.download": "↓ DL",
  "studioCreative.generated.noTextOverlay": "No text overlay",

  // ── Generate CTA ──
  "studioCreative.cta.groupProgress": "Group {current}/{total}…",
  "studioCreative.cta.generating": "Generating…",
  "studioCreative.cta.generate_one": "Generate {n} Pin",
  "studioCreative.cta.generate_other": "Generate {n} Pins",
  "studioCreative.cta.privacyNote": "Your generation is private and secure",

  // ── Right panel: settings ──
  "studioCreative.settings.heading": "4. Settings",
  "studioCreative.settings.imagesPerReference": "Images per reference",
  "studioCreative.settings.imagesPerReferenceHint": "How many images to generate per reference.",
  "studioCreative.settings.textOverlay": "Text overlay",
  "studioCreative.settings.noTextRecommended": "No text (recommended)",
  "studioCreative.settings.noTextHint": "Pins will be generated without any text.",

  // ── Right panel: generation summary ──
  "studioCreative.summary.heading": "Generation Summary",
  "studioCreative.summary.oneOpportunity": "1 opportunity",
  "studioCreative.summary.noOpportunity": "No opportunity",
  "studioCreative.summary.references_one": "{n} reference",
  "studioCreative.summary.references_other": "{n} references",
  "studioCreative.summary.noReferencesAutoStyle": "No references · Auto Style",
  "studioCreative.summary.products_one": "{n} product",
  "studioCreative.summary.products_other": "{n} products",
  "studioCreative.summary.imagesPer_one": "{n} image per {scope}",
  "studioCreative.summary.imagesPer_other": "{n} images per {scope}",
  "studioCreative.summary.scopeReference": "reference",
  "studioCreative.summary.scopeGeneration": "generation",
  "studioCreative.summary.formula.refsTimesImages_one": "{refCount} reference × {count} image each",
  "studioCreative.summary.formula.refsTimesImages_other": "{refCount} references × {count} images each",
  "studioCreative.summary.formula.imagesAutoStyle_one": "{count} image (Auto Style)",
  "studioCreative.summary.formula.imagesAutoStyle_other": "{count} images (Auto Style)",
  "studioCreative.summary.formula.equals": "=",
  "studioCreative.summary.formula.totalPins": "{n} Pins",

  // ── Right panel: tips ──
  "studioCreative.tips.heading": "Tips for better results",
  "studioCreative.tips.useReferences": "Use 1–5 style references for clear direction",
  "studioCreative.tips.addProducts": "Add multiple products for variety",
  "studioCreative.tips.keepSimple": "Keep it simple — let the visuals speak",
  "studioCreative.tips.avoidText": "Avoid text for higher save rate",

  // ── Creative Direction panel ──
  "studioCreative.direction.title": "AI Creative Direction",
  "studioCreative.direction.subtitle": "Choose a direction; VibePin builds the technical prompt behind the scenes.",
  "studioCreative.direction.confidenceTitle": "How well this direction matches your inputs",
  "studioCreative.direction.whyLabel": "Why: ",
  "studioCreative.direction.influencedByLabel": "Influenced by:",
  "studioCreative.direction.contextLabel": "Context: ",
  "studioCreative.direction.removeContextAria": "Remove opportunity context",
  "studioCreative.direction.fineTune": "Fine-tune direction",

  "studioCreative.direction.field.goal": "Goal",
  "studioCreative.direction.field.subject": "Subject",
  "studioCreative.direction.field.referenceStrength": "Reference strength",
  "studioCreative.direction.field.productEmphasis": "Product emphasis",
  "studioCreative.direction.field.textOverlay": "Text overlay",
  "studioCreative.direction.field.auto": "Auto",

  "studioCreative.direction.goal.saves": "Saves",
  "studioCreative.direction.goal.clicks": "Clicks",
  "studioCreative.direction.goal.productShowcase": "Product showcase",
  "studioCreative.direction.goal.engagement": "Engagement",
  "studioCreative.direction.goal.traffic": "Traffic",

  "studioCreative.direction.subject.onModel": "On-model",
  "studioCreative.direction.subject.productOnly": "Product only",
  "studioCreative.direction.subject.flatLay": "Flat lay",
  "studioCreative.direction.subject.lifestyleScene": "Lifestyle scene",

  "studioCreative.direction.strength.subtle": "Subtle",
  "studioCreative.direction.strength.balanced": "Balanced",
  "studioCreative.direction.strength.strong": "Strong",

  "studioCreative.direction.emphasis.balanced": "Balanced",
  "studioCreative.direction.emphasis.productFirst": "Product first",
  "studioCreative.direction.emphasis.aestheticFirst": "Aesthetic first",

  "studioCreative.direction.textOverlay.none": "None",
  "studioCreative.direction.textOverlay.light": "Light",
  "studioCreative.direction.textOverlay.headline": "Headline",
  "studioCreative.direction.textOverlay.informationRich": "Information-rich",

  "studioCreative.direction.optionalRefinement": "Optional refinement",
  "studioCreative.direction.optionalRefinementDesc": "Add anything not covered above. Example: no text overlay, urban street scene, warm natural lighting.",
  "studioCreative.direction.customInstructionsPlaceholder": "e.g. no text overlay, urban street scene, warm natural lighting",
  "studioCreative.direction.briefPlaceholder": "Creative brief preview. You can edit it, or use the direction controls above.",
  "studioCreative.direction.inputsChanged": "Inputs changed.",
  "studioCreative.direction.updateDirection": "Update direction",
  "studioCreative.direction.keepMyEdits": "Keep my edits",
  "studioCreative.direction.manualBrief": "Manual brief",
  "studioCreative.direction.generatedFromDirection": "Generated from selected direction",

  // ── Prompt moderation notice (AI-compliance) ──
  "studioCreative.direction.moderationNotice": "Prompts are screened before generation. Sexual, NSFW, exploitative, harmful, illegal, deepfake, and face-manipulation content is prohibited.",
  "studioCreative.direction.moderationNoticeLink": "View policy",
} as const;
