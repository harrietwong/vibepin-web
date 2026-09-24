# VibePin Amazon 联盟营销 MVP 实施方案 v1.0

> 制定：Fable（技术总监/advisor 会话），2026-09-23
> 状态：待用户确认 4 个决策点后启动执行流；Phase 0 只读核对可先行
> 读者：用户 + 各执行会话（worker/部署/ops）

## 0. MVP 目标（用户原话归一）

目标人群：在亚马逊做联盟营销、想把流量阵地扩到 Pinterest 的人。

一条闭环，四步：

```text
批量上传视频
→ 粘贴 Amazon 源链接
→ 生成可在 Pinterest 被搜索到的标题/描述/关键词
→ 排期发布（Pinterest）
```

衡量 MVP 完成的唯一标准：一个真实用户能在 Preview 上完整走完这条链，
排期发布可靠（失败自动重试、结果不重复、不谎报失败）。

## 1. 现状盘点（基于 0923 三份交接 + 实测待核）

| 环节 | 现状 | 结论 |
|---|---|---|
| 批量视频上传 | 已在 `b3661877` Preview（多文件隔离、可追加、封面选择） | 基本完成，需收尾 QA + 3 个候选分支语义 diff |
| Amazon 链接 → 文案 | URL analysis + AI Copy v2 已有框架（0918 FR-03），但无 Amazon 特判、无 PAAPI | **MVP 唯一的新建模块** |
| 排期发布 | Pinterest 原生链路真实在跑（58 条排期 0 overdue），但无自动重试、无 reconciliation worker | 缺"可靠性 P0"（0921 PRD 的 MVP 切片） |
| 验收环境 | Stable Preview 被 Vercel SSO 拦截 | **阻塞一切验收，Phase 0 必修** |

代码基线：一切新工作从 `b3661877`（`codex/three-platform-plan-0922`）开
worktree/分支。主目录 `feat/referral-credits-0904` 有 5000+ 混合改动，
**永久禁止**在其上 `git add .`、全量提交、合并、部署。

## 2. 明确不做（MVP 范围裁剪）

以下不进 MVP，防止滑成"修完所有交接遗留"：

1. 参考图库 / AI 生图闭环（交接 3 整份）——独立线，MVP 后再排。
2. Insights、64 页 UI 全量审查、多语言深化。
3. Instagram / YouTube 排期接入（MVP 只做 Pinterest；YouTube 保持外部发布器）。
4. daily-ten 排期切换（运营决策，见 §6 运营项）。
5. Amazon PAAPI 接入（fast-follow，不进 MVP）。
6. 0921 PRD 的 P1/P2（202+jobId Publish Command API、SSE、运营看板）。

## 3. 决策记录（2026-09-23 用户已拍板 3 项，1 项待研究结果）

| # | 决策 | 结论 | 状态 |
|---|---|---|---|
| D1 | Amazon 商品数据来源 | **抓 metadata + 抓不到时用户手填**（字段全可编辑，ASIN/affiliate tag 从 URL 解析保留）；PAAPI 作 fast-follow，不进 MVP | ✅ 已定 |
| D2 | Affiliate 链接是否直接作 Pin destination URL、披露文案怎么加 | R1 研究已完成（见 §3.1），Fable 建议方案已列出，待用户确认其中的风险认知项 | ⏳ 待用户确认 |
| D3 | MVP 平台范围 | **仅 Pinterest**；且 **Instagram 和 Facebook 先隐藏所有入口**（发布目标选择、Settings Social accounts 等）**以及售价页中的相关内容** | ✅ 已定 |
| D4 | 批量视频 × 批量链接配对 | **每卡一个 Website URL + Bulk actions"对选中卡批量生成文案"**（各卡用自己的链接、独立成败）；**CSV 导入也要支持（用户 2026-09-23 补充，参考 Tailwind 的 Bulk CSV 交互；此条覆盖 0918 PRD Non-Goal §2.2）**，排为 Stream 1 第二阶段，不挡主闭环 | ✅ 已定 |

