/**
 * Public "data deletion status" page. Meta requires the data-deletion callback
 * (api/auth/facebook/data-deletion) to hand back a URL where the user can check
 * on their deletion request — this is that page.
 *
 * Deliberately static/minimal: it does not query any database (the actual
 * disconnect already happened synchronously inside the callback route). This
 * page exists to give Meta's reviewer and the end user a concrete confirmation
 * to look at, keyed by the confirmation_code from the callback response.
 *
 * Public by construction: it lives at the app-root level (NOT under /app/**),
 * and the auth proxy's matcher is scoped to "/app/:path*" (see src/proxy.ts),
 * so this route is never intercepted by the login guard.
 */

export const metadata = {
  title: "Data Deletion Status — VibePin",
};

export default async function DataDeletionStatusPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  const confirmationCode = typeof code === "string" && code.trim() ? code.trim() : null;

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "#0B0F1A",
        color: "#E2E8F0",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: 480,
          textAlign: "center",
          padding: "32px 28px",
          borderRadius: 16,
          border: "1px solid rgba(255,255,255,0.10)",
          background: "#161D2E",
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 800, margin: "0 0 12px" }}>
          Data deletion request received
        </h1>
        {confirmationCode ? (
          <p style={{ fontSize: 14, lineHeight: 1.6, color: "#8892A4", margin: 0 }}>
            Your data deletion request has been received and processed. Confirmation code:{" "}
            <strong style={{ color: "#E2E8F0" }}>{confirmationCode}</strong>
          </p>
        ) : (
          <p style={{ fontSize: 14, lineHeight: 1.6, color: "#8892A4", margin: 0 }}>
            No confirmation code was provided. If you requested data deletion via Facebook,
            please allow a few minutes and check the link Facebook provided again.
          </p>
        )}
      </div>
    </main>
  );
}
