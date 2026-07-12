# Create Pins Creative Direction V2 Audit

Date: 2026-06-15

## Current Metadata Sources

- `AssetItem` in `src/lib/assetStore.ts` can provide `id`, `role`, `assetRole`, `itemType`, `productType`, `productSubtype`, `destinationType`, `sourceContext`, `source`, `imageUrl`, `title`, `category`, `keyword`, `visualFormat`, `sourceUrl`, `productUrl`, `sourceDomain`, `price`, `store`, and `riskFlags`.
- `CreatePinsPrefill` in `src/lib/createPinsPrefill.ts` can provide opportunity `title`, `keyword`, `category`, evidence and score; product `title`, `source`, `category`, `productUrl`, `sourceDomain`; and reference `category`, `keyword`, `saveCount`, `visualFormat`, `humanPresence`, `saveSignal`.
- Studio selection state is URL-first (`products: string[]`, `refs: string[]`), so V2 must normalize selected URLs back to metadata from `assetStore` or prefill snapshots before building category-aware direction.

## Current Prompt Flow

- Studio owns a visible `prompt` string and one `promptManuallyEdited` ref.
- Studio currently appends content language guidance before calling `/api/generate`.
- `/api/generate` also appends a language hint before piping JSON into `backend/generator.py`.
- `generator.py` infers category/output type, optionally calls `prompt_enhancer.py`, and then builds the final image prompt.
- `prompt_enhancer.py` can render its own final prompt from VLM analysis, which can conflict with frontend-assembled instructions if not version-gated.

## Persistence

- Durable Studio setup is stored in `HistoryEntry.setupSnapshot`, local history, IndexedDB remix recovery, and compact DB/storage recovery through `pin_generations.groups_json`.
- Some deployed databases may not have `setup_snapshot`, `prompt_full`, `status`, or `category_audit`; `groups_json` remains the compatibility fallback.
- Legacy records without V2 metadata must continue to restore from `promptSnapshot`.

## Weekly Plan

- Weekly Plan drafts store `generationSessionId`, `pinId`, `imageUrl`, `setupSnapshot`, and `promptSnapshot`.
- There is no reliable `generated_asset_id` resolution path in current handoff code, so V2 should continue referencing session/image first and avoid duplicating large snapshots when compact setup is already available.
