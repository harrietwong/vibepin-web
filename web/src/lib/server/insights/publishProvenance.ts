/**
 * Publish provenance: which Pinterest Pins VibePin itself published, and through
 * which connected account.
 *
 * Pure functions over a stored draft payload — no Supabase client, no `server-only`
 * import — because this is the whitelist Insights trusts and it has to be testable
 * directly. `vibepinPublishedPins.ts` owns the paging; this module owns the reading
 * of one payload.
 *
 * ── Two provenance shapes, in a deliberate order ──────────────────────────────
 * A Content can be published to SEVERAL Pinterest accounts in one action. The
 * fan-out path records one result per destination on `payload.destinationResults`,
 * each with its own remote Pin id and the social connection it went to. The older
 * single-destination path recorded one `remotePinId` plus one `targetConnectionId`
 * on the payload root.
 *
 * `destinationResults` therefore wins whenever it is present and parseable, and the
 * legacy pair is read only when it is absent or empty. Merging the two would double
 * count: the root `remotePinId` of a fanned-out draft is one of the destinations,
 * usually the first, and re-admitting it would attach that Pin to whichever
 * connection the root field happened to name — the mis-attribution that per
 * destination records exist to prevent.
 *
 * The field is typed as `unknown` and validated here rather than imported: the
 * fan-out branch owns the writer's type, this branch may not have it yet, and a
 * payload read out of the database is untrusted input regardless of which branch
 * wrote it.
 */

export type VibePinPublishedPinterestPin = {
  pinId: string;
  draftId: string;
  title: string | null;
  imageUrl: string | null;
  postUrl: string;
  publishedAt: string | null;
  mediaType: string | null;
  /**
   * The social_connections row this Pin was actually published through — the
   * destination's `socialConnectionId` for fan-out records, `targetConnectionId`
   * for legacy ones. Null only for drafts published before either was recorded;
   * those cannot be attributed from the payload alone, so Insights falls back to
   * the v64 content registry and, failing that, shows them on every account rather
   * than silently hiding them from the account that really owns them.
   */
  targetConnectionId: string | null;
};

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Pinterest Pin ids are decimal strings. Anything else is not a Pin id, and a Pin
 *  we cannot address is not provenance — it is a stray field. */
export function pinterestPinId(value: unknown): string | null {
  const id = nonEmptyString(value);
  return id && /^\d+$/.test(id) ? id : null;
}

function mediaType(payload: Record<string, unknown>): string | null {
  return nonEmptyString(payload.mediaType)
    ?? nonEmptyString(payload.format)
    ?? (nonEmptyString(payload.imageUrl) ? "IMAGE" : null);
}

function pinUrl(pinId: string): string {
  return `https://www.pinterest.com/pin/${pinId}/`;
}

/** One entry of `payload.destinationResults`, after validation. Kept structurally
 *  identical to the writer's record so a field added there is visible here as a
 *  missing case rather than as a silent drop. */
export type DestinationResultEntry = {
  destinationId: string | null;
  provider: string;
  socialConnectionId: string | null;
  status: string | null;
  remoteId: string | null;
  postUrl: string | null;
  publishedAt: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate `payload.destinationResults`.
 *
 * "Parseable" only requires an object naming a provider. That is a lower bar than
 * "published", on purpose: a draft whose fan-out failed on every destination has
 * results, and they say the publish did NOT happen. Treating that draft as legacy
 * and admitting its root `remotePinId` would resurrect a Pin the fan-out says was
 * never created — so the presence of results, not their success, is what decides
 * which path is authoritative.
 */
export function parseDestinationResults(value: unknown): DestinationResultEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: DestinationResultEntry[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const provider = nonEmptyString(raw.provider);
    if (!provider) continue;
    entries.push({
      destinationId: nonEmptyString(raw.destinationId),
      provider: provider.toLowerCase(),
      socialConnectionId: nonEmptyString(raw.socialConnectionId),
      status: nonEmptyString(raw.status),
      remoteId: nonEmptyString(raw.remoteId),
      postUrl: nonEmptyString(raw.postUrl),
      publishedAt: nonEmptyString(raw.publishedAt),
    });
  }
  return entries;
}

/**
 * A destination becomes provenance only when it carries the full evidence: this
 * platform, a confirmed publish, a usable Pin id, and the account it went to. A
 * "published" entry without a remote id is a bookkeeping bug, not a Pin, and
 * admitting it would put a row on the dashboard that no analytics call can ever
 * fill.
 */
function publishedPinterestEntry(entry: DestinationResultEntry): boolean {
  return entry.provider === "pinterest"
    && entry.status === "published"
    && pinterestPinId(entry.remoteId) !== null
    && entry.socialConnectionId !== null;
}

/**
 * The pre-fan-out shape: one Pin recorded on the payload root. `remotePinId` is
 * written only after Pinterest confirms a successful publish, so title/image
 * similarities never qualify a Pin.
 */
export function legacyPublishedPinterestPinFromDraft(
  draftId: string,
  payload: Record<string, unknown>,
): VibePinPublishedPinterestPin | null {
  const pinId = pinterestPinId(payload.remotePinId);
  if (!pinId) return null;

  return {
    pinId,
    draftId,
    title: nonEmptyString(payload.title),
    imageUrl: nonEmptyString(payload.imageUrl) ?? nonEmptyString(payload.sourceImageUrl),
    postUrl: nonEmptyString(payload.remotePinUrl) ?? pinUrl(pinId),
    publishedAt: nonEmptyString(payload.postedAt),
    mediaType: mediaType(payload),
    targetConnectionId: nonEmptyString(payload.targetConnectionId),
  };
}

/**
 * Every Pinterest Pin one draft produced.
 *
 * An array because one Content can reach N accounts — the same creative, N distinct
 * Pin ids, N owners. Duplicated Pin ids inside one draft collapse to the first
 * occurrence; a Pin id belongs to exactly one account, so a repeat is a writer bug
 * and choosing later over earlier would only make it non-deterministic.
 */
export function publishedPinterestPinsFromDraft(
  draftId: string,
  payload: Record<string, unknown>,
): VibePinPublishedPinterestPin[] {
  const results = parseDestinationResults(payload.destinationResults);

  if (results.length > 0) {
    const pins: VibePinPublishedPinterestPin[] = [];
    const seen = new Set<string>();
    for (const entry of results) {
      if (!publishedPinterestEntry(entry)) continue;
      const pinId = pinterestPinId(entry.remoteId)!;
      if (seen.has(pinId)) continue;
      seen.add(pinId);
      pins.push({
        pinId,
        draftId,
        title: nonEmptyString(payload.title),
        imageUrl: nonEmptyString(payload.imageUrl) ?? nonEmptyString(payload.sourceImageUrl),
        postUrl: entry.postUrl ?? pinUrl(pinId),
        // The destination's own timestamp when it has one: destinations of a single
        // draft can publish at different times, and the payload root records only one.
        publishedAt: entry.publishedAt ?? nonEmptyString(payload.postedAt),
        mediaType: mediaType(payload),
        targetConnectionId: entry.socialConnectionId,
      });
    }
    return pins;
  }

  const legacy = legacyPublishedPinterestPinFromDraft(draftId, payload);
  return legacy ? [legacy] : [];
}
