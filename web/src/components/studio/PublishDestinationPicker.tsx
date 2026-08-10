"use client";

/**
 * PublishDestinationPicker — which connected Pinterest account this Pin publishes to.
 *
 * Renders NOTHING when the user has 0 or 1 connected accounts (`shouldShowAccountPicker`).
 * That is a hard requirement, not a nicety: everyone on the product today has exactly one
 * account, and they must keep seeing the UI they saw before multi-account existed — no
 * extra row, no "publishing to @x" noise (PRD §13, invariant C0.4).
 *
 * With several accounts it renders one select, above the Board field it belongs to,
 * because the Board list is only meaningful within the chosen account.
 *
 * Switching accounts ALWAYS clears the selected Board (`switchTargetPatch`) and says so.
 * Board ids belong to one account; "Home decor" on account A and "Home decor" on account B
 * are different boards, so we never guess a match by name.
 */

import { useLocale } from "@/lib/i18n/LocaleProvider";
import {
  shouldShowAccountPicker,
  switchTargetPatch,
  type PublishTargetPatch,
  type TargetableConnection,
} from "@/lib/studio/publishTarget";

const UI = {
  surface3: "var(--app-surface-3, #0F1524)",
  fieldBorder: "var(--app-border-hi, rgba(255,255,255,0.18))",
  text: "var(--app-text, #E2E8F0)",
  textMuted: "var(--app-text-muted, #5B6577)",
};

export type PublishDestinationPickerProps = {
  /** Every usable account, in the server's order (oldest first). */
  connections: readonly TargetableConnection[];
  /** The account currently targeted, or null while it resolves / when it's gone. */
  selectedConnectionId: string | null;
  disabled?: boolean;
  /**
   * The user picked a different account. `patch` carries the two target fields AND the
   * blanked boardId/boardName — apply it as one write so a draft can never be left
   * pointing at account B while holding account A's board.
   */
  onChange: (patch: PublishTargetPatch & { boardId: string; boardName: string }) => void;
};

export function PublishDestinationPicker({
  connections, selectedConnectionId, disabled, onChange,
}: PublishDestinationPickerProps) {
  const { t } = useLocale();
  if (!shouldShowAccountPicker(connections)) return null;

  return (
    <div style={{ marginBottom: 10 }} data-testid="publish-destination-picker">
      <label
        htmlFor="publish-target-account"
        style={{ display: "block", marginBottom: 5, fontSize: 11, color: UI.textMuted }}
      >
        {t("studioBoard.target.accountLabel")}
      </label>
      <select
        id="publish-target-account"
        data-testid="publish-target-account"
        value={selectedConnectionId ?? ""}
        disabled={disabled}
        onChange={(e) => {
          const next = connections.find(c => c.id === e.target.value);
          if (!next || next.id === selectedConnectionId) return;
          onChange(switchTargetPatch(next));
        }}
        style={{
          width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10,
          border: `1px solid ${UI.fieldBorder}`, fontSize: 13.5, color: UI.text,
          background: UI.surface3, outline: "none",
        }}
      >
        {/* Only reachable when the pinned account is no longer connected: the Pin keeps
            pointing at it (it is not re-routed), and the retry guard explains why. */}
        {!selectedConnectionId && <option value="">—</option>}
        {connections.map(c => (
          <option key={c.id} value={c.id}>
            {c.username?.trim() ? `@${c.username.trim().replace(/^@/, "")}` : c.id}
          </option>
        ))}
      </select>
      <p style={{ margin: "5px 0 0", fontSize: 10.5, color: UI.textMuted, lineHeight: 1.5 }}>
        {t("studioBoard.target.switchClearsBoard")}
      </p>
    </div>
  );
}
