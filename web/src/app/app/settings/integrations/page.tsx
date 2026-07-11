import { redirect } from "next/navigation";
import { SETTINGS_PINTEREST_PATH } from "@/lib/settingsPaths";

export default function IntegrationsRedirectPage() {
  redirect(SETTINGS_PINTEREST_PATH);
}