## 3.1 R1 政策研究结论（2026-09-23，官方原文已核，出处存研究记录）

**官方条文确认的硬约束（直接进 Stream 1 设计）：**

1. **Pinterest 允许 affiliate 链接**，但要求对商业性质透明披露，且"affiliate Pins 要适度、
   遵守 spam 政策"（无官方数字上限；我们自建的限速是产品安全边际，不得对用户宣称是
   Pinterest 规定）。
2. **Pinterest Developer/API Terms 硬性要求：排期发布必须由用户逐条选择每个 Pin**，
   禁止"用户未逐条考虑即自动发起动作"。→ 批量排期 UI 可以做，但**不允许
   "生成 N 条后无人审核自动入队"**；每条 Pin 必须经用户明确选中/确认。
   这条约束我们的工具本身（API 集成方），是 MVP 交互设计的硬边界。
3. **Amazon 明令禁止链接遮蔽和短链**（Program Policies §6(v)/(w)）：Pin destination
   必须是完整 `amazon.com/...?tag=...` 原始链接，禁止 bit.ly/redirect 包装
   （amzn.to 是 Amazon 自家短链，但产品内默认展开为完整链接更稳）。
4. **披露双层要求**：Amazon 要求账号层声明 "As an Amazon Associate I earn from
   qualifying purchases"（用户 Pinterest 简介里放）；FTC + Pinterest 要求**每条 Pin
   内容处**有清晰披露（"#ad" 或 "(paid link)"，仅写 "affiliate link" 不合格）。
   → 产品应默认在生成的描述里自动附加披露标记，并引导用户在简介放 Amazon 声明。

**未决风险（需用户知情确认）：**

5. **Pinterest 不在 Amazon Associates 官方"接受的社交网络"名单上**（名单只有
   Facebook/Instagram/Twitter/YouTube/TikTok/Twitch）。Operating Agreement 的
   "Site" 宽定义可涵盖社媒 UGC，但官方名单未列 Pinterest——这是 Amazon 自己文档里的
   真实模糊地带，不是我们能推断解决的。Tailwind 等 Pinterest 官方合作伙伴公开教
   "Amazon Affiliate on Pinterest" 玩法（旁证可行，非法律确认）。
   → 建议：产品内加一次性风险提示；MVP 照做直链方案，但用户须知悉此模糊性
   （最稳妥的替代是链到用户自己的落地页/独立站再跳 Amazon，MVP 不做）。
6. Amazon 对自动化内容生成工具无明文禁止（§6(s) 禁的是机器人刷点击），
   但也无明文许可——标记为推断项。
7. 文案避免 "Buy Now/Add to Cart" 类结账话术、用 "Find it on Amazon"——
   社区最佳实践（Tailwind 建议），非官方条文，作为文案生成默认风格采纳。

## 4. 执行分工

### Phase 0：解阻塞（并行，本周内）

| 编号 | 任务 | 执行者 | 性质 |
|---|---|---|---|
| P0-1 | docs-only 快照：独立 docs worktree 把 `docs/prd`、`docs/design`、`docs/coordination` 精确提交进 Git（逐路径 stage，**禁 `git add -A`**，提交前后文件数对账——Windows worktree 曾丢 275 个中文路径文件） | worker-sonnet | 低风险 |
| P0-2 | 修复 Stable Preview 的 Vercel SSO / Deployment Protection，验证无痕浏览器 `/api/version` 返回应用 JSON | **部署会话**（用户开；按部署纪律，非部署会话不得改 Vercel 设置） | 高权限 |
| P0-3 | 只读现状实测：① AI Copy v2 两个 flag 在 Preview env 的现值；② URL analysis 端点现状与输入约束；③ publish intent/destination/attempt 现有表结构与状态字段（对照 0921 PRD 数据模型差距）；④ 本地 + （SSO 修复后）Preview 环境真实 fetch 一个 Amazon 商品页，记录响应（200/503/robot check） | Fable 派 Explore/general-purpose 子代理（只读） | 零风险，**可立即先行** |
| R1 | 研究任务：Pinterest affiliate 链接披露要求 + Amazon Associates 现行条款中关于社交平台/链接展示的规定，引用官方原文出处 | Fable 派带联网能力的子代理 | 只读 |

