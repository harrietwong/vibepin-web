import type { SupabaseClient } from "@supabase/supabase-js";
import { PinterestClient } from "@/lib/server/pinterest/service";
import {
  dispatchV76PinterestVideo,
  type DurableVideoPublishInput,
  type DurableVideoPublishResult,
} from "./v76PinterestVideoPublish";
import { createSupabaseV76VideoPublishDependencies } from "./v76PinterestVideoRuntime";

/** Production binding shared by the immediate route and the due worker. */
export async function dispatchSupabaseV76PinterestVideo(
  db: SupabaseClient,
  input: DurableVideoPublishInput,
): Promise<DurableVideoPublishResult> {
  const connectionId = input.destination.socialConnectionId?.trim() ?? "";
  const boardId = input.destination.boardId?.trim() ?? "";
  if (!connectionId || !boardId) throw new Error("video_destination_invalid");
  return dispatchV76PinterestVideo(input, createSupabaseV76VideoPublishDependencies({
    db,
    publishVideo: async (current, source) => {
      // Provider client construction/refresh is inside this callback, hence
      // unreachable until v76 grants a ready claim and starts a durable attempt.
      const client = await PinterestClient.forConnection(current.uid, connectionId);
      const media = current.receipt.media.find(item => item.id === source.mediaId);
      return client.createVideoPin({
        boardId,
        title: current.receipt.title,
        description: current.receipt.description,
        link: current.receipt.destinationUrl,
        altText: current.receipt.altText,
        file: source.file,
        fileName: source.fileName,
        ...(media?.kind === "video" ? { coverFrameTimeMs: media.coverFrameTimeMs, durationMs: media.durationMs } : {}),
      });
    },
  }));
}
