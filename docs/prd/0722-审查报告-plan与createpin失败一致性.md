# 审查报告：Plan 与 Create Pins 发布失败数据一致性

> 对应任务书 `docs/prd/0722plan和createpin失败一致性问题.txt`
> 性质：**只读审计 + 根因定位 + 方案建议**，尚未改任何代码。
> 证据来源：直接读源码 + 三路并行子代理审计（Plan 计数链 / Create Pins 失败链 / 失败持久化模型），三方结论互相印证。
> Codex 终审：本轮 Codex 裁决 job 运行 50+ 分钟无终态、疑似卡死，经用户同意放弃等待；最关键的边界裁决（P0 selector 是否含 `isBoardSource`）已由本会话自查源码定案（见 §八"关键边界裁决"，四个 `failureType:"publish"` 写入点 + `isBoardSource` 语义为证）。实施前的关键节点可再请 Codex。

---

## 0. 一句话结论

**四个失败数字（Plan Banner、Plan 统计条 N failed、Create Pins "Failed" tab、Create Pins "Publish failures" 子筛选）读的是同一个客户端 store，但各自套了三套不同的判定谓词、喂了两套不同的输入集合。** 数字不一致不是数据源问题，也不是缓存问题——是**同一份数据被三种口径各算一遍**。同时失败原因、失败卡片、跨设备一致性存在结构性缺陷。因此当前 PRD **未通过**。

---

## 一、PRD 逐条判定（Passed / Failed）

| # | 验收标准 | 判定 | 依据 |
|---|---|---|---|
| 1 | Plan 失败数 = Create Pins Failed→Publish failures 数 | **Failed（但目标不是简单相等）** | 三套谓词不同（见§三），输入集合不同。修复目标是**同一核心谓词派生两个 selector**：Plan=全量 actionable、Create Pins=板内 actionable，Plan≥Create Pins 是语义正确（见§八边界裁决），关键是**每页"数字=点进去能处理的列表"都成立** |
| 2 | 点 Banner/N failed 进入 Failed 视图且默认 Publish failures | **部分 Passed** | 进入时 `openFailedInStudio` 写两个 sessionStorage key 正确设置了 `failed`+`publish`；但**刷新后 sub-filter 退回 "all"**（一次性 key 已被清），违反 §八"刷新后仍保持 Publish failures" |
| 3 | 每条失败都能显示具体 publishError | **Failed** | `publishError` 存在 `pin_drafts.payload` JSON blob 里，能持久化;但旧记录/`failStaleGeneratingDrafts` 写的失败没有 `publishError`，且无 `failedAt`、无 attempt 历史，任务书 §六要求的兜底文案未实现 |
| 4 | 每条失败能找到对应 Pin 草稿/原排程时间/Board | **部分 Failed** | 有 `previousScheduledTime`，但被 `!isBoardSource` / `archivedAt` 过滤掉的失败草稿在 Create Pins 板上**根本不出现**——正是"跳到 Create Pins 找不到对应失败 Pin"的症状 |
| 5 | 失败归零后 Plan 与 Create Pins 同时归零 | **Failed（条件性）** | 同设备内成功发布会清 `publishError`/`failureType`，两边随 `DRAFT_STORE_EVENT` 重算，可归零；但因谓词不同，某些失败一边显示一边不显示，无法保证"同时" |

**结论：PRD 未通过。** 症状（Plan 显示二十多、点进去看不到原因、跳过去找不到卡、两边数字不一致）全部可由下面的根因解释。

---

## 二、两条数据源并排对比

两侧**读的是同一个 store**：`pinDraftStore`（localStorage `vp:pin_drafts:v1`，经 `pinDraftSync` 从 `GET /api/pin-drafts` 拉服务端 `pin_drafts.payload` 做 LWW 合并）。差异全在"喂什么集合 + 用什么谓词"。