### Stream 1：Amazon 链接 → 文案（MVP 核心新建）

**前置**：D1/D2/D4 拍板 + P0-3 实测结果。设计要点由 Fable 出（见下），实现派 worker-opus。

**P0-3 实测结论（2026-09-23，影响本流设计）：**

- 真正的抓取入口是 `/api/import/product-urls`（`web/src/lib/productUrlImport/urlImportService.ts`：
  原生 fetch、10s 超时、3 跳、2MB 上限、自报身份 UA `VibePin/1.0`）；
  `/api/ai-copy/v2/analyze` 不抓网页，页面上下文全由客户端传入。
- **Amazon 全系域名目前在 `urlSecurity.ts` 的 blocklist 里被硬阻断**——请求根本不发出。
  支持 Amazon 的第一步是把 Amazon 域名从 blocklist 移入受控允许路径（产品决策已由 D1 覆盖），
  不是反爬技术问题。
- 本机实测：有效 ASIN 用浏览器 UA 抓 Amazon 返回 200 + 完整 HTML（代理/直连均可）；
  但 Vercel 数据中心 IP 未测（等 SSO 修复后在 Preview 实测），且现有代码用的是 bot UA。
- **设计立场：不做 UA 伪装/反爬规避。** 保持诚实 UA 抓取，抓不到就走 D1 的手填兜底
  ——这本来就是"默认会失败"的设计前提，也避免 Amazon Conditions of Use 层面的抓取争议。
- AI Copy v2 双 flag 在 Preview 均存在（值部分不可读，`AI_COPY_V2_ENABLED` 是 Sensitive）；
  server flag 关闭时 v2 路由直接 404、无服务端回退，客户端 flag 决定走 v1 还是 v2。

设计边界（Fable 已定，执行不得偏离）：

1. **不建第二套流程**。Amazon 支持 = 现有 URL analysis + AI Copy v2 的扩展：
   Amazon 域名识别、ASIN 解析、affiliate tag（`tag=`、`amzn.to` 短链展开）保留、
   抓取失败的手填降级。复用同一 Create AI version 抽屉 / Setup / 额度 / 占位卡（0918 AC-09）。
2. 文案生成走 AI Copy v2 的诚实关键词规则：`trend_keywords` 才算需求信号，
   无可靠关键词时进 `no_keyword_demand_data`，仍按商品事实生成。
   **禁止伪造搜索量**——这是产品差异化，不是限制。
3. 抓取失败不扣生成额度、不清空用户已填字段（0918 §4.5）。
4. 输出字段：Title（Pinterest 长度约束）、Description、Alt text、
   Recommended keywords（标来源）、Board 建议；destination URL 按 D2 结论处理。
5. Bulk actions "批量生成文案"：逐卡独立任务、独立失败、不覆盖 `userTouched=true` 字段。
6. **第二阶段：CSV 批量导入**（用户已确认要做，参考 Tailwind Bulk CSV 交互）：
   CSV 列建议 `media 文件名或已上传媒体标识, Amazon URL, 标题(可空), 描述(可空), Board(可空), 排期时间(可空)`；
   导入 = 对已上传视频卡批量回填字段 + 触发批量文案生成，空字段由 AI 补齐。
   带预检报告（行级错误、文件名未匹配、URL 非法），错误行跳过不阻断整批。
   在每卡流程验收通过后启动，不与主闭环并行抢同一批文件。

### Stream 1.5：隐藏 IG/Facebook 入口与售价页内容（D3 决策产物）

