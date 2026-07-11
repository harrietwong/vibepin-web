/**
 * Instant loading frame for the Pinterest connect interstitial — paints immediately
 * on navigation so there is never a blank/frozen gap before the client page mounts.
 */
export default function Loading() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--app-bg, #0B0F1A)", color: "var(--app-text-sec, #8892A4)", fontSize: 14 }}>
      Opening Pinterest…
    </div>
  );
}
