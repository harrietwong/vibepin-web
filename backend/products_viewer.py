"""
products_viewer.py — 生成只含商品 pin 的 HTML（有 outbound_link 且 save_count > 10）
用法: py products_viewer.py [--open]
"""
import json, argparse, webbrowser
from pathlib import Path

ROOT      = Path(__file__).parent
LIB_ROOT  = ROOT / "vibe_library"
OUT_HTML  = ROOT / "products.html"


def load_product_pins() -> list[dict]:
    folders = sorted(LIB_ROOT.glob("style_library_*"))
    pins = []
    for folder in folders:
        f = folder / "style_library.jsonl"
        if not f.exists():
            continue
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                p = json.loads(line)
            except Exception:
                continue
            if p.get("outbound_link") and (p.get("save_count") or 0) > 10:
                pins.append(p)
    # deduplicate by pin_id, keep highest save_count version
    seen: dict[str, dict] = {}
    for p in pins:
        pid = p["pin_id"]
        if pid not in seen or (p.get("save_count") or 0) > (seen[pid].get("save_count") or 0):
            seen[pid] = p
    result = sorted(seen.values(), key=lambda x: x.get("save_count") or 0, reverse=True)
    return result


HTML = """<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Product Pins</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f7f7;color:#333}

.topbar{position:sticky;top:0;z-index:100;background:#fff;border-bottom:1px solid #ddd;
        padding:12px 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.topbar h1{font-size:17px;font-weight:700;color:#e60023;white-space:nowrap}
.count{font-size:13px;color:#888;white-space:nowrap}
#search{border:1px solid #ddd;border-radius:20px;padding:7px 16px;font-size:14px;
        width:220px;outline:none}
#search:focus{border-color:#e60023}
.filters{display:flex;gap:8px;flex-wrap:wrap}
.fbtn{border:1px solid #ddd;border-radius:20px;padding:5px 14px;font-size:13px;
      cursor:pointer;background:#fff;transition:all .15s}
.fbtn:hover{border-color:#aaa}
.fbtn.active{background:#e60023;color:#fff;border-color:#e60023}
#sort-sel{border:1px solid #ddd;border-radius:20px;padding:5px 12px;font-size:13px;
          cursor:pointer;background:#fff;outline:none}

#grid{column-count:5;column-gap:12px;padding:16px 20px}
@media(max-width:1400px){#grid{column-count:4}}
@media(max-width:1100px){#grid{column-count:3}}
@media(max-width:750px){#grid{column-count:2}}

.card{break-inside:avoid;margin-bottom:12px;background:#fff;border-radius:12px;
      overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);
      transition:transform .15s,box-shadow .15s;cursor:pointer}
.card:hover{transform:translateY(-3px);box-shadow:0 6px 16px rgba(0,0,0,.14)}
.card.hidden{display:none}
.card img{width:100%;display:block;background:#eee}

.card-body{padding:10px 12px 12px}
.card-title{font-size:13px;font-weight:600;line-height:1.4;
            max-height:2.8em;overflow:hidden;margin-bottom:6px}
.meta{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px}
.badge{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500}
.badge-home   {background:#fff0f0;color:#e60023}
.badge-fashion{background:#f0f0ff;color:#5050e6}
.badge-beauty {background:#fff0ff;color:#c050c0}
.badge-kw{background:#f5f5f5;color:#555;max-width:160px;
          overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge-ecomm{background:#e8f5e9;color:#2e7d32}

.stats{display:flex;gap:10px;font-size:12px;color:#555;margin-bottom:6px;flex-wrap:wrap}
.stat{display:flex;align-items:center;gap:3px}
.stat svg{width:13px;height:13px;fill:currentColor;opacity:.75}
.stat-label{font-size:10px;color:#aaa;margin-right:1px}

.links{display:flex;gap:6px;margin-top:6px}
a.lout,a.lpin{font-size:11px;padding:2px 10px;border-radius:10px;
               text-decoration:none;font-weight:500}
a.lout{background:#fff0f0;color:#e60023}
a.lpin{background:#f5f5f5;color:#555}
a.lout:hover{background:#e60023;color:#fff}
a.lpin:hover{background:#ddd}
.domain{font-size:11px;color:#aaa;margin-top:4px;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.no-results{text-align:center;padding:80px 20px;color:#aaa;font-size:16px}
</style>
</head>
<body>

<div class="topbar">
  <h1>Product Pins</h1>
  <span class="count" id="cnt">— pins</span>
  <input id="search" type="text" placeholder="搜索标题 / 域名…">
  <div class="filters">
    <button class="fbtn active" data-cat="all">全部</button>
    <button class="fbtn" data-cat="home">Home</button>
    <button class="fbtn" data-cat="fashion">Fashion</button>
    <button class="fbtn" data-cat="beauty">Beauty</button>
  </div>
  <select id="sort-sel">
    <option value="save">Saves 最多</option>
    <option value="react">Reactions 最多</option>
    <option value="created">发布时间最新</option>
  </select>
</div>

<div id="grid"></div>
<p class="no-results hidden" id="no-res">没有符合条件的商品 Pin</p>

<script>
const PINS = __PINS_JSON__;

function fmt(n){
  if(!n) return '0';
  if(n>=10000) return (n/1000).toFixed(0)+'k';
  if(n>=1000)  return (n/1000).toFixed(1)+'k';
  return n;
}

function buildCard(p){
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.cat     = p.category || '';
  card.dataset.title   = (p.title||'').toLowerCase();
  card.dataset.domain  = (p.domain||'').toLowerCase();
  card.dataset.save    = p.save_count || 0;
  card.dataset.react   = p.reaction_count || 0;
  card.dataset.created = p.created_at || '';

  const cat     = p.category || '';
  const catLbl  = cat.toUpperCase();
  const kw      = p.seed_keyword || '';
  const title   = p.title || '(无标题)';
  const saves   = fmt(p.save_count);
  const reacts  = fmt(p.reaction_count);
  const date    = (p.created_at||'').slice(0,10);
  const pinPage = `https://www.pinterest.com/pin/${p.pin_id}/`;
  const outLink = p.outbound_link;
  const domain  = p.domain || '';
  const isEcomm = p.is_ecommerce;

  card.innerHTML = `
    ${p.image_url ? `<img src="${p.image_url}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
    <div class="card-body">
      <div class="card-title">${title}</div>
      <div class="meta">
        <span class="badge badge-${cat}">${catLbl}</span>
        ${isEcomm ? '<span class="badge badge-ecomm">电商</span>' : ''}
        <span class="badge badge-kw" title="${kw}">${kw}</span>
      </div>
      <div class="stats">
        <span class="stat" title="Saves">
          <svg viewBox="0 0 24 24"><path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg>
          <span class="stat-label">Saves</span>${saves}
        </span>
        <span class="stat" title="Reactions">
          <svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
          <span class="stat-label">Likes</span>${reacts}
        </span>
        ${date ? `<span class="stat"><span class="stat-label">发布</span>${date}</span>` : ''}
      </div>
      <div class="links">
        <a class="lout" href="${outLink}" target="_blank" onclick="event.stopPropagation()">商品链接</a>
        <a class="lpin" href="${pinPage}" target="_blank" onclick="event.stopPropagation()">Pin 页</a>
      </div>
      ${domain ? `<div class="domain">${domain}</div>` : ''}
    </div>`;

  card.addEventListener('click', () => window.open(outLink, '_blank'));
  return card;
}

const grid  = document.getElementById('grid');
const noRes = document.getElementById('no-res');
const cntEl = document.getElementById('cnt');
const cards = PINS.map(buildCard);
cards.forEach(c => grid.appendChild(c));

function updateCount(){
  const v = cards.filter(c=>!c.classList.contains('hidden')).length;
  cntEl.textContent = v + ' / ' + cards.length + ' product pins';
}

let activeCat = 'all', searchQ = '';

document.querySelectorAll('.fbtn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.fbtn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    activeCat = btn.dataset.cat;
    applyFilters();
  });
});

document.getElementById('search').addEventListener('input',e=>{
  searchQ = e.target.value.toLowerCase().trim();
  applyFilters();
});

function applyFilters(){
  let v = 0;
  cards.forEach(c=>{
    const catOk = activeCat==='all' || c.dataset.cat===activeCat;
    const qOk   = !searchQ || c.dataset.title.includes(searchQ) || c.dataset.domain.includes(searchQ);
    const show  = catOk && qOk;
    c.classList.toggle('hidden',!show);
    if(show) v++;
  });
  noRes.classList.toggle('hidden', v>0);
  updateCount();
}

document.getElementById('sort-sel').addEventListener('change',e=>{
  const key = e.target.value;
  const sorted = [...cards].sort((a,b)=>{
    if(key==='created') return b.dataset.created.localeCompare(a.dataset.created);
    return Number(b.dataset[key]) - Number(a.dataset[key]);
  });
  sorted.forEach(c=>grid.appendChild(c));
});

updateCount();
</script>
</body>
</html>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--open", action="store_true")
    args = ap.parse_args()

    pins = load_product_pins()
    print(f"商品 pins: {len(pins)} 个（outbound_link 非空且 save_count > 10）")
    if pins:
        ecomm = sum(1 for p in pins if p.get("is_ecommerce"))
        print(f"  其中 is_ecommerce=True: {ecomm} 个")
        print(f"  最高收藏: {pins[0].get('save_count')}  {pins[0].get('outbound_link')}")

    pins_json = json.dumps(pins, ensure_ascii=False, default=str)
    html = HTML.replace("__PINS_JSON__", pins_json)
    OUT_HTML.write_text(html, encoding="utf-8")
    print(f"已生成: {OUT_HTML}")

    if args.open:
        webbrowser.open(OUT_HTML.as_uri())


if __name__ == "__main__":
    main()
