"use client";

/**
 * Permanent non-production environment badge.
 *
 * Preview and Production render identically, so "which environment am I looking
 * at?" was repeatedly ambiguous — a question the address bar answers only if you
 * think to check it, and a stale tab answers wrongly. This badge answers it from
 * the RUNNING deployment: host, commit, deployment id, plus a traceId that is
 * also written into the deployment log (via /api/debug/probe), so a log search
 * for that id proves which deployment a browser session actually talked to.
 *
 * Renders nothing when VERCEL_ENV is "production".
 */

import { useEffect, useState } from "react";

type Deployment = {
  host: string | null;
  vercelEnv: string;
  gitCommitSha: string | null;
  deploymentId: string | null;
};

export function PreviewBadge() {
  const [info, setInfo] = useState<Deployment | null>(null);
  const [traceId, setTraceId] = useState<string>("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // 404 in production — the badge then stays invisible, which is the point.
        const res = await fetch("/api/debug/deployment");
        if (!res.ok || !alive) return;
        const d = (await res.json()) as Deployment;
        if (!alive || d.vercelEnv === "production") return;
        setInfo(d);

        const id =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID().slice(0, 8)
            : Math.random().toString(36).slice(2, 10);
        setTraceId(id);
        // One breadcrumb per page load, findable in the logs by this id.
        void fetch("/api/debug/probe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ traceId: id, path: window.location.pathname }),
        }).catch(() => {});
      } catch {
        /* debug-only: never disturb the app */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!info) return null;

  return (
    <div
      onClick={() => setOpen(o => !o)}
      title="Non-production deployment — click to expand"
      style={{
        position: "fixed",
        right: 10,
        bottom: 10,
        zIndex: 2147483647,
        padding: open ? "8px 10px" : "4px 9px",
        borderRadius: 7,
        background: "#7C2D12",
        color: "#FFEDD5",
        border: "1px solid #F97316",
        font: "600 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace",
        cursor: "pointer",
        maxWidth: 320,
        wordBreak: "break-all",
        boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
      }}
    >
      <span style={{ letterSpacing: "0.08em" }}>
        {info.vercelEnv === "local" ? "LOCAL" : "PREVIEW"}
        {info.gitCommitSha ? ` · ${info.gitCommitSha}` : ""}
      </span>
      {open && (
        <div style={{ marginTop: 6, opacity: 0.95, fontWeight: 500 }}>
          <div>host: {info.host ?? "?"}</div>
          <div>deployment: {info.deploymentId ?? "?"}</div>
          <div>trace: {traceId || "…"}</div>
        </div>
      )}
    </div>
  );
}
