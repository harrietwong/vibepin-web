"use client";

import { useState, useEffect, useCallback } from "react";

export type BookmarkType = "keyword" | "pin" | "product";

export interface Bookmark {
  id: string;
  type: BookmarkType;
  title: string;
  category?: string;
  image_url?: string | null;
  savedAt: number;
  /** ISO — account-sync LWW key. Backfilled from savedAt on save when missing. */
  updatedAt?: string;
  // type-specific
  keyword?: string;
  pin_id?: string;
  domain?: string;
  marketTag?: string;
}

const STORAGE_KEY = "pf_bookmarks_v1";
export const BOOKMARKS_EVENT = "pf_bookmarks_changed";

/** Stable ISO updatedAt for a bookmark: its own if present, else derived from savedAt. */
function bookmarkUpdatedAt(b: Bookmark): string {
  if (typeof b.updatedAt === "string" && b.updatedAt) return b.updatedAt;
  return new Date(typeof b.savedAt === "number" ? b.savedAt : 0).toISOString();
}

export function loadBookmarks(): Bookmark[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as Bookmark[];
  } catch {
    return [];
  }
}

export function saveBookmarks(items: Bookmark[]): void {
  // Backfill a stable updatedAt on any item missing one (new bookmark = its savedAt),
  // so the account-sync layer has a deterministic LWW key for every row.
  const stamped = items.map((b) => (b.updatedAt ? b : { ...b, updatedAt: bookmarkUpdatedAt(b) }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stamped));
  window.dispatchEvent(new Event(BOOKMARKS_EVENT));
}

export function useBookmarks() {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);

  useEffect(() => {
    setBookmarks(loadBookmarks());
    function onSync() { setBookmarks(loadBookmarks()); }
    window.addEventListener("pf_bookmarks_changed", onSync);
    return () => window.removeEventListener("pf_bookmarks_changed", onSync);
  }, []);

  const isBookmarked = useCallback(
    (id: string) => bookmarks.some(b => b.id === id),
    [bookmarks],
  );

  const toggle = useCallback((item: Omit<Bookmark, "savedAt">) => {
    const current = loadBookmarks();
    const next = current.some(b => b.id === item.id)
      ? current.filter(b => b.id !== item.id)
      : [...current, { ...item, savedAt: Date.now() }];
    saveBookmarks(next);
    setBookmarks(next);
  }, []);

  const remove = useCallback((id: string) => {
    const next = loadBookmarks().filter(b => b.id !== id);
    saveBookmarks(next);
    setBookmarks(next);
  }, []);

  return { bookmarks, isBookmarked, toggle, remove, count: bookmarks.length };
}

// ── Account-level sync (WP-B) ────────────────────────────────────────────────
// Collection under storeKey `bookmarks` (doc_id = bookmark id). Bookmarks only had
// `savedAt`; updatedAt is backfilled (new = savedAt) so the engine has a stable LWW
// key. User deletes disappear from getAll → the engine tombstones them (no extra
// delete plumbing here). A merge does a single saveBookmarks (one persist + one emit).

function bookmarkTsMs(v: string | null | undefined): number {
  const ms = v ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

export const bookmarksSyncAdapter: import("./userStoreSync").StoreSyncAdapter<Bookmark> = {
  storeKey: "bookmarks",
  eventName: BOOKMARKS_EVENT,
  getAll() {
    return loadBookmarks()
      .filter((b) => b && typeof b.id === "string" && b.id)
      .map((b) => ({ id: b.id, updatedAt: bookmarkUpdatedAt(b), doc: b }));
  },
  mergeServer(live, deleted) {
    if (typeof window === "undefined") return;
    const byId = new Map<string, Bookmark>();
    for (const b of loadBookmarks()) {
      if (b && typeof b.id === "string" && b.id) byId.set(b.id, b);
    }
    let changed = false;
    for (const inc of live) {
      if (!inc || typeof inc.id !== "string" || !inc.id) continue;
      const local = byId.get(inc.id);
      if (local && bookmarkTsMs(bookmarkUpdatedAt(inc)) <= bookmarkTsMs(bookmarkUpdatedAt(local))) continue;
      byId.set(inc.id, inc);
      changed = true;
    }
    for (const t of deleted) {
      if (!t || typeof t.id !== "string") continue;
      const local = byId.get(t.id);
      if (!local) continue;
      if (bookmarkTsMs(bookmarkUpdatedAt(local)) >= bookmarkTsMs(t.deletedAt)) continue;
      byId.delete(t.id);
      changed = true;
    }
    if (changed) saveBookmarks([...byId.values()]); // single persist + single emit
  },
};
