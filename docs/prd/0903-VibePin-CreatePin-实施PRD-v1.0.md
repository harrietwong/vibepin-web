# VibePin Create Pin —— 实施 PRD v1.0

> 日期：2026-09-03
> 基线：`feat/pinterest-production-transition` @ `fec94a7f`
> 上游：`0903-VibePin-CreatePin-业务PRD-v2.0.md`（为什么做）、`0903-VibePin-CreatePin-开发PRD-v2.0.md`（是什么/证据）
> 本文档：**怎么做** —— 可直接派给执行代理的有序工单

---

## ⚠️ D-1 世系裁决已定（2026-09-05）——**下方"执行状态"的成果需在新基线重做**

`7f2c128d` 已 **soft reset 回退**（改动保留在工作区）。Codex 审查 REJECT，
根因不是修复本身，而是**施工基线选错了**。

### 决定性证据（生产归属，只读核验）

线上 deployment `dpl_GdtGTzX3` = commit `5bcc1a6`。

| 判据 | 结果 |
|---|---|
| `5bcc1a6` 是 `fec94a7f`（本分支 HEAD）的祖先？ | **否** |
| `5bcc1a6` 是 `2142aeeb` 的祖先？ | **是** |
| `fec94a7f..5bcc1a6` | **195**（本分支缺 195 个线上已有提交） |
| `5bcc1a6..fec94a7f` | **0**（本分支对生产零贡献） |
| `5bcc1a6..2142aeeb` | 354 |

**结论**：`feat/pinterest-production-transition` 是生产分叉**之前**的旧点，
比线上还旧 195 个提交。在它上面做的任何修复都不可能直接上线。
`2142aeeb`（分支 `codex/unified-preview-ui-feedback-0901`）是唯一包含线上全部代码的世系。

**裁决：在 `2142aeeb` 上重做 8 项 P0。** 不选它的 tip `60db2264`——那只是
freeze manifest 提交，修复后其 commit/tree 哈希必然失效。

### 为什么不能搬运，只能重做

- 脏工作区混有**至少三个并行会话**的未提交工作（Insights / Etsy / Studio UI 三簇，
  共 11 个未跟踪 `web/src` 文件）。`7f2c128d` 引用了其中三个组件却没包含它们，
  clean checkout 编译不过——**此前所有"全绿"都是脏树结果，按项目纪律一律不计**。
- 实测 `StudioBoard.tsx` 新增 593 行中，本任务特征仅 20 行、他人显性特征 2 行，
  **571 行归属不可判定**。hunk 级摘取不可靠。
- `2142aeeb` 上 CP-11 已重构为 `onPlaceholdersReady/onSettled` 架构，
  与本轮的内联实现结构不同，cherry-pick 解冲突比重写更危险。

### 目标世系检出可行性（已验证）

`2142aeeb` 树 2516 个文件，**非 ASCII 路径 0 个**——
记忆中"Windows worktree 漏 275 个中文/长路径文件"的坑在这条线上不存在。
`web/src` 687 文件、`web/scripts` 227 个测试脚本齐全。

### ⚠️ 换基线后，两条旧裁决作废（Codex 复核 + 主对话实测确认）

| 旧裁决 | 在 `2142aeeb` 上的实测 | 处置 |
|---|---|---|
| **D-8**：`destination_not_schedulable` / `destination_unavailable` "本树无代码产生、应删除" | **两个 code 真实存在且可达**（`route.ts:335`、`:379`，是真实的安全门） | **作废**。必须保留并纳入逐条 outcome |
| **CP-12b 需重做** | **已修好**（`handleGenerateCopyBatch useCallback` 在 970 行，早退 `if (!open) return null` 在 1028 行） | 不改源码，**只补运行时回归测试** |

教训：`fec94a7f` 上"grep 不到就是不可达"的推断，换基线即失效。
**每条根因证据都必须在目标基线重新核对，不得照抄旧 file:line。**

### Codex 追加的两个关键约束（主对话已核实）

1. **CP-14 的改动面比原 PRD 大得多。** 不能只改 `contentDraftModel.ts` +
   `PinBoardCard.tsx` + `StudioBoard.tsx`——还必须覆盖中央发布器
   `publishContent.ts`、`bulkActions.ts`、`mediaNotice.ts`、`planSidebarModel.ts`。
   只改三个 UI 文件会**留下 Plan、Batch 和共享 publisher 的 legacy 投影发布路径**。
   另：canonical 字段是 **`scheduledDestinations`**，不是脏树里的 `publishDestinations`——
   后者与 `2142aeeb` 不兼容，禁止搬运。

2. **`stale` outcome 必须携带服务端 `current` 行。** `2142aeeb` 已有 CAS rebase
   防重复发布（`pinDraftSync.ts` 25 处引用，主对话已核实）。
   只回 `updatedAt` 会**丢掉发布结果或复活已清除的排期**。

### 新基线开工规格（Codex 裁决 + 主对话核实，可直接派工）

**✅ 基线已实测冻结（2026-09-05，worktree `/d/wt/cp-p0-2142` @ `2142aeeb`）**

| 项 | 实测结果 |
|---|---|
| 检出完整性 | **2516 / 2516**，零丢失（该世系树非 ASCII 路径为 0，Windows 漏检出的坑不存在） |
| `check:test-registry` | **绿** — 224 tracked / 216 runnable / 8 excluded |
| `validate:i18n` | **绿** — 2882 English keys, 18 locale catalogs |
| **typecheck 基线** | **2 个错误**，均为 `@paddle/paddle-node-sdk` 缺类型声明（TS7016），与本次工作无关：`api/paddle/webhook/route.ts:26`、`lib/server/paddle/paddleServer.ts:11`。**这是唯一合法的基线豁免**；出现任何第 3 个错误都要当场定位 |
| 七个拟新增 P0 测试脚本 | **全部不存在**，需新建 |
| CP-14 中央发布器四文件 | `publishContent` / `bulkActions` / `mediaNotice` / `planSidebarModel` **全在** |
| `runAiGeneration.ts` | **存在**（CP-11 必须顺它的结构改） |
| **CP-12b** | **已修好** — 早退 `if (!open) return null` 在 1028 行，其后零 Hook。**不改源码，只补测试** |
| **CP-12a** | **基本已实现**（重大发现，详见下方） |
| **CP-14 根因** | **仍在** — `contentDestinations()` 末尾 `if (!draft.boardId && !draft.boardName && !draft.remotePinId && !draft.publishError) return []`，只要有 boardId/boardName 就投影出 Pinterest destination |

### 🔎 CP-12a 在新基线已基本实现（2026-09-05 实测，推翻原工单假设）

用户裁决的**路线 A（每个参考图组各发一次请求）在 `2142aeeb` 上已经是既成事实**：

| 要求 | 新基线实测 |
|---|---|
| 数量按参考图相乘 | ✅ `runAiGeneration.ts:144` `const totalPins = groups.length * perGroup` |
| 分组机制 | ✅ `runAiGeneration.ts:143` `planReferenceGroups(opts.selectedReferences ?? [], perGroup)`，实现在 `selectedReferences.ts:151` |
| 占位提前创建 | ✅ `:201` `onPlaceholdersReady?.(totalPins)` 在生成循环**之前** |
| 每组带自己的参考图 | ✅ `:213` `styleReference: group.reference?.imageUrl ?? null` |
| 服务端上限 | ✅ 默认已从旧基线的 **2** 放宽到 **4**（`generate/route.ts:74`） |

