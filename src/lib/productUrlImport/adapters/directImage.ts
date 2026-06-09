import type { AdapterResult } from "../types";

/** Single-candidate result for a direct image URL (jpg/png/webp). */
export function directImageAdapter(imageUrl: string): AdapterResult {
  return {
    status:     "success",
    candidates: [{ imageUrl, score: 1.0, reason: "direct_image_url" }],
  };
}
