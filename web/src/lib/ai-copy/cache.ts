const PREFIX = "vbp:ai_copy:";
const DAY_MS = 24 * 60 * 60 * 1000;

type CacheEnvelope<T> = {
  value: T;
  savedAt: number;
};

function key(scope: string, id: string): string {
  return `${PREFIX}${scope}:${id}`;
}

export function readCached<T>(scope: string, id: string, ttlMs = DAY_MS): T | null {
  if (typeof window === "undefined" || !id) return null;
  try {
    const raw = localStorage.getItem(key(scope, id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed?.savedAt || Date.now() - parsed.savedAt > ttlMs) return null;
    return parsed.value;
  } catch {
    return null;
  }
}

export function writeCached<T>(scope: string, id: string, value: T): void {
  if (typeof window === "undefined" || !id) return;
  try {
    localStorage.setItem(key(scope, id), JSON.stringify({ value, savedAt: Date.now() }));
  } catch {
    /* local cache best effort */
  }
}

export async function withTimeout<T>(
  label: string,
  task: Promise<T>,
  timeoutMs: number,
  fallback: T,
  timings: Record<string, number>,
): Promise<T> {
  const start = performance.now();
  try {
    const result = await Promise.race([
      task,
      new Promise<T>(resolve => setTimeout(() => resolve(fallback), timeoutMs)),
    ]);
    timings[label] = Math.round(performance.now() - start);
    return result;
  } catch {
    timings[label] = Math.round(performance.now() - start);
    return fallback;
  }
}
