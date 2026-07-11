// Dev-only sidebar navigation timing. No-ops entirely in production builds.
//
// Usage:
//   markNavClick(href)   — call from the sidebar Link's onClick, before navigation.
//   markRouteVisible(path) — call from a `useEffect(() => {...}, [path])` in the
//                            app shell once the new route has committed.
//   markDataReady(path)  — optional: a page calls this once its primary data load
//                            finishes, to close out the "route visible -> data ready" span.
//
// Logs:
//   [Sidebar Navigation] click -> push: Nms
//   [Sidebar Navigation] push -> route visible: Nms
//   [Sidebar Navigation] route visible -> data ready: Nms
//   [Sidebar Navigation] slow route: /app/xxx Nms   (any step over 500ms)

const DEV = process.env.NODE_ENV !== "production";
const SLOW_THRESHOLD_MS = 500;

type PendingClick = { href: string; clickAt: number };

let pendingClick: PendingClick | null = null;
const routeVisibleAt = new Map<string, number>();

function log(step: string, ms: number, path: string): void {
  const rounded = Math.round(ms);
  console.log(`[Sidebar Navigation] ${step}: ${rounded}ms`);
  if (rounded > SLOW_THRESHOLD_MS) {
    console.warn(`[Sidebar Navigation] slow route: ${path} ${rounded}ms`);
  }
}

/** Call from the sidebar nav item's onClick, before the Link navigates. */
export function markNavClick(href: string): void {
  if (!DEV) return;
  const clickAt = performance.now();
  pendingClick = { href, clickAt };
  // Link's push happens synchronously in the same event handler, so this span
  // is expected to be ~0ms — logged mainly to make the full requested sequence
  // visible and to catch any accidental blocking work before the push fires.
  log("click -> push", performance.now() - clickAt, href);
}

/** Call from the app shell once the route (pathname) has changed and committed. */
export function markRouteVisible(path: string): void {
  if (!DEV) return;
  if (pendingClick && pendingClick.href === path) {
    const now = performance.now();
    log("push -> route visible", now - pendingClick.clickAt, path);
    routeVisibleAt.set(path, now);
    pendingClick = null;
  }
}

/** Optional: a page calls this once its primary data load finishes. */
export function markDataReady(path: string): void {
  if (!DEV) return;
  const visibleAt = routeVisibleAt.get(path);
  if (visibleAt != null) {
    log("route visible -> data ready", performance.now() - visibleAt, path);
    routeVisibleAt.delete(path);
  }
}