**✅ 已完成（2026-09-23，Fable 独立复核通过）**：分支 `feat/hide-igfb-mvp-0923`
（基 b3661877，5 个 commit：761db3ca → 7f3cc26b，未 push）。

- 单一开关 `NEXT_PUBLIC_HIDE_IG_FB`（严格 === "true"，默认关=行为不变），共享 helper
  `web/src/lib/social/visibleProviders.ts`，带 keep 语义（已连接账号/已排 IG 的 Pin
  不被静默隐藏，只挡新入口）。
- 覆盖：发布目标选择（单卡/批量/抽屉/排期共用组件一处收口）、Settings Social
  accounts、默认目标选择器、Pricing 图标行、套餐 bullet/比较表行/FAQ/CTA 文案
  （9 个 `.pinterestOnly` i18n 变体 key × 18 语言，validate:i18n 通过）、
  pricing SEO metadata（generateMetadata 双变体）、顶层 /dashboard /settings
  遗留孤岛页的 Instagram 入口。
- 有意不隐藏：已排期条目渠道徽章（事实记录非入口）、Facebook 数据删除合规页。
- **部署注意**：Preview 部署时需在 Vercel env 设 `NEXT_PUBLIC_HIDE_IG_FB=true`
  才生效（客户端 flag，构建期内联）。
- **验证状态（诚实口径）**：已实现 + 静态验证通过（tsc、validate:i18n、
  Fable 对动态 key 做过反向交叉核对：pricingPlans 全部 9 处 IG/FB 源串位置均有
  对应变体或结构过滤，未加变体的 footnote.extraAccounts 源串确实不含平台名）。
  **缺 flag-on 真实渲染冒烟**——`as never` 绕过了 tsc 的 key 校验、validate:i18n
  不校验代码引用，必须在 Preview（或本地 dev flag-on）实际打开 /pricing、landing、
  Studio、Settings 各看一遍才算验收完成。

### Stream 2：发布可靠性 P0（0921 PRD 的 MVP 切片，不做全量）

**前置**：Fable 审完技术设计（迁移 SQL + 状态机改动）再动工。实现派 worker-opus。

**P0-3 实测结论（影响本流工作量与设计）：**

- 当前**完全没有自动重试**（无 next_attempt_at/max_attempts/retry_class，无重试 worker；
  v73 的 retry lineage 只是手动重试血缘）。
- **完全没有自动 reconciliation**：`/api/publish/reconcile` 是用户手动触发的只读聚合，
  不查 provider、不回写。
- 0921 PRD 的 17 个新字段：1 个精确存在（claim_token）、5 个语义近似但名称不同
  （status↔publish_state、attempt↔attempt_no、lease_expires_at↔claim_expires_at、
  provider_status↔last_provider_status 等，**设计时按复用现有列处理，不改名不建重复列**）、
  11 个真缺失。
- 结论：**本流按"新建"估工作量，不是"增强"**。
- 迁移取号：实测当前最大号 **v81**（文件系统全量扫），下一个安全空号 **v82**；
  v71 曾发生撞号（两个不同文件同号），实施时必须再全量扫一次确认。
- cron 调度不在仓库内（web/vercel.json 无 crons 段）；publish-due 由 VPS crontab 每 5 分钟
  触发（见记忆 project_auto_publish_verified_20260810），重试/对账 worker 的触发方式
  设计时需明确（建议复用同一 VPS crontab 通道）。

只做 0921 PRD 自标的 P0：

1. 数据库迁移：`publish_intent_destinations` 增 attempt/retry/reconcile 字段，
   attempt 上限 5 的 check constraint，claim 唯一性。
   **取号必须按迁移取号陷阱流程全量扫 worktree**（交接已出现 v76/v78/v80/v81，
   记忆里的 v69 已过时；先 `git ls-files` + 扫 `D:/wt/*`、`D:/vp-worktrees/*`、`D:/代码/wt-*`）。
