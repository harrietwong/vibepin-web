import { redirect } from "next/navigation";
import { getCurrentAdminRole } from "@/lib/server/superAdmin";
import { getGenerationLogs } from "@/lib/server/generationLogs";
import GenerationLogsClient from "./GenerationLogsClient";

export const dynamic = "force-dynamic";

// Any authorized admin role may debug generation logs. The full internal prompt
// template stays gated to super_admin (see the reveal API + client), so support
// can triage failures without seeing prompt internals.
export default async function GenerationLogsPage() {
  const session = await getCurrentAdminRole();
  if (!session) redirect("/app?admin=forbidden");

  const overview = await getGenerationLogs();
  return <GenerationLogsClient overview={overview} canSeeFullPrompt={session.role === "super_admin"} />;
}
