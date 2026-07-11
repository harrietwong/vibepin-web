import { redirect } from "next/navigation";
import { getCurrentAdminRole } from "@/lib/server/superAdmin";
import AdminNav from "./AdminNav";
import AdminTopbar from "./AdminTopbar";
import { AdminChromeProvider } from "./AdminChromeProvider";

// Standalone internal admin console shell. This layout is a sibling of the
// customer /app shell — it deliberately does NOT render the customer sidebar,
// Ask VibePin launcher/panel, token badge, workspace navigation, Create Pins,
// or Product Ideas. It only wraps the internal admin control plane.
//
// AdminChromeProvider + AdminTopbar are admin-only (independent localStorage
// keys, independent `--admin-*` CSS vars, independent `data-admin-theme`
// attribute) — they never read/write the client app's theme or locale state.
//
// Gate: any authorized admin role (super_admin or support) may reach the shell.
// Support is empty by default, so this is super-admin-only until a support user
// is provisioned. Sensitive pages (Overview, Data Freshness, Visual Review,
// Customers) keep their OWN getCurrentSuperAdmin gate and redirect support
// users — only Generation Logs opts into support access. See superAdmin.ts.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentAdminRole();
  if (!session) redirect("/app?admin=forbidden");

  return (
    <AdminChromeProvider>
      <div style={{ display: "flex", overflow: "hidden", height: "100dvh", background: "var(--admin-bg, #F8FAFC)" }}>
        <AdminNav />
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <AdminTopbar />
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {children}
          </div>
        </div>
      </div>
    </AdminChromeProvider>
  );
}
