import { PublicDocumentPage } from "@/components/public/PublicDocumentPage";
import { PublicShell } from "@/components/public/PublicShell";

export const metadata = { title: "Pinterest App — VibePin", description: "How VibePin optionally connects with Pinterest." };

export default function PinterestAppPage() { return <PublicShell><PublicDocumentPage route="pinterest" updated="August 8, 2026" /></PublicShell>; }
