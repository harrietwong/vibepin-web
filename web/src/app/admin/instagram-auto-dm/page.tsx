import { redirect } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { getCurrentSuperAdmin } from "@/lib/server/superAdmin";
import { AdminT } from "../AdminT";
import InstagramAutoDmClient from "./InstagramAutoDmClient";

export const dynamic = "force-dynamic";

// Internal, super-admin only. Phase 1 automates the site owner's OWN Instagram
// account; every API behind this page is scoped to the signed-in admin's user id.
export default async function AdminInstagramAutoDmPage() {
  const admin = await getCurrentSuperAdmin();
  if (!admin) redirect("/app?admin=forbidden");

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: "var(--admin-bg, #F8FAFC)" }}>
      <div className="mx-auto max-w-[1180px] px-6 py-6">
        <div className="mb-5">
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold"
            style={{ background: "rgba(99,102,241,0.12)", color: "#4338CA" }}
          >
            <MessageCircle style={{ width: 12, height: 12 }} />
            <AdminT k="igdm.badge" />
          </span>
          <h1 className="mt-2 text-[22px] font-black text-gray-950">
            <AdminT k="igdm.title" />
          </h1>
          <p className="mt-1 max-w-[820px] text-[13px] text-gray-600">
            <AdminT k="igdm.subtitle" />
          </p>
        </div>
        <InstagramAutoDmClient />
        <p className="mt-6 text-[11.5px] text-gray-500">
          <AdminT k="igdm.footer" />
        </p>
      </div>
    </div>
  );
}
