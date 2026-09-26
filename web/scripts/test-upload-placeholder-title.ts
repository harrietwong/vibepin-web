import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { copyInputTitle, isUploadPlaceholderTitle } from "../src/lib/studio/uploadPlaceholderTitle";

let passed = 0;
function test(name: string, run: () => void) { run(); passed++; console.log(`  OK ${name}`); }

console.log("\nUpload placeholder title\n");

const uploaded = (altText: string) => ({ media: [{ source: "upload", altText }] });
const longName = "AQPeHY3umOnmFwL6zs_rqhFg06WWFlMltum99xTOTWXgBsITn9moYhEhOdj57sGgU5tYcEM0cVh7h9WkpIBoSfTviacEnm4seYfwqPtZh3knFQ";

test("a title still equal to the upload file name is a placeholder", () => {
  assert.equal(isUploadPlaceholderTitle(uploaded("IMG_1234"), "IMG_1234"), true);
  assert.equal(copyInputTitle(uploaded("IMG_1234"), "IMG_1234"), "");
});

test("long file names match the 100-char capped title", () => {
  assert.equal(isUploadPlaceholderTitle(uploaded(longName), longName.slice(0, 100)), true);
});

test("a user-edited title is never a placeholder", () => {
  assert.equal(isUploadPlaceholderTitle(uploaded("IMG_1234"), "Cozy fall throw blanket"), false);
  assert.equal(copyInputTitle(uploaded("IMG_1234"), "IMG_1234 edited"), "IMG_1234 edited");
});

test("non-upload drafts and empty titles are left alone", () => {
  assert.equal(isUploadPlaceholderTitle({ media: [{ source: "generated", altText: "Kitchen" }] }, "Kitchen"), false);
  assert.equal(isUploadPlaceholderTitle({ media: [] }, "Kitchen"), false);
  assert.equal(isUploadPlaceholderTitle({}, "Kitchen"), false);
  assert.equal(isUploadPlaceholderTitle(uploaded("IMG_1234"), ""), false);
});

test("single-card AI Copy (Studio card + Plan drawer) treats the placeholder as empty for input and overwrite", () => {
  const card = readFileSync("src/components/studio/PinBoardCard.tsx", "utf8");
  assert.match(card, /title=\{copyInputTitle\(draft, fields\.title\)\}/);
  assert.match(card, /const prevTitle = copyInputTitle\(draft, fields\.title\);/);
  assert.match(card, /const nextTitle = r\.confirmedReplace \|\| !prevTitle\.trim\(\) \? r\.title : prevTitle;/);
  const drawer = readFileSync("src/components/plan/DraftDetailsDrawer.tsx", "utf8");
  assert.match(drawer, /title=\{copyInputTitle\(draft, title\)\}/);
  assert.match(drawer, /r\.confirmedReplace \|\| !copyInputTitle\(draft, prev\)\.trim\(\) \? r\.title : prev/);
});

console.log(`\n${passed} upload placeholder title checks passed.\n`);