`generateAiVersions.ts:148` 的 `style_ref: referenceImages[0]` **不是缺陷**——
它是"每次调用只带一张参考图"的单次调用契约，由 `runAiGeneration` 逐 group 调用它。
（旧基线上它是缺陷，因为那里没有 group 循环。**又一个"换基线即失效"的例子**。）

注：groups **串行**执行，注释说明原因是 `/api/generate` 持有 per-user 锁，
并发第二次会被 429。这是有意设计，不是性能疏漏。

**CP-12a 工单因此从"实现路线 A"降级为**：
1. 核对 UI 是否明确显示总数（2 refs × 4 → 显示 8）
2. 核对计量是否按**成功张数**扣（`quantity: successfulImageCount`），而非整批一次
3. 补运行时回归测试守住 `totalPins` 公式与 slot 归属
4. 确认 `MAX_IMAGES_PER_REQUEST` 默认 4 是否满足产品预期（8 张需分 2 组各 4，已满足）

**⚠️ node_modules 事故（2026-09-05，主对话自己造成，非基线问题）**：
在两个执行代理正在使用该 worktree 时执行 `npm install --save-dev jsdom`，
撞上 Windows 文件锁报 `ENOTEMPTY: rmdir 'node_modules/next/dist/compiled/react-dom-experimental'`，
**npm 回滚时把 `next` 包删掉了**。后续 typecheck 因此报大量
`Cannot find module 'next' / 'next/link' / 'next/navigation'`——
**这些不是 `2142aeeb` 的基线红项，是本次事故的产物**，不得记入基线。
修复：等代理释放 worktree 后重装 `next@16.3.3`（`package.json` 声明版本），再重跑 typecheck 取真实基线。
教训：**执行代理占用 worktree 期间不要动 `node_modules`**。

**环境坑（记录备查）**：该 worktree 里 `npx tsc` 会抓到系统的假 tsc，
`npm run typecheck` 因 Windows 下 `node_modules/.bin` 未建链接而报 `'tsc' is not recognized`。
正确跑法：`node node_modules/typescript/bin/tsc --noEmit`。

**基线红项预期**（Codex 给出，上表已实测的以上表为准）：
- `typecheck`：**预期 0 error**。旧记录的"4 个 Etsy 错误"是 `fec94a7f` 脏树/在途改动，
  **不是 `2142aeeb` 的豁免项**，不得当基线红。
- `validate:i18n`：预期绿；`validate:i18n-coverage`：**预期红**——
  `2142aeeb` 新增 13 个英文 key 只补了 en/zh-CN/zh-TW，其余 16 个语言包缺 `13×16=208` 项。
- test registry：**225 个 tracked**（CORE 132 / STUDIO 56 / PLAN 28 / EXCLUDED 9，runnable 216）。
  旧记录的"123 scripts"是 `fec94a7f` 线数据。七个拟新增 P0 脚本在基线全不存在。

| P0 | 目标文件 | 必须保持的不变量 | 禁止做法 |
|---|---|---|---|
| CP-10 | `AiVersionDrawer.tsx`、`StudioBoard.tsx` | `doGenerate` 先等 setup 落盘再 `onGenerate`；抽屉只能由 `runAiGeneration → onPlaceholdersReady` 关闭；cache 未命中从 draft `setupSnapshot` 恢复 | 只在 close 保存；**把 React `setState` 当持久化确认**；绕开 `runAiGeneration` |
| CP-11 | `StudioBoard.tsx`、`runAiGeneration.ts`、19 语言包 | 每 intent 一个稳定 toast id；`onPlaceholdersReady` 建 loading，progress/limit/settled 原位更新；ambiguous 保留原 intent 与占位、标 recovery pending | 另起生成链；`toast.dismiss` 后另造终态；**用 `TypeError` 猜 unknown**；把 unknown 的占位标 failed |
| CP-12b | 仅核验 + 新增运行时测试 | 基线已正确（useCallback 970 < 早退 1028） | 无理由重排现有逻辑；**只做源码字符串断言** |
| CP-13a | `api/pin-drafts/route.ts` + 新增 import-safe `pinDraftSyncContract.ts` | 仅 envelope/auth/JSON 整批拒绝；格式/大小/destination/CAS 逐条返回；保留 `applied/skippedStale`；**保留两个 destination 安全门**；**保留 CAS**；D-7 全拒只作用于"本批新排期项"，不阻断无关普通草稿 | batch size 改 1；删 destination 门；一个坏条提前 return；**把 CAS stale 当成功** |
| CP-13b | `pinDraftSync.ts`、`SyncStatusIndicator.tsx` | applied→ack；**stale→先按 `current` rebase 再定去留**；rejected→action-required；deferred→有界退避；`(unknown)` 不匹配本地条目；**本地 200KB 预检也必须进 action-required** | 整 chunk ack；丢掉既有 `reconcileStale`；rejected 无限重试；显示原始 message key |
| CP-13c | 新 `storeScope.ts` + `pinDraftStore/Sync`、`userStoreSync(.Helpers/.Registry)`、`mediaOffload.ts`、`layout.tsx`、15 adapters 所在 13 个 store | 仅 `scoped` 可读写；切换时 **abort + epoch 双重失效**；清 timer/listener/outbox/cache/evicted；**先 scope 后 init、先 stop 后 signOut**；首次本地空必须先完成 server pull 再显示空态 | 全局 key；只停 pinDraft engine；旧 token getter 读新 session；**逐 store 分批上线**；无 owner 的 v1 数据自动认领 |
| CP-14 | `contentDraftModel.ts`、**`publishContent.ts`**、**`bulkActions.ts`**、**`mediaNotice.ts`**、**`planSidebarModel.ts`**、三个 UI 文件、i18n | `explicitPublishDestinations()` 读并过滤 **`scheduledDestinations`**；所有未来发布/重试/批量/media gate/chip 都用 explicit；`contentDestinations()` 仅供历史投影 | 读写 `publishDestinations`；用 `resolveScheduledDestinations()` 实现 explicit；任何默认 Pinterest/account/Board；`\|\| "Pinterest"`；**删掉用户明确保存的默认目标机制** |
| CP-14b | `StudioBoard.tsx`、`PinBoardCard.tsx`、i18n | 拦截原因按 draftId 常驻卡片，toast 消失后仍在；修好即清 | toast-only；**写进 `draft.publishError`**（会让生命周期变 Failed）；模糊通用文案 |

**scope 抽象最小契约**（CP-13c 开工前必须先定，否则 15 store 要返工）：

```ts
type StoreScope =
  | { state: "unknown";  epoch: number }                                    // 认证未解析
  | { state: "scoped";   epoch: number; userId: string; workspaceId: string } // 唯一可读写
  | { state: "cleared";  epoch: number };                                   // 登出后

activateStoreScope(identity) → ScopeLease { scope, signal }
clearStoreScope() / isCurrentScope(lease) / scopedLocalKey(name, version)
```

- `unknown` 与 `cleared` **都 fail closed**，但可区分"仍在加载" vs "已登出"
- 每次 activate/clear **先 abort 旧 controller、再递增 epoch**
- 每个 token/fetch/merge/persist 捕获 lease；**每次 `await` 后检查 `isCurrentScope()`**
  （abort 管取消，epoch 管拦截已返回的旧异步）
