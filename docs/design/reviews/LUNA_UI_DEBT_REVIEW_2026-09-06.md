# VibePin UI Debt Review — GPT-5.6 Luna

Date: 2026-09-06  
Scope: read-only mechanical review of Keyword Trends, My Pins, and Pin Ideas  
Inputs: `VIBEPIN_DESIGN_SYSTEM.md`, `VIBEPIN_UI_AUDIT_2026-09-06.md`, `AGENT_UI_CHECKLIST.md`, and current working tree

## Ownership boundary

The reviewed pages already contain uncommitted work from multiple tasks. Existing improvements include the shared `AppPage` / `PageHeader` shell, responsive field labels, selected typography fixes, semantic surface tokens, and mobile card layouts. The items below are residual debt; they are not a recommendation to rewrite the pages.

## Findings

### P0

No statically verifiable release-blocking UI issue was found in this narrow review.

### P1

1. Keyword Trends still maintains multiple local color and state maps. Evidence: `web/src/app/app/trends/page.tsx:117`, `:198`, `:262`. Consolidate `INTEREST_COLOR`, `COMP_COLOR`, `SAVE_COLOR`, and `TREND_META`; move visible colors to semantic tokens.
2. Keyword Trends still contains functional text below 12px. Evidence: `web/src/app/app/trends/page.tsx:85`, `:133`, `:137`, `:290`, `:1358`. Raise badges, metric metadata, table help, and source notes to at least 12px.
3. Keyword Trends uses Unicode status symbols instead of the shared icon system. Evidence: `web/src/app/app/trends/page.tsx:165`, `:216`. Replace `↑`, `∞`, `◎`, and `❄` with Lucide or the shared status icon mapping.
4. Mobile field labels in Trends rely on CSS `::before`, so assistive technology may not receive the field meaning. Evidence: `web/src/app/globals.css:1333`, `:1402`. Render real label text nodes in JSX; `data-label` may remain only as a test hook.
5. My Pins filter controls retain extensive inline layout and visual styling despite new shared classes. Evidence: `web/src/app/app/history/page.tsx:1181`, `:1207`, `:1225`, `:1239`. Keep behavior and DOM structure, but migrate layout, active state, and input appearance to `.vp-history-*` classes and shared control styles.
6. My Pins `SessionCard` still owns a separate button, status, gradient, shadow, and typography system. Evidence: `web/src/app/app/history/page.tsx:839`, `:920`, `:986`. First extract status tokens and shared button classes; do not rewrite card business logic or the whole detail modal.
7. My Pins card selection relies on clickable `div` elements without equivalent keyboard operation. Evidence: `web/src/app/app/history/page.tsx:839`, `:853`. Use a focusable interactive element and Enter/Space handling; implement selection as a real checkbox or complete checkbox semantics.
8. Pin Ideas hides its primary row action on hover and does not expose the same discovery state to keyboard focus. Evidence: `web/src/app/app/discover/page.tsx:903`, `:905`, `:910`. Add `focus-within` / `focus-visible` visibility while retaining the always-visible touch rule.
9. Pin Ideas has separate production and demo heading hierarchies. Evidence: `web/src/app/app/discover/page.tsx:1467`, `:1517`. Preserve demo behavior, but converge both modes on `PageHeader` and the same heading tokens.

### P2

10. Pin Ideas search, filtering, and view controls retain local color, radius, and shadow literals. Evidence: `web/src/app/app/discover/page.tsx:1478`, `:1545`, `:1604`. Replace with existing button/control classes and semantic tokens.
11. Pin Ideas mobile analysis labels also depend on CSS pseudo-elements. Evidence: `web/src/app/globals.css:1325`, `:1333`. Render real labels in the table cells and keep `data-label` only where useful for tests.
12. The My Pins detail modal contains remaining 7–11px text, emoji/symbol status, and duplicated gradient actions. Evidence: `web/src/app/app/history/page.tsx:552`, `:602`, `:729`. Prioritize task-critical status and actions; defer broad modal restructuring.

## Recommended first pass

Prioritize findings 5, 7, and 8 because they directly affect theme consistency, keyboard operation, and core-action discoverability. Use screenshot evidence and product review before accepting the broader visual cleanups.

