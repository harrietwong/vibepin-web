import { getUserIdFromSameOriginSession } from "@/lib/server/authUser";
import {
  PinterestClient,
  type PinterestPinMetadata,
} from "@/lib/server/pinterest/service";

export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 10 * 60 * 1000;
const PIN_TIMEOUT_MS = 3_000;
const MAX_IDS = 10;
const CONCURRENCY = 5;
const metadataCache = new Map<string, {
  at: number;
  item: PinterestPinMetadata | null;
}>();

async function readPin(
  client: PinterestClient,
  pinId: string,
): Promise<PinterestPinMetadata | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.getPinMetadata(pinId).catch(() => null),
      new Promise<null>(resolve => {
        timeout = setTimeout(() => resolve(null), PIN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(CONCURRENCY, items.length) },
    () => worker(),
  ));
  return results;
}

export async function GET(req: Request) {
  try {
    const uid = await getUserIdFromSameOriginSession(req);
    if (!uid) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const params = new URL(req.url).searchParams;
    const rawIds = params.get("ids") ?? "";
    // Which connected account owns these Pins. REQUIRED: Pin metadata is readable
    // only with that account's own token, so a user-scoped client would 404 every
    // Pin belonging to the non-default account and the row would silently lose its
    // thumbnail — a wrong answer dressed as a missing image. The caller always
    // knows the owning account (it is rendering that account's rows), so demanding
    // it here is free and removes the only way to get this silently wrong.
    const connectionId = params.get("connectionId")?.trim() || null;
    if (!connectionId) {
      return Response.json({ error: "connectionId is required" }, { status: 400 });
    }
    const ids = [...new Set(rawIds.split(","))]
      .filter(id => /^\d+$/.test(id))
      .slice(0, MAX_IDS);
    if (ids.length === 0) {
      return Response.json({ error: "At least one valid Pin id is required" }, { status: 400 });
    }

    const now = Date.now();
    const items: PinterestPinMetadata[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const cached = metadataCache.get(`${uid}:${connectionId}:${id}`);
      if (cached && now - cached.at < CACHE_TTL_MS) {
        if (cached.item) items.push(cached.item);
      } else {
        missing.push(id);
      }
    }

    if (missing.length > 0) {
      const client = await PinterestClient.forConnection(uid, connectionId);
      const fetched = await mapWithConcurrency(missing, id => readPin(client, id));
      for (let index = 0; index < missing.length; index += 1) {
        const item = fetched[index];
        metadataCache.set(`${uid}:${connectionId}:${missing[index]}`, { at: now, item });
        if (item) items.push(item);
      }
      if (metadataCache.size > 2_000) metadataCache.clear();
    }

    return Response.json(
      { items: items.map(item => ({ id: item.id, title: item.title, imageUrl: item.imageUrl })) },
      { headers: { "Cache-Control": "private, max-age=0, must-revalidate" } },
    );
  } catch (error) {
    console.error("[insights] Pinterest Pin metadata request failed", error);
    return Response.json({ error: "Pin previews could not be loaded" }, { status: 500 });
  }
}