- token getter 必须校验 session user id **等于** `lease.userId`
- **键必须分离**：本地 `scopedLocalKey("pin_metadata", 2)` → `vp:pin_metadata:v2:u:<uid>:w:<wid>`；
  服务器 adapter `storeKey` 保持稳定的 `"pin_metadata"`，**绝不把 owner 拼进去**
- 无真实 workspace 来源时固定 `"personal"`，**禁止拿 userId 冒充**
- v1 无 owner 痕迹的数据：**逻辑丢弃但不物理删除**（新版永不读取、旧 key 留回滚窗口）

### 本轮成果的价值

8 项 P0 的**根因分析、行级证据、修复设计、37 条测试断言**全部有效，
作为新基线上重做的**只读规格与反例库**。失效的只是它们所依附的基线。

---

## 执行状态（2026-09-04，基于已回退的 `7f2c128d`——保留作重做规格）

**9 项 P0 已关闭 8 项。** 每项都经主对话独立复跑核实，不采信子代理自述。

| P0 | 工单 | 状态 | 代码证据（当前树实测） |
|---|---|---|---|
| CP-10 生成前存 setup | T-01/T-02 | ✅ | `AiVersionDrawer.tsx` `await saveSetup()` ×2 |
| CP-11 单一 toast | T-04 | ✅ | `StudioBoard.tsx` `id: toastId` ×6 |
| **CP-12a 生成数量** | **T-06** | ⏳ **开放** | `requested = count`（未相乘）；服务端上限仍为 **2** |
| CP-12b Hook 顺序 | T-01 | ✅ | 早退后 Hook 数 = 0 |
| CP-13a 逐条 outcome | T-09 | ✅ | `route.ts` 整批 `return` 已改 `continue` |
| CP-13b 停止无限重试 | T-11 | ✅ | `pinDraftSync.ts` `_actionRequired` 隔离区 |
| CP-13c 账号隔离 | T-13 | ✅ | `STORE_KEY_PREFIX` v2 分区 + `stopPinDraftSync` |
| CP-14 目标真实性 | T-15 | ✅ | `explicitPublishDestinations()`；**五处**伪造全清 |
| CP-14b 拦截持久化 | T-16 | ✅ | `publishBlocked` per-draft state |

**测试**：4 个新套件 37 条断言，全部注册进 `test-registry.ts`（123 脚本）。
每个套件都做过**变异验证**——把对应修复改回去，确认测试真的变红，不是假绿灯。

**门禁**：`tsc` 稳定在 4 个既有 Etsy 错误（他人在途，非本次引入）；
i18n 19 语言全绿；相关回归 16/16、7/7、14/14、19/19、35/35、28/28、26/26。

### 执行中发现、原 PRD 未记载的事实

1. **CP-14 实际是五处伪造，不是三处。** 除 PRD 列出的 helper 投影、卡片兜底、发布路径兜底外，
   还有：(4) `StudioBoard.tsx` 的 board 预填 effect **会把用户从未选过的 destination 写进数据库**
   ——这处最严重，足以击穿其余修复；(5) `BatchEditDrawer.tsx` 表格的 `|| "Pinterest"` 兜底。
2. **CP-13c 只关闭了一半，而且另一半比初报更严重。**
   T-13 的报告说其余 store"很可能"仍有同类风险。**主对话实测后确认：是确定存在，且会上传服务器。**

   `userStoreSyncRegistry.ts` 里 **15 个 store 注册了服务器同步适配器**
   （`smartSchedule` / `notificationPrefs` / `publishingPrefs` / `brandProfile` /
   `amazonAffiliateSettings` / `niches` / `creatorProductLinks` / `bookmarks` /
   `pinMetadata` / `pinSessions` / `pinRecords` / `productLibrary` /
   `referenceLibrary` / `assets` / `basket`），
   而它们的 localStorage key **全部是全局常量**（实测：`vp:pin_metadata:v1`、
   `vp:pin_store:v1`、`vp:brand_profile:v1`、`vp:smart_schedule:v1` 等），
   且这套引擎**没有 teardown 路径**。

   这意味着 CP-13c 修好的只是 pin-drafts 这一条。**A 登出、B 登录后，
   A 的这 15 类数据仍可能以 B 的身份上传到 B 的账号下**——与原漏洞同一形状、同一后果。
   `pinMetadataStore` 尤其相关：`pinDraftStore.syncPinMetadataStore()` 几乎每次
   更新草稿都会写它。

   **这是上线前必须裁决的事项**，不是可延后的技术债。见下方 T-18。
3. **v1 草稿数据里没有任何 owner 痕迹**（已全仓库 grep 确认）。因此按 D-4 裁决，
   升级后所有存量未同步草稿会被**丢弃一次**。已服务端同步的草稿不受影响（启动拉取会重新落入新命名空间）。
4. **`useSessionUser` 用的是 `getSession()` 而非 `getUser()`**（未验证的 cookie session）。
   作客户端存储命名空间可接受，但它**不是服务端强制的授权边界**——真正的归属校验仍在 `route.ts`。

### 新增待办（本轮范围外）

| ID | 内容 | 优先级 |
|---|---|---|
| T-18 | **15 个会同步到服务器的 user store 的 owner 分区与 teardown**（CP-13c 的另一半） | **上线阻断候选**——与原漏洞同形状、同后果，需用户裁决是否随本轮一起修 |

#### T-18 工单预案（待用户裁决后即可派发）

**规模已探明，比初看乐观。** 15 个 store 的读写模式**完全一致**
（都是 `localStorage.getItem(STORE_KEY)` / `setItem(STORE_KEY, ...)`），
而 T-13 已经在 `pinDraftStore.ts` 建好了可复用的 scope 机制
（`setStoreScope` / `clearStoreScope` / `getStoreScope` + tri-state fail-closed）。

因此**不需要重写 2200 行**，做法是：

1. 把 T-13 的 scope 逻辑从 `pinDraftStore.ts` 抽成共享模块
   （例如 `src/lib/storeScope.ts`），保持 tri-state 语义与 fail-closed 行为不变。
2. 15 个 store 各自把 `const STORE_KEY = "vp:xxx:v1"` 换成
   `storeKey("xxx")` 形态，读写各改一行。
3. 给 `initAllUserStoreSync` 加 teardown（对应 `stopPinDraftSync` 的角色），
   并接进 `handleLogout` 的同一处——顺序同样是先停引擎再 `signOut()`。
4. v1→v2 迁移沿用 D-4 裁决：能确认归属才迁，认不出就丢。
   **注意**：这 15 个 store 的旧数据同样很可能没有 owner 痕迹，
   派工前应先 grep 确认，并把"存量数据会丢一次"的影响面如实告知用户
   （比 pin-drafts 影响更广：包含商品库、素材库、购物篮、品牌配置等）。

**风险**：这 15 个 store 被大量功能依赖（`pinDraftStore.syncPinMetadataStore()`
几乎每次草稿更新都写 `pinMetadataStore`）。改动面横跨 Plan / Studio / Products
多个模块，回归范围远大于 T-13。建议派 **Opus**，并要求先出方案再动手。
| T-19 | 补运行时行为断言：本仓库无 React Testing Library，`test-generation-single-toast` 等目前是源码文本断言 | 中 |

每个工单（Task）是一个**独立可交付、可验证、可回滚**的单元，包含：

