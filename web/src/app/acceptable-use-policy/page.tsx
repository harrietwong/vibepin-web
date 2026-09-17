import { PublicDocumentPage } from "@/components/public/PublicDocumentPage";
import { PublicShell } from "@/components/public/PublicShell";

export const metadata = { title: "Acceptable Use Policy — VibePin", description: "Rules for responsible use of VibePin." };

export default function AcceptableUsePolicyPage() { return <PublicShell><PublicDocumentPage route="acceptableUse" updated="August 8, 2026" /></PublicShell>; }
