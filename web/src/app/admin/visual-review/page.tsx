import { redirect } from "next/navigation";
import { getCurrentSuperAdmin } from "@/lib/server/superAdmin";
import VisualReviewClient from "./VisualReviewClient";

export const dynamic = "force-dynamic";

export default async function VisualReviewPage() {
  const admin = await getCurrentSuperAdmin();
  if (!admin) redirect("/app?admin=forbidden");

  return <VisualReviewClient />;
}
