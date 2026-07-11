"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Edit2, RefreshCw, Send, Download } from "lucide-react";
import { apiFetch } from "@/lib/utils";

type TaskStatus =
  | "pending" | "scraping" | "generating" | "copywriting"
  | "awaiting_review" | "publishing" | "done" | "failed";

interface Task {
  id: string;
  status: TaskStatus;
  product_url: string;
  style_preset: string;
  metadata?: { title: string; price: number; currency: string; image_url: string; product_url: string };
  assets?: {
    img_2x3_url?: string;
    img_1x1_url?: string;
    copy_pinterest_title?: string;
    copy_pinterest_description?: string;
    copy_instagram_caption?: string;
  };
  error_message?: string;
  pin_url?: string;
  ig_permalink?: string;
}

const STATUS_STEPS: { status: string; label: string }[] = [
  { status: "pending",        label: "Queued" },
  { status: "scraping",       label: "Reading product" },
  { status: "generating",     label: "Creating scene" },
  { status: "copywriting",    label: "Writing captions" },
  { status: "awaiting_review",label: "Ready to review" },
  { status: "publishing",     label: "Publishing" },
  { status: "done",           label: "Published" },
];

function ProgressBar({ status }: { status: TaskStatus }) {
  const idx = STATUS_STEPS.findIndex(s => s.status === status);
  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-2">
        {STATUS_STEPS.filter(s => s.status !== "publishing").map((step, i) => {
          const stepIdx = STATUS_STEPS.findIndex(s2 => s2.status === step.status);
          const done = idx > stepIdx;
          const current = idx === stepIdx;
          return (
            <div key={step.status} className="flex flex-col items-center gap-1">
              <div className={`h-7 w-7 rounded-full border-2 flex items-center justify-center text-xs font-bold transition-colors ${
                done ? "bg-[#00B08A] border-[#00B08A] text-white"
                : current ? "border-[#00B08A] text-[#00B08A]"
                : "border-neutral-200 text-neutral-300"
              }`}>
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </div>
              <span className={`text-xs ${current ? "text-[#00B08A] font-medium" : "text-neutral-400"}`}>
                {step.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EditableField({ label, value, onChange, multiline = false }: {
  label: string; value: string; onChange: (v: string) => void; multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const Tag = multiline ? "textarea" : "input";
  return (
    <div className="rounded-lg border border-neutral-100 p-3">
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-xs font-medium text-neutral-400 uppercase tracking-wide">{label}</p>
        <button onClick={() => setEditing(!editing)} className="text-neutral-400 hover:text-[#00B08A] transition-colors">
          <Edit2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {editing ? (
        <Tag
          value={value}
          onChange={e => onChange(e.target.value)}
          onBlur={() => setEditing(false)}
          autoFocus
          rows={multiline ? 6 : undefined}
          className="w-full text-sm text-neutral-800 border-0 outline-none resize-none bg-neutral-50 rounded p-1.5"
        />
      ) : (
        <p className="text-sm text-neutral-800 whitespace-pre-wrap">{value}</p>
      )}
    </div>
  );
}

export default function PreviewPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const router = useRouter();
  const [task, setTask] = useState<Task | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [editedAssets, setEditedAssets] = useState<Task["assets"]>({});

  // SSE: stream task status
  useEffect(() => {
    let es: EventSource;
    const listen = () => {
      es = new EventSource(
        `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}/api/tasks/${taskId}/stream`
      );
      es.onmessage = e => {
        const data = JSON.parse(e.data);
        if (data.status === "stream_end") { es.close(); return; }
        setTask(prev => ({ ...prev!, ...data }));
        if (data.assets && Object.keys(editedAssets ?? {}).length === 0) {
          setEditedAssets(data.assets);
        }
      };
      es.onerror = () => { es.close(); };
    };

    // Also fetch initial task state
    apiFetch<Task>(`/api/tasks/${taskId}`)
      .then(t => {
        setTask(t);
        if (t.assets) setEditedAssets(t.assets);
        if (!["done", "failed"].includes(t.status)) listen();
      })
      .catch(() => toast.error("Could not load task"));

    return () => es?.close();
  }, [taskId]);

  async function handlePublish() {
    if (!task) return;
    setPublishing(true);
    try {
      // Save any edits first
      if (editedAssets && JSON.stringify(editedAssets) !== JSON.stringify(task.assets)) {
        await apiFetch(`/api/tasks/${taskId}`, {
          method: "PATCH",
          body: JSON.stringify({ assets: editedAssets }),
        });
      }
      await apiFetch(`/api/tasks/${taskId}/publish`, {
        method: "POST",
        body: JSON.stringify({ task_id: taskId, platforms: "both" }),
      });
      toast.success("Published successfully!");
      const updated = await apiFetch<Task>(`/api/tasks/${taskId}`);
      setTask(updated);
    } catch (err: any) {
      toast.error(err.message ?? "Publish failed");
    } finally {
      setPublishing(false);
    }
  }

  if (!task) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <RefreshCw className="h-6 w-6 text-[#00B08A] animate-spin" />
      </div>
    );
  }

  const isReady = task.status === "awaiting_review";
  const isDone = task.status === "done";
  const isFailed = task.status === "failed";
  const assets = editedAssets ?? task.assets ?? {};

  return (
    <div className="min-h-screen bg-[#FAF9F7]">
      {/* Nav */}
      <nav className="sticky top-0 z-10 border-b border-neutral-100 bg-white/90 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <button onClick={() => router.push("/")} className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-md bg-[#00B08A]" />
            <span className="font-bold text-neutral-900 text-sm">VibePin</span>
          </button>
          {task.metadata && (
            <p className="text-sm text-neutral-500 truncate max-w-xs">{task.metadata.title}</p>
          )}
          {isReady && (
            <button
              onClick={handlePublish} disabled={publishing}
              className="flex items-center gap-2 rounded-lg bg-[#00B08A] px-4 py-2 text-sm font-semibold text-white hover:bg-[#008F70] transition-colors disabled:opacity-60"
            >
              {publishing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {publishing ? "Publishing..." : "Publish to both"}
            </button>
          )}
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-6 py-8">
        <ProgressBar status={task.status} />

        {/* Generating state */}
        {!isReady && !isDone && !isFailed && (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <RefreshCw className="h-8 w-8 text-[#00B08A] animate-spin" />
            <p className="text-neutral-600 font-medium">
              {task.status === "scraping" && "Reading your product..."}
              {task.status === "generating" && "Creating lifestyle scene (this takes ~30s)..."}
              {task.status === "copywriting" && "Writing captions..."}
              {task.status === "pending" && "Starting up..."}
            </p>
            <p className="text-sm text-neutral-400">You can stay on this page or come back later.</p>
          </div>
        )}

        {/* Failed state */}
        {isFailed && (
          <div className="rounded-xl border border-red-100 bg-red-50 p-6 text-center">
            <p className="font-semibold text-red-700 mb-2">Generation failed</p>
            <p className="text-sm text-red-500 mb-4">{task.error_message ?? "Unknown error"}</p>
            <p className="text-sm text-neutral-500">
              You can still fill in the details manually and we'll generate the images.
            </p>
          </div>
        )}

        {/* Done state */}
        {isDone && (
          <div className="rounded-xl border border-green-100 bg-green-50 p-6 text-center mb-6">
            <Check className="mx-auto h-8 w-8 text-green-500 mb-2" />
            <p className="font-semibold text-green-700 mb-2">Published successfully!</p>
            <div className="flex gap-4 justify-center mt-3">
              {task.pin_url && (
                <a href={task.pin_url} target="_blank" className="text-sm text-[#00B08A] underline">View Pinterest Pin</a>
              )}
              {task.ig_permalink && (
                <a href={task.ig_permalink} target="_blank" className="text-sm text-[#00B08A] underline">View Instagram Post</a>
              )}
            </div>
          </div>
        )}

        {/* Preview content */}
        {(isReady || isDone) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Pinterest */}
            <div className="rounded-2xl border border-neutral-100 bg-white p-6">
              <div className="flex items-center gap-2 mb-4">
                <div className="h-5 w-5 rounded bg-red-500/80 flex items-center justify-center">
                  <span className="text-white text-xs font-bold">P</span>
                </div>
                <p className="font-semibold text-neutral-800">Pinterest Pin</p>
                <span className="ml-auto text-xs text-neutral-400">2:3 · 1000×1500px</span>
              </div>
              {assets.img_2x3_url ? (
                <img src={assets.img_2x3_url} alt="Pinterest" className="w-full rounded-xl mb-4 aspect-[2/3] object-cover" />
              ) : (
                <div className="w-full aspect-[2/3] rounded-xl bg-neutral-50 mb-4 flex items-center justify-center">
                  <RefreshCw className="h-5 w-5 text-neutral-300 animate-spin" />
                </div>
              )}
              <div className="space-y-3">
                <EditableField
                  label="Title"
                  value={assets.copy_pinterest_title ?? ""}
                  onChange={v => setEditedAssets(p => ({ ...p, copy_pinterest_title: v }))}
                />
                <EditableField
                  label="Description"
                  value={assets.copy_pinterest_description ?? ""}
                  onChange={v => setEditedAssets(p => ({ ...p, copy_pinterest_description: v }))}
                  multiline
                />
              </div>
            </div>

            {/* Instagram */}
            <div className="rounded-2xl border border-neutral-100 bg-white p-6">
              <div className="flex items-center gap-2 mb-4">
                <div className="h-5 w-5 rounded bg-gradient-to-br from-purple-500 to-pink-500" />
                <p className="font-semibold text-neutral-800">Instagram Feed</p>
                <span className="ml-auto text-xs text-neutral-400">1:1 · 1080×1080px</span>
              </div>
              {assets.img_1x1_url ? (
                <img src={assets.img_1x1_url} alt="Instagram" className="w-full rounded-xl mb-4 aspect-square object-cover" />
              ) : (
                <div className="w-full aspect-square rounded-xl bg-neutral-50 mb-4 flex items-center justify-center">
                  <RefreshCw className="h-5 w-5 text-neutral-300 animate-spin" />
                </div>
              )}
              <EditableField
                label="Caption + Hashtags"
                value={assets.copy_instagram_caption ?? ""}
                onChange={v => setEditedAssets(p => ({ ...p, copy_instagram_caption: v }))}
                multiline
              />
              {/* Download fallback */}
              <button className="mt-3 flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-600 transition-colors">
                <Download className="h-3.5 w-3.5" />
                Download image + copy caption manually
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
