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
  // type-specific
  keyword?: string;
  pin_id?: string;
  domain?: string;
  marketTag?: string;
}

const STORAGE_KEY = "pf_bookmarks_v1";

export function loadBookmarks(): Bookmark[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as Bookmark[];
  } catch {
    return [];
  }
}

export function saveBookmarks(items: Bookmark[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  window.dispatchEvent(new Event("pf_bookmarks_changed"));
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
