import { redirect } from "next/navigation";
import { getCurrentSuperAdmin } from "@/lib/server/superAdmin";
import { getUsersOverview } from "@/lib/server/customer360";
import UsersTableClient from "./UsersTableClient";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const admin = await getCurrentSuperAdmin();
  if (!admin) redirect("/app?admin=forbidden");

  const overview = await getUsersOverview();
  return <UsersTableClient overview={overview} />;
}
