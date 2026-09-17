import { PublicDocumentPage } from "@/components/public/PublicDocumentPage";
import { PublicShell } from "@/components/public/PublicShell";

export const metadata = { title: "Privacy Policy — VibePin", description: "How VibePin handles personal information." };

export default function PrivacyPage() { return <PublicShell><PublicDocumentPage route="privacy" updated="August 8, 2026" /></PublicShell>; }