```
前置条件  → 不满足就不许开工
改动范围  → 精确到文件和函数，超出范围要回主对话
实现步骤  → 有序
完成判据  → 可执行的命令 + 可观察的结果
禁止事项  → 这个工单里明确不许做的事
派工模型  → Sonnet / Opus
```

**执行纪律（所有工单适用）**

1. 只改「改动范围」里列的文件。需要动别的文件 → **停下，回主对话**。
2. 连续两次修复失败 → **停止重试**，把失败现场（命令 + 完整输出）带回主对话，由 Fable 裁决。
3. 不许 `git stash -u`、不许 `git checkout <tree-ish> -- .`、不许根目录 `git add -A`
   （见 CLAUDE.md Git 安全规则；提交只 stage 明确路径）。
4. 不碰生产库。任何 DB 写操作前先打印 project ref 并断言 ≠ `jaxteelkecvlozdrdoog`。
5. 完成判据里的命令**必须真跑**并贴出输出。不许写"应该能过"。
6. 报告只带结论：改了什么 / 验证结果 / 发现的真问题。不带中间过程。

---

## 1. 阻塞门：T-00

### T-00 世系裁决

**状态**：✅ **已关闭**（2026-09-03）

三个待确认问题**我自己全部查清了**，没有依赖部署会话的回复
（消息已发出，该会话 offline；但这三条都是可直接验证的事实，不需要等人）：

1. 线上 = `dpl_GdtGTzX3FW9dGP1uE3UtgoWgApAn`（`/api/version` 实测），确认 = `5bcc1a6` 世系
2. 5 条已完成分支**全部不在**当前分支里（`merge-base --is-ancestor` 实测）
3. `2142aeeb` 内容**已独立核实**：只改视觉层，不碰数据逻辑

**裁决结果**：**在当前 `feat/pinterest-production-transition` 上修，上线前再合并。**
详见 §9。

**下面所有工单可以开工。**

---

## 2. 工单：Phase 0A（生成链）

### T-01 · BatchEditDrawer Hook 移位 · Sonnet

> 先做这个：改动最小、完全独立、能立刻验证，用来校准执行流程。

**前置**：T-00 通过

**改动范围**：`web/src/components/studio/BatchEditDrawer.tsx` （仅此一个文件）

**实现**
1. 把 `handleGenerateCopyBatch`（当前第 936 行的 `useCallback`）整体移到
   `if (!open) return null;`（当前第 899 行）**之前**。
2. 放在 `usePublishAssistantContext(...)`（897 行）之后，保持与其他 Hook 同一区块。
3. 检查它引用的所有变量在新位置都已声明（它依赖 `genProgress` 等，
   这些 state 在 697-733 行，都在 899 之前，安全）。

**完成判据**
```bash
cd web
# 1. 早退之后不许再有任何 Hook
awk 'NR>899 && /use(State|Effect|Memo|Callback|Ref|Context|Reducer)\(/ {print NR": "$0}' \
  src/components/studio/BatchEditDrawer.tsx
# 期望：空输出

npm run typecheck    # 0 error
npx tsx scripts/test-batch-edit-planning.ts   # 现有测试不许变红
```

**禁止**
- 不许把 `handleGenerateCopyBatch` 改成普通函数（会丢引用稳定性）
- 不许顺手重构这个文件里的任何其他东西（1870 行，改一处就够）

---

### T-02 · CP-10 生成前原子保存 setup · Sonnet

**前置**：T-01 完成

**改动范围**
- `web/src/components/studio/AiVersionDrawer.tsx`
- `web/src/components/studio/StudioBoard.tsx`

**背景（实施要点，开发 PRD 未展开）**
`aiSetupCache` 是 `StudioBoard.tsx:223` 的 **React state，不持久化**，刷新即丢。
所以本工单要做两件事，缺一不可：
- **(a) 顺序修复** —— 解决"关闭/重开丢失"
- **(b) 持久化恢复** —— 解决"刷新后丢失"

`setupSnapshot` 已经随 draft 持久化（`pinDraftStore.ts:84/533`），(b) 从它读。

**实现**
1. `AiVersionDrawer.tsx`：`doGenerate()` 改 async，**第一步**调 `await saveSetup()`，
   确认返回后再调 `onGenerate(...)`。
2. `saveSetup` 的类型从 `() => void` 改为 `() => void | Promise<void>`，
   `onSetupChange` 同步改签名。
3. `StudioBoard.tsx:1025` 的 `onSetupChange` 回调改为返回 Promise，
   在 `setAiSetupCache` 之后 resolve。
4. `StudioBoard.tsx:702` 的 `setAiDrawer(null)` 移到 setup 持久化**确认之后**。
5. **恢复路径**：`initialSetup`（1024 行）在 `aiSetupCache` 未命中时，
   回落读取该 draft 的 `setupSnapshot`，还原 `selectedReferences` / `selectedProducts` /
   `promptSnapshot` / `modelKey` / `format` / `imagesPerReference`。

**完成判据**
```bash
cd web
npm run typecheck
npx tsx scripts/test-generation-setup-atomic.ts   # T-03 里新建；本工单可先手工验
```
手工验（两条都必须过）：
- 选 2 张参考图 → 点 Generate → 生成结束 → 重开抽屉 → **2 张参考图仍在**
- 选 2 张参考图 → 点 Generate → **刷新页面** → 重开抽屉 → **2 张参考图仍在**

**禁止**
- 不许只在 close 时保存（根因是顺序，不是时机）
- 不许加 debounce 掩盖
- 不许在本工单里动 toast（那是 T-04）

---

### T-03 · CP-10 自动化测试 · Sonnet

**前置**：T-02 完成

**新建**：`web/scripts/test-generation-setup-atomic.ts`
**修改**：`web/scripts/test-registry.ts`（加进 `STUDIO` 组）

**断言**
1. 调用 `doGenerate` 后，`onSetupChange` 已被调用
2. 它携带的 setup 里 `referenceUrls` 等于当前选中的参考图
3. **调用顺序**：`onSetupChange` 在 `onGenerate` **之前**（这是核心断言）
4. `aiSetupCache` 未命中时，`initialSetup` 能从 `setupSnapshot` 还原

**完成判据**
```bash
cd web
npx tsx scripts/test-generation-setup-atomic.ts   # 全绿
npm run check:test-registry                        # 绿（新脚本已注册）
```

---

### T-04 · CP-11 单一 toast + unknown 终态 · Sonnet

**前置**：T-02 完成（共用 intentId）

**改动范围**：`web/src/components/studio/StudioBoard.tsx`（`handleAiGenerate`，653-742 行）

**实现**
1. 生成开始前造 `intentId`，并构造
   `const toastId = \`generation:${ownerScope}:${intentId}\``。
   `ownerScope` 取当前登录用户身份（T-08 会把它变成可靠来源；本工单先用现有 session 值）。
2. 704 行 `toast.success(...)` → `toast.loading(..., { id: toastId })`
3. 732 / 733 / 736 / 739 全部加 `{ id: toastId }`，原地更新，**不新建 toast**
4. 新增 `unknown` 分支：请求发出但响应丢失/超时时，
   `toast.info(中性文案"正在确认结果", { id: toastId })`，
   **不**显示"未生成任何 Pin"，**不**新建 job / 占位 / 预留 / 扣量，
   保留可恢复 intent。
5. 新增 i18n key（如"正在确认结果"）→ **19 个语言包全部补齐**

