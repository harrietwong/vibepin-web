import { readFileSync } from "node:fs";
import { join } from "node:path";

const card = readFileSync(join(process.cwd(), "src/components/studio/PinBoardCard.tsx"), "utf8");
const media = readFileSync(join(process.cwd(), "src/components/studio/PinCardMedia.tsx"), "utf8");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Studio UI contract failed: ${message}`);
}

assert(card.includes('const compactFields = lifecycle !== "generating";'),
  "metadata fields should be shown for every non-generating lifecycle");
assert(card.includes('const cardFieldsEditable = lifecycle !== "posted";'),
  "posted metadata should be read-only");
assert(card.includes('data-testid="board-card-board"'),
  "board field should be present in the default card view");
assert(card.includes('disabled={!cardFieldsEditable || publishing || generating}'),
  "posted metadata controls should be disabled");
assert(card.includes("mediaAspectRatio(draft)"),
  "card media frame should use the cover media aspect ratio");
assert(media.includes('objectFit: "contain"'),
  "card media should preserve the source aspect ratio");

console.log("Studio UI contract: PASS");
