/**
 * test-scheduled-image-url.ts — a scheduled publish must send Pinterest an
 * absolute image URL, exactly like Publish now does.
 *
 * The defect: some drafts store the relative proxy path
 * `/api/storage-image?path=studio/…` (written when NEXT_PUBLIC_SUPABASE_URL was
 * unset at generation time). Publish now resolved it via toProxyUrl before
 * publishing; the scheduled path passed the raw value through. Pinterest fetches
 * the image itself and cannot resolve a relative path, so server validation
 * rejected it with "imageUrl is not a valid URL" — the same draft could publish
 * by hand and fail on a schedule.
 *
 * Asserted against the REAL validator the publish route uses, so this cannot
 * drift from what actually gates a publish.
 *
 * Run: npx tsx scripts/test-scheduled-image-url.ts
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

export {};

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
}
function section(t: string) { console.log(`\n=== ${t} ===`); }

const RELATIVE = "/api/storage-image?path=studio/1780637848_0_14c017a5.png";
const ABSOLUTE = "https://example.supabase.co/storage/v1/object/public/generated/studio/x.png";

async function main() {
  const { payloadToPublishInput } = await import("../src/app/api/cron/publish-due/publishDueLogic");
  const { validatePublicImageUrl } = await import("../src/lib/server/pinterest/validatePublish");

  const base = { boardId: "b1", title: "t" };

  section("the stored relative path is resolved before publishing");
  {
    const input = payloadToPublishInput("u1", { ...base, imageUrl: RELATIVE });
    check("an input is produced", !!input);
    check("the relative path is NOT sent as-is", input?.imageUrl !== RELATIVE,
      `got ${input?.imageUrl}`);
    check("it becomes an absolute https URL", !!input && /^https:\/\//.test(input.imageUrl),
      `got ${input?.imageUrl}`);
    check("the original filename is preserved",
      !!input?.imageUrl.includes("1780637848_0_14c017a5.png"), `got ${input?.imageUrl}`);
  }

  section("the real publish validator now accepts it");
  {
    // This is the exact check that produced "imageUrl is not a valid URL".
    const before = validatePublicImageUrl(RELATIVE);
    check("the RAW stored value would still be rejected", before.ok === false,
      "if this passes, the bug never existed and the fix is pointless");
    if (!before.ok) console.log(`       raw → "${before.message}"`);

    const input = payloadToPublishInput("u1", { ...base, imageUrl: RELATIVE });
    const after = validatePublicImageUrl(input?.imageUrl);
    check("the RESOLVED value passes validation", after.ok === true,
      after.ok ? "" : `still rejected: ${after.message}`);
  }

  section("already-absolute URLs are untouched");
  {
    const input = payloadToPublishInput("u1", { ...base, imageUrl: ABSOLUTE });
    check("an absolute URL passes through unchanged", input?.imageUrl === ABSOLUTE,
      `got ${input?.imageUrl}`);
    check("and still validates", validatePublicImageUrl(input?.imageUrl).ok === true);
  }

  section("hard requirements still block, they are not papered over");
  {
    check("no image ⇒ null", payloadToPublishInput("u1", { boardId: "b1" }) === null);
    check("no board ⇒ null", payloadToPublishInput("u1", { imageUrl: ABSOLUTE }) === null);
    check("empty image ⇒ null", payloadToPublishInput("u1", { ...base, imageUrl: "   " }) === null);
  }

  section("sourceImageUrl fallback is resolved too");
  {
    const input = payloadToPublishInput("u1", { boardId: "b1", sourceImageUrl: RELATIVE });
    check("the fallback field also becomes absolute", !!input && /^https:\/\//.test(input.imageUrl),
      `got ${input?.imageUrl}`);
  }

  section("a data:/blob: image is still refused by the validator");
  {
    // Resolution must not turn an unpublishable image into a passing one.
    const input = payloadToPublishInput("u1", { ...base, imageUrl: "data:image/png;base64,AAAA" });
    const v = validatePublicImageUrl(input?.imageUrl);
    check("data: URL still rejected", v.ok === false, "resolution must not launder a bad image");
  }

  console.log(`\nScheduled image URL: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("SUITE CRASH:", e); process.exit(1); });