2. 可安全重试的退避调度（1/5/15/60 分钟 + jitter，尊重 Retry-After）。
3. 第 5 次前抑制客户可见的最终失败通知；`terminal_notified_at` 去重。
4. `delivery_unknown` → reconciliation（先查 media/recent pins 再决定 retry），禁止盲目重发。
5. cron timeout 核验 + schema capability check（缺迁移时 fail closed）。

**不做**（P1/P2）：Publish Command API 202+jobId、SSE、图片上传队列重构、运营看板。
现有 cron 链路实际在跑，MVP 缺的是"失败自动重试 + unknown 先核对"，不是重写。

测试门槛（上线 Preview 前）：mock provider 回归全过（429/5xx/断连/成功无 ID/
settlement 崩溃/并发 claim/第 6 次 attempt 被数据库拒绝），测试库先行。

### Stream 3：批量上传收尾（读式审查 → 最小补丁）

语义 diff 已完成（2026-09-23），**Fable 裁决如下**：

1. `d9f460b2` 竖版视频 full-range 修复：**基线真缺失，实施新写最小补丁**（~30-40 行，
   3 个文件：portrait filter 加 `in_range=auto:out_range=tv`、抽出
   `buildCompatibilityNormalizeCommand` 用于普通规范化路径、移植 2 个测试断言）。
   **不可 cherry-pick**（父提交早于 9f97c098 的重构）。附带已知问题：ffmpeg 输出按
   sha256 缓存且 `needsVideoNormalization` 只查 pix_fmt 不查 range——已用旧代码规范化
   过的视频修复后不会自动重处理，需清缓存目录或输出路径加版本。
2. `566c123d` placeholder 兜底：5 个 patch 中 4 个已被基线覆盖或在自身世系内作废，
   仅剩 `page.tsx` 资产匹配未用 `canonicalMediaUrl` 归一（~3 行 + import，元数据级影响）。
   **随手补上**。
3. `e58a18b0` canvas 像素启发式拒绝 placeholder：**不采纳**。基线 `failureMedia.ts`
   文档明确拒绝该类技术（避免误杀纯色商品图），改用 provenance 标记方案。
   残余缺口（大尺寸近单色 data URL 无 provenance 标记时会渲染）作为已知取舍记录，
   如未来要补走 provenance 扩展路线，不走 canvas 采样。

**实施状态（2026-09-23）**：裁决 1、2 已实现并通过 Fable 独立复核：
分支 `fix/vertical-fullrange-0923`（基 b3661877），commit `33a691aa`（range 修复，
portrait filter + buildCompatibilityNormalizeCommand + yuvj420p 测试夹具）与
`81505873`（canonicalMediaUrl 归一比较）。测试由 Fable 独立复跑通过；
tsc 仅剩一个与本改动无关的既有错误（.superpowers 下 pglite 模块缺失）。
未 push、未部署，待合入集成分支。

⚠️ 运维遗留：ffmpeg 输出缓存目录 `D:/vp-tmp/publish-prep/normalized` 中
修复前生成的产物（9/18、9/20、9/22）不会被新代码自动重处理
（portrait 门只查宽高、compatibility 门查不出"标了 yuv420p 但值域是 full-range"）。
下次用该脚本发新批次前，需清理该目录强制按修复后命令重新生成；
已发布的旧 Pin 不动。

剩余任务：批量上传真实 QA（多文件并发、上传中追加、单文件失败隔离、封面持久化），
等 Preview SSO 修复后在 Preview 上做。

### Stream 4：UI（审 Codex 产出，不阻塞 MVP）

Codex 会话（`codex://threads/01a0b414-...`）在出 UI。Fable 打不开 codex:// 链接——
**需要用户把 Codex 的 UI 产出（代码分支/截图/HTML）落到 `docs/design/` 或贴进会话**。
Fable 对照 0918 PRD + `VIBEPIN_DESIGN_SYSTEM.md` + `AGENT_UI_CHECKLIST.md` 审查。
用户已明确：Codex 产出不一定对，以 Fable 审查结论为准。UI 改版不阻塞 Stream 1/2。

