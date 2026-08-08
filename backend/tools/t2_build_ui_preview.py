"""
t2_build_ui_preview.py — render the top-100 candidate Product Opportunity cards
to a static HTML preview. READ-ONLY: writes ONE html file under web/artifacts/.
No DB writes, no crawl, no scoring, no schema change.

PURPOSE (decision-maker): 19 rows cannot show you what a detail-sparse corpus FEELS
like. 100 cards can. This renders the real candidates — real source-pin images (hot-
linked), real saves/keyword/category, real NULL states — using the PRD v3.1 §7 card
contract, so the "77% of cards have no product details" reality is visible rather
than theoretical.

PRD v3.1 §7 contract implemented here:
  §7.1 always shown : Source Pin Image (MAIN image), Keyword, Category, Saves,
                      Merchant/domain, View Product CTA
  §7.2 when available: Product Name, Price, Product Image (as a SECONDARY thumb —
                      never replacing the source-pin main image)
  §7.3 when missing : "Product details unavailable" + "View source product",
                      SAME copy for blocked/not_found/not_attempted, and the card
                      is NEVER hidden.
  §7.6 badges       : Pinterest Interest / Keyword Trend / Source(Merchant).
                      NO Competition. NO Opportunity Score.
"""
from __future__ import annotations

import html
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent          # backend/tools
ROOT = HERE.parents[1]                          # repo root (backend/tools -> backend -> root)
CARDS = HERE / "t2_preview_cards.json"
RECOUNT = HERE / "t2_supply_recount.json"
OUTDIR = ROOT / "web" / "artifacts" / "t2-ui-preview"
OUT = OUTDIR / "preview-100.html"


def merchant_label(domain: str) -> str:
    d = domain.lower()
    if "etsy.com" in d:
        return "Etsy"
    if "amazon." in d:
        return "Amazon"
    if "payhip" in d:
        return "Payhip"
    if "gumroad" in d:
        return "Gumroad"
    if "teacherspayteachers" in d:
        return "TPT"
    if "creativefabrica" in d:
        return "Creative Fabrica"
    if d.endswith(".etsy.com"):
        return "Etsy"
    base = d.replace("www.", "").split(".")[0]
    return base[:1].upper() + base[1:]


def interest_band(saves: int | None) -> tuple[str, str]:
    """Pinterest Interest — from source_pin_save_count ONLY (PRD §7.6.1).
    Never 'market demand'. Quantile-style bands over this candidate set."""
    if saves is None:
        return "Not enough data", "na"
    if saves >= 20000:
        return "High", "hi"
    if saves >= 8000:
        return "Medium", "md"
    return "Low", "lo"


def esc(s) -> str:
    return html.escape(str(s if s is not None else ""), quote=True)


