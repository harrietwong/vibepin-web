import en from "../src/lib/i18n/messages/en";
import pl from "../src/lib/i18n/messages/pl";

type Entry = [string, string];

const missing: Entry[] = [];
for (const [key, value] of Object.entries(en) as Entry[]) {
  if (!(key in pl)) {
    missing.push([key, value]);
  }
}

// Group by namespace (portion before first dot)
const byNs = new Map<string, Entry[]>();
for (const [key, value] of missing) {
  const ns = key.split(".")[0];
  if (!byNs.has(ns)) byNs.set(ns, []);
  byNs.get(ns)!.push([key, value]);
}

const nsNames = [...byNs.keys()].sort();
for (const ns of nsNames) {
  console.log(`\n// ── ${ns} (${byNs.get(ns)!.length}) ──`);
  for (const [key, value] of byNs.get(ns)!) {
    console.log(`${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  }
}

console.log(`\nTOTAL MISSING: ${missing.length}`);
console.log(`EN TOTAL: ${Object.keys(en).length}`);
console.log(`PL TOTAL (existing): ${Object.keys(pl).length}`);
