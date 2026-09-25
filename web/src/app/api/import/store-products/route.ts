import { handlePost } from "./handler";

export async function POST(request: Request) {
  return handlePost(request);
}
