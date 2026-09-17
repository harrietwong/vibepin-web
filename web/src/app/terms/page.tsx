import { PublicDocumentPage } from "@/components/public/PublicDocumentPage";
import { PublicShell } from "@/components/public/PublicShell";

export const metadata = { title: "Terms of Service — VibePin", description: "Terms and conditions for using VibePin." };

export default function TermsPage() { return <PublicShell><PublicDocumentPage route="terms" updated="August 8, 2026" /></PublicShell>; }
