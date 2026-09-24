/**
 * reconcileVerdict.ts — "was that Pin actually created?", as a pure function.
 *
 * 发布可靠性 P0 技术设计 v0.1 §5.2 / §5.3. No I/O, no Supabase, no Pinterest
 * client: the probes are performed by the caller and handed in as results, so
 * every branch of the decision can be tested without a network and, more to the
 * point, so the decision can be read in one place.
 *
 * ── THE ONE RULE ────────────────────────────────────────────────────────────
 * There are three verdicts and they are NOT symmetric:
 *
 *   confirmed_published  the Pin exists. Safe: we stop, and record the link.
 *   still_unknown        we do not know. Safe: we stop, and ask again later.
 *   confirmed_absent     the Pin does not exist. ★ DANGEROUS ★ — this is the
 *                        only verdict that authorizes sending again, so it is
 *                        the only one that can produce a DUPLICATE PIN if it
 *                        is wrong.
 *
 * Therefore every uncertainty resolves to `still_unknown`, never to
 * `confirmed_absent`. A timeout is unknown. A 500 is unknown. A board listing
 * we could not page through is unknown. A Pin that exists but sits on a board
 * we did not aim at is unknown (the anchor is stale, not the Pin absent). Two
 * candidate matches are unknown. Only an unambiguous "Pinterest, using this
 * user's own token, said no such Pin" — a clean 404, or a media the provider
 * itself marked failed — is allowed to mean absent.
 *
 * The cost of being wrong in the `still_unknown` direction is a Pin that never
 * goes out until a human looks. The cost of being wrong in the
 * `confirmed_absent` direction is the merchant's audience seeing the same Pin
 * twice. Those are not equally bad, and the asymmetry above is deliberate.
 */

import type { FetchedPin, PinterestMediaStatus } from "@/lib/server/pinterest/service";

export type ReconcileOutcome = "confirmed_published" | "confirmed_absent" | "still_unknown";

/** Why the verdict came out the way it did — recorded as evidence, and logged. */
export type ReconcileVerdict = {
  outcome: ReconcileOutcome;
  reason: string;
  remoteId?: string;
  remoteUrl?: string;
};

/**
 * The result of one probe. `error` is a FIRST-CLASS case, not an exception to
 * be caught somewhere else: a probe that failed is exactly the situation where
 * a careless implementation concludes "absent", so it is represented explicitly
 * and every consumer has to decide about it.
 */
export type ProbeResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

/** What the worker knows before it probes anything. */
export type ReconcileAnchors = {
  /** From v81 evidence / provider attempt. NEVER from the client-writable payload. */
  pinId: string | null;
  mediaId: string | null;
  /** The board this destination was aimed at. */
  boardId: string | null;
  /** Identity of the content we tried to send, for the listing match. */
  title: string | null;
  link: string | null;
  /** When the attempt started — the centre of the listing window. */
  attemptStartedAtMs: number | null;
};

/** The probes the caller performed, in the order §5.2 allows. */
export type ReconcileProbes = {
  pin?: ProbeResult<FetchedPin>;
  media?: ProbeResult<PinterestMediaStatus>;
  boardPins?: ProbeResult<{ items: FetchedPin[]; bookmark: string | null }>;
};

/** ±15 minutes around the attempt (design §5.2 step 3). */
export const LISTING_WINDOW_MS = 15 * 60_000;

/** Media states that prove nothing was ever created from the upload. */
const MEDIA_FAILED = new Set(["FAILED", "REJECTED"]);
/** Media states that are terminal-success — the Pin question stays open. */
const MEDIA_SUCCEEDED = new Set(["SUCCEEDED"]);

/**
 * Which probe should the caller run next, given what it already knows?
 *
 * Expressed as a separate function so the caller stays a thin loop and the
 * SHORT-CIRCUIT ORDER (§5.2: pinId → mediaId → board listing, stop as soon as
 * one is decisive) is stated once, here, where it is testable. A caller that
 * probes everything unconditionally would still reach a correct verdict, but it
 * would spend three provider round-trips per open reconciliation and the 60s
 * sub-budget would cover a third as many rows.
 */
export function nextProbe(
  anchors: ReconcileAnchors,
  probes: ReconcileProbes,
): "pin" | "media" | "boardPins" | null {
  if (anchors.pinId && !probes.pin) return "pin";
  // A decisive pin probe ends it — no further probe can improve on a direct
  // answer about the exact Pin id the provider gave us.
  if (probes.pin && probes.pin.kind !== "error") return null;
  if (anchors.mediaId && !probes.media) return "media";
  // Media that failed is decisive on its own; media that succeeded is not.
  if (probes.media?.kind === "ok" && probes.media.value.status
      && MEDIA_FAILED.has(probes.media.value.status)) {
    return null;
  }
  if (anchors.boardId && !probes.boardPins) return "boardPins";
  return null;
}

/** Does a listed Pin describe the content this destination tried to send? */
function matchesContent(pin: FetchedPin, anchors: ReconcileAnchors): boolean {
  const want = (s: string | null) => (typeof s === "string" ? s.trim() : "");
  const wantTitle = want(anchors.title);
  const wantLink = want(anchors.link);
  // With neither anchor there is nothing to match ON, and "every Pin on the
  // board matches" would make a busy board look like a confirmed publish.
  if (!wantTitle && !wantLink) return false;
  if (wantTitle && want(pin.title) !== wantTitle) return false;
  if (wantLink && want(pin.link) !== wantLink) return false;
  return true;
}

