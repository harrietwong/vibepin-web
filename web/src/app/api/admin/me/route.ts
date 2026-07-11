import { requireSuperAdminFromRequest } from "@/lib/server/superAdmin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const admin = await requireSuperAdminFromRequest(request);
  if (!admin) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  return Response.json({ isSuperAdmin: true });
}