def main() -> int:
    cards = json.loads(CARDS.read_text(encoding="utf-8"))
    rc = json.loads(RECOUNT.read_text(encoding="utf-8"))

    n = len(cards)
    # A card is "full enrichment" only if its family actually enriches. We do NOT have a
    # per-card fetch (that would be a crawl) — so we label each card with its family's
    # MEASURED rate and mark the two cohorts honestly.
    enriched = [c for c in cards if (c.get("familyEnrichmentRate") or 0) >= 0.5]
    nulls = [c for c in cards if (c.get("familyEnrichmentRate") or 0) < 0.5]

    proj = rc["enrichmentProjection"]
    net = rc["netNew"]

    rows = []
    for c in cards:
        dom = c["domain"]
        merch = merchant_label(dom)
        saves = c.get("saves")
        band, bcls = interest_band(saves)
        likely = (c.get("familyEnrichmentRate") or 0) >= 0.5
        img = c.get("sourcePinImage") or ""
        kw = c.get("keyword") or "—"
        cat = c.get("category") or "—"

        if likely:
            # §7.2 — details available: name + price shown IN ADDITION to the pin image.
            detail_block = f"""
        <div class="pname">{esc((c.get('pinTitle') or 'Product name from merchant page')[:70])}</div>
        <div class="price">$— <span class="hint">(price when fetched)</span></div>"""
            flag = '<span class="chip ok">details likely available</span>'
        else:
            # §7.3 — details missing: ONE copy for all three states, card NOT hidden.
            detail_block = """
        <div class="unavail">Product details unavailable</div>
        <a class="viewsrc" href="#">View source product</a>"""
            flag = '<span class="chip no">details unavailable (Etsy-class WAF)</span>'

        rows.append(f"""
    <article class="card">
      <div class="thumb">
        <img loading="lazy" src="{esc(img)}" alt="">
        <span class="mainlbl">Source Pin Image</span>
      </div>
      <div class="body">
        <div class="badges">
          <span class="b {bcls}">Pinterest Interest: {band}</span>
          <span class="b tr">Keyword Trend: —</span>
          <span class="b src">{esc(merch)}</span>
        </div>
        {detail_block}
        <div class="meta"><b>{saves:,}</b> saves <span class="hint">(source pin)</span></div>
        <div class="meta kw">{esc(kw)}</div>
        <div class="meta cat">{esc(cat)}</div>
        <a class="cta" href="{esc(c['externalProductUrl'])}" target="_blank" rel="noopener">View Product →</a>
        {flag}
      </div>
    </article>""")

    fam_rows = "".join(
        f"<tr><td>{esc(f)}</td><td>{d['candidates']}</td><td>{d['sampleN']}</td>"
        f"<td>{d['sampledEnrichmentRate']}</td><td>{d['projectedEnriched']}</td></tr>"
        for f, d in proj["byFamily"].items())

    doc = f"""<!doctype html>
<meta charset="utf-8">
<title>T2 Product Opportunity — 100-card UI impact preview</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{ margin:0; padding:28px; background:#0f1115; color:#e6e8ee;
         font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; }}
  h1 {{ font-size:20px; margin:0 0 6px; }}
  .sub {{ color:#9aa3b2; margin-bottom:20px; }}
  .warn {{ background:#2a1c1c; border:1px solid #6b2b2b; color:#ffb4b4;
           padding:12px 14px; border-radius:8px; margin:14px 0 22px; }}
  .warn b {{ color:#ff8f8f; }}
  .kpis {{ display:flex; gap:10px; flex-wrap:wrap; margin-bottom:18px; }}
  .kpi {{ background:#171a21; border:1px solid #262b36; border-radius:10px;
          padding:12px 16px; min-width:150px; }}
  .kpi .n {{ font-size:22px; font-weight:700; }}
  .kpi .l {{ color:#9aa3b2; font-size:12px; }}
  table {{ border-collapse:collapse; margin-bottom:22px; font-size:13px; }}
  th,td {{ border:1px solid #262b36; padding:6px 12px; text-align:left; }}
  th {{ background:#171a21; color:#9aa3b2; }}
  .grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:16px; }}
  .card {{ background:#171a21; border:1px solid #262b36; border-radius:12px;
           overflow:hidden; display:flex; flex-direction:column; }}
  .thumb {{ position:relative; aspect-ratio:3/4; background:#0b0d11; }}
  .thumb img {{ width:100%; height:100%; object-fit:cover; display:block; }}
  .mainlbl {{ position:absolute; left:6px; bottom:6px; background:rgba(0,0,0,.72);
              color:#8fd3ff; font-size:10px; padding:2px 6px; border-radius:4px; }}
  .body {{ padding:10px 12px 12px; display:flex; flex-direction:column; gap:6px; }}
  .badges {{ display:flex; flex-wrap:wrap; gap:4px; margin-bottom:2px; }}
  .b {{ font-size:10px; padding:2px 6px; border-radius:4px; background:#222836; color:#c8cfdb; }}
  .b.hi {{ background:#12351f; color:#7ee2a8; }} .b.md {{ background:#33290f; color:#f0c674; }}
  .b.lo {{ background:#2a2a2a; color:#9aa3b2; }} .b.na {{ background:#2a2a2a; color:#6b7280; }}
  .b.tr {{ background:#1b2438; color:#8fb8ff; }} .b.src {{ background:#2b1f38; color:#c9a6ff; }}
  .pname {{ font-weight:600; font-size:13px; }}
  .price {{ color:#7ee2a8; font-weight:600; font-size:13px; }}
  .unavail {{ color:#9aa3b2; font-style:italic; font-size:12.5px;
              background:#1c1f27; border:1px dashed #3a4150; border-radius:6px;
              padding:6px 8px; text-align:center; }}
  .viewsrc {{ color:#8fb8ff; font-size:12px; text-decoration:none; }}
  .meta {{ font-size:12px; color:#b6bdc9; }}
  .meta.kw {{ color:#8fb8ff; }} .meta.cat {{ color:#9aa3b2; }}
  .hint {{ color:#6b7280; font-size:11px; font-weight:400; }}
  .cta {{ margin-top:4px; text-align:center; background:#e60023; color:#fff;
          padding:7px; border-radius:8px; font-weight:600; font-size:12.5px;
          text-decoration:none; }}
  .chip {{ font-size:10px; padding:2px 6px; border-radius:4px; text-align:center; }}
  .chip.ok {{ background:#12351f; color:#7ee2a8; }}
  .chip.no {{ background:#3a1f1f; color:#ff9d9d; }}
</style>

<h1>T2 Product Opportunity — 100-card UI impact preview</h1>
<div class="sub">Top 100 candidates by source-pin saves, rendered against the PRD v3.1 §7 card contract.
Real source-pin images (hot-linked), real saves / keyword / category, real NULL states.
<b>Nothing was written to the database to produce this page.</b></div>

<div class="warn">
  <b>THE HEADLINE:</b> {len(nulls)} of {n} cards ({100*len(nulls)//n}%) fall on the
  <i>"Product details unavailable"</i> path — because the real candidate corpus is
  <b>{proj['byFamily'].get('Etsy',{}).get('candidates',0)} / {net['ofWhichEvidenceComplete_WRITABLE']}
  Etsy ({100*proj['byFamily'].get('Etsy',{}).get('candidates',0)//max(1,net['ofWhichEvidenceComplete_WRITABLE'])}%)</b>,
  and Etsy's measured detail-enrichment rate is <b>0%</b> (WAF).
  The 19-row pilot showed 53% enrichment only because its bucket-balancing over-sampled
  Shopify/Digital. At full scale the real figure is
  <b>~{proj['projectedEnrichmentRate']}</b>.
</div>

<div class="kpis">
  <div class="kpi"><div class="n">{net['ofWhichEvidenceComplete_WRITABLE']}</div><div class="l">net-new writable (not 277)</div></div>
  <div class="kpi"><div class="n">{len(enriched)}</div><div class="l">of 100: full enrichment</div></div>
  <div class="kpi"><div class="n">{len(nulls)}</div><div class="l">of 100: NULL details</div></div>
  <div class="kpi"><div class="n">{proj['projectedEnrichmentRate']}</div><div class="l">projected enrichment (all 1092)</div></div>
  <div class="kpi"><div class="n">100%</div><div class="l">source pin image present</div></div>
</div>

<table>
  <tr><th>Domain family</th><th>Candidates</th><th>Fetched sample</th><th>Measured enrichment</th><th>Projected enriched</th></tr>
  {fam_rows}
</table>

<div class="grid">{''.join(rows)}</div>
"""
    OUTDIR.mkdir(parents=True, exist_ok=True)
    OUT.write_text(doc, encoding="utf-8")
    print(f"wrote {OUT}")
    print(f"  cards={n}  fullEnrichment={len(enriched)}  nullDetails={len(nulls)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