/** Is this Pin inside the ±15 minute window around the attempt? */
function inWindow(pin: FetchedPin, anchors: ReconcileAnchors): boolean {
  if (anchors.attemptStartedAtMs === null) return false;
  const created = pin.createdAt ? Date.parse(pin.createdAt) : NaN;
  if (Number.isNaN(created)) return false;
  return Math.abs(created - anchors.attemptStartedAtMs) <= LISTING_WINDOW_MS;
}

/**
 * The verdict.
 *
 * Reads in the same order as §5.2 and returns the FIRST decisive answer. The
 * fall-through at the bottom is `still_unknown`, which is the point: a case
 * nobody thought about lands on the verdict that cannot duplicate a Pin.
 */
export function reconcileVerdict(
  anchors: ReconcileAnchors,
  probes: ReconcileProbes,
): ReconcileVerdict {
  // ── 1. The Pin id, if the provider ever gave us one ───────────────────────
  if (probes.pin) {
    if (probes.pin.kind === "ok") {
      const pin = probes.pin.value;
      // ★ A Pin on a DIFFERENT board is not proof of this destination's
      // publish. It is proof the anchor is stale (a recycled id, a wrong
      // evidence row). Absent would be a duplicate; published would attach a
      // stranger's permalink to the merchant's Content. Unknown is the only
      // honest answer.
      if (anchors.boardId && pin.boardId && pin.boardId !== anchors.boardId) {
        return {
          outcome: "still_unknown",
          reason: `pin_board_mismatch(anchor=${anchors.boardId},actual=${pin.boardId})`,
        };
      }
      return {
        outcome: "confirmed_published",
        reason: "pin_found",
        remoteId: pin.id,
        remoteUrl: pin.url,
      };
    }
    // ★ THE ONE PLACE A RE-SEND IS AUTHORIZED BY A PIN PROBE. A clean 404 from
    // the user's own token on the exact id the provider returned.
    if (probes.pin.kind === "not_found") {
      return { outcome: "confirmed_absent", reason: "pin_404" };
    }
    // An errored pin probe falls through to the cheaper anchors below rather
    // than concluding anything.
  }

  // ── 2. The media upload, for video ────────────────────────────────────────
  if (probes.media?.kind === "ok") {
    const status = probes.media.value.status ?? "";
    // The media itself never completed, so no Pin can have been created FROM
    // it. This is the second and last route to `confirmed_absent`.
    if (MEDIA_FAILED.has(status)) {
      return { outcome: "confirmed_absent", reason: `media_${status.toLowerCase()}` };
    }
    // Succeeded media says nothing about the create call — fall through.
    if (!MEDIA_SUCCEEDED.has(status)) {
      return { outcome: "still_unknown", reason: `media_not_terminal(${status || "unknown"})` };
    }
  }

  // ── 3. The board listing, last resort ─────────────────────────────────────
  if (probes.boardPins?.kind === "ok") {
    const matches = probes.boardPins.value.items.filter(
      p => matchesContent(p, anchors) && inWindow(p, anchors));
    if (matches.length === 1) {
      return {
        outcome: "confirmed_published",
        reason: "board_listing_unique_match",
        remoteId: matches[0].id,
        remoteUrl: matches[0].url,
      };
    }
    // ★ Two candidates means we cannot say WHICH is ours, and possibly the
    // merchant already has a duplicate. Re-sending would make a third.
    if (matches.length > 1) {
      return { outcome: "still_unknown", reason: `board_listing_ambiguous(${matches.length})` };
    }
    // Zero matches is only absence if the listing could have SEEN a match:
    //   · there was something to match on (title or link), and
    //   · we know when the attempt was, and
    //   · the page we read covers the window — an unread `bookmark` page may
    //     hold the Pin, so a truncated listing is not a complete search.
    const searchable = !!((anchors.title ?? "").trim() || (anchors.link ?? "").trim());
    const windowKnown = anchors.attemptStartedAtMs !== null;
    const complete = probes.boardPins.value.bookmark === null;
    if (searchable && windowKnown && complete) {
      return { outcome: "confirmed_absent", reason: "board_listing_no_match" };
    }
    return {
      outcome: "still_unknown",
      reason: `board_listing_inconclusive(searchable=${searchable},`
        + `window=${windowKnown},complete=${complete})`,
    };
  }

  // ── Nothing was decisive ──────────────────────────────────────────────────
  const failed: string[] = [];
  if (probes.pin?.kind === "error") failed.push(`pin:${probes.pin.message}`);
  if (probes.media?.kind === "error") failed.push(`media:${probes.media.message}`);
  if (probes.boardPins?.kind === "error") failed.push(`board:${probes.boardPins.message}`);
  if (probes.media?.kind === "not_found") failed.push("media:expired");
  if (!anchors.pinId && !anchors.mediaId && !anchors.boardId) failed.push("no_anchor");
  return {
    outcome: "still_unknown",
    reason: failed.length ? `probe_failed(${failed.join(";")})` : "no_decisive_probe",
  };
}
