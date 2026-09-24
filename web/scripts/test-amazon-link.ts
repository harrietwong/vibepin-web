/**
 * Amazon link parsing / normalisation / tag priority / short-link expansion.
 * Design: docs/coordination/0924-AmazonURL文案-技术设计-v0.1.md §1 + Fable rulings.
 *
 * Run: npx tsx scripts/test-amazon-link.ts
 */
import {
  classifyAmazonHost,
  parseAmazonLink,
  resolveAffiliateDestination,
  suggestAmazonLinkNormalization,
  type AmazonRetailParse,
} from "../src/lib/affiliate/amazonLink";
import { extractAsin, isAmazonUrl } from "../src/lib/affiliate/amazon";
import { expandAmazonShortLink, type ShortLinkFetch } from "../src/lib/productUrlImport/amazonShortLink";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  OK ${name}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${(error as Error).message}`);
    failed++;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function retail(raw: string): AmazonRetailParse {
  const p = parseAmazonLink(raw);
  assert(p.ok && p.kind === "retail", `${raw} → ${JSON.stringify(p)}`);
  return p;
}

const ASIN = "B08N5WRWNW";

async function run() {
  console.log("\n-- host classification: 13+ sites --");
  const sites: Array<[string, string | null]> = [
    ["amazon.com", "US"], ["amazon.co.uk", "UK"], ["amazon.ca", "CA"], ["amazon.de", "DE"],
    ["amazon.fr", "FR"], ["amazon.it", "IT"], ["amazon.es", "ES"], ["amazon.com.au", "AU"],
    ["amazon.co.jp", "JP"], ["amazon.nl", null], ["amazon.se", null], ["amazon.in", null],
    ["amazon.com.mx", null], ["amazon.com.br", null], ["amazon.sg", null],
  ];
  for (const [host, market] of sites) {
    await test(`www.${host} → retail ${market ?? "null"}, rebuilt on its own host`, () => {
      const p = retail(`https://www.${host}/Some-Product-Name/dp/${ASIN}/ref=sr_1_1?qid=1&sr=8-1`);
      assert(p.host === host && p.marketplace === market, `got ${p.host}/${p.marketplace}`);
      assert(p.normalizedUrl === `https://www.${host}/dp/${ASIN}`, `got ${p.normalizedUrl}`);
    });
  }

  await test("bare, smile., m. subdomains accepted and normalised to www.", () => {
    for (const h of ["amazon.com", "smile.amazon.com", "m.amazon.com", "WWW.AMAZON.COM", "www.amazon.com."]) {
      const p = retail(`https://${h}/dp/${ASIN}`);
      assert(p.normalizedUrl === `https://www.amazon.com/dp/${ASIN}`, `${h} → ${p.normalizedUrl}`);
    }
  });

  console.log("\n-- short links --");
  for (const host of ["amzn.to", "a.co", "amzn.eu", "amzn.asia"]) {
    await test(`${host} → short (needs expansion)`, () => {
      const p = parseAmazonLink(`http://${host}/d/Ab12Cd?x=1`);
      assert(p.ok && p.kind === "short" && p.host === host, JSON.stringify(p));
      assert(p.shortUrl === `https://${host}/d/Ab12Cd?x=1`, `got ${p.shortUrl}`);
    });
  }

  console.log("\n-- hostile / invalid inputs --");
  const rejects: Array<[string, string]> = [
    ["https://amazon.com.evil.io/dp/B08N5WRWNW", "not_amazon"],
    ["https://evil.io/?r=amzn.to", "not_amazon"],
    ["https://evil.io/amazon.com/dp/B08N5WRWNW", "not_amazon"],
    ["https://amazon.com@evil.io/dp/B08N5WRWNW", "invalid_url"],   // userinfo rejected before host check
    ["https://user@www.amazon.com/dp/B08N5WRWNW", "invalid_url"],
    ["https://amazon.com:8443/dp/B08N5WRWNW", "unsupported_host"],
    ["amazon.com:8443/dp/B08N5WRWNW", "unsupported_host"],
    ["https://sellercentral.amazon.com/x", "unsupported_host"],
    ["https://aws.amazon.com/", "unsupported_host"],
    ["https://www.аmazon.com/dp/B08N5WRWNW", "not_amazon"],   // Cyrillic "а" → punycode host
    ["javascript:alert(1)//amazon.com", "bad_scheme"],
    ["ftp://www.amazon.com/dp/B08N5WRWNW", "bad_scheme"],
    ["", "invalid_url"],
    ["not a url", "invalid_url"],
    [`https://www.amazon.com/dp/B08N5WRWNW?x=${"a".repeat(2100)}`, "invalid_url"],
  ];
  for (const [raw, reason] of rejects) {
    await test(`rejects ${raw.slice(0, 50)} (${reason})`, () => {
      const p = parseAmazonLink(raw);
      assert(!p.ok && p.reason === reason, `got ${JSON.stringify(p).slice(0, 120)}`);
    });
  }

  await test("http upgraded to https; scheme-less paste accepted", () => {
    assert(retail(`http://www.amazon.com/dp/${ASIN}`).normalizedUrl.startsWith("https://"), "http not upgraded");
    assert(retail(`amazon.com/dp/${ASIN}`).normalizedUrl === `https://www.amazon.com/dp/${ASIN}`, "scheme-less failed");
  });

  await test("classifyAmazonHost is exact (no substring / suffix tricks)", () => {
    assert(classifyAmazonHost("amazon.com.evil.io") === null, "suffix trick");
    assert(classifyAmazonHost("evilamazon.com") === null, "prefix trick");
    assert(classifyAmazonHost("www.a.co") === null, "short hosts are exact only");
    assert(classifyAmazonHost("A.CO")?.kind === "short", "case-insensitive short host");
  });

  await test("non-ASCII path is tolerated", () => {
    const p = retail(`https://www.amazon.co.jp/%E5%95%86%E5%93%81/dp/${ASIN}?th=1`);
    assert(p.asin === ASIN && p.normalizedUrl === `https://www.amazon.co.jp/dp/${ASIN}?th=1`, p.normalizedUrl);
  });

  console.log("\n-- ASIN: path shapes + mis-match regression --");
  const asinCases: Array<[string, string | null]> = [
    [`https://www.amazon.com/dp/${ASIN}`, ASIN],
    [`https://www.amazon.com/Name-Here/dp/${ASIN}/`, ASIN],
    [`https://www.amazon.com/gp/product/${ASIN}?psc=1`, ASIN],
    [`https://www.amazon.com/gp/aw/d/${ASIN}`, ASIN],
    [`https://www.amazon.com/exec/obidos/ASIN/${ASIN}`, ASIN],
    [`https://www.amazon.com/dp/${ASIN}/ref=sr_1_3`, ASIN],
    [`https://www.amazon.com/dp/${ASIN};ref=x`, ASIN],
    [`https://www.amazon.com/s?k=lamp&asin=${ASIN}`, ASIN],
    ["https://www.amazon.com/dp/BT00CTOUNS", "BT00CTOUNS"],
    ["https://www.amazon.com/electronic/", null],
    ["https://www.amazon.com/stationery?x=1", null],
    ["https://www.amazon.com/Lamp/ELECTRONIC/", null],
    ["https://www.amazon.com/dp/b08n5wrwnw", null],      // lowercase is not a URL ASIN
    ["https://www.amazon.com/dp/ELECTRONIC", null],      // no B0/BT prefix
    ["https://www.amazon.com/dp/B08N5WRWNWX", null],     // 11 chars
    ["https://www.amazon.com/product/B08N5WRWNW", null], // not an Amazon path shape
    ["https://www.amazon.com/dp/0316769487", "0316769487"],             // ISBN-10 book
    ["https://www.amazon.com/Catcher-Rye/dp/0316769487/ref=x", "0316769487"],
    ["https://www.amazon.com/gp/product/030640615X", "030640615X"],     // ISBN-10 with X check char
    ["https://www.amazon.com/dp/030640615x", null],                     // lowercase x is not a URL ASIN
    ["https://www.amazon.com/dp/03164X9487", null],                     // X only as the last char
    ["https://www.amazon.com/dp/031676948", null],                      // 9 digits
  ];
  for (const [raw, want] of asinCases) {
    await test(`asin(${raw.replace("https://www.amazon.com", "")}) = ${want}`, () => {
      const p = retail(raw);
      assert(p.asin === want, `got ${p.asin}`);
      assert(extractAsin(raw) === want, `legacy extractAsin disagrees: ${extractAsin(raw)}`);
    });
  }

  await test("no-ASIN retail link is kept as pasted (not rebuilt), https only", () => {
    const raw = "http://www.amazon.com/s?k=desk+lamp&ref=nb_sb_noss&tag=me-20";
    const p = retail(raw);
    assert(p.asin === null, "unexpected asin");
    assert(p.normalizedUrl === "https://www.amazon.com/s?k=desk+lamp&ref=nb_sb_noss&tag=me-20", p.normalizedUrl);
    assert(p.droppedParams.length === 0, "no-ASIN link must not be stripped");
  });

  console.log("\n-- params: keep attribution, drop junk --");
  await test("tag/linkCode/linkId/ascsubtag kept verbatim, in order (ruling 2)", () => {
    const p = retail(`https://www.amazon.com/Name/dp/${ASIN}/ref=as_li_ss_tl?crid=X&keywords=lamp&linkCode=sl1&tag=harriet-20&linkId=abc123def&ascsubtag=pin1&language=en_US&qid=1&sr=8-1`);
    assert(p.normalizedUrl === `https://www.amazon.com/dp/${ASIN}?linkCode=sl1&tag=harriet-20&linkId=abc123def&ascsubtag=pin1&language=en_US`, p.normalizedUrl);
    assert(p.tag === "harriet-20", "tag not extracted");
  });

  await test("every listed junk param is dropped and reported", () => {
    const junk = "ref=a&ref_=b&pd_rd_w=1&pd_rd_r=2&pf_rd_p=3&pf_rd_r=4&content-id=5&qid=6&sr=7&keywords=8&crid=9&sprefix=10&dib=11&dib_tag=12&_encoding=UTF8&smid=13";
    const p = retail(`https://www.amazon.com/dp/${ASIN}?${junk}&tag=me-20`);
    assert(p.normalizedUrl === `https://www.amazon.com/dp/${ASIN}?tag=me-20`, p.normalizedUrl);
    for (const k of ["ref", "ref_", "pd_rd_w", "pf_rd_p", "content-id", "qid", "smid", "_encoding"]) {
      assert(p.droppedParams.includes(k), `${k} not reported`);
    }
  });

  await test("variant selectors th/psc kept (design §1.4)", () => {
    const p = retail(`https://www.amazon.com/dp/${ASIN}?th=1&psc=1`);
    assert(p.normalizedUrl === `https://www.amazon.com/dp/${ASIN}?th=1&psc=1`, p.normalizedUrl);
  });

  await test("path /ref= segment removed and reported", () => {
    const p = retail(`https://www.amazon.com/dp/${ASIN}/ref=cm_sw_r_cp`);
    assert(p.normalizedUrl === `https://www.amazon.com/dp/${ASIN}` && p.droppedParams.includes("ref"), JSON.stringify(p));
  });

  await test("malformed tag is dropped and flagged, not kept", () => {
    const p = retail(`https://www.amazon.com/dp/${ASIN}?tag=${encodeURIComponent("<script>")}`);
    assert(p.tag === null && p.tagInvalid && p.normalizedUrl === `https://www.amazon.com/dp/${ASIN}`, JSON.stringify(p));
  });

  console.log("\n-- tag priority table (design §1.3) --");
  const us = (trackingId: string, marketplace: "US" | "DE" = "US") => ({ trackingId, marketplace });

  await test("row 1: URL tag T, no default → keep T, suggest saving", () => {
    const d = resolveAffiliateDestination(retail(`https://www.amazon.com/dp/${ASIN}?tag=t-20`), us(""));
    assert(d.tagSource === "url" && d.url.endsWith("tag=t-20") && d.warnings.includes("suggest_save_tag"), JSON.stringify(d));
  });
  await test("row 2: URL tag T, default T → keep T, no warning", () => {
    const d = resolveAffiliateDestination(retail(`https://www.amazon.com/dp/${ASIN}?tag=t-20`), us("t-20"));
    assert(d.tagSource === "url" && d.warnings.length === 0, JSON.stringify(d));
  });
  await test("row 3: URL tag T, default S → keep T (never rewritten), warn", () => {
    const d = resolveAffiliateDestination(retail(`https://www.amazon.com/dp/${ASIN}?tag=t-20`), us("s-20"));
    assert(d.tagSource === "url" && d.url.includes("tag=t-20") && !d.url.includes("s-20") && d.warnings.includes("tag_differs_from_default"), JSON.stringify(d));
  });
  await test("row 4: no tag, default S, same marketplace → append S", () => {
    const d = resolveAffiliateDestination(retail(`https://www.amazon.com/dp/${ASIN}?th=1`), us("s-20"));
    assert(d.tagSource === "settings" && d.url === `https://www.amazon.com/dp/${ASIN}?th=1&tag=s-20`, JSON.stringify(d));
  });
  await test("row 5a: no tag, default S for US, link on amazon.de → not applied, warn", () => {
    const d = resolveAffiliateDestination(retail(`https://www.amazon.de/dp/${ASIN}`), us("s-20"));
    assert(d.tagSource === "none" && !d.url.includes("tag=") && d.warnings.includes("marketplace_mismatch"), JSON.stringify(d));
  });
  await test("row 5b: no tag, default S, host marketplace unknown (amazon.nl) → not applied", () => {
    const d = resolveAffiliateDestination(retail(`https://www.amazon.nl/dp/${ASIN}`), us("s-20"));
    assert(d.tagSource === "none" && d.url === `https://www.amazon.nl/dp/${ASIN}` && d.warnings.includes("marketplace_mismatch"), JSON.stringify(d));
  });
  await test("row 6: no tag, no default → no commission warning (non-blocking)", () => {
    const d = resolveAffiliateDestination(retail(`https://www.amazon.com/dp/${ASIN}`), us(""));
    assert(d.tagSource === "none" && d.warnings.includes("no_tag_no_commission"), JSON.stringify(d));
  });

  console.log("\n-- chip suggestion (ruling 6: suggest, never replace) --");
  await test("suggestion keeps pastedUrl untouched and offers cleaned URL", () => {
    const raw = `https://www.amazon.com/Name/dp/${ASIN}/ref=sr_1_1?qid=1&tag=t-20&linkCode=ll1`;
    const s = suggestAmazonLinkNormalization(raw, us("s-20"));
    assert(s && s.pastedUrl === raw && s.changed, JSON.stringify(s));
    assert(s.suggestedUrl === `https://www.amazon.com/dp/${ASIN}?tag=t-20&linkCode=ll1`, s.suggestedUrl);
  });
  await test("already-clean link → changed=false (no chip)", () => {
    const raw = `https://www.amazon.com/dp/${ASIN}?tag=t-20`;
    const s = suggestAmazonLinkNormalization(raw, us("t-20"));
    assert(s && !s.changed, JSON.stringify(s));
  });
  await test("non-Amazon and short links → null suggestion", () => {
    assert(suggestAmazonLinkNormalization("https://etsy.com/listing/1", us("t-20")) === null, "etsy");
    assert(suggestAmazonLinkNormalization("https://amzn.to/abc", us("t-20")) === null, "short");
  });

  await test("isAmazonUrl agrees with parser on hostile hosts", () => {
    for (const raw of ["https://amazon.com.evil.io/x", "https://evil.io/?r=amzn.to", "https://amazon.com@evil.io/"]) {
      assert(!isAmazonUrl(raw), `${raw} accepted by isAmazonUrl`);
    }
  });

  console.log("\n-- short-link expansion (injected fetch) --");
  const redirect = (location: string, status = 301) => new Response(null, { status, headers: { location } });
  const scripted = (steps: Array<Response | Error>): { fetchImpl: ShortLinkFetch; calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      fetchImpl: async (url, init) => {
        calls.push(url);
        assert(init.redirect === "manual", "must not auto-follow redirects");
        const step = steps.shift();
        if (!step) throw new Error("unexpected extra fetch");
        if (step instanceof Error) throw step;
        return step;
      },
    };
  };

  await test("amzn.to → 301 → retail: expanded, retail page not fetched", async () => {
    const { fetchImpl, calls } = scripted([redirect(`https://www.amazon.com/dp/${ASIN}?tag=t-20`)]);
    const r = await expandAmazonShortLink("https://amzn.to/abc", fetchImpl);
    assert(r.ok && r.retailUrl === `https://www.amazon.com/dp/${ASIN}?tag=t-20` && r.hops === 1, JSON.stringify(r));
    assert(calls.length === 1, "retail page must not be fetched during expansion");
  });
  await test("a.co → a.co → retail (relative Location resolved)", async () => {
    const { fetchImpl } = scripted([redirect("/d/next", 302), redirect(`https://www.amazon.co.uk/dp/${ASIN}`)]);
    const r = await expandAmazonShortLink("https://a.co/d/abc", fetchImpl);
    assert(r.ok && r.hops === 2 && r.retailUrl.startsWith("https://www.amazon.co.uk/"), JSON.stringify(r));
  });
  await test("redirect to non-Amazon host → off_allowlist, not followed", async () => {
    const { fetchImpl, calls } = scripted([redirect("https://evil.io/steal")]);
    const r = await expandAmazonShortLink("https://amzn.to/abc", fetchImpl);
    assert(!r.ok && r.reason === "off_allowlist" && calls.length === 1, JSON.stringify(r));
  });
  await test("redirect to look-alike amazon.com.evil.io → off_allowlist", async () => {
    const { fetchImpl } = scripted([redirect("https://amazon.com.evil.io/dp/B08N5WRWNW")]);
    const r = await expandAmazonShortLink("https://amzn.to/abc", fetchImpl);
    assert(!r.ok && r.reason === "off_allowlist", JSON.stringify(r));
  });
  await test("redirect to private IP → off_allowlist", async () => {
    const { fetchImpl } = scripted([redirect("http://[::ffff:127.0.0.1]/")]);
    const r = await expandAmazonShortLink("https://amzn.to/abc", fetchImpl);
    assert(!r.ok && r.reason === "off_allowlist", JSON.stringify(r));
  });
  await test("more than 3 short hops → too_many_hops", async () => {
    const { fetchImpl, calls } = scripted([redirect("https://amzn.to/2"), redirect("https://amzn.to/3"), redirect("https://amzn.to/4")]);
    const r = await expandAmazonShortLink("https://amzn.to/1", fetchImpl);
    assert(!r.ok && r.reason === "too_many_hops" && calls.length === 3, JSON.stringify(r));
  });
  await test("200 (bot page) → not_redirect; timeout → timeout; network → network_error", async () => {
    const a = await expandAmazonShortLink("https://amzn.to/1", scripted([new Response("<html>", { status: 200 })]).fetchImpl);
    assert(!a.ok && a.reason === "not_redirect", JSON.stringify(a));
    const t = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const b = await expandAmazonShortLink("https://amzn.to/1", scripted([t]).fetchImpl);
    assert(!b.ok && b.reason === "timeout", JSON.stringify(b));
    const c = await expandAmazonShortLink("https://amzn.to/1", scripted([new Error("ECONNRESET")]).fetchImpl);
    assert(!c.ok && c.reason === "network_error" && c.expandedFrom === "https://amzn.to/1", JSON.stringify(c));
  });
  await test("non-short or non-fetchable input → invalid_short_link, no fetch", async () => {
    for (const raw of [`https://www.amazon.com/dp/${ASIN}`, "https://amzn.eu/d/x", "https://evil.io/"]) {
      const { fetchImpl, calls } = scripted([]);
      const r = await expandAmazonShortLink(raw, fetchImpl);
      assert(!r.ok && r.reason === "invalid_short_link" && calls.length === 0, `${raw}: ${JSON.stringify(r)}`);
    }
  });

  console.log(`\nAmazon link: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