## 5. 汇合与验收

1. 集成分支：`integrate/amazon-mvp-0923`，从 `b3661877` 开独立 worktree。
   各 Stream 完成后由 Fable 审查再合入，不允许各自直接部署。
2. 验收顺序：clean worktree 门禁（tsc/测试）→ Preview 部署（部署会话执行）→
   MVP 闭环端到端人工验收（真实批量视频 + 真实 Amazon 链接 + 排期 + 到点发布 + 失败重试演练）。
3. 完成定义：闭环全绿 + Stream 2 mock 回归全过 + 无重复 Pin + Fable 终审
   （必要时 Codex 二审，结论以 Fable 为准）。
4. Production 仍未授权，不 promote。

## 6. MVP 外的紧急运营项（不占执行流，提醒用户单开 ops 会话）

1. **Grinch YouTube 仍有 10 条未来排期**（交接 2 §1.1）：需用带 `youtube.force-ssl`
   的 token 或 YouTube Studio 取消；已公开视频不删。
2. daily-ten 是否切换：等用户决策；YouTube receipt 缺失时禁 `--apply`。

## 7. 执行纪律（所有会话）

1. 基线 `b3661877`，主脏目录不动；每流独立 worktree。
2. 交接文档的"已实现/未实现"断言必须实测再信（P0-3 就是干这个的）。
3. worker 连续两次修复失败 → 停手回报 Fable 裁决。
4. 写库前打印 project ref 断言 ≠ `jaxteelkecvlozdrdoog`（生产）；一切测试走测试库。
5. 部署动作只归部署会话；非部署会话只 push 分支 + 汇报。
6. 每流交付物 = 结论 + 验证证据（命令输出），不带中间过程回主对话。

## 8. 各执行会话启动指令（用户可直接复制开会话）

### 部署会话（P0-2）

```text
你是 VibePin 部署会话。任务：修复 Stable Preview（vibepin-fb-preview.vercel.app）
被 Vercel SSO 拦截的问题（Deployment Protection / alias 配置）。
验收：无 Vercel Session 的无痕浏览器访问 /api/version 返回
buildSha=b3661877... 的应用 JSON，而不是 Vercel 登录页。
只改 Preview 保护设置，不动 Production，不 promote，不重部署其他分支。
完成后回报最终 Host、状态码、重定向链。
背景见 D:\代码\Pinterest flow\docs\coordination\0923-VibePin-Amazon联盟MVP实施方案-v1.0.md §4。
```

### docs 快照会话（P0-1，或由 Fable 派 worker-sonnet）

```text
任务：docs-only 快照提交。从 b3661877 新建 worktree（或独立 docs 分支），
将 D:\代码\Pinterest flow 主目录下 docs/prd、docs/design、docs/coordination
的未跟踪文档复制进去并提交。硬规则：逐路径 stage，禁止 git add -A / commit -a；
复制前后统计文件数并对账（Windows 曾丢中文/长路径文件）；提交后 git ls-tree 核对
文件数一致；输出文件清单。不动主目录任何文件。
```

### Stream 2 会话（发布可靠性，D 决策后启动）

```text
你是 VibePin 发布可靠性执行会话（worker-opus 级）。从 b3661877 开
worktree 实施 0921 统一发布队列 PRD 的 P0 切片（仅 P0，范围见
docs/coordination/0923-VibePin-Amazon联盟MVP实施方案-v1.0.md §4 Stream 2）。
先出技术设计（迁移 SQL + 状态机 + claim 语义）交 Fable 审，批准后再写代码。
迁移取号前全量扫 worktree。一切测试走测试库 snulmwprsahzqvdbyenc。
两次修复失败停手回报。
```

（Stream 1 / Stream 3 由 Fable 在本会话直接派子代理，不需用户单开。）