**完成判据**
```bash
cd web
npm run typecheck
npm run validate:i18n
npm run validate:i18n-coverage    # 19 个包全绿，缺一个就红
```
手工验：
- 全成功 → **一条** toast 原地变绿
- 全失败 → **一条** toast 原地变红，绿色"正在生成"**已消失**
- 部分成功 → **一条**中性终态，数字与占位卡一致

**禁止**
- 不许保留任何不带 `id` 的 toast 调用（本函数内）
- 不许用 `toast.success` 表达 pending

---

### T-05 · CP-11 自动化测试 · Sonnet

**前置**：T-04 完成

**新建**：`web/scripts/test-generation-single-toast.ts` → 注册进 `STUDIO`

**断言**
1. 一次 attempt 内所有 toast 调用**共享同一 id**
2. pending 用 `loading`，**不是** `success`
3. 全失败后不残留 pending toast
4. 快速双击 Generate → 只有一个 intent、一批占位、**一条** toast

---

### T-06 · CP-12a 生成数量重构：矩阵组合 + 排队分批 · **Opus**

> **本工单的需求在 2026-09-03 被用户改写，与 0901/0902 PRD 的口径不同。以本节为准。**

**用户裁决（原文口径）**
1. **不要写死上限**。API 有并发/单次限制 → **排队分批生成**，不是把用户的请求砍掉。
2. **数量 = 产品图 × 参考图**（矩阵组合），不是"参考图 × 每组几张"。
3. **界面上限不按套餐分级**。

**新公式（取代旧的 `groupCount × pinsPerReference`）**
```
expectedOutputCount = max(productImages.length, 1) × max(referenceImages.length, 1)
```
每个输出 = 一个 (产品图 × 参考图) 组合。
例：3 张产品图 × 2 张参考图 = **6 张**，产品A×风格1、产品A×风格2、产品B×风格1……

**与现有 UI 的冲突（必须一并处理）**
现有文案是 `{refCount} references × {count} images each`
（`i18n/messages/en/studioCreative.ts:105-106`），还有一个
`imagesPerReference` "每张参考图生成几张" 滑块（同文件 86-87 行）。
按新公式，**这个滑块的语义没有了**——数量完全由选了多少图决定。
处理方式：**移除 `imagesPerReference` 控件**，改为在 Generate 按钮旁
直接显示矩阵结果（"3 张产品图 × 2 张风格 = 将生成 6 张"）。
相关 i18n key 一并改写并补齐 **19 个语言包**。

**前置**：T-00 通过。**D-3 仍需取证**（见下方⚠）。

**改动范围**
- `web/src/components/studio/StudioBoard.tsx`
- `web/src/components/studio/AiVersionDrawer.tsx`（移除 count 滑块、改总数显示）
- `web/src/lib/studio/generateAiVersions.ts`
- `web/src/app/api/generate/route.ts`
- `web/src/lib/i18n/messages/**`（19 个语言包）

**实现**
1. 按新公式算 `expectedOutputCount`，每个组合一个 slot：
   `{ slotId, productImageKey, referenceImageKey, placeholderDraftId, status }`。
   **数组下标不得参与身份**（当前 690 行的 `gen:${requestId}:${i}` 要改）。
2. 结果归属按 slot 匹配，不按位置（当前 710 行的 `placeholders[i]` 要改）。
3. **占位先行**（用户裁决：先占位 N 个格子，出一张填一张）：
   点 Generate 后**立刻**创建全部 N 个"生成中"占位卡，
   每完成一个就地替换成结果，**不等全部跑完**。
   中途失败的 slot 单独标失败，不影响其他 slot。
4. **排队分批**（用户裁决：不写死上限）：
   把 N 个组合切成若干批提交给 provider，
   批大小取自"provider 实际能力"而**不是**一个写死的产品上限。
   `MAX_IMAGES_PER_REQUEST`（route.ts:46-49）的角色从
   **"产品上限"降级为"单批传输上限"** —— 它只决定切几批，
   **不再截断用户的请求**。
5. **超量确认**（用户裁决：不限但超过一定数量先提醒）：
   `expectedOutputCount` 超过阈值（建议 20，可配）时，
   弹一次确认框说明"将生成 N 张，预计耗时约 X 分钟"，确认后才跑。
   **不阻止**，只提醒。
6. ~~废掉 `generateAiVersions.ts:73` 的 `referenceImages[0]`~~
   **❌ 撤回（2026-09-04 取证）**：它不是 bug，是在如实反映后端只接受一张参考图。
   见开发 PRD §2.3B。**本工单在 D-3 裁决前保持阻塞。**

**完成判据**
```bash
cd web
npm run typecheck && npm run validate:i18n-coverage
npx tsx scripts/test-generation-groups.ts       # T-07
npx tsx scripts/test-generation-count-cap.ts    # T-07
```
手工验：
- 3 产品图 × 2 参考图 → UI 显示 **6** → **点击后立刻**出现 6 个占位 → 陆续填满 → 最终 6 张
- 数量超过阈值 → 出现确认提示，确认后正常跑
- 中途某张失败 → 只有那一个 slot 标失败，其余照常填入

**禁止**
- **不许**保留任何会截断用户请求的产品级上限
- **不许**按套餐分级限制界面可选数量
- 不许保留"用数组下标当 slot 身份"的代码路径
- 不许等全部跑完才显示（必须出一张填一张）

**⚠ D-3 仍需取证（开工第一步）**：`generateAiVersions` 打的是哪个 provider 后端、
单次能否带多张参考图、并发上限是多少 —— **尚未取证**。
执行代理**第一步是读代码确认**，把结论带回主对话，
由此决定"每批放几个组合",**不要凭推断选形态**。

---

### T-07 · CP-12a 自动化测试 · Sonnet

**前置**：T-06 完成

**新建两个脚本**
- `test-generation-groups.ts` → `STUDIO`：
  `expected = max(products,1) × max(refs,1)`；3×2 → 6 slot；
  每 slot 有 `{productImageKey, referenceImageKey}` 且组合唯一不重复；
  下标不参与身份；占位在第一个结果返回前已全部创建
- `test-generation-count-cap.ts` → `CORE`：**守"不截断"**——
  给定 6 个组合的请求，服务端**不得**把它夹成 2；
  `MAX_IMAGES_PER_REQUEST` 只影响切几批，不影响最终产出总数

---

### T-08 · CP-12b 运行时回归测试 · Sonnet

**前置**：T-01 完成

**新建**：`web/scripts/test-batch-edit-hook-order.ts` → `STUDIO`

**断言**：**运行时**渲染 closed→open→closed，捕获 React 错误，断言无 #310。

**禁止**：不许只做源码字符串断言（0901 PRD §16 明确禁止把它当唯一证据）。

---

## 3. 工单：Phase 0D（草稿同步）

> **顺序**：T-09 → T-11 → T-13。三者是同一条链：
> 服务端先能逐条给结果 → 客户端才能逐条 ack → 同步链路通了，
> "换浏览器看不到草稿"才真正解决（T-13 补最后一环）。
> 不要把 T-13 提前并行——它的地基是前两个。

### T-09 · CP-13a 服务端逐条 outcome · **Opus**

**前置**：T-00 通过

**改动范围**：`web/src/app/api/pin-drafts/route.ts`

