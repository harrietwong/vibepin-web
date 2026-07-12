import { redirect } from "next/navigation";
import { getCurrentAdminRole } from "@/lib/server/superAdmin";
import { AdminSupportTicketDetail } from "./AdminSupportTicketDetail";

export const dynamic = "force-dynamic";

export default async function AdminSupportTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentAdminRole();
  if (!session) redirect("/app?admin=forbidden");
  const { id } = await params;
  return <AdminSupportTicketDetail ticketId={id} />;
}
