import { redirect } from "next/navigation";
import { getCurrentAdminRole } from "@/lib/server/superAdmin";
import { AdminSupportTicketList } from "./AdminSupportTicketList";

export const dynamic = "force-dynamic";

// Both admin roles (super_admin and support) can triage tickets — this is
// exactly what the "support" role tier exists for.
export default async function AdminSupportPage() {
  const session = await getCurrentAdminRole();
  if (!session) redirect("/app?admin=forbidden");
  return <AdminSupportTicketList />;
}
