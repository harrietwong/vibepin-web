/** Stable, non-secret client operation identity for one reference group. */
export function generationRequestIdForGroup(batchRequestId: string, groupIndex: number): string {
  const index = Math.max(0, Math.floor(groupIndex) || 0);
  return `${batchRequestId}_g${index}`;
}
