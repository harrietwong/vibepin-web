import { requireSuperAdminFromRequest } from "@/lib/server/superAdmin";

export const dynamic = "force-dynamic";

// Internal support notes for Customer 360. Super-admin gated. The ONLY write
// action in the Customer 360 feature — no delete, no impersonation, no requeue,
// no prompt/ranking changes. Notes contain no secrets.

const TABLE = "admin_support_notes";

export type SupportNote = {
  id: string;
  note: string;
  authorEmail: string | null;
  createdAt: string | null;
};

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /relation .* does not exist|could not find the table/i.test(error.message ?? "");
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireSuperAdminFromRequest(request);
  if (!admin) return Response.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const { createServerClient } = await import("@/lib/supabase");
  const db = createServerClient();

  const { data, error } = await db
    .from(TABLE)
    .select("id,note,author_email,created_at")
    .eq("user_id", id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    if (isMissingTable(error)) {
      return Response.json({ notes: [], persistenceAvailable: false }, { status: 200 });
    }
    return Response.json({ error: "Failed to load notes" }, { status: 500 });
  }

  const notes: SupportNote[] = (data ?? []).map(r => ({
    id: String(r.id),
    note: (r.note as string) ?? "",
    authorEmail: (r.author_email as string) ?? null,
    createdAt: (r.created_at as string) ?? null,
  }));
  return Response.json({ notes, persistenceAvailable: true });
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireSuperAdminFromRequest(request);
  if (!admin) return Response.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  let body: { note?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note) return Response.json({ error: "Note is required" }, { status: 400 });
  if (note.length > 4000) return Response.json({ error: "Note too long (max 4000 chars)" }, { status: 400 });

  const { createServerClient } = await import("@/lib/supabase");
  const db = createServerClient();

  const { data, error } = await db
    .from(TABLE)
    .insert({ user_id: id, note, author_email: admin.email ?? null, author_id: admin.id })
    .select("id,note,author_email,created_at")
    .single();

  if (error) {
    if (isMissingTable(error)) {
      return Response.json(
        { error: "Notes storage not set up — apply migration v33 (admin_support_notes)." },
        { status: 503 },
      );
    }
    return Response.json({ error: "Failed to save note" }, { status: 500 });
  }

  const saved: SupportNote = {
    id: String(data.id),
    note: (data.note as string) ?? note,
    authorEmail: (data.author_email as string) ?? null,
    createdAt: (data.created_at as string) ?? null,
  };
  return Response.json({ note: saved, persistenceAvailable: true });
}
