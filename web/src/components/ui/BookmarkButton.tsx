"use client";

import { useState, useEffect } from "react";
import { Bookmark } from "lucide-react";
import { loadBookmarks, saveBookmarks, type Bookmark as BookmarkData } from "@/lib/useBookmarks";

interface BookmarkButtonProps {
  item: Omit<BookmarkData, "savedAt">;
  className?: string;
}

export function BookmarkButton({ item, className = "" }: BookmarkButtonProps) {
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSaved(loadBookmarks().some(b => b.id === item.id));
    function onSync() { setSaved(loadBookmarks().some(b => b.id === item.id)); }
    window.addEventListener("pf_bookmarks_changed", onSync);
    return () => window.removeEventListener("pf_bookmarks_changed", onSync);
  }, [item.id]);

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    const current = loadBookmarks();
    const next = current.some(b => b.id === item.id)
      ? current.filter(b => b.id !== item.id)
      : [...current, { ...item, savedAt: Date.now() }];
    saveBookmarks(next);
    setSaved(!current.some(b => b.id === item.id));
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title={saved ? "Remove from saved" : "Save"}
      className={`rounded-full p-1.5 transition-all ${className}`}
      style={
        saved
          ? { background: "rgba(192,38,211,0.10)", color: "#C026D3" }
          : { background: "rgba(0,0,0,0.04)", color: "#9CA3AF" }
      }
    >
      <Bookmark className={`w-3.5 h-3.5 ${saved ? "fill-current" : ""}`} />
    </button>
  );
}
