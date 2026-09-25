import { handlePost } from "./handler";

// Up to 4 product pages + meta.json at 10 s each plus inter-page pauses; a real
// 100-product store took ~13 s. Same segment-config export the cron and generate
// routes use — Next.js route config, not a second handler.
export const maxDuration = 60;

export async function POST(request: Request) {
  return handlePost(request);
}