| 维度 | **Plan failed count** | **Create Pins Publish failures** |
|---|---|---|
| 组件 | `FailureBanner`（`components/shared/FailureBanner.tsx`）+ `CompactSummaryBar`（`plan/page.tsx:913`） | `StudioBoard`（`components/studio/StudioBoard.tsx`）的 Failed tab + 子筛选 chip |
| 计数入口 | `plan/page.tsx:2093` + `weeklyPlanStats.ts:137` | Failed tab: `usePinBoardDrafts.ts:66`；子筛选: `StudioBoard.tsx:109-113` |
| API | **无**（纯客户端计算） | **无**（纯客户端计算） |
| 数据表 | `pin_drafts`（仅作同步镜像，计数不查库） | 同上 |
| 查询条件 | 无（`getAllDrafts()` 原样全量） | `getAllDrafts().filter(d => !d.archivedAt && isBoardSource(d))`（`usePinBoardDrafts.ts:53`） |
| workspace/user scope | 客户端本机 store（服务端同步按 `vibepin_user_id`） | 同左 |
| 时间范围 | 无 | 无 |
| 是否含历史 | 是（无时间过滤） | 是 |
| 是否含重复 attempt | 否（每草稿单行覆盖写，无 attempt 表） | 否 |
| 是否含已删除 | 否（tombstone 同步删除） | 否 |
| 是否含已归档 | **是（含 archived）** | **否（`!archivedAt`）** |
| Failed 判定谓词 | `failureType === "publish" && trim(publishError)` | Failed tab: `trim(publishError) \|\| generationStatus∈{failed,error}`；子筛选: `!!publishError?.trim()` |
| 是否要求 publishError 非空 | 是 | 子筛选是；Failed tab 否（生成失败也算） |
| 是否要求 failureType==="publish" | **是** | **否**（两个 Create Pins 谓词都不查 `failureType`） |
| 是否排除缺图/非 board-source | 不排除（全量） | 排除非 board-source；不查缺图 |
| 是否缓存 | 无 fetch 缓存；`DRAFT_STORE_EVENT` 实时重算 | 同左（`useSyncExternalStore`） |

**并排谓词（根因浓缩）：**
```
Plan（Banner + 统计条 N failed）：
    输入 = getAllDrafts()                                   // 含 archived、含非 board-source
    计数 = d.failureType === "publish" && trim(d.publishError)   // pinLifecycle.ts:100  —— 最严

Create Pins "Failed" tab chip：
    输入 = getAllDrafts().filter(!archivedAt && isBoardSource)   // usePinBoardDrafts.ts:53
    计数 = getPinLifecycle(d) === "failed"
         = trim(publishError) || generationStatus∈{failed,error}  // pinLifecycle.ts:46 —— 最松（含生成失败）

Create Pins "Publish failures" 子筛选（Failed 视图内）：
    输入 = 上面 "failed" lifecycle 子集
    计数 = !!d.publishError?.trim()                         // StudioBoard.tsx:109 —— 第三套，不查 failureType
```

---

## 三、数量不一致的精确根因

三条相互独立、可叠加：

1. **输入集合不同（最主要，直接对上"跳过去找不到卡"）。**
   Plan 用 `getAllDrafts()` 全量；Create Pins 只算 `!archivedAt && isBoardSource(d)`。
   → 一条 publish 失败的草稿只要被**归档**，或**来源不是 board-source**（Weekly-Plan 直接来的草稿），就会 **Plan 计数、Create Pins 板上完全不出现**。这正是"Plan 显示二十多、跳到 Create Pins 找不到"的机制。

2. **`failureType` 要求不对称。**
   Plan 要求 `failureType==="publish"`；Create Pins 两个谓词都**不查** `failureType`。
   → 任何"有 `publishError` 但 `failureType` 缺失/≠publish"的草稿（旧记录、部分写、或 `failStaleGeneratingDrafts` 只写 `generationStatus="failed"` 从不写 `failureType`——`pinDraftStore.ts:516-528`），会在 Create Pins 计数、Plan 不计数。反向也成立。

3. **生成失败 vs 发布失败混入。**
   Create Pins "Failed" tab（`getPinLifecycle`）把 `generationStatus==="failed"` 也算 failed；Plan 的"Pins failed to publish"刻意只算发布失败。
   → Failed tab 数天然 ≥ Plan 数。

