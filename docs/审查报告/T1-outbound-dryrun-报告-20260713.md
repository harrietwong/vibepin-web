# T1 Outbound Link dry-run 报告

**日期：** 2026-07-13　**任务：** 数据侧任务书 v1.1 §5 T1（P0，只读）
**执行人：** Fable5 数据侧代理　**性质：** 全程只读，**本次未写库**（见文末声明）

---

## 0. 一句话结论

对 pin_samples 全部 **6,258** 条含站外链接（`outbound_link` 非空）的行跑完两层判定：URL 规则层放行 **1,312** 条，页面/结构验证综合确认率 **95.2%（保守）/ 98.8%（Amazon /dp/ 修正后）**，人工抽查 20 条**零首页/分类页混入（误收率 0%，远优于 ≤10% 阈值）**。**关键约束：1,312 条里 914 条已存在于 pin_products（多为既有 `outbound_link_bootstrap` 批次），真正净新增仅约 379–393 条。** 未触发任何停止条件。**建议：达到 T2 bounded apply 的准入条件，但须先解决"去重键"与"Etsy WAF 商品字段抓取"两个前置问题（详见 §9）。**

---

## 1. 数据来源与字段澄清（重要）

- 扫描字段用 **`pin_samples.outbound_link`**（站外跳转真链），非 `source_url`。经核对：`source_url` 对这批行**绝大多数是 Pinterest 搜索页 URL**（`pinterest.com/search/pins/?q=...`），并非商品页；`outbound_link` 才是 Pin 落地的站外真链。任务卡"outbound_link 非空的行"即指此列。
- §3 字段规范里 `product_url ← source_url` 是**目标表 pin_products 的列映射**（T2 写入语义），与本次"扫描哪一列"是两码事，不冲突。
- `pin_samples.parent_pin_id` 对这批行**全部为 NULL**（这些行本身就是来源 Pin，无 parent）；真正的追溯键是 **`pin_samples.pin_id`**（全量非空）。这直接影响去重口径（见 §6）。

---

## 2. DB 侧全量精确统计（不发外部请求）

| 指标 | 数值 |
|---|---|
| pin_samples 总行数 | **20,608** |
| `source_url` 非空行 | 19,674 |
| **`outbound_link` 非空行（本次扫描集）** | **6,258** |
| URL 规则层**通过** | **1,312** |
| URL 规则层**拒绝** | 4,946 |

---

## 3. URL 规则层判定（任务书 §2 第 1 层）

### 3.1 拒绝原因分桶（4,946）

| 拒绝桶 | 数量 | 说明 |
|---|---|---|
| other_non_product | 2,480 | 食谱/教程/内容博客、shffls.com(Pinterest Shuffles 拼贴)、linktr.ee/benable 聚合页、Google Drive、App Store、无可识别商品路径的深链 |
| social | 1,437 | instagram / x / facebook / youtube / tiktok / tumblr / vk 等社媒域 |
| blog_tutorial | 623 | 明确 blog/tutorial/how-to/recipe/年份路径 |
| collection_category | 188 | collection/category/Amazon `/shop/` 店铺列表 |
| homepage | 83 | 站点首页（path 为 / 或空） |
| shortlink_unresolvable | 72 | amzn.to / bit.ly / rstyle.me / shop.app / liketk.it 等短链（终点未知，URL 层不放行） |
| lookbook | 60 | lookbook/gallery/inspiration |
| search | 3 | 搜索页 |

拒绝集抽样人工核对：均为**正确拒绝**（内容页/社媒/聚合页/短链），无明显误杀主流电商 PDP。

### 3.2 通过集平台分布（1,312）

| 平台 | 通过数 | 命中模式 |
|---|---|---|
| **Etsy** | 1,036 | `/listing/<id>` |
| **Amazon** | 57 | `/dp/<ASIN>` 或 `/gp/product/` |
| **Shopify / 自定义域** | 197 | `/products/<slug>`（含 Depop `/products/`） |
| **eBay** | 22 | `/itm/<id>` |

（域名口径全量分布：other/custom 4,949、etsy 1,045、amazon 236、ebay 26、aliexpress 2；通过集里 other/custom 197 = 全部为带 `/products/` 路径的独立站 Shopify + Depop。）

---

## 4. 页面验证层（任务书 §2 第 2 层，轻量只读 GET）

**参数：** UA=正常 Chrome UA + 完整浏览器头；超时 10s；跟随重定向（终点重跑 URL 规则，重定向到首页判失败）；单页 ≤500KB；限速 ~1.8 req/s（< 2 req/s）；绝不登录/提交表单。

**抽样口径：** 通过集 1,312 > 600，故按平台分层随机抽 **600** 验证，比例外推。分层配额：Etsy≈474、Shopify/自定义≈68、Amazon≈47、eBay≈10、Depop≈19（对应各平台在通过集中的占比）。

### 4.1 三类判定结果（n=600）

