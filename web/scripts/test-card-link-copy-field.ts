import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0;
function test(name: string, run: () => void) { run(); passed++; console.log(`  OK ${name}`); }

const card = readFileSync("src/components/studio/PinBoardCard.tsx", "utf8");
const field = readFileSync("src/components/studio/LinkCopyField.tsx", "utf8");
const form = readFileSync("src/components/pins/PinFieldsForm.tsx", "utf8");
const panel = readFileSync("src/components/pins/PinAICopyPanel.tsx", "utf8");

console.log("\nCard link field with AI copy action\n");

test("compact card: link field comes first, before Amazon, title, description, board and alt text", () => {
  const at = (needle: string) => { const i = card.indexOf(needle); assert.ok(i >= 0, `missing ${needle}`); return i; };
  const link = at("<LinkCopyField id={`board-card-url-${draft.id}`}");
  assert.ok(link < at("<AmazonCardSection"));
  assert.ok(link < at('data-testid="board-card-title"'));
  assert.ok(link < at('data-testid="board-card-description"'));
  assert.ok(at('data-testid="board-card-board"') < at('data-testid="board-card-alt"'));
});

test("compact card: the AI copy trigger lives only in the link field", () => {
  assert.doesNotMatch(card, /<TitleAICopyButton/);
  assert.match(card, /onGenerate=\{\(\) => aiRef\.current\?\.generate\(\)\}/);
  assert.match(card, /\{aiCopyPanel\(true\)\}/);
  // Instagram caption children have no link field, so they keep the panel's own button.
  assert.match(card, /\) : aiCopyPanel\(\)\}/);
  assert.match(panel, /\{!props\.hideTrigger && <div/);
});

test("link field shows idle / busy / generated / stale states and keeps the url test id", () => {
  assert.match(field, /export type LinkCopyState = "idle" \| "busy" \| "generated" \| "stale";/);
  assert.match(field, /data-testid="board-card-url"/);
  assert.match(field, /data-testid="ai-copy-link-action"/);
  assert.match(field, /tr\("studioBoard\.card\.linkCopy\.generated"\)/);
  assert.match(field, /tr\("studioBoard\.card\.linkCopy\.regenerate"\)/);
  assert.match(card, /copyGeneratedForUrl === fields\.websiteUrl\.trim\(\) \? "generated"/);
});

test("expanded editor also puts the link first", () => {
  assert.ok(form.indexOf('{!hidden("websiteUrl") && (') < form.indexOf('{!hidden("title") && ('));
});

console.log(`\n${passed} card link field checks passed.\n`);
