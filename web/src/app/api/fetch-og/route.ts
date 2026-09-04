import { handleGet } from "./handler";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return handleGet(request);
}
