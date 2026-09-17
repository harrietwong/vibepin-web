import { PublicDocumentPage } from "@/components/public/PublicDocumentPage";
import { PublicShell } from "@/components/public/PublicShell";

export const metadata = { title: "Refund Policy — VibePin", description: "Cancellation and refund information." };

export default function RefundPolicyPage() { return <PublicShell><PublicDocumentPage route="refund" updated="August 8, 2026" /></PublicShell>; }
