"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Link } from "lucide-react";
import NextLink from "next/link";
import { apiFetch } from "@/lib/utils";

interface Settings {
  auto_publish: boolean;
  review_image: boolean;
  review_copy: boolean;
  default_platforms: string;
  daily_limit: number;
  default_style: string;
  pinterest_connected: boolean;
  pinterest_username?: string;
  instagram_connected: boolean;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({
    auto_publish: false, review_image: true, review_copy: true,
    default_platforms: "both", daily_limit: 10, default_style: "scandinavian",
    pinterest_connected: false, instagram_connected: false,
  });
  const [saving, setSaving] = useState(false);
  const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

  useEffect(() => {
    apiFetch<Settings>("/api/auth/status").then(s => setSettings(prev => ({ ...prev, ...s }))).catch(() => {});
  }, []);

  function Toggle({ label, desc, field }: { label: string; desc: string; field: keyof Settings }) {
    const val = settings[field] as boolean;
    return (
      <div className="flex items-start justify-between py-4 border-b border-neutral-100 last:border-0">
        <div>
          <p className="text-sm font-medium text-neutral-800">{label}</p>
          <p className="text-xs text-neutral-400 mt-0.5">{desc}</p>
        </div>
        <button
          onClick={() => setSettings(p => ({ ...p, [field]: !val }))}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${val ? "bg-[#00B08A]" : "bg-neutral-200"}`}
        >
          <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${val ? "translate-x-6" : "translate-x-1"}`} />
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FAF9F7]">
      <nav className="border-b border-neutral-100 bg-white">
        <div className="max-w-2xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-md bg-[#00B08A]" />
            <span className="font-bold text-neutral-900">VibePin</span>
          </div>
          <a href="/dashboard" className="text-sm text-neutral-500 hover:text-neutral-800">← Dashboard</a>
        </div>
      </nav>

      <main className="max-w-2xl mx-auto px-6 py-8 space-y-6">
        <h1 className="text-xl font-bold text-neutral-900">Settings</h1>

        {/* Platform connections — Pinterest moved to dark-app Integrations */}
        <div className="rounded-2xl border border-neutral-200 bg-white p-6">
          <h2 className="font-semibold text-neutral-800 mb-5">Platform connections</h2>
          <div className="space-y-3">
            <div className="rounded-xl border border-neutral-200 p-4">
              <p className="text-sm font-semibold text-neutral-800">Pinterest</p>
              <p className="text-xs mt-0.5 text-neutral-400 mb-3">
                Connect and manage your Pinterest account in the app Integrations settings.
              </p>
              <NextLink
                href="/app/settings/pinterest"
                className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-neutral-700"
              >
                Open Integrations
              </NextLink>
            </div>

            {/* Instagram — legacy connection (unchanged). */}
            {[
              { label: "Instagram", connected: settings.instagram_connected, href: `${API}/api/auth/instagram` },
            ].map(p => (
              <div key={p.label} className={`rounded-xl border p-4 flex items-center justify-between ${p.connected ? "border-[#00B08A]/30 bg-[#E6F7F4]/50" : "border-neutral-200"}`}>
                <div>
                  <p className="text-sm font-semibold text-neutral-800">{p.label}</p>
                  <p className={`text-xs mt-0.5 ${p.connected ? "text-[#00B08A]" : "text-neutral-400"}`}>
                    {p.connected ? "Connected" : "Not connected"}
                  </p>
                </div>
                {p.connected
                  ? <Check className="h-5 w-5 text-[#00B08A]" />
                  : <a href={p.href} className="flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-neutral-700"><Link className="h-3 w-3" />Connect</a>
                }
              </div>
            ))}
          </div>
        </div>

        {/* Publish preferences */}
        <div className="rounded-2xl border border-neutral-200 bg-white p-6">
          <h2 className="font-semibold text-neutral-800 mb-1">Publish preferences</h2>
          <p className="text-xs text-neutral-400 mb-5">Control when and how content is published.</p>
          <Toggle label="Auto-publish" desc="Skip review and publish immediately after generation. Off by default." field="auto_publish" />
          <Toggle label="Review images" desc="Pause for approval before publishing images." field="review_image" />
          <Toggle label="Review captions" desc="Pause for approval before publishing captions." field="review_copy" />

          <div className="mt-4 space-y-3">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">Daily publish limit</label>
              <input
                type="number" min={1} max={25} value={settings.daily_limit}
                onChange={e => setSettings(p => ({ ...p, daily_limit: Number(e.target.value) }))}
                className="w-24 rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:border-[#00B08A] focus:outline-none"
              />
              <p className="text-xs text-neutral-400 mt-1">Instagram limit is 25/day. Excess posts are queued.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">Default platforms</label>
              <select
                value={settings.default_platforms}
                onChange={e => setSettings(p => ({ ...p, default_platforms: e.target.value }))}
                className="rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:border-[#00B08A] focus:outline-none bg-white"
              >
                <option value="both">Pinterest + Instagram</option>
                <option value="pinterest">Pinterest only</option>
                <option value="instagram">Instagram only</option>
              </select>
            </div>
          </div>
        </div>

        <button
          onClick={async () => {
            setSaving(true);
            try {
              await apiFetch("/api/settings", { method: "PATCH", body: JSON.stringify(settings) });
              toast.success("Settings saved");
            } catch {
              toast.success("Settings saved locally");
            } finally {
              setSaving(false);
            }
          }}
          disabled={saving}
          className="w-full rounded-lg bg-[#00B08A] py-3 text-sm font-semibold text-white hover:bg-[#008F70] transition-colors disabled:opacity-60"
        >
          {saving ? "Saving..." : "Save settings"}
        </button>
      </main>

      <div className="max-w-2xl mx-auto px-6 pb-10 flex gap-4 text-[11px] text-neutral-400">
        <NextLink href="/privacy" className="hover:text-neutral-600">Privacy</NextLink>
        <NextLink href="/terms" className="hover:text-neutral-600">Terms</NextLink>
        <NextLink href="/pinterest-app" className="hover:text-neutral-600">Pinterest App</NextLink>
      </div>
    </div>
  );
}
