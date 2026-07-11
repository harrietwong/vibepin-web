import { redirect } from "next/navigation";

// The admin console moved out of the customer /app shell into a standalone
// internal console at /admin. This route only redirects; the real dashboard,
// its data, and its super-admin gate live at /admin.
export default function OldAdminRedirect() {
  redirect("/admin");
}