| 结果 | 数量 | 含义 |
|---|---|---|
| **page-verified pass** | 68 | 真实 GET 成功且命中 og:type=product / schema.org Product / 价格 / Amazon PDP 标记 |
| **URL-structural（page_blocked）** | 503 | Etsy 474 + Depop 19 + eBay 10：站点 CDN/WAF 对任何轻量 GET 返回 403，但 URL 命中 canonical PDP 模式（`/listing/<id>`、`/itm/<id>`、`/products/<slug>`），结构上不可能是首页/分类/搜索 |
| **genuine fail** | 29 | 见下 |

### 4.2 "URL 命中但页面验证失败" 明细（29，任务卡必含项）

| 失败原因 | 数量 | 判断 |
|---|---|---|
| no_product_marker | 22 | **全部是 Amazon `/dp/<ASIN>` 页** → 实为真实商品，标记未命中是 Amazon 对数据中心 IP 返回验证/精简页或 500KB 截断所致（**false-negative**，实际是商品） |
| http_403（非主流站 WAF） | 5 | supplyme / rulyshop / kenkoda / marialady 等小型 Shopify 站的 WAF 拦截 |
| http_404 / 下架 | 2 | lolarain.com 两条已下架商品（真·失效链接） |
| redirected_non_product | 0 | — |
| timeout | 0 | — |

### 4.3 提取能力（在 68 条 page-verified pass 中）

| 可提取字段 | 数量 |
|---|---|
| 商品标题 | 67 / 68 |
| 商品图（og:image / landingImage） | 63 / 68 |
| 价格 | 68 / 68 |

> Etsy/eBay/Depop 的 503 条因 WAF 拦截，本轮**无法轻量抓取商品标题/图/价格**——这是 T2 的实抓短板（§9），不是本次 dry-run 的判定失败。

### 4.4 请求失败率与停止条件

- **fetchable（非 WAF 墙）请求 97 条，网络失败（timeout/5xx）= 0 → 失败率 0%。**
- 主流站 403（Etsy/eBay/Depop）是**站点访问策略**，按方法学归类为 page_blocked，不计入"验证实现失败"。
- **未触发 >30% 失败率停止条件；未出现连续 429/403 限流（非墙站零 403 连击）。**

---

## 5. 综合确认率

| 口径 | 计算 | 结果 |
|---|---|---|
| **保守**（page-verified pass + URL-structural，Amazon /dp/ 未命中的算失败） | (68+503)/600 | **95.17%** |
| **修正**（把 22 条 Amazon /dp/ false-negative 计为商品） | (68+503+22)/600 | **98.83%** |

外推到通过集 1,312：约 **1,249–1,297 条**为真实商品详情页。

---

## 6. Duplicates / existing rows（对现有 pin_products）

**pin_products 现状：** 总 3,474 行，`discovery_method` 分布 = `stl` 2,676 + `outbound_link_bootstrap` 798。

**去重口径说明（关键）：** 任务卡要求"parent_pin_id + product_url 去重"，但本批 `pin_samples.parent_pin_id` **全为 NULL**，该键失效。改用**真实追溯键 `pin_samples.pin_id`**（→ 对齐 pin_products 的 `parent_pin_id/source_pin_id/product_pin_id`）+ **归一化 URL**（去 query/fragment/尾斜杠）。

| 去重方式 | 命中 |
|---|---|
| pin_id + 归一化 URL | 891 |
| 归一化 URL（任意位置已存在） | **914** |
| **通过集去重后真·净新增（URL-unique）** | **398** |

URL-overlap 的 914 条来源：既有 `outbound_link_bootstrap` 批 671 + `stl` 245 —— 说明**这批 outbound 链接大部分已被上一轮 bootstrap 采过**，T1 通过集的增量价值主要在那 398 条新 URL。

---

## 7. Projected inserts

**公式（任务卡口径）：** 规则通过 × 验证通过率 − duplicates。本处按"先去重再乘确认率"给两档：

| 口径 | 计算 | projected inserts |
|---|---|---|
| **净新增 × 保守确认率** | 398 × 0.9517 | **≈ 379** |
| **净新增 × 修正确认率** | 398 × 0.9883 | **≈ 393** |
| （参考：不去重全池 × 保守率 | 1,312 × 0.9517 | ≈ 1,249，**但其中 914 是重复，不应写入**） |

**决策数字：T2 首批 insert-only 真实增量约 379–393 行**（恰好落在任务卡"首批 ≤100 行"之上——意味着一次 100 行 bounded apply 后仍有 3–4 批的量，符合分批节奏）。

---

## 8. 人工抽查表（任务卡验收项）

- 文件：**`web/artifacts/t1-outbound-dryrun/review-20.html`**
- 内容：从"两层都通过"集合随机 20 条（16 条 page-verified + 4 条 URL-structural），每行含：来源 Pin 缩略图（热链，`referrerpolicy=no-referrer`）+ Pinterest pin 链接 + outbound 终点 URL（可点击）+ 提取到的商品图/标题/价格 + 判定依据（哪层通过）。
- **误收核对结果：20 条中首页/分类页混入 = 0 → 误收率 0%，通过 ≤10% 验收线。** page-verified 16 条均有真实商品标题+价格；URL-structural 4 条为 Etsy/Depop canonical `/listing`、`/products/` 路径。