**实现**
1. 定义并返回逐条 outcome：
   ```ts
   type DraftSyncOutcome = {
     draftId: string;
     status: "applied" | "stale" | "rejected" | "deferred";
     updatedAt?: string;
     code?: "payload_too_large" | "destination_not_schedulable"
          | "destination_unavailable" | "quota_exceeded" | "stale" | "storage_unavailable";
     userMessageKey?: string;
     retryable: boolean;
   };
   // 响应：{ outcomes: DraftSyncOutcome[], applied: number, skippedStale: number }
   ```
2. 189-200 行的校验循环：**不再 `return`**。单条不合法 → 记 `rejected` + code，
   继续处理其余条目。
3. 293 行的配额门禁同理，逐条 `quota_exceeded`。
4. **只有 request-level 错误**（JSON 解析失败、缺认证、整个 envelope 不可识别）
   才允许拒绝整批。
5. **向后兼容**：保留 `applied` / `skippedStale` 字段，老客户端仍可工作。

**完成判据**
```bash
cd web
npm run typecheck
npx tsx scripts/test-pin-drafts-per-draft-outcome.ts   # T-10
npx tsx scripts/test-pin-draft-sync.ts                 # 现有测试不许变红
```

**禁止**
- 不许把 batch size 改成 1 来"绕过"（0901 PRD 明确点名这种掩盖手法）
- 不许改客户端（那是 T-11）

---

### T-10 · CP-13a 服务端测试 · Sonnet

**前置**：T-09 完成

**新建**：`test-pin-drafts-per-draft-outcome.ts` → `CORE`

**断言**：混合批次（1 合法 + 1 超 200KB）→ 合法条 `applied`、坏条 `rejected` 带 code；
响应含 `outcomes[]`；合法条**确实写进了库**。

---

### T-11 · CP-13b 客户端逐条 ack · Sonnet

**前置**：T-09 完成（✅ 已完成并复核）+ T-10 完成（契约被测试钉死后再动客户端）

**⚠ T-09 交付后暴露的契约细节（开工前必读，否则会写错）**

1. **`code` 可能是 `undefined`。** 畸形字段的草稿没有对应的 code
   （code 枚举里没有"字段格式错"这一项），服务端给的是
   `status: "rejected"` + `userMessageKey: "sync.draft.error.invalid"` + **无 code**。
   客户端必须能处理 `status === "rejected" && code === undefined`。

2. **`draftId` 可能是 `"(unknown)"`。** 畸形草稿可能连 draftId 都取不到，
   服务端用常量 `UNKNOWN_DRAFT_ID` 占位。
   **不能盲目按 draftId 回匹配 outbox** —— 这类 outcome 对不上任何本地草稿。

3. **`remaining` 字段**（2026-09-04 新增）：仅在 `quota_exceeded` 时出现，
   表示还剩几个排期额度。客户端应该用它给出
   "还剩 N 个排期名额"这种具体提示，而不是干巴巴的"超出配额"。

4. **配额是全拒不是部分接纳**（D-7 裁决）：一批里只要新排期总数超额，
   **全部**新排期被拒。UI 文案要匹配这个语义 ——
   不要说"部分已排期"，要说"这批都没排上，你还剩 N 个名额"。

5. **只剩 4 个 code**（D-8 裁决，已删两个不可达的）：
   `payload_too_large` / `quota_exceeded` / `stale` / `storage_unavailable`。
   **不要**为 `destination_not_schedulable` / `destination_unavailable` 做 UI，它们已被删除。

6. **i18n 缺口**：服务端产生 5 个 `userMessageKey`
   （4 个 code 各一个 + `sync.draft.error.invalid`），
   **19 个语言包目前一个都没有**。T-11 必须全部补齐，否则界面会显示原始 key。

**改动范围**
- `web/src/lib/pinDraftSync.ts`
- `web/src/components/sync/SyncStatusIndicator.tsx`

**实现**
1. `flush()`（367 行附近）解析 `outcomes[]`，逐条处理：
   - `applied` / 已 merge 的 `stale` → ack，移出 outbox
   - `rejected` → 移出重试队列，进入 `action_required`，**停止自动重试**
   - `deferred` → 保留，有界退避
2. `ackEntries(chunk)`（369 行）→ `ackEntries(appliedDraftIds)`
3. `action_required` 只有在用户修正该草稿产生新 `updatedAt` 后才重新入队
4. `SyncStatusIndicator` 从单一全局三态，改为能区分
   「已保存到服务器」/「仅存本机」/「需要处理」，并能**点进去定位到具体 Draft**
5. 新增 i18n key（5 个 code 的用户文案）→ **19 个语言包全补**

**完成判据**
```bash
cd web
npm run typecheck && npm run validate:i18n-coverage
npx tsx scripts/test-pin-draft-sync-partial-ack.ts    # T-12
```

---

### T-12 · CP-13b 客户端测试 · Sonnet

**新建**：`test-pin-draft-sync-partial-ack.ts` → `CORE`

**断言**：收到混合 outcome 后只 ack `applied`；
`rejected` 移出重试队列**且不再自动重试**（这条是核心，守的是 389 行那个 "forever"）；
`deferred` 有界退避。

---

### T-13 · CP-13c 账号数据跟随账号（owner 隔离 + 登出清理）· **Opus**

> **本工单是安全项 + 产品能力项**，四处必须**同时**完成才算关闭。
> 只改 key 不改登出 = 泄露仍在；只做隔离不做服务器回读 = 换浏览器还是空的。

**产品目标（用户 2026-09-03 明确要求）**：
**账号数据必须跟着账号走,换浏览器/换电脑登录后自己的草稿仍在。**
浏览器本地存储只是离线缓冲,**不是**事实源。

**现状核实（已实测,好消息）**：服务器端骨架**已经具备**——
- `GET /api/pin-drafts`（route.ts:117-139）按 `vibepin_user_id` 回读,带分页游标
- `pullAllPages()`（pinDraftSync.ts:248-276）会翻页拉全量

**所以"换浏览器看不到"不是缺功能,是同步链路坏了**：
一条坏草稿 → 整批 413/422 → 无限重试(pinDraftSync.ts:389 注释自己写着 forever)
→ 后续草稿永远推不上服务器 → 换浏览器自然是空的。
**T-09 / T-11 修好逐条同步,这个问题就解决了大半**;本工单补齐隔离与回读的最后一环。

**前置**：T-00 通过；**T-09 + T-11 完成**（服务器逐条 outcome + 客户端逐条 ack 是本工单的地基）。
**D-4 裁决**：已拍板 —— **能确认 owner 的迁移,认不出的丢弃**。

**改动范围**
- `web/src/lib/pinDraftStore.ts`
- `web/src/lib/pinDraftSync.ts`
- `web/src/app/app/layout.tsx`

**实现**
1. `STORE_KEY`（`pinDraftStore.ts:33`）→ `vp:pin_drafts:v2:${ownerUserId}:${workspaceId}`
2. 按 D-4 处理 v1 遗留数据：**仅在能确认 owner 时迁移，否则丢弃**
   （跨账号污染风险高于丢失本地草稿）
3. 导出 `stopPinDraftSync()`：清 timer、清 in-flight、复位模块级 `_initialized` latch
   （`pinDraftSync.ts:194`）
4. `handleLogout`（`layout.tsx:388-392`）改为：
   **先** `stopPinDraftSync()` + 冻结 A scope，**再** `signOut()`
