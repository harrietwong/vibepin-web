"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, RefreshCw, Check, AlertCircle, Clock } from "lucide-react";
import { apiFetch } from "@/lib/utils";

type TaskStatus = "pending" | "scraping" | "generating" | "copywriting" | "awaiting_review" | "publishing" | "done" | "failed";

interface Task {
  id: string;
  status: TaskStatus;
  product_url: string;
  style_preset: string;
  metadata?: { title: string; image_url: string };
  pin_url?: string;
  ig_permalink?: string;
  created_at: string;
}

interface AuthStatus {
  pinterest_connected: boolean;
  pinterest_username?: string;
  instagram_connected: boolean;
  instagram_ig_user_id?: string;
}

const STATUS_ICON: Record<TaskStatus, React.ReactNode> = {
  pending:          <Clock className="h-4 w-4 text-neutral-400" />,
  scraping:         <RefreshCw className="h-4 w-4 text-blue-400 animate-spin" />,
  generating:       <RefreshCw className="h-4 w-4 text-purple-400 animate-spin" />,
  copywriting:      <RefreshCw className="h-4 w-4 text-yellow-400 animate-spin" />,
  awaiting_review:  <AlertCircle className="h-4 w-4 text-orange-400" />,
  publishing:       <RefreshCw className="h-4 w-4 text-[#00B08A] animate-spin" />,
  done:             <Check className="h-4 w-4 text-[#00B08A]" />,
  failed:           <AlertCircle className="h-4 w-4 text-red-400" />,
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "Queued", scraping: "Reading product", generating: "Generating scene",
  copywriting: "Writing captions", awaiting_review: "Ready to review",
  publishing: "Publishing", done: "Published", failed: "Failed",
};

function ConnectionCard({ label, connected, username, connectHref }: {
  label: string; connected: boolean; username?: string; connectHref: string;
}) {
  return (
    <div className={`rounded-xl border p-4 flex items-center justify-between ${connected ? "border-[#00B08A]/30 bg-[#E6F7F4]/50" : "border-neutral-200"}`}>
      <div>
        <p className="text-sm font-semibold text-neutral-800">{label}</p>
        <p className={`text-xs mt-0.5 ${connected ? "text-[#00B08A]" : "text-neutral-400"}`}>
          {connected ? (username ? `@${username}` : "Connected") : "Not connected"}
        </p>
      </div>
      {connected
        ? <Check className="h-5 w-5 text-[#00B08A]" />
        : <a href={connectHref} className="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-neutral-700 transition-colors">Connect</a>
      }
    </div>
  );
}

export default function DashboardPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [auth, setAuth] = useState<AuthStatus>({ pinterest_connected: false, instagram_connected: false });
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState("");
  const [style, setStyle] = useState("scandinavian");
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();

  const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

  useEffect(() => {
    Promise.all([
      apiFetch<Task[]>("/api/tasks"),
      apiFetch<AuthStatus>("/api/auth/status"),
    ]).then(([t, a]) => {
      setTasks(t);
      setAuth(a);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  async function handleNewTask(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const task = await apiFetch<Task>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ product_url: url, style_preset: style }),
      });
      router.push(`/preview/${task.id}`);
    } catch (err: any) {
      toast.error(err.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#FAF9F7]">
      <nav className="border-b border-neutral-100 bg-white">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-md bg-[#00B08A]" />
            <span className="font-bold text-neutral-900">VibePin</span>
          </div>
          <div className="flex items-center gap-4">
            <a href="/settings" className="text-sm text-neutral-500 hover:text-neutral-800">Settings</a>
            <a href="/" className="text-sm text-neutral-500 hover:text-neutral-800">Home</a>
          </div>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-3 gap-8">

        {/* ── Left sidebar ────────────────────────────── */}
        <div className="lg:col-span-1 space-y-5">
          {/* New task form */}
          <div className="rounded-2xl border border-neutral-200 bg-white p-5">
            <p className="font-semibold text-neutral-800 mb-4 flex items-center gap-2">
              <Plus className="h-4 w-4" /> New content
            </p>
            <form onSubmit={handleNewTask} className="space-y-3">
              <input
                type="url" value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="Shopify or Etsy product URL"
                required
                className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm focus:border-[#00B08A] focus:outline-none placeholder:text-neutral-400"
              />
              <select
                value={style} onChange={e => setStyle(e.target.value)}
                className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm focus:border-[#00B08A] focus:outline-none bg-white"
              >
                <option value="scandinavian">Scandinavian Minimal</option>
                <option value="boho_vintage">Boho Vintage</option>
                <option value="contemporary_minimal">Contemporary Minimal</option>
              </select>
              <button
                type="submit" disabled={submitting}
                className="w-full rounded-lg bg-[#00B08A] py-2.5 text-sm font-semibold text-white hover:bg-[#008F70] transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
              >
                {submitting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {submitting ? "Starting..." : "Generate content"}
              </button>
            </form>
          </div>

          {/* Platform connections */}
          <div className="rounded-2xl border border-neutral-200 bg-white p-5">
            <p className="font-semibold text-neutral-800 mb-4">Platform connections</p>
            <div className="space-y-3">
              <ConnectionCard
                label="Pinterest"
                connected={auth.pinterest_connected}
                username={auth.pinterest_username}
                connectHref={`${API}/api/auth/pinterest`}
              />
              <ConnectionCard
                label="Instagram"
                connected={auth.instagram_connected}
                username={auth.instagram_ig_user_id}
                connectHref={`${API}/api/auth/instagram`}
              />
            </div>
          </div>
        </div>

        {/* ── Task list ────────────────────────────────── */}
        <div className="lg:col-span-2">
          <div className="flex items-center justify-between mb-5">
            <h1 className="text-lg font-bold text-neutral-900">Your content queue</h1>
            <button
              onClick={() => apiFetch<Task[]>("/api/tasks").then(setTasks)}
              className="flex items-center gap-1.5 text-sm text-neutral-400 hover:text-neutral-600 transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <RefreshCw className="h-6 w-6 text-[#00B08A] animate-spin" />
            </div>
          ) : tasks.length === 0 ? (
            <div className="rounded-2xl border-2 border-dashed border-neutral-200 p-12 text-center">
              <p className="text-neutral-500 mb-2">No content yet</p>
              <p className="text-sm text-neutral-400">Paste a product URL on the left to get started.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {tasks.map(task => (
                <button
                  key={task.id}
                  onClick={() => router.push(`/preview/${task.id}`)}
                  className="w-full rounded-xl border border-neutral-100 bg-white p-4 hover:border-neutral-200 transition-colors text-left flex items-center gap-4"
                >
                  {task.metadata?.image_url ? (
                    <img src={task.metadata.image_url} alt="" className="h-14 w-14 rounded-lg object-cover shrink-0" />
                  ) : (
                    <div className="h-14 w-14 rounded-lg bg-neutral-50 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-neutral-800 text-sm truncate">
                      {task.metadata?.title ?? task.product_url}
                    </p>
                    <p className="text-xs text-neutral-400 mt-0.5 capitalize">{task.style_preset.replace("_", " ")}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {STATUS_ICON[task.status]}
                    <span className={`text-xs font-medium ${
                      task.status === "done" ? "text-[#00B08A]"
                      : task.status === "failed" ? "text-red-400"
                      : task.status === "awaiting_review" ? "text-orange-400"
                      : "text-neutral-400"
                    }`}>
                      {STATUS_LABEL[task.status]}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
