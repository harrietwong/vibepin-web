import useSWR from "swr";
import { fetchPinIdeasWithMeta, PIN_IDEAS_SWR_KEY, type PinIdeasFetchResult } from "@/lib/pinIdeas";

export function usePinIdeas() {
  return useSWR<PinIdeasFetchResult>(PIN_IDEAS_SWR_KEY, fetchPinIdeasWithMeta, {
    revalidateOnFocus: false,
    revalidateOnReconnect: true,
    errorRetryCount: 2,
    dedupingInterval: 30_000,
    shouldRetryOnError: true,
  });
}
