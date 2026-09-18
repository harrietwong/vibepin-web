export type BusyRef = { current: boolean };

const busyKeys = new Set<string>();
const busyKeyListeners = new Map<string, Set<() => void>>();

function notifyBusyKey(key: string): void {
  for (const listener of busyKeyListeners.get(key) ?? []) listener();
}

export function isBusyKey(key: string): boolean {
  return busyKeys.has(key);
}

export function subscribeBusyKey(key: string, listener: () => void): () => void {
  const listeners = busyKeyListeners.get(key) ?? new Set<() => void>();
  listeners.add(listener);
  busyKeyListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) busyKeyListeners.delete(key);
  };
}

/** Runs one async AI-copy operation at a time and reports its request lifetime. */
export async function runWithBusyGuard<T>(
  busyRef: BusyRef,
  onBusyChange: ((busy: boolean) => void) | undefined,
  beforeRun: (() => void) | undefined,
  operation: () => Promise<T>,
  busyKey?: string,
): Promise<T | undefined> {
  if (busyRef.current || (busyKey !== undefined && busyKeys.has(busyKey))) return undefined;
  busyRef.current = true;
  if (busyKey !== undefined) {
    busyKeys.add(busyKey);
    notifyBusyKey(busyKey);
  }
  try {
    onBusyChange?.(true);
    beforeRun?.();
    return await operation();
  } finally {
    busyRef.current = false;
    if (busyKey !== undefined) {
      busyKeys.delete(busyKey);
      notifyBusyKey(busyKey);
    }
    onBusyChange?.(false);
  }
}