5. `layout.tsx:327-335` 的 init effect 加 cleanup return，deps 带上 owner 身份
6. 无法确认 owner 时 **fail closed**（不读、不写、不提交）
7. **新浏览器首次登录必须先拉服务器数据**：owner scope 初始化时,
   若本地该 owner 的存储为空 → **先 `pullAllPages()` 回填再渲染**,
   不要先渲染空列表再异步补(会让用户以为草稿丢了)。
   拉取期间显示明确的加载态,失败时显示"正在同步你的草稿"而**不是**空状态。

**完成判据**
```bash
cd web
npm run typecheck
npx tsx scripts/test-pin-draft-owner-scope.ts   # T-14
npx tsx scripts/test-pin-draft-sync.ts          # 现有不许变红
```
手工验（三条都必须过）：
- **隔离**：A 建草稿 → 登出 → B 登录 →
  B 侧对 A 的内容 **0 请求 / 0 job / 0 扣量**，界面看不到 A 内容 → A 重登 → A 的待同步还在
- **跟随账号（本工单的产品目标）**：A 在浏览器 1 建草稿并等同步完成 →
  **换一个全新浏览器配置**登录 A → **草稿都在**
- **不误报空**：新浏览器首次登录时不出现"先空一下再填上"的闪烁

---

### T-14 · CP-13c 测试 · Sonnet

**新建**：`test-pin-draft-owner-scope.ts` → `CORE`

**断言**：store key 含 owner；A 写入后切 B，B 读到空；
`stopPinDraftSync()` 后无 in-flight 请求；无 owner 时 fail closed。

---

## 4. 工单：Phase 0C（发布目标真实性）

### T-15 · CP-14 destination 真实性 · **Opus**

**前置**：T-00 通过；Multichannel canonical destination 模型已确认可消费

**改动范围**
- `web/src/lib/contentDraftModel.ts`
- `web/src/components/studio/PinBoardCard.tsx`
- `web/src/components/studio/StudioBoard.tsx`

**实现**
1. 新增 `explicitPublishDestinations(draft)`：**只**返回明确保存的
   `publishDestinations[]`（provider + connectionId + 账号身份 +（Board/Page））。
   不做任何 legacy 投影。
2. **删除** `PinBoardCard.tsx:588` 的兜底
   （`destinations.length ? destinations : [{...pinterest}]`）
3. **删除** `StudioBoard.tsx:453` 的兜底
   （`if (!destinations.length) destinations = [{...pinterest}]`）
4. **删除** `customerFacingBoardName`（`PinBoardCard.tsx:95-99`）的 `|| "Pinterest"` 兜底
5. 卡片：`explicitPublishDestinations()` 为空 → 渲染中性的
   **「尚未选择发布目标」**，可点击直接打开 destination picker
6. `contentDestinations()` 的 legacy 投影**保留但降级用途**：
   只用于展示历史 posted/failed 记录，**不得**用于"接下来会发到哪"
7. 新增 i18n key（"尚未选择发布目标"）→ **19 个语言包全补**

**完成判据**
```bash
cd web
npm run typecheck && npm run validate:i18n-coverage
npx tsx scripts/test-explicit-destinations.ts   # T-17
```
手工验（三类草稿逐一对比）：
| 草稿类型 | 卡片应显示 |
|---|---|
| 仅有 legacy `boardId` | 「尚未选择发布目标」，可点击 |
| 明确零目标 | 「尚未选择发布目标」，可点击 |
| 一个合法 canonical destination | 真实 provider + 账号 + Board |

**禁止**
- **不许恢复任何默认兜底**：不默认 Pinterest、不默认账号、不默认 Board
- 不许让空 Board 名显示成 "Pinterest"

---

### T-16 · CP-14b 前置拦截持久化 · Sonnet

**前置**：T-15 完成

**改动范围**：`web/src/components/studio/StudioBoard.tsx`（451、474 行）

**实现**
把两处 `toast.error(...) + return` 改为**同时**写入卡片级持久状态。
复用已有的 `setScheduleErrors` 模式（`StudioBoard.tsx:431` 已有先例），
在卡片上常驻显示原因 + 修复动作，修好后原位消失。
toast 可保留，但**不能是唯一反馈**。

**手工验**：点发布被拦 → 卡片上有持久、说得清的原因 → 修好后原位消失

---

### T-17 · CP-14 测试 · Sonnet

**新建**：`test-explicit-destinations.ts` → `STUDIO`

**断言**：只有 legacy `boardId` 的草稿 → `explicitPublishDestinations()` 返回 `[]`；
卡片不渲染可发布 chip；`customerFacingBoardName` 不再返回 `"Pinterest"` 兜底。

---

## 5. 派工总表

| Task | 内容 | 模型 | 依赖 | 可并行 |
|---|---|---|---|---|
| T-00 | 世系裁决 | — | — | ✅ 已关闭 |
| T-01 | Hook 移位 | Sonnet | T-00 | |
| T-02 | CP-10 原子保存 | Sonnet | T-01 | |
| T-03 | CP-10 测试 | Sonnet | T-02 | |
| T-04 | CP-11 单 toast | Sonnet | T-02 | |
| T-05 | CP-11 测试 | Sonnet | T-04 | |
| T-06 | CP-12a group/slot | **Opus** | T-00 + D-2 + D-3 取证 | |
| T-07 | CP-12a 测试 | Sonnet | T-06 | |
| T-08 | CP-12b 运行时测试 | Sonnet | T-01 | |
| T-09 | CP-13a 服务端 | **Opus** | T-00 | 草稿链第 1 环 |
| T-10 | CP-13a 测试 | Sonnet | T-09 | |
| T-11 | CP-13b 客户端 | Sonnet | T-09 | |
| T-12 | CP-13b 测试 | Sonnet | T-11 | |
| T-13 | CP-13c 数据跟随账号 | **Opus** | T-09 + T-11 | 草稿链第 3 环 |
| T-14 | CP-13c 测试 | Sonnet | T-13 | |
| T-15 | CP-14 真实性 | **Opus** | T-00 | |
| T-16 | CP-14b 拦截持久化 | Sonnet | T-15 | |
| T-17 | CP-14 测试 | Sonnet | T-15 | |

**并行边界**：同一时刻最多 2 个执行代理，且**不得触碰同一文件**。
`StudioBoard.tsx` 被 T-02 / T-04 / T-06 / T-15 / T-16 五个工单共用 —— **这五个必须串行**。

---

## 6. 阶段验收

### 每个 Task 完成后（执行代理自己跑）
```bash
cd web && npm run typecheck && npm run check:test-registry
```

### 每个 Phase 完成后（**Fable 在主对话独立复跑**，不采信子代理自述）
```bash
cd web
npm run typecheck
npm test                      # 仅剩基线红 4，新增任何一条都要当场定位
npm run validate:i18n
npm run validate:i18n-coverage
npm run check:test-registry
```

### 全部 P0 完成后（**clean worktree**，脏树绿灯不算）
```bash
git worktree add <干净目录> <已提交SHA>
cd <干净目录>/web && npm ci
npm run typecheck && npm test && npm run validate:i18n-coverage && npm run build
git diff --check
```
然后进两轮 USER E2E（开发 PRD §6.3 的 U-01..U-18，
同一 runtime，`1440×900` + `390×844`，Round 2 必须刷新重开）。

---

## 7. 未决事项（开工前需拍板）

