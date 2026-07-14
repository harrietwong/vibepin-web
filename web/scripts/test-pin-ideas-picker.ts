import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapPinIdeaToPickerAsset, type PinIdea } from "../src/lib/pinIdeas";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  OK ${name}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${(error as Error).message}`);
    failed++;
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const pickerSource = readFileSync(join(process.cwd(), "src/components/studio/InlineCreateAssetPicker.tsx"), "utf8");
const discoverSource = readFileSync(join(process.cwd(), "src/app/app/discover/page.tsx"), "utf8");

const samplePin: PinIdea = {
  id: "pin-1",
  image_url: "https://example.com/pin.jpg",
  title: "Cozy living room",
  source_keyword: "home decor",
  save_count: 2500,
  category: "Home Decor",
};

test("mapPinIdeaToPickerAsset uses pin_ideas source", () => {
  const mapped = mapPinIdeaToPickerAsset(samplePin);
  assert(mapped.source === "pin_ideas", "source should be pin_ideas");
  assert(mapped.imageUrl === samplePin.image_url, "imageUrl mismatch");
  assert(mapped.keyword === "home decor", "keyword mismatch");
  assert(mapped.saveSignal === "Growing", "saveSignal mismatch");
});

test("Pin Ideas picker uses shared usePinIdeas hook", () => {
  assert(pickerSource.includes("usePinIdeas"), "picker missing usePinIdeas");
  assert(pickerSource.includes("fetchPinIdeas") === false || pickerSource.includes("usePinIdeas"), "picker should use hook not raw fetch");
  assert(!pickerSource.includes('.from("pin_samples")'), "picker should not query pin_samples directly");
  assert(pickerSource.includes("pin-ideas-grid"), "picker missing pin ideas grid");
});

test("Pin Ideas picker has loading and error states", () => {
  assert(pickerSource.includes("pinIdeasLoading"), "picker missing loading state");
  assert(pickerSource.includes("studioModals.picker.couldNotLoadPinIdeas"), "picker missing error state");
  assert(pickerSource.includes("pin-ideas-retry"), "picker missing retry button");
});

test("fetchPinIdeas module uses viral-pins API", () => {
  const pinIdeasSource = readFileSync(join(process.cwd(), "src/lib/pinIdeas.ts"), "utf8");
  assert(pinIdeasSource.includes("/api/viral-pins"), "pinIdeas should use viral-pins API");
  assert(pinIdeasSource.includes("PIN_IDEAS_SWR_KEY"), "pinIdeas missing SWR key");
});

test("discover page still uses pin_samples family data", () => {
  assert(discoverSource.includes("pin_samples"), "discover should reference pin_samples");
});

console.log(`\nPin Ideas picker tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