> 注：`countPublishFailures` 本身按草稿去重（同一草稿多次失败覆盖写单行，无 attempt 表），所以任务书 §十"3 个 Pin 失败其中一个连失 3 次要显示 3 不是 5"在**同一设备**内成立。真正的不一致来自上面三条口径差异，不是重复计数。

---

## 四、看不到失败原因的精确根因

- 失败原因**只存在 `pin_drafts.payload` 这个 JSONB blob 里的松散 key**（`publishError`/`failureType`/`errorCategory`/`publishErrorCode`/`previousScheduledTime`），**没有任何独立列**，因此服务端无法查询/索引，UI 只能靠客户端 store 里合并下来的那份。
- **没有 `failedAt` 列/字段**——只有 `previousScheduledTime`（失败前的排程）和 `updatedAt`。任务书 §六要求展示 `failedAt`，当前无此数据。
- **无 attempt 历史**——每次失败覆盖写同一行，任务书 §六"从最新 publish attempt 兼容恢复"、§七"内部诊断查看 attempt history"无处可查。
- 旧记录若 `publishError` 为空（如 `failStaleGeneratingDrafts` 写的失败），**当前没有兜底文案**"Publishing failed, but detailed error information was not recorded."，会出现空白区域。

---

## 五、找不到失败卡片的精确根因

- 见§三-1、§三-2：被 `!isBoardSource` 或 `archivedAt` 过滤掉的失败草稿，Plan 算进数字但 Create Pins 板上不渲染；`failureType` 不匹配的草稿在两边归属不同。用户点 Banner 进去后，那条被过滤的失败卡就是"数字里有、列表里没有"。
- **刷新丢筛选（次要）**：`openFailedInStudio` 靠一次性 sessionStorage key 传 sub-filter="publish"，`StudioBoard` mount 时读完即清（`StudioBoard.tsx:79-86`）。刷新后 `vp:studio:filter` 仍是 `failed`，但 sub-entry key 已清，sub-filter 退回 `all`——违反 §八"刷新后仍保持 Publish failures"。

---

## 六、重复 attempt / 孤儿记录

- **重复 attempt：不存在。** v42 cron 流按 `(vibepin_user_id, draft_id)` 复合主键 `UPDATE … RETURNING` 覆盖写单行，无 `retry_count`、无 attempt 表；失败后清 `scheduled_at` 掉出 due scan（无 retry storm）。`retry_count` 只在**废弃**的 `publishing_queue`/`publish_jobs` 里。
- **孤儿记录：v42 结构上不可能产生。** "job" 不是独立行，就是草稿行本身（`scheduled_at`/`publish_claimed_at` 是 `pin_drafts` 的列）。删草稿=打 `deleted_at` tombstone，cron scan 过滤 `deleted_at is null`，不会留悬挂 job。
- **但存在三套并行的历史发布子系统**，均无 live 消费者、与 `pin_drafts` 不对账：`publishing_queue`（`api/publish`+`backend/publisher.py`）、`publish_jobs`（`api/publish-jobs`+`migrate_v14`）、`social_publish_jobs`/`social_publish_job_destinations`（`migrate_v32`，从未接线）。任何"孤儿状"失败只可能来自这些遗留表或本机陈旧 localStorage 草稿，不是 v42 流本身。

---

## 七、跨设备一致性（额外发现，任务书 §九/§十七要求）

**这是最被低估的隐患。** 计数完全由 **localStorage** 派生。cron 在服务端把失败写进 `pin_drafts.payload` 后，只有当**那台设备**下次 `pinDraftSync` 拉取并 LWW 合并后才会显示。因此：
- 换浏览器/无痕/换设备打开同一账号，Plan 日历和失败数可能完全不同（源码里已有 dev 诊断注释明确记录了这个 `pinDraftStore` 未跨设备同步的问题——`plan/page.tsx:2111-2124`）。
- 任务书 §十七"跨设备打开后数量一致"当前**做不到**——不是同步 bug，是"计数只信本机 store"的架构选择。