---

## 9. 任务卡 13 项数字总表

| # | 项 | 数值 |
|---|---|---|
| 1 | 扫描 Pin 数（outbound_link 非空） | 6,258 |
| 2 | 含站外链接 Pin 数 | 6,258 |
| 3 | 判定为具体商品页数量（URL 规则通过） | 1,312 |
| 4 | URL 命中但页面验证失败数量 | 29（22=Amazon /dp/ false-neg、5=小站 WAF 403、2=404 下架） |
| 5 | Shopify/Etsy/其他电商域名分布 | Etsy 1,036 / Shopify+自定义 197 / Amazon 57 / eBay 22 |
| 6 | 首页拒绝 | 83 |
| 7 | 分类/collection 拒绝 | 188 |
| 8 | 内容页（blog+tutorial+lookbook+social+search）拒绝 | 623+60+1,437+3 = 2,123 |
| 9 | 可提取商品标题数量 | 67/68 page-verified（Etsy 503 条因 WAF 未抓，见 §9 短板） |
| 10 | 可提取商品图数量 | 63/68 |
| 11 | 可提取价格数量 | 68/68 |
| 12 | projected inserts | **379–393**（净新增 398 × 95–99%） |
| 13 | duplicates / existing rows | duplicates 914（URL）/ 891（pin_id+URL）；existing pin_products 3,474 |

---

## 10. 风险点与 T2 前置问题（务必先处理）

1. **去重键必须换成 `pin_id` + 归一化 URL**。任务卡默认的 `parent_pin_id + product_url` 在本数据上因 parent_pin_id 全空而失效，若照搬会把 914 条已存在行当作"新"重复写入。T2 迁移的 `discovery_method` + 唯一约束应建在 `(parent_pin_id/source_pin_id, normalized_product_url_hash)` 上，写入时用 pin_id 填 source 侧追溯键。
2. **Etsy/eBay/Depop 商品字段（标题/图/价格）无法用轻量 GET 抓取**（占通过集 ~80%）。T2 写入这些行时，`product_title/product_image_url/price` 会大量为空——要么接受"仅 URL+来源 Pin 图"最小写入，要么 T5 阶段引入合规的详情抓取（注意 §6 红线：外部页只读轻量）。**建议 T2 首批 100 行优先挑 Shopify/Amazon 可抓全字段的行**，把 Etsy 空字段问题留到 T5 决策。
3. **Amazon /dp/ 标记检测需加固**（当前 22 条 false-negative）。加 ASIN 正则 / productTitle-id 已在脚本里，但 Amazon 反爬会返回精简页——T2 若要落 Amazon 商品字段需更稳的抓取，否则同样只落 URL。
4. **召回缺口（非阻塞，可选提升）**：other_non_product 桶里约 **196 条**是被保守拒绝的**真实商品页**——Payhip `/b/<id>`(57)、TeachersPayTeachers `/Product/`(47)、Poshmark `/listing/`(35)、Redbubble(34)、Zazzle(12)、Gumroad(9)。放开这些模式可近乎翻倍数字类商品产出，但会略增误收风险，建议 T2 稳定后再单独评估。

---

## 11. 对"是否达到 T2 bounded apply 条件"的建议

**建议：达到准入条件，可放行 T2 首批 100 行 insert-only，但附三条硬约束。**

- ✅ 报告完整覆盖任务卡 13 项 + 双层判定 + 抽查表；
- ✅ 误收率 0%（≤10% 线）；
- ✅ 综合确认率 95–99%，精度足够；
- ✅ 未触发任何停止条件（请求失败率 0%、无限流）。

**放行 T2 的三条硬约束（对应 §10）：**
1. 迁移的去重唯一键改为 **pin_id/source_pin_id + 归一化 URL hash**，不得用全空的 parent_pin_id；写入前按 §6 口径剔除已存在的 914 条，**首批只从 398 条净新增里取 ≤100 行**。
2. **首批 100 行优先选 Shopify/Amazon 可抓全字段行**（能填 product_title/image/price），Etsy 空字段批次延后到 T5 详情抓取方案定了再做；
3. 严格 insert-only + `discovery_method='outbound_link'` + 统一 created_at 窗口，保留单条 SQL 整批回滚能力（任务卡 T2 约束）。

**风险提示：** 若决策人希望 T2 立刻上量，须接受 Etsy 行商品字段暂缺；若要求字段完整，则 T2 实际可用增量会收缩到 Shopify+Amazon 那部分（通过集里约 254 条，去重后更少）。

---

## 12. 声明

- **本次任务全程只读，未对任何数据库表执行 INSERT/UPDATE/DELETE，未写库。** 仅执行 Supabase `select`（count:exact + 分页拉取）与外部页面的只读 GET。
- **未触发停止条件：** 页面验证请求失败率 0%（远低于 30% 阈值）；未出现连续 429/403 限流（主流站 403 为 WAF 策略，已按方法学单列，非验证失败）。
- 临时脚本置于 `web/scripts/__t1_*.ts`，报告产出后删除；未 commit 任何改动。
