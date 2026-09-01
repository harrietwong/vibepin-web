import type { AiVersionDrawerSetup } from "@/components/studio/AiVersionDrawer";
import {
  generationToastId,
  isBlockingGenerationState,
  type GenerationAttemptState,
  type GenerationAttemptSummary,
} from "@/lib/studio/generationAttemptState";

export type GenerationOwnerScope = {
  ownerUserId: string;
  workspaceId: string;
};

export type StoredGenerationSetup = {
  setupKey: string;
  setupRevision: string;
  savedAt: string;
  setup: AiVersionDrawerSetup;
};

export type StoredGenerationAttempt = {
  attemptId: string;
  toastId: string;
  setupKey: string;
  setupRevision: string;
  state: GenerationAttemptState;
  expectedCount: number;
  okCount: number;
  failCount: number;
  updatedAt: string;
};

type StoredGenerationState = {
  version: 1;
  ownerUserId: string;
  workspaceId: string;
  setups: Record<string, StoredGenerationSetup>;
  activeAttempt?: StoredGenerationAttempt;
};

const PREFIX = "vp:generation_setup:v1";

function exactScope(scope: GenerationOwnerScope | null | undefined): GenerationOwnerScope | null {
  const ownerUserId = scope?.ownerUserId?.trim();
  const workspaceId = scope?.workspaceId?.trim();
  return ownerUserId && workspaceId ? { ownerUserId, workspaceId } : null;
}
function storageKey(scope: GenerationOwnerScope): string {
  return `${PREFIX}:${encodeURIComponent(scope.ownerUserId)}:${encodeURIComponent(scope.workspaceId)}`;
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function emptyState(scope: GenerationOwnerScope): StoredGenerationState {
  return {
    version: 1,
    ownerUserId: scope.ownerUserId,
    workspaceId: scope.workspaceId,
    setups: {},
  };
}

function read(scopeInput: GenerationOwnerScope | null | undefined): StoredGenerationState | null {
  const scope = exactScope(scopeInput);
  const storage = getStorage();
  if (!scope || !storage) return null;
  try {
    const raw = storage.getItem(storageKey(scope));
    if (!raw) return emptyState(scope);
    const parsed = JSON.parse(raw) as Partial<StoredGenerationState>;
    if (parsed.version !== 1 || parsed.ownerUserId !== scope.ownerUserId || parsed.workspaceId !== scope.workspaceId) {
      return emptyState(scope);
    }
    return {
      version: 1,
      ownerUserId: scope.ownerUserId,
      workspaceId: scope.workspaceId,
      setups: parsed.setups && typeof parsed.setups === "object" ? parsed.setups : {},
      ...(parsed.activeAttempt ? { activeAttempt: parsed.activeAttempt } : {}),
    };
  } catch {
    return emptyState(scope);
  }
}

function write(scopeInput: GenerationOwnerScope | null | undefined, state: StoredGenerationState): boolean {
  const scope = exactScope(scopeInput);
  const storage = getStorage();
  if (!scope || !storage || state.ownerUserId !== scope.ownerUserId || state.workspaceId !== scope.workspaceId) return false;
  try {
    storage.setItem(storageKey(scope), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

/** Non-secret revision only; raw URLs/prompts never enter lookup keys or diagnostics. */
export function generationSetupRevision(setup: AiVersionDrawerSetup): string {
  const input = JSON.stringify(canonicalize(setup));
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `gs_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function saveGenerationSetup(
  scope: GenerationOwnerScope | null | undefined,
  setupKey: string,
  setup: AiVersionDrawerSetup,
): StoredGenerationSetup | null {
  const normalizedScope = exactScope(scope);
  const key = setupKey.trim();
  const state = read(normalizedScope);
  if (!normalizedScope || !state || !key) return null;
  const stored: StoredGenerationSetup = {
    setupKey: key,
    setupRevision: generationSetupRevision(setup),
    savedAt: new Date().toISOString(),
    setup,
  };
  state.setups[key] = stored;
  return write(normalizedScope, state) ? stored : null;
}

export function loadGenerationSetup(
  scope: GenerationOwnerScope | null | undefined,
  setupKey: string,
): StoredGenerationSetup | null {
  const state = read(scope);
  return state?.setups[setupKey] ?? null;
}

export function clearGenerationSetup(
  scope: GenerationOwnerScope | null | undefined,
  setupKey: string,
): boolean {
  const normalizedScope = exactScope(scope);
  const state = read(normalizedScope);
  if (!normalizedScope || !state) return false;
  delete state.setups[setupKey];
  return write(normalizedScope, state);
}

/** One localStorage write persists the visible setup and stable attempt before placeholders exist. */
export function prepareGenerationAttempt(input: {
  scope: GenerationOwnerScope | null | undefined;
  setupKey: string;
  setup: AiVersionDrawerSetup;
  attemptId: string;
  expectedCount: number;
}): StoredGenerationAttempt | null {
  const normalizedScope = exactScope(input.scope);
  const state = read(normalizedScope);
  const setupKey = input.setupKey.trim();
  const attemptId = input.attemptId.trim();
  if (!normalizedScope || !state || !setupKey || !attemptId) return null;

  const setupRevision = generationSetupRevision(input.setup);
  const now = new Date().toISOString();
  state.setups[setupKey] = { setupKey, setupRevision, savedAt: now, setup: input.setup };
  state.activeAttempt = {
    attemptId,
    toastId: generationToastId(attemptId),
    setupKey,
    setupRevision,
    state: "persisting",
    expectedCount: Math.max(1, Math.floor(input.expectedCount) || 1),
    okCount: 0,
    failCount: 0,
    updatedAt: now,
  };
  return write(normalizedScope, state) ? state.activeAttempt : null;
}

export function getActiveGenerationAttempt(
  scope: GenerationOwnerScope | null | undefined,
): StoredGenerationAttempt | null {
  return read(scope)?.activeAttempt ?? null;
}

export function getBlockingGenerationAttempt(
  scope: GenerationOwnerScope | null | undefined,
): StoredGenerationAttempt | null {
  const attempt = getActiveGenerationAttempt(scope);
  return attempt && isBlockingGenerationState(attempt.state) ? attempt : null;
}

export function updateGenerationAttempt(
  scope: GenerationOwnerScope | null | undefined,
  summary: GenerationAttemptSummary,
): StoredGenerationAttempt | null {
  const normalizedScope = exactScope(scope);
  const state = read(normalizedScope);
  const attempt = state?.activeAttempt;
  if (!normalizedScope || !state || !attempt || attempt.attemptId !== summary.attemptId) return null;
  state.activeAttempt = {
    ...attempt,
    state: summary.state,
    okCount: Math.max(0, summary.okCount),
    failCount: Math.max(0, summary.failCount),
    expectedCount: summary.expectedCount ?? attempt.expectedCount,
    updatedAt: new Date().toISOString(),
  };
  return write(normalizedScope, state) ? state.activeAttempt : null;
}