| ID | 问题 | 阻塞哪些 Task | 状态（2026-09-03） |
|---|---|---|---|
| **D-1** | 在哪条世系施工 | 全部 | ✅ **已定：先在当前分支修，上线前再合并 5 条分支**（详见 §9） |
| **D-2** | 生成数量上限 | T-06 | ✅ **已定**（2026-09-05 用户裁决，见下方 CP-12a 完整规格） |
| **D-3** | provider 调用形态 | T-06 | ✅ **已定：路线 A**（每组合各发一次请求 + 服务端调度层） |

### CP-12a 完整产品规格（2026-09-05 用户裁决，D-2 + D-3 一并闭合）

**一、一张图放几个产品：取决于用户上传了几个。**
用户传 1 个产品 → 单品图；传 3 个 → 3 个同框。**不再让用户做第二次选择。**
后端 `generator.py:707` 现有 prompt（"Feature most or all of the products together
in one cohesive scene"）**本来就是这个语义，不用改**。

**二、数量公式（据此修正先前写法）**

```
张数 = max(参考图数, 1) × 每张参考图的数量
```

产品数**不参与乘法**——它决定的是"每张图里有几个主体"，不是"生成几张图"。
例：3 个产品 + 2 张参考图 + 每张 4 个 = **8 张图**，每张都是 3 个产品同框，
分 2 组风格、每组 4 个变体。

> 先前 D-2 记录的"数量 = 产品图 × 参考图"是对用户原话的错误理解，此处更正。

**三、实现路线：A（每个「参考图 × 变体序号」组合各发一次请求）**

用户裁决理由（业务视角，非技术偏好）：
- **部分失败可控**：8 张里第 3 张失败，其余 7 张照常交付并可单独重试。
  路线 B 一次请求失败可能颗粒无收——用户已付 3 倍成本，颗粒无收不可接受。
- **出图更快**：并行而非排队。
- **风险面小**：不碰 `generator.py` 的 prompt 核心（那是决定出图质量的地方）。

**A 的必做配套**（Codex 强调，否则不成立）：
必须有服务端轻量 orchestrator，**不能只在浏览器里循环**。要保证：
一个父 intent 统一计量、幂等、刷新恢复、结果归属；子任务逐组合执行。

**四、上限与计量**
- **不写死产品级上限**，界面**不按套餐分级**。额度系统本身就是成本闸门，
  不在生成上限上再设第二道闸。
- 服务端 `MAX_IMAGES_PER_REQUEST ?? 2` 的语义要改成"单次 provider 调用的图片数"，
  不再充当"用户一次生成的总量上限"。

- **计量：按成功出图的张数扣，不按提交次数。** 8 张成功 = 扣 8。
  理由是成本模型而非 UX 偏好——**每次成功的 provider 调用都真实产生费用**，
  按 intent 计等于 8 张只收 1 张的钱。

  > 本文档先前写的"一个 intent 只计一次"是错的，2026-09-05 用户指出并更正。
  > 该说法源自 PRD 里"一条 Content 多渠道**发布**只计一次"——那条讲的是
  > **publish** 计量（fan-out 到 3 个平台仍算 1 条内容），
  > 与 **generation** 计量是两码事，不可混用。

  **现有实现已经是对的**，不需要改：
  `route.ts:713-719` 用 `quantity: successfulImageCount` 且 `!ok || successfulImageCount <= 0`
  时直接 return——只扣成功的张数，失败和超时不扣。
  路线 A 改造时**必须保持这个语义**：每个子任务成功出图就按其张数计量，
  父 intent 只负责聚合与幂等，**不得**退化成"整批扣一次"。

  幂等键仍用**服务端生成**的 `serverRunId`（`route.ts:712`），
  不能用客户端可控的 `generationRequestId`——否则客户端可以复用 id 逃避计量。
| **D-3** | provider 调用形态 / 矩阵语义 | T-06 | ⏳ **取证已完成**（开发 PRD §2.3B），但结果**推翻了原假设**：后端只接受 1 张参考图，矩阵组合无法直接实现。**待用户在路线 A/B 之间裁决，并澄清"一张图放几个产品"** |
| **D-7** | 配额不够时部分接纳还是全拒 | T-09 | ✅ **已定：全拒**，并把剩余额度数（`remaining`）带回给客户端提示用户 |
| **D-8** | 两个不可达的 outcome code 是否保留 | T-09/T-11 | ✅ **已定：删除** `destination_not_schedulable` / `destination_unavailable`。本树无任何代码产生它们，留着会诱导客户端做出永远走不到的 UI |
| **D-4** | `vp:pin_drafts:v1` → v2：迁移还是丢弃 | T-13 | ✅ **已定：能确认 owner 的迁移，认不出的丢弃** |
| **D-5** | P1（CP-01..09、ST-01..05）本轮做还是延后 | Phase 1 | ✅ **已定：分开做，先修 9 个 P0** |

**只剩 D-3 未决，且它由执行代理取证后由 Fable 裁决，不阻塞其他工单开工。**

---

## 9. 上线策略（D-1 裁决结果）

**已核实的事实**（我自己查的，不是转述）：

1. 线上当前跑的是 `dpl_GdtGTzX3FW9dGP1uE3UtgoWgApAn`
   （`curl https://vibepin.co/api/version` 实测），与记忆记录一致 = `5bcc1a6` 世系。
2. 以下 5 条分支**全部不在** `feat/pinterest-production-transition` 里
   （`git merge-base --is-ancestor` 实测）：

   | 分支 | tip |
   |---|---|
   | `integrate/multichannel-0827` | `e7a26eba` |
   | `feat/reference-recs-p0-0827` | `68eebbd2` |
   | `integrate/usage-phase1-0829` | `af7eed8f` |
   | `codex/admin-cockpit-on-live` | `d7f5ddf9` |
   | `codex/unified-preview-ui-feedback-0901` | `60db2264` |

3. `2142aeeb` 的内容**已独立核实**（`git show --stat`）：14 个文件，
   **只改视觉层**（PinBoardCard / PinCardMedia / PinFallbackArtwork / StudioBoard /
   StudioBoardFilters / StudioPlanSidebar / boardUI / globals.css + 3 个语言包 + 2 个测试）。
   **没有碰** generation、destination、draft sync 的任何数据逻辑。
   PRD 自述这次属实。**但它只补了 3 个语言包（en/zh-CN/zh-TW），不是 19 个** —— 集成时要补齐。

**裁决（用户 2026-09-03）：先在当前分支修 9 个 P0，上线前再把 5 条分支合并成一条一起上。**

**因此必须遵守**：
- 本轮**不部署**。P0 修完只做内部验收。
- 上线时**必须**先合并成一条分支、跑完整门禁、再**一次**部署。
  **禁止**"你部署完我再部署"——那是互相清洗（见 CLAUDE.md 生产部署纪律）。
- 部署由**用户指定的部署会话**执行，本会话只负责修复和汇报"可上线"。
- 部署前 `npm run predeploy:guard` 的 check 7 必须通过，
  它会列出"本次部署会丢掉哪些活跃分支的工作"。

---

## 8. 回滚

每个 Task 一个独立 commit，commit message 写清 Task ID 和覆盖的 CP 编号。
任一 Task 出问题 → `git revert` 该 commit，不影响其他 Task。

**不许**用 `git reset --hard` 回滚（会波及其他会话的未跟踪草稿，见 CLAUDE.md）。