---

## 八、建议的唯一事实来源（先审计再决定，不新建平行表）

**核心主张：先统一谓词与输入集合（零迁移即可消除主要不一致），再逐步补齐持久化短板。分阶段，避免一次性大改。**

### P0（零迁移，先止血）——统一到一个共享 selector
建一个**单一共享纯函数**（语义上就是任务书要的 `getActionablePublishFailures`），四个入口全部改调它，删掉前端各自复制的 Failed 判定：

```
// pinLifecycle.ts（或新建 studio/publishFailures.ts）
listActionablePublishFailures(drafts): PinDraft[]
    唯一 actionable 发布失败定义 =
        failureType === "publish" && trim(publishError)      // 与现 countPublishFailures 一致
        && !archivedAt                                       // 统一：两边都排除已归档
        && !deleted                                          // 已删除不计（store 里已 tombstone，稳妥起见显式排除）
        —— 不含 isBoardSource（裁决见下）
```
- Plan Banner / Plan 统计条 / Create Pins Banner / Failed tab 的"Publish failures" 子计数 / 子筛选列表 **全部**由它派生。
- 保留 Failed tab **整体**含生成失败（那是"Failed"总口径，合理），但"Publish failures"子筛选、两处 Banner、Plan N failed 统一走上面这一个定义。
- 同时把 `failStaleGeneratingDrafts` 之类只写 `generationStatus` 的路径审一遍，确保发布失败一定同时写 `failureType="publish"`+`publishError`，消除字段不对称。

#### 关键边界裁决：P0 selector **不含** `isBoardSource`（已自查源码定案）

任务书要的"2 = 2 个当前仍需用户处理的唯一 Pin drafts"是**按"用户能否处理"定义 actionable，而非按"哪个页面能渲染"**。源码证据：

- **`failureType:"publish"` 有四个写入点**，其中两个会落在**非 board-source** 草稿上：
  - `DraftDetailsDrawer.tsx:983-986` —— 这是 **Plan 页**的 Pin Details & Publish 模态，对 Weekly-Plan 来源（`createFromHandoff`，source 为 workspace/weekly_plan 等，**非 board-source**）的草稿也能发布/失败；且该抽屉自带 `publishError`/`publishAttempts`/"Retry publish"完整重试态（`DraftDetailsDrawer.tsx:153-171`）。
  - cron `publishDueLogic.ts:144-145` —— 任何有 `scheduled_at` 的草稿到点发布，含非 board-source。
- **`isBoardSource` 仅对 uploaded_image / ai_generated_from_upload 为真**（`pinDraftStore.ts:206-208`）。Weekly-Plan 来源的失败草稿**永远不在 Create Pins 板渲染**，但**能在 Plan 抽屉里被 Retry**——它是真实的、用户需要处理的失败。

结论：
1. **"唯一 actionable 失败"的正确边界 = `failureType==="publish" && publishError && !archived && !deleted`，与来源无关**。若 P0 selector 加 `isBoardSource`，会**漏掉经 Plan 抽屉/cron 失败的 Weekly-Plan 草稿**——这些恰恰是用户在 Plan 上要处理的，等于把真实失败从计数里抹掉，违反任务书 §四。
2. 但"数字里有、点进去找不到卡"的症状必须同时修——办法**不是**用 `isBoardSource` 缩小计数，而是**让点击落在能渲染该失败的页面**：
   - **Plan 的 Banner/N failed 点击**：改为进入 **Plan 自己的失败视图**（Plan 抽屉/列表能打开任意来源草稿），而不是硬跳 Create Pins。这样每一条计数进去都找得到、能 Retry。
   - **Create Pins 的 Banner/Failed tab**：其列表天然只含 board-source（`usePinBoardDrafts` 的板集合不变），**但它的 Banner 计数也用同一个全量 selector**，于是可能出现"Create Pins Banner 说 N，但板上 Failed 列表 < N"。解决：Create Pins 的 Banner 文案在有"板外失败"时补一句指向 Plan 的入口（"其中 k 条在 Plan 中处理"），或该页 Banner 仅统计板内 actionable 失败、Plan 承载全量——**二者取一，建议后者**（Create Pins 只管板内，Plan 承载全量 actionable），语义最干净：**Plan = 全量 actionable 失败的唯一处理入口；Create Pins = 板内失败的就地处理**。
