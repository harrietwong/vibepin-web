import { redirect } from "next/navigation";

// Virals content moved into /app/discover (Rising Virals tab)
export default function ViralRedirect() {
  redirect("/app/discover");
}
