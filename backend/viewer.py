"""
viewer.py — 把所有 style_library.jsonl 合并生成一个可视化 HTML 文件
用法: py viewer.py [--latest] [--open]
  --latest  只用最新一次运行的数据
  --open    生成后自动在浏览器打开
"""
import json, argparse, webbrowser
from pathlib import Path
from datetime import datetime

ROOT      = Path(__file__).parent
LIB_ROOT  = ROOT / "vibe_library"
OUT_HTML  = ROOT / "viewer.html"


def load_pins(latest_only: bool) -> list[dict]:
    folders = sorted(LIB_ROOT.glob("style_library_*"))
    if latest_only:
        folders = folders[-1:]
    pins = []
    for folder in folders:
        f = folder / "style_library.jsonl"
        if not f.exists():
            continue
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                pins.append(json.loads(line))
    # deduplicate by pin_id (keep last)
    seen: dict[str, dict] = {}
    for p in pins:
        seen[p["pin_id"]] = p
    return list(seen.values())


HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pinterest Style Library</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
       background: #f0f0f0; color: #333; }

/* ── Top bar ── */
.topbar { position: sticky; top: 0; z-index: 100; background: #fff;
          border-bottom: 1px solid #ddd; padding: 12px 20px;
          display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.topbar h1 { font-size: 18px; font-weight: 700; color: #e60023; white-space: nowrap; }
.topbar .count { font-size: 13px; color: #888; white-space: nowrap; }

/* search */
#search { border: 1px solid #ddd; border-radius: 20px; padding: 7px 16px;
          font-size: 14px; width: 220px; outline: none; }
#search:focus { border-color: #e60023; }

/* filter buttons */
.filters { display: flex; gap: 8px; flex-wrap: wrap; }
.filter-btn { border: 1px solid #ddd; border-radius: 20px; padding: 5px 14px;
              font-size: 13px; cursor: pointer; background: #fff;
              transition: all .15s; }
.filter-btn:hover { border-color: #aaa; }
.filter-btn.active { background: #e60023; color: #fff; border-color: #e60023; }

/* sort */
#sort-select { border: 1px solid #ddd; border-radius: 20px; padding: 5px 12px;
               font-size: 13px; cursor: pointer; background: #fff; outline: none; }

/* ── Masonry grid ── */
#grid { column-count: 5; column-gap: 12px; padding: 16px 20px; }
@media (max-width: 1400px) { #grid { column-count: 4; } }
@media (max-width: 1100px) { #grid { column-count: 3; } }
@media (max-width: 750px)  { #grid { column-count: 2; } }

.card { break-inside: avoid; margin-bottom: 12px;
        background: #fff; border-radius: 12px; overflow: hidden;
        box-shadow: 0 1px 4px rgba(0,0,0,.08);
        transition: transform .15s, box-shadow .15s; cursor: pointer; }
.card:hover { transform: translateY(-3px); box-shadow: 0 6px 16px rgba(0,0,0,.14); }
.card.hidden { display: none; }

.card img { width: 100%; display: block; object-fit: cover; background: #eee; }
.card-body { padding: 10px 12px 12px; }
.card-title { font-size: 13px; font-weight: 600; line-height: 1.4;
              max-height: 2.8em; overflow: hidden; margin-bottom: 6px; }
.card-meta { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 500; }
.badge-category { background: #fff0f0; color: #e60023; }
.badge-home     { background: #fff0f0; color: #e60023; }
.badge-fashion  { background: #f0f0ff; color: #5050e6; }
.badge-beauty   { background: #fff0ff; color: #c050c0; }
.badge-kw   { background: #f5f5f5; color: #555; max-width: 160px;
              overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-stats { display: flex; gap: 10px; font-size: 11px; color: #777; }
.stat { display: flex; align-items: center; gap: 3px; }
.stat svg { width: 12px; height: 12px; fill: currentColor; opacity: .7; }
.card-links { display: flex; gap: 6px; margin-top: 6px; }
.link-out, .link-pin { font-size: 11px; padding: 2px 8px; border-radius: 10px;
                        text-decoration: none; font-weight: 500; }
.link-out { background: #fff0f0; color: #e60023; }
.link-pin { background: #f5f5f5; color: #555; }
.link-out:hover { background: #e60023; color: #fff; }
.link-pin:hover { background: #ddd; }
.domain { font-size: 11px; color: #aaa; margin-top: 4px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.no-results { text-align: center; padding: 80px 20px; color: #aaa; font-size: 16px; }
</style>
</head>
<body>

<div class="topbar">
  <h1>Pinterest Style Library</h1>
  <span class="count" id="count-label">— pins</span>
  <input id="search" type="text" placeholder="搜索标题/关键词/域名…">
  <div class="filters">
    <button class="filter-btn active" data-cat="all">全部</button>
    <button class="filter-btn" data-cat="home">Home</button>
    <button class="filter-btn" data-cat="fashion">Fashion</button>
    <button class="filter-btn" data-cat="beauty">Beauty</button>
  </div>
  <select id="sort-select">
    <option value="save">按 Saves 排序</option>
    <option value="react">按 Reactions 排序</option>
    <option value="created">按发布时间排序</option>
  </select>
</div>

<div id="grid"></div>
<div class="no-results hidden" id="no-results">没有符合条件的 Pin</div>

<script>
const PINS = __PINS_JSON__;

function catBadgeClass(cat) {
  return 'badge badge-' + (cat || 'category');
}

function fmt(n) {
  if (n >= 10000) return (n/1000).toFixed(0) + 'k';
  if (n >= 1000)  return (n/1000).toFixed(1) + 'k';
  return n;
}

function buildCard(p) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.cat = p.category || '';
  card.dataset.kw  = (p.seed_keyword || '') + ' ' + (p.source_keyword || '');
  card.dataset.title = (p.title || '').toLowerCase();
  card.dataset.domain = (p.domain || '').toLowerCase();
  card.dataset.save    = p.save_count || 0;
  card.dataset.react   = p.reaction_count || 0;
  card.dataset.created = p.created_at || '';
  card.dataset.ms      = p.make_similar_score || 0;
  card.dataset.ci      = p.commercial_intent_score || 0;

  const imgHtml = p.image_url
    ? `<img src="${p.image_url}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : '';

  const catClass = catBadgeClass(p.category);
  const catLabel = (p.category || '').toUpperCase();
  const kwLabel  = p.seed_keyword || '';
  const title    = p.title || '(无标题)';
  const domain   = p.domain || '';
  const saves    = fmt(p.save_count || 0);
  const reacts   = fmt(p.reaction_count || 0);
  const dateStr  = p.created_at ? p.created_at.slice(0,10) : '';
  const pinPage  = `https://www.pinterest.com/pin/${p.pin_id}/`;
  const link     = p.outbound_link || pinPage;

  card.innerHTML = `
    ${imgHtml}
    <div class="card-body">
      <div class="card-title">${title}</div>
      <div class="card-meta">
        <span class="${catClass}">${catLabel}</span>
        <span class="badge badge-kw" title="${kwLabel}">${kwLabel}</span>
      </div>
      <div class="card-stats">
        <span class="stat" title="Saves">
          <svg viewBox="0 0 24 24"><path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg>
          ${saves}
        </span>
        <span class="stat" title="Reactions (likes)">
          <svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
          ${reacts}
        </span>
        ${dateStr ? `<span class="stat" title="Created">${dateStr}</span>` : ''}
      </div>
      <div class="card-links">
        ${p.outbound_link ? `<a class="link-out" href="${p.outbound_link}" target="_blank" onclick="event.stopPropagation()">外链</a>` : ''}
        <a class="link-pin" href="${pinPage}" target="_blank" onclick="event.stopPropagation()">Pin</a>
      </div>
      ${domain ? `<div class="domain">${domain}</div>` : ''}
    </div>`;

  card.addEventListener('click', () => window.open(link, '_blank'));
  return card;
}

// ── Render ──────────────────────────────────────────────────────────────────

const grid    = document.getElementById('grid');
const noRes   = document.getElementById('no-results');
const countEl = document.getElementById('count-label');
const cards   = PINS.map(buildCard);
cards.forEach(c => grid.appendChild(c));

function updateCount() {
  const visible = cards.filter(c => !c.classList.contains('hidden')).length;
  countEl.textContent = visible + ' / ' + cards.length + ' pins';
}

// ── Filters ──────────────────────────────────────────────────────────────────

let activeCat = 'all';
let searchQ   = '';

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeCat = btn.dataset.cat;
    applyFilters();
  });
});

document.getElementById('search').addEventListener('input', e => {
  searchQ = e.target.value.toLowerCase().trim();
  applyFilters();
});

function applyFilters() {
  let visible = 0;
  cards.forEach(c => {
    const catOk = activeCat === 'all' || c.dataset.cat === activeCat;
    const qOk   = !searchQ ||
                  c.dataset.title.includes(searchQ) ||
                  c.dataset.kw.toLowerCase().includes(searchQ) ||
                  c.dataset.domain.includes(searchQ);
    const show  = catOk && qOk;
    c.classList.toggle('hidden', !show);
    if (show) visible++;
  });
  noRes.classList.toggle('hidden', visible > 0);
  updateCount();
}

// ── Sort ──────────────────────────────────────────────────────────────────────

document.getElementById('sort-select').addEventListener('change', e => {
  const key = e.target.value;
  const sorted = [...cards].sort((a, b) => {
    if (key === 'created') return b.dataset.created.localeCompare(a.dataset.created);
    return Number(b.dataset[key]) - Number(a.dataset[key]);
  });
  sorted.forEach(c => grid.appendChild(c));
});

updateCount();
</script>
</body>
</html>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--latest", action="store_true", help="只用最新一次运行")
    ap.add_argument("--open",   action="store_true", help="生成后自动打开浏览器")
    args = ap.parse_args()

    pins = load_pins(args.latest)
    print(f"加载了 {len(pins)} 个 pin（来自 {'最新' if args.latest else '全部'} 运行）")

    pins_json = json.dumps(pins, ensure_ascii=False, default=str)
    html = HTML_TEMPLATE.replace("__PINS_JSON__", pins_json)

    OUT_HTML.write_text(html, encoding="utf-8")
    print(f"已生成: {OUT_HTML}")

    if args.open:
        webbrowser.open(OUT_HTML.as_uri())


if __name__ == "__main__":
    main()