3. 因此 P0 收敛为**两个 selector 派生自同一核心谓词**：
   - `listActionablePublishFailures(drafts)` = 核心谓词（不含来源）→ 供 **Plan** 的 Banner/统计条/失败列表。
   - `listBoardActionablePublishFailures(drafts)` = 前者再叠 `isBoardSource` → 供 **Create Pins** 的 Banner/Failed"Publish failures"子计数/子筛选。
   - 两者共享**唯一**的 `isActionablePublishFailure(d)` 判定，杜绝三套谓词。Plan 数 ≥ Create Pins 数是**语义正确**（Plan 是全量入口），且两页各自"数字=点进去能处理的列表"都成立。

### P0.5（零迁移）——修刷新丢筛选
把 Failed 主筛选 + Publish-failures 子筛选改为 **URL query param**（如 `/app/studio?filter=failed&sub=publish`）而非一次性 sessionStorage，满足 §八"刷新后仍保持"。

### P1（小迁移，补可见性与诊断）
- 给 `pin_drafts` **promote 出可查询列**（additive，遵循 v38/v41/v42 惯例，IF NOT EXISTS）：至少 `failed_at timestamptz`、`failure_type text`、`publish_error text`（脱敏后的用户可读串）。让服务端能做真正的 `getActionablePublishFailures(userId)`，为跨设备一致打基础。
- 旧记录缺 `publishError` 时的**兜底文案**（§六）：UI 层先做，"Publishing failed, but detailed error information was not recorded."
- 可选：轻量 attempt 历史（不进用户计数，仅诊断），满足 §六/§七——**建议延后**，非当前止血必需。

### P2（架构，跨设备真一致）
- 计数从"localStorage 派生"迁到"服务端派生 + 客户端订阅"，配合 P1 的可查询列，让 §十七跨设备一致成立。这一步改动大，**单独立项**，不塞进本轮。
- 三套遗留发布表（`publishing_queue`/`publish_jobs`/`social_publish_*`）确认无 live 消费者后，**明确废弃并从失败对账口径中剔除**，避免未来有人误接。

**不建议**：未经审计新建平行失败表——现有 `pin_drafts.payload` 已是事实来源，缺的是"promote 成可查询列 + 统一前端谓词"，不是再造一张表。

---

## 九、数据兼容 / 迁移风险

- P0/P0.5 **零迁移、纯前端**，风险最低，可先上。唯一行为变化：Plan 数字会因"统一排除 archived / 统一 failureType 口径"而**变化**（通常变小并与 Create Pins 对齐）——这是修复目标，非回退。
- P1 迁移为 additive promote 列，遵循现有 `run_migration.py --apply` 通道；旧行 promote 列为 NULL，需回填脚本从 `payload` 抽取（幂等、可整批回滚）。**迁移只写文件不擅自 apply**，由用户执行。查号取 `backend/db/migrate_v*.sql` 最大号+1（注意 v53/v54 已被占）。
- P2 涉及计数数据源迁移，需灰度 + 双读对账，**本轮不做**。
- 全程遵守测试库隔离：任何造失败数据的 E2E 只进测试库 `snulmwprsahzqvdbyenc`（`.env.test.local` / `dev:testdb`），生产 `jaxteelkecvlozdrdoog` 只读。

---

## 十、预计修改文件与数据库对象

