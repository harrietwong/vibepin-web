"use client";

/**
 * StudioBoardSkeleton — a neutral, board-shaped bootstrap/loading shell for Create
 * Pins (studioBoardV2). Rendered:
 *   - while the Studio experience is still "resolving" (env unset → reading the
 *     localStorage override), and
 *   - while StudioBoard itself is hydrating its draft store on the first client
 *     render.
 *
 * It deliberately mirrors StudioBoard's outer layout (same header padding, filter
 * row, and card grid) so there is NO structural layout shift when the real board
 * takes over. It must NEVER render any legacy Studio surface (products, references,
 * creative direction, generation tabs). Static "Create Pins" heading paints
 * immediately; everything data-dependent is a shimmer placeholder.
 */

import { BUI } from "@/components/studio/boardUI";

function Block({ w, h, r = 8, style }: { w: number | string; h: number; r?: number; style?: React.CSSProperties }) {
  return (
    <span
      aria-hidden
      className="studio-skel-shimmer"
      style={{ display: "inline-block", width: w, height: h, borderRadius: r, background: BUI.surface3, ...style }}
    />
  );
}

export function StudioBoardSkeleton({ testId = "studio-board-skeleton" }: { testId?: string }) {
  return (
    <div
      data-testid={testId}
      aria-busy="true"
      style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0, background: BUI.bg }}
    >
      {/* Header — matches StudioBoard's header box exactly (no shift on swap). */}
      <div style={{ padding: "16px 22px 10px", display: "flex", flexDirection: "column", gap: 12, background: BUI.surface, borderBottom: `1px solid ${BUI.border}`, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            {/* Real, instant heading so the page never looks blank. */}
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: BUI.text }}>Create Pins</h1>
            <p style={{ margin: "2px 0 0", fontSize: 12.5, color: BUI.textSec }}>Create, edit, schedule and publish Pinterest Pins.</p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
            <Block w={110} h={20} r={999} />
            <Block w={78} h={26} r={999} />
          </div>
        </div>
        {/* Filter pills row */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {[64, 96, 84, 72, 64].map((w, i) => (
            <Block key={i} w={w} h={30} r={999} />
          ))}
        </div>
      </div>

      {/* Body — card grid placeholders, same grid as the real board. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 22 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14, alignItems: "start" }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} style={{ borderRadius: 14, border: `1px solid ${BUI.border}`, background: BUI.surface, overflow: "hidden" }}>
              <Block w="100%" h={190} r={0} style={{ display: "block" }} />
              <div style={{ padding: "12px 12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                <Block w="70%" h={13} />
                <Block w="90%" h={11} />
                <Block w="45%" h={11} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <style>{`
        @keyframes studio-skel-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
        .studio-skel-shimmer { animation: studio-skel-pulse 1.3s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .studio-skel-shimmer { animation: none; } }
      `}</style>
    </div>
  );
}
