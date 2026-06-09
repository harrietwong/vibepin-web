"use client";
import { useState, useEffect, useCallback } from "react";
import {
  getSelectedNiches, saveSelectedNiches,
  getScope, saveScope,
  type NicheId, type Scope,
} from "@/lib/niches";

export interface NicheScopeState {
  selectedNiches: NicheId[];
  scope: Scope;
  /** true when scope === "for_you" AND niches.length > 0 */
  isFiltering: boolean;
  hasNiches: boolean;
  /** false until localStorage has been read (avoids hydration flash) */
  initialized: boolean;
  setScope: (s: Scope) => void;
  saveNiches: (niches: NicheId[]) => void;
}

export function useNicheScope(): NicheScopeState {
  const [selectedNiches, setSelectedNiches] = useState<NicheId[]>([]);
  const [scope, setScopeState] = useState<Scope>("all_trends");
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    const niches = getSelectedNiches();
    const sc = getScope(niches.length > 0);
    setSelectedNiches(niches);
    setScopeState(sc);
    setInitialized(true);
  }, []);

  const setScope = useCallback((s: Scope) => {
    saveScope(s);
    setScopeState(s);
  }, []);

  const saveNiches = useCallback((niches: NicheId[]) => {
    saveSelectedNiches(niches);
    saveScope("for_you");
    setSelectedNiches(niches);
    setScopeState("for_you");
  }, []);

  return {
    selectedNiches,
    scope,
    isFiltering: scope === "for_you" && selectedNiches.length > 0,
    hasNiches: selectedNiches.length > 0,
    initialized,
    setScope,
    saveNiches,
  };
}
