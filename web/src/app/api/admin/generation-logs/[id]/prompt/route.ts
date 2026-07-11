import { requireAdminRoleFromRequest } from "@/lib/server/superAdmin";
import { getGenerationPromptReveal } from "@/lib/server/generationLogs";

export const dynamic = "force-dynamic";

// Reveal a generation's SENSITIVE full internal prompt template.
//   * Super Admin only — the "support" role is explicitly denied (403).
//   * Records an audit event (admin_audit_events) that a sensitive detail was
//     viewed. Audit is best-effort: if the audit table is missing the reveal
//     still proceeds (so debugging is never blocked) but flags audited:false.
//   * Read-only otherwise. Never returns tokens/secrets.

async function recordAudit(
  db: ReturnType<typeof import("@/lib/supabase").createServerClient>,
  actor: { id: string; email: string | null; role: string },
  targetId: string,
): Promise<boolean> {
  try {
    const { error } = await db.from("admin_audit_events").insert({
      actor_id: actor.id,
      actor_email: actor.email,
      actor_role: actor.role,
      action: "generation_log.reveal_prompt",
      target_type: "pin_generation",
      target_id: targetId,
      metadata: { at: new Date().toISOString() },
    });
    return !error;
  } catch {
    return false;
  }
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireAdminRoleFromRequest(request);
  if (!session) return Response.json({ error: "Forbidden" }, { status: 403 });
  if (session.role !== "super_admin") {
    return Response.json(
      { error: "Support role cannot view the full internal prompt template." },
      { status: 403 },
    );
  }

  const { id } = await ctx.params;
  const reveal = await getGenerationPromptReveal(id);
  if (!reveal.found) return Response.json({ error: "Generation not found" }, { status: 404 });

  const { createServerClient } = await import("@/lib/supabase");
  const db = createServerClient();
  const audited = await recordAudit(
    db,
    { id: session.user.id, email: session.user.email ?? null, role: session.role },
    id,
  );

  return Response.json({
    promptFull: reveal.promptFull,
    promptSnapshot: reveal.promptSnapshot,
    finalPrompt: reveal.finalPrompt,
    audited,
  });
}
