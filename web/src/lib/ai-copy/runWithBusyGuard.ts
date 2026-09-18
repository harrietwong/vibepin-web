export type BusyRef = { current: boolean };

/** Runs one async AI-copy operation at a time and reports its request lifetime. */
export async function runWithBusyGuard<T>(
  busyRef: BusyRef,
  onBusyChange: ((busy: boolean) => void) | undefined,
  beforeRun: (() => void) | undefined,
  operation: () => Promise<T>,
): Promise<T | undefined> {
  if (busyRef.current) return undefined;
  busyRef.current = true;
  try {
    onBusyChange?.(true);
    beforeRun?.();
    return await operation();
  } finally {
    busyRef.current = false;
    onBusyChange?.(false);
  }
}