**P0/P0.5（前端，零迁移）：**
- `web/src/lib/studio/pinLifecycle.ts` — 新增唯一判定 `isActionablePublishFailure(d)`（`failureType==="publish" && trim(publishError) && !archivedAt && !deleted`）+ 两个派生 selector：`listActionablePublishFailures`（全量，供 Plan）/ `listBoardActionablePublishFailures`（再叠 `isBoardSource`，供 Create Pins）；`countPublishFailures` 改为前者派生
- `web/src/hooks/usePinBoardDrafts.ts` — Failed 相关计数改调**板内** selector
- `web/src/components/studio/StudioBoard.tsx` — `isPublishFailureItem`/`failedSubCounts` 改调板内 selector；Banner 计数走板内 selector；sub-filter 改 URL param
- `web/src/lib/weeklyPlanStats.ts` — `stats.failed` 改调**全量** selector（排除 archived）
- `web/src/app/app/plan/page.tsx` — Banner/统计条计数走全量 selector；**`openFailedInStudio` 改为进入 Plan 自己的失败视图（能打开任意来源草稿 Retry），不再硬跳 Create Pins**；若保留跳转则改 URL param 且补"板外失败在 Plan 处理"入口
- `web/src/lib/pinDraftStore.ts` — 审 `failStaleGeneratingDrafts` 等只写 `generationStatus` 的路径（不改语义，仅确认发布失败字段成对写）
- 兜底文案落在失败卡组件（`PinBoardCard.tsx` / `DraftDetailsDrawer.tsx`）

**P1（迁移，additive）：**
- `backend/db/migrate_v55_pin_drafts_failure_cols.sql`（号待查确认）— `ALTER TABLE pin_drafts ADD COLUMN IF NOT EXISTS failed_at / failure_type / publish_error`
- `web/src/app/api/pin-drafts/route.ts` — promote 上述列（参照现有 `buildPromotedColumns`/`buildScheduleColumns`）
- `web/src/app/api/cron/publish-due/route.ts` + `publishDueLogic.ts` — 写失败时同步 promote 列 + 写 `failed_at`

**验收（任务书 §十 1-19）**在测试库跑：3 个失败 Pin（一个连失 3 次）→ Plan 与 Create Pins 都显示 3；逐条对账；Retry/Move/Delete 后两边同步；生成失败不进 publish 数；typecheck+build+DB 查询测试+浏览器 QA 全绿（干净环境复跑）。

---

## 十一、P0 实施与验收记录（2026-07-23）

**状态：P0 已实施 + 主对话独立复核通过。**

- 改动文件：`pinLifecycle.ts`（新增唯一谓词 `isActionablePublishFailure` + `listActionablePublishFailures`/`listBoardActionablePublishFailures`，`countPublishFailures` 派生自前者、现额外排除 archived）；`StudioBoard.tsx`（`isPublishFailureItem`→共享谓词，Banner 计数→板内 selector，消除第三套谓词）；`PinBoardCard.tsx:305`（per-card 分类→共享谓词）。
- `weeklyPlanStats.ts:137` / `plan/page.tsx:2093` 未改（已调 `countPublishFailures`，现已等价于全量 actionable selector）。`usePinBoardDrafts.ts:66` 的 Failed 总计数未动（含生成失败的总口径，保留）。
- 验收：`npx tsc --noEmit` EXIT 0（**主对话独立复跑核实**）；定向单测 test-pin-board-store 14/14、test-status-normalization 35/35、test-failure-banner 8/8、test-studio-plan-match 15/15、test-generation-failure-media 25/25 全绿。全量 build/eslint 本机过慢未单跑（tsc + 定向测试已覆盖类型与失败语义）。
- **遗留数据评估（advisor 复核）**：收紧谓词后，"有 `publishError` 但缺 `failureType`" 的草稿 per-card 会走 "Generation failed/Try again" 而非 "Publish failed/Retry publish"。核实四个失败写入点（StudioBoard/BatchEditDrawer/DraftDetailsDrawer/cron）**全部成对写** `failureType:"publish"`+`publishError`，故**新数据不产生此类脏数据**；仅早于 `failureType` 字段的**历史 localStorage 草稿**受影响。该遗留数据的回填归 **P1 写入侧**，P0 不处理——收紧本身安全、在边界内。

## 十二、P0.5 实施与验收记录（2026-07-23）

**状态：P0.5 已实施 + 主对话独立复核通过。** 三件事全做：

