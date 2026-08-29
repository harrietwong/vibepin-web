"use client";

/**
 * The "why is this user stuck" cell — shared by the /admin/today blocker list
 * and the Customer 360 alert strip so the two can never explain the same
 * blocker differently.
 *
 * Layout is two lines: a MAIN line built from enum codes only (count, error
 * code, error class) and, when we have it, a MUTED second line carrying the raw
 * provider/DB message. The main line is always safe display prose from the
 * message catalog; the second line is the one place free text reaches the
 * screen, which is why it is clipped at the data layer, rendered verbatim
 * (never translated), and carries the full value in a title attribute.
 *
 * Rationale for showing the message at all: a code like `board_not_owned` tells
 * the operator the class of failure, but answering the customer usually needs
 * the specific detail ("board 'Fall Recipes' not found").
 */

import { AdminT, AdminTFmt } from "../AdminT";
import { useAdminChrome } from "../AdminChromeProvider";
import { generationErrorKey } from "@/lib/admin/adminConsoleKeys";
import type { BlockerItem } from "@/lib/server/adminActionCenter";

/** Muted second line holding the raw failure text (verbatim, never translated). */
function ReasonDetail({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <span
      className="mt-0.5 block truncate text-[11px] leading-snug"
      style={{ color: "var(--admin-text-muted, #9CA3AF)", maxWidth: "42ch" }}
      title={message}
    >
      {message}
    </span>
  );
}

/**
 * Renders "{count} failed generation(s) … · latest: {typeLabel}" with the label
 * resolved through the admin catalog. Needs the imperative t()/tFmt() (not the
 * <AdminT> leaves) because the label is a STRING interpolated into another
 * catalog sentence — an unrecognized error_type falls through verbatim so a
 * value we never classified is still visible to whoever is debugging.
 */
function GenerationFailureLine({ count, type }: { count: number; type: string }) {
  const { t, tFmt } = useAdminChrome();
  const key = generationErrorKey(type);
  const typeLabel = key ? t(key) : type;
  return <>{tFmt("blocker.evidence.generationFailuresWithType", { count, typeLabel })}</>;
}

export function BlockerReason({ item }: { item: BlockerItem }) {
  const e = item.evidence;
  switch (item.blockerType) {
    case "publish_failure":
      return (
        <>
          {e.publishErrorCode ? (
            <AdminTFmt k="blocker.evidence.publishFailureWithCode" vars={{ count: e.failedPublishCount ?? 1, code: e.publishErrorCode }} />
          ) : (
            <AdminTFmt k="blocker.evidence.publishFailure" vars={{ count: e.failedPublishCount ?? 1 }} />
          )}
          <ReasonDetail message={e.publishErrorMessage} />
        </>
      );
    case "pinterest_disconnected":
      return <AdminT k={e.disconnectReason === "disconnected" ? "blocker.evidence.pinterestDisconnected.disconnected" : "blocker.evidence.pinterestDisconnected.needsReconnect"} />;
    case "generation_failures": {
      const count = e.failedGenerationCount ?? 0;
      const type = e.generationErrorType;
      return (
        <>
          {type ? (
            <GenerationFailureLine count={count} type={type} />
          ) : (
            <AdminTFmt k="blocker.evidence.generationFailures" vars={{ count }} />
          )}
          <ReasonDetail message={e.generationErrorMessage} />
        </>
      );
    }
    case "signup_not_connected":
      return <AdminTFmt k="blocker.evidence.signupNotConnected" vars={{ hours: e.ageHours ?? 0 }} />;
    case "connected_not_creating":
      return <AdminTFmt k="blocker.evidence.connectedNotCreating" vars={{ hours: e.ageHours ?? 0 }} />;
    default:
      return null;
  }
}