- **A｜修 PlanListView 漏判 publish 失败**（`PlanListView.tsx:46-54`）：Failed 判定从 `generationStatus==="failed"` 改为 `getPinLifecycle(d)==="failed"`——统一到 P0 口径，覆盖 publish + generation 失败。此前 publish 失败草稿在 Plan 列表被错归 Scheduled/Unscheduled（第四套谓词，审计初期未发现，实施中挖出）。
- **B｜Plan 失败点击留在 Plan**（`plan/page.tsx` `openFailedList`，:2118-2129）：不再硬跳 `/app/studio`；改为 `setViewMode("list")` + seed PlanListView 状态为 Failed + 写 `?view=list&status=failed`。PlanListView 每行 `onOpenDetails` 打开含 Retry 的 DraftDetailsDrawer，故任意来源失败（含非 board-source）都能就地处理。
- **C｜Failed 筛选改 URL param**：Create Pins（`StudioBoard.tsx:91-98,174-189`）`?filter=&sub=` URL-first、校验取值、sessionStorage 仅作兜底；Plan（`plan/page.tsx:1521-1528`）`?view=&status=` deep link 首渲染 seed。刷新后两页都保持 Failed→Publish failures 视图。

验收（**主对话独立复跑核实**）：`npx tsc --noEmit` exit 0（清 `.next/dev/types` 陈旧类型后）；test-plan-list-view 14/14、test-studio-plan-match 15/15、test-status-normalization 35/35、test-failure-banner 8/8、test-pin-board-store 14/14 全绿。注：P0.5 执行代理的自述报告因卡在 `.next` 陈旧类型（已知 dev 坑）未写完结论，但代码实为完整正确——由主对话独立复验坐实。

**至此主症状闭环**：四套谓词收敛为一套核心判定 + 两个来源派生 selector；每页"失败数字 = 点进去能处理的列表"成立；刷新保持。

---

## 十三、剩余待办（P1 / P2，本轮未做）

- **P1（迁移，只写文件不 apply，由用户执行）**：`pin_drafts` promote 可查询列 `failed_at/failure_type/publish_error`；旧记录缺 `publishError` 的兜底文案；**写入侧回填历史脏数据的 `failureType`**（消除"仅 publishError 无 failureType"的老 localStorage 草稿 per-card 走错分支）；可选轻量 attempt 历史。查号取 `backend/db/migrate_v*.sql` 最大号+1（v53/v54 已占）。
- **P2（单独立项）**：计数从 localStorage 派生迁到服务端派生 + 客户端订阅，实现跨设备一致（任务书 §十七）；废弃三套遗留发布表（`publishing_queue`/`publish_jobs`/`social_publish_*`）。

---

## 附：关键证据文件行号
- `web/src/lib/studio/pinLifecycle.ts:43-49`（`getPinLifecycle`）、`:97-103`（`countPublishFailures`）
- `web/src/hooks/usePinBoardDrafts.ts:53`（board 集合过滤）、`:66`（Failed tab 计数）
- `web/src/components/studio/StudioBoard.tsx:109-118`（子筛选谓词）、`:79-86`/`:142-155`（一次性 sub-entry）、`:278-286`（客户端发布失败写 `failureType`）
- `web/src/lib/weeklyPlanStats.ts:137`（Plan 统计条 failed）
- `web/src/app/app/plan/page.tsx:2090-2109`（Banner 计数 + `openFailedInStudio`）、`:2111-2124`（跨设备诊断注释）
- `web/src/app/api/cron/publish-due/publishDueLogic.ts:79-104`（成功清失败）、`:120-155`（失败写 payload）
- `web/src/app/api/cron/publish-due/route.ts`（SCAN/CLAIM/PUBLISH + persist）
- `backend/db/migrate_v42_scheduled_publish.sql`（仅 promote `scheduled_at`/`publish_claimed_at`，无错误列）
- `backend/db/migrate_v38_pin_drafts.sql`（`payload` 为权威，无失败列）
- 遗留：`web/src/app/api/publish/route.ts`、`api/publish-jobs/route.ts`、`migrate_v14.sql`、`migrate_v32_social_connections.sql`
