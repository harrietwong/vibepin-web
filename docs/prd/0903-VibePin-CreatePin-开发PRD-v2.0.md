# VibePin Create Pin 生产阻断 —— 开发 PRD v2.0

> 日期：2026-09-03
> 基线：`feat/pinterest-production-transition` @ `fec94a7f`（当前工作树，已逐行实测）
> 取代：`0902-VibePin-CreatePin-开发PRD-v1.0.md`
> 配套业务文档：`0903-VibePin-CreatePin-业务PRD-v2.0.md`

---

## 1. 本版的方法论差异

v1.0 开发 PRD 描述的是**目标状态**（应该有什么类型、什么状态机）。
它没有回答工程师真正需要的问题：**现在的代码到底是什么样，我要改哪一行。**

本版每一条 P0 都给出：

```
现状证据（file:line + 代码引用）
  ↓
为什么这是错的（失败场景，不是抽象原则）
  ↓
改法（具体到函数和契约）
  ↓
怎么证明改对了（自动化测试 + 人工验证，各自可独立执行）
```

**所有 §2 的证据都是我在当前工作树上直接读出来的**，不是从 0901 PRD 转述的。
0901 PRD 的若干描述与本树不符，差异见 §3。

---

## 2. 现状实测：9 项 P0 的行级证据

### 2.1 CP-10 —— 生成不保存 setup（风格参考图丢失）

**证据** `web/src/components/studio/AiVersionDrawer.tsx`

```ts
552  const saveSetup = () => onSetupChange?.(currentSetup);
554  const closeDrawer = () => { saveSetup(); onClose(); };
574  ...  saveSetup();          // openProductPicker
579  ...  saveSetup();          // openReferencePicker

590  const doGenerate = () => {
591    const snapshot = buildSnapshot({ ... });
608    onGenerate({ ... });     // ← 全函数体没有任何 saveSetup / onSetupChange
627  };
```

`closeDrawer`、`openProductPicker`、`openReferencePicker` 三处都调了 `saveSetup()`，
唯独 `doGenerate()`（590-627）没有。

**失败场景**：用户选 2 张参考图 → 点 Generate → `StudioBoard.tsx:702` `setAiDrawer(null)`
直接卸载抽屉（**没有走 `closeDrawer`**）→ `aiSetupCache` 里这次的 `referenceImages` 从未写入
→ 重开抽屉，`initialSetup`（`StudioBoard.tsx:1024`）读到的是上一次的旧快照，参考图消失。

**改法**
1. `doGenerate()` 第一步就 `saveSetup()`，并且要**等它落盘**再调 `onGenerate`。
   把 `onSetupChange` 改成返回 `void | Promise<void>`，`doGenerate` 变 async。
2. `StudioBoard.handleAiGenerate` 里的 `setAiDrawer(null)` 移到 setup 持久化确认之后。
3. 失败/刷新路径也要能回填：`setupSnapshot` 已经写进 placeholder draft
   （`StudioBoard.tsx:698`），恢复时优先读它。

**不接受的改法**：只在 close 时保存、只加前端 debounce。根因是顺序，不是时机抖动。

---

### 2.2 CP-11 —— 一次生成两条互相矛盾的 toast

**证据** `web/src/components/studio/StudioBoard.tsx`

```ts
702    setAiDrawer(null);
703    setAiGenerating(false);
704    toast.success(requested === 1 ? tr("...generatingOne") : tr("...generatingMany")...);
       //  ↑ pending 状态用了 success（绿色）
...
732      if (okCount && failCount) toast.error(tr("...generatedSomeFailedSome")...);
733      else if (okCount) toast.success(...);
736      else { placeholders.forEach(p => pinDraftStore.failGeneratedDraft(p.id));
               toast.error(tr("...noAiPinsGenerated")); }
739      toast.error(tr("...couldNotGenerate"));   // catch
```

四处 toast 调用**没有一个带 id**。全文件唯一传过的 toast option 是
`{ action: ... }`（442、582 行）。

**失败场景**：全失败时，704 的绿色"正在生成 2 个"**不会消失**（没有 id 就没法更新/dismiss），
736 又叠一条红色"未生成任何 Pin"。用户同屏看到两条矛盾提示。

注意：0901 PRD 说根因在 `onPlaceholdersReady` / `onSettled`。
**这棵树上这两个 handler 不存在**，生成是 `handleAiGenerate` 里的内联流程。

**改法**
1. 生成开始前生成 `intentId`，`const toastId = \`generation:${ownerScope}:${intentId}\``。
2. 704 改 `toast.loading(..., { id: toastId })`。
3. 732/733/736/739 全部改成带同一个 `{ id: toastId }` 的原地更新
   （`toast.success/error/info(..., { id: toastId })`）。
4. 新增 `unknown` 终态：提交后响应丢失时用中性文案"正在确认结果"，
   **不**显示"未生成任何 Pin"，**不**新建 job/占位/预留。

---

### 2.3 CP-12a —— 数量：前端不乘、后端上限是 2

**证据 1（前端不乘）** `web/src/components/studio/StudioBoard.tsx`

```ts
664    const requested = Math.max(1, opts.count || 1);   // ← selectedReferences.length 从未参与
671      imagesPerReference: opts.count,                 // ← 只是快照标签，从不相乘
677      selectedReferences: opts.referenceImages.map(imageUrl => ({ imageUrl })),
685    const placeholders = Array.from({ length: requested }, (_, i) => ...
690        idempotencyKey: `gen:${requestId}:${i}`,      // ← slot 身份 = 数组下标
```

**证据 2（只发第一张参考图 + 二次夹紧）** `web/src/lib/studio/generateAiVersions.ts`

```ts
57       count: Math.max(1, Math.min(4, setup.count)),
73       style_ref: referenceImages[0] || null,          // ← 只取第 0 张
```

**证据 3（服务端上限默认 2）** `web/src/app/api/generate/route.ts`

```ts
46   const MAX_IMAGES_PER_REQUEST = Math.max(1, Math.min(
47     process.env.ALLOW_MAX_IMAGES_PER_REQUEST_OVER_4 === "true" ? 99 : 4,
48     Number(process.env.MAX_IMAGES_PER_REQUEST ?? 2) || 2,     // ← 默认 2
49   ));
131    const requested = Math.max(1, Math.floor(Number(raw ?? 4) || 4));
132    const actual = Math.min(MAX_IMAGES_PER_REQUEST, requested);
465    ... Number(body.referenceImageCountRequested ?? (styleRef ? 1 : 0))  // ← 参考图最多算 1
```

**这是本版相对 0901 PRD 的重要修正**：
即使把前端乘法修好，`MAX_IMAGES_PER_REQUEST` 默认 2 会把 8 夹到 2。
**只改前端等于没改。**

**结果归属是位置匹配**（710 行 `result.urls.slice(0, placeholders.length).forEach((url, i) => ... placeholders[i].id)`），
没有 `groupId` / `slotIndex` 概念，参考图与结果的对应关系不可追溯。

**改法（2026-09-03 用户改写需求，取代原方案）**

> ⚠️ 本节的公式在 09-03 被用户改写。上面的**证据**仍然有效，
> 但**目标**从"参考图 × 每组 N 张"改成了"产品图 × 参考图"矩阵，
> 且**取消了产品级上限**。实施细则见实施 PRD T-06。

1. **新公式**：
   ```
   expectedOutputCount = max(productImages.length, 1) × max(referenceImages.length, 1)
   ```
   每个输出 = 一个 (产品图 × 参考图) 组合。3 产品 × 2 风格 = 6 张。
   每个 slot 带 `{ slotId, productImageKey, referenceImageKey, placeholderDraftId }`，
   **不用数组下标做身份**。
2. **移除 `imagesPerReference` 滑块**（`i18n/messages/en/studioCreative.ts:86-87`）——
   按新公式它的语义没有了。Generate 按钮旁直接显示矩阵结果
   （"3 张产品图 × 2 张风格 = 将生成 6 张"）。相关 i18n key 改写并补齐 **19 个语言包**。
3. **占位先行、出一张填一张**：点 Generate 后立刻创建全部 N 个占位卡，
   每完成一个就地替换，**不等全部跑完**。
4. **排队分批**：把 N 个组合切批提交，批大小取自 **provider 实际能力**。
   `MAX_IMAGES_PER_REQUEST` 的角色从"产品上限"**降级为"单批传输上限"**——
   它只决定切几批，**不再截断用户的请求**。
5. **超量确认**：`expectedOutputCount` 超阈值（建议 20，可配）时弹一次确认
   （"将生成 N 张，预计耗时约 X 分钟"），**提醒但不阻止**。
6. ~~`generateAiVersions.ts:73` 的 `referenceImages[0]` 必须废掉。~~
   **❌ 这句判断是错的，2026-09-04 取证后撤回。**
   `referenceImages[0]` 不是 bug，它在**如实反映后端能力**——
   `backend/generator.py` 的输入模型只接受**一张**参考图（见 §2.3B）。
   废掉它而不改后端，只会让前端传一个后端读不到的字段。

**新增禁止**：不许保留任何会截断用户请求的产品级上限；不许按套餐分级限制界面可选数量。

---

### 2.3B D-3 取证结果（2026-09-04）——**推翻了一个隐含假设**

**链路**（读代码得出，非推断）：
`generateAiVersions` → `POST /api/generate` → spawn `backend/generator.py`
→ **LINAPI**（`api.linapi.net`，默认模型 `gemini-3.1-flash-image-preview`）

| 事实 | 证据 | 对 T-06 的影响 |
|---|---|---|
| `count` **已经是并行的** | `generator.py:2057` `"starting {count} image generation(s) in parallel"`；`2059-2067` 为每个输出生成独立 variant prompt | **"排队分批"底层已具备**，不需要新建排队机制 |
| 参考图**只能有一张** | `generator.py:95-99` `_input_ordering()`：产品图是 `product` 角色可多张，参考图只有 `product_count + 1` 一个位置 | **矩阵组合无法直接实现** |
| prompt 假定"所有产品同框" | `generator.py:707` `"Feature most or all of the {product_count} provided products together in one cohesive scene"` | "每个产品配每个风格"与当前 prompt 语义冲突 |

**后端当前语义**：N 张产品图 + 1 张参考图 → 一个场景；`count` = 同一组输入生成几个变体。
**用户要的语义**：产品图 × 参考图 的矩阵组合。**两者不一致。**

**两条路（待用户裁决）**：

| 路线 | 做法 | 代价 |
|---|---|---|
| **A. 前端循环调用** | 对每张参考图各发一次请求，每次带全部产品图 | 后端零改动、风险低；但多次请求各自计量/计时，矩阵语义由前端拼出，非后端保证 |
| **B. 后端支持多参考图** | 改 `generator.py` 输入模型与 prompt 构造 | 语义正确、一次请求一次计量；但要动 `_input_ordering` / `_build_image_manifest` / `_v2_image_role_preamble` 等 prompt 核心，**高风险区** |

**还需用户澄清**：「每个产品配每个风格」是指
(a) 每张图里**只有一个**产品（产品A×风格1、产品A×风格2……），还是
(b) 每张图里**所有产品同框**、只是风格不同？
后端当前 prompt 是 (b)。两种理解产出完全不同，**不推断**。

**T-06 在此裁决前保持阻塞。**

---

### 2.4 CP-12b —— BatchEditDrawer Hook 顺序（React #310）

**证据** `web/src/components/studio/BatchEditDrawer.tsx`

```ts
897    usePublishAssistantContext(assistantBatchContext, open, [assistantBatchContext]);
899    if (!open) return null;              // ← 早退
...
936    const handleGenerateCopyBatch = useCallback(async () => {   // ← 早退之后的 Hook
```

`open=false` 时渲染在 899 行停止，执行了 N 个 Hook；
`open=true` 时执行 N+1 个。false→true 转换必然触发
React #310 "Rendered more hooks than during the previous render"。

我已核对 899→1130 区间内**只有这一个** Hook，所以修复面很小。

**改法**：把 `handleGenerateCopyBatch` 整体移到 899 行之前。
**不接受**：把它改成普通函数（会丢引用稳定性，可能引入新的重渲染问题）——
移动位置即可，不改语义。

---

### 2.5 CP-13a —— 一条坏草稿阻断整批

**证据** `web/src/app/api/pin-drafts/route.ts`

```ts
189    for (const item of raw) {
190      const d = item as Partial<IncomingDraft> | null;
191      if (!d || typeof d.draftId !== "string" || ...) {
192        return jsonError(400, "bad_request", "Each draft needs draftId, updatedAt (ISO) and payload (object)");
       //   ↑ 第一条不合法就 return，同批其余合法草稿全部丢弃
       }
196      if (Buffer.byteLength(JSON.stringify(d.payload), "utf8") > MAX_PAYLOAD_BYTES) {
197        return jsonError(413, "payload_too_large", `Draft ${d.draftId} payload exceeds 200KB`);
       }
...
293    // 配额门禁同样是整批 429
362    return Response.json({ applied: rows.length, skippedStale });   // ← 批级响应，无逐条 outcome
```

**与 0901 PRD 的差异**：PRD 说有两条 422
（`destination_not_schedulable` / `destination_unavailable`）。
**这棵树上没有任何 422**，这两个 code 全仓库零命中。
但**整批阻断的形状一模一样**，只是触发码是 400 / 413 / 429。

**失败场景**：用户有 20 条待同步草稿，其中 1 条 payload 超 200KB
→ 整批 413 → 另外 19 条永远同步不上去，且客户端会一直重试这个必然失败的批次。

**改法**
1. `PUT` 响应改为逐条 outcome：
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
2. 只有 **request-level** 错误（JSON 解析失败、缺认证、整个 envelope 不可识别）
   才允许拒绝整批。单条的 payload/destination/quota/stale 问题**必须隔离到该 draftId**。
3. 保留向后兼容：老客户端读 `applied`/`skippedStale` 仍能工作。

---

### 2.6 CP-13b —— 确定性拒绝被无限热重试

**证据** `web/src/lib/pinDraftSync.ts`

```ts
367      if (!res.ok && res.status !== 202) throw new Error(`pin-drafts PUT failed: ${res.status}`);
368      if (res.status === 202) throw new DeferredError();
369      ackEntries(chunk);          // ← 只在整块成功时 ack，没有部分 ack
...
388    } catch {
389      // Outbox entries stay put — exponential backoff (capped at backoffMaxMs), forever.
390      _failureCount++;
391      maybeEnterError();
393      scheduleRetry(() => void flush());
314    const delay = Math.min(_opts.backoffBaseMs * 2 ** Math.max(_failureCount - 1, 0), _opts.backoffMaxMs);
       // backoffMaxMs = 60_000
```

任何非 2xx 都落进同一个 `catch`，整个 outbox 原地保留，60 秒一次**永远**重试。
一条 413 会被无限重发。

**改法**
1. `flush()` 解析 `outcomes[]`，逐条处理：
   - `applied` / `stale`（已 merge）→ ack，从 outbox 移除
   - `rejected` → 移出重试队列，进入 `action_required`，**停止自动重试**
   - `deferred` → 保留，有界退避
2. `ackEntries(chunk)` 改成 `ackEntries(appliedDraftIds)`。
3. `action_required` 只有在用户修正该草稿、产生新 `updatedAt` 后才重新入队。

---

### 2.7 CP-13c —— 存储不分账号 + 登出不清理（跨账号数据泄露）

**证据 1** `web/src/lib/pinDraftStore.ts`
```ts
33   const STORE_KEY = "vp:pin_drafts:v1";   // ← 全局常量，无 userId / workspaceId
```

**证据 2** `web/src/app/app/layout.tsx`
```ts
388  async function handleLogout() {
389    await supabase.auth.signOut();
390    router.push("/login");
391    router.refresh();
392  }
```
三行，**没有**停止同步引擎、**没有**清空/冻结 store scope。

**证据 3** `web/src/lib/pinDraftSync.ts:194` —— `initPinDraftSync` 有模块级 `_initialized` latch，
早退；唯一的重置出口是 `__resetPinDraftSyncForTests`。
`layout.tsx:327-335` 的 `useEffect` deps 是 `[]` 且**没有 cleanup return**。

**失败场景（本项最严重）**：A 在公用浏览器登出、B 登录 →
同步引擎从未停过，outbox 里还是 A 的草稿 → `getToken` 读到的已经是 B 的 session →
**A 的草稿被以 B 的身份提交到 B 的账号下**。这既是数据泄露也是数据污染。

**2026-09-03 用户新增要求（D-6）：账号数据必须跟着账号走。**
换浏览器/换电脑登录后草稿仍在。**服务器是事实源，浏览器本地只是离线缓冲。**

**已实测的好消息**：服务器骨架已经具备——
`GET /api/pin-drafts`（route.ts:117-139）按 `vibepin_user_id` 回读并分页，
`pullAllPages()`（pinDraftSync.ts:248-276）会翻页拉全量。
**所以"换浏览器看不到"不是缺功能，是同步链路坏了**：
一条坏草稿 → 整批 413/422 → 无限重试 → 后续草稿永远推不上服务器 → 换浏览器自然是空的。
**修好 CP-13a/b 就解决了大半**，本项补齐最后一环。

**改法**
1. `STORE_KEY` 改为 `vp:pin_drafts:v2:${ownerUserId}:${workspaceId}`。
   保留 v1 的一次性迁移读取（**D-4 已定：只在能确认 owner 时迁移，否则丢弃**）。
2. 导出 `stopPinDraftSync()`：清 timer、清 in-flight、复位 `_initialized`。
3. `handleLogout` 改为：先 `stopPinDraftSync()` + 冻结 A scope，再 `signOut()`。
4. `layout.tsx` 的 init effect 加 cleanup return，deps 带上 owner 身份。
5. 无法确认 owner 时 **fail closed**（不读、不写、不提交）。
6. **新浏览器首次登录先拉服务器数据再渲染**：owner scope 初始化时若本地为空，
   **先 `pullAllPages()` 回填**，期间显示"正在同步你的草稿"，
   **不要**先渲染空列表再异步补（会让用户以为草稿丢了）。

---

### 2.8 CP-14 —— 卡片和发布路径各自凭空造发布目标

**证据 1（helper 的 legacy 投影）** `web/src/lib/contentDraftModel.ts:97-107`
```ts
export function contentDestinations(draft: ContentDraftLike): PublishDestination[] {
  const explicit = (draft.publishDestinations ?? []).filter(item => item?.id && item?.provider);
  if (explicit.length) return explicit;
  if (!draft.boardId && !draft.boardName && !draft.remotePinId && !draft.publishError) return [];
  return [{ id: `${draft.id}:pinterest`, provider: "pinterest",
            boardId: draft.boardId, boardName: draft.boardName }];
}
```

**证据 2（卡片再造一次）** `web/src/components/studio/PinBoardCard.tsx:588`
```tsx
{(destinations.length ? destinations : [{ id: `${draft.id}:pinterest`, provider: "pinterest" as const }]).map(...)}
```

**证据 3（发布路径又造一次）** `web/src/components/studio/StudioBoard.tsx:452-453`
```ts
let destinations: PublishDestination[] = contentDestinations(d);
if (!destinations.length) destinations = [{ id: `${id}:pinterest`, provider: "pinterest",
                                            boardId: d.boardId, boardName: d.boardName }];
```

**证据 4（空名兜底成字面量 "Pinterest"）** `web/src/components/studio/PinBoardCard.tsx:95-99`
```ts
function customerFacingBoardName(...names: Array<string | null | undefined>): string {
  const name = names.map(item => item?.trim()).find(item => item
    && !/^(qa board|vibepin sandbox demo board|sandbox demo board)$/i.test(item));
  return name || "Pinterest";
}
```

**这是本版对 0901 PRD 的第二处重要修正。**
PRD 说的是"chip 用宽松 helper、确认框用严格 helper，两者漂移"。
实测：`explicitPublishDestinations` 和 `scheduledDestinations` **在本树完全不存在**；
卡片和发布路径**用的是同一个宽松 helper，而且各自还额外兜底一次**。

所以真正的缺陷不是"两边不一致"，而是：
**"零发布目标"这个状态在 UI 上根本不可达。**
一个从未选过目标的草稿，与一个真的发往名叫 "Pinterest" 的 Board 的草稿，
在界面上**完全无法区分**。用户以为选好了，其实没有。

**改法**
1. 删除 `PinBoardCard.tsx:588` 和 `StudioBoard.tsx:453` 两处兜底。
2. 新增 `explicitPublishDestinations(draft)`：**只**返回明确保存的
   `publishDestinations[]`（provider + connectionId + 账号身份 +（Board/Page））。
3. 卡片：`explicitPublishDestinations()` 为空 → 渲染中性的
   "尚未选择发布目标"，可点击直接打开 destination picker。
   `contentDestinations()` 的 legacy 投影**只**用于展示历史 posted/failed 记录，
   不得用于"接下来会发到哪"。
4. `customerFacingBoardName` 的 `|| "Pinterest"` 兜底删掉，
   空名走"尚未选择"，不伪装成 provider 名。
5. **不恢复任何默认 Pinterest / 默认账号 / 默认 Board。**

---

### 2.9 CP-14b —— 前置拦截只有一个转瞬 toast

**证据** `web/src/components/studio/StudioBoard.tsx:451, 474`
```ts
451  if (d.assetError || !isPublishableImage(d.imageUrl)) { toast.error(tr("...imageUnavailable")); return; }
474  if (!pinterestReady && !socialTargets.length) { setActiveId(id); toast.error(tr("...completeDetailsToPublish")); return; }
```

**改法**：拦截时写入卡片级持久状态（复用已有的
`setScheduleErrors` 模式，`StudioBoard.tsx:431` 已有先例），
在卡片上常驻显示原因 + 修复动作，修好后原位消失。toast 可保留但不能是唯一反馈。

---

## 3. 与 0901 PRD 的差异清单（施工前必读）

| 0901 PRD 假定 | 本树实测 | 影响 |
|---|---|---|
| `PUT /api/pin-drafts` 有 2 条 422 | 无任何 422；整批阻断码是 400/413/429 | CP-13a 是**新建**契约，不是改分支 |
| `explicitPublishDestinations()` 存在 | 不存在 | CP-14 要新写 |
| `scheduledDestinations[]` 字段 | 不存在（是 `publishDestinations[]`） | 字段名要对齐 |
| `runAiGeneration.ts` | 不存在 | 生成仍内联在 StudioBoard |
| `selectedReferences.ts` | 不存在 | group/slot 要新建 |
| `generationRecovery.ts` | 不存在 | recovery 要新建 |
| `meterGeneration.ts` / `settleGenerationJob.ts` | 不存在（计量在 `lib/server/usage.ts`） | 路径要对齐 |
| `/api/generation-jobs/[id]` 路由 | 不存在 | 无 job 轮询，恢复链要重新设计 |
| `onPlaceholdersReady` / `onSettled` | 不存在 | CP-11 改的是 `handleAiGenerate` 内联流程 |
| CP-12 只是"没相乘" | 服务端上限默认 **2** | 只改前端无效 |
| CP-14 是"chip/gate 漂移" | 两边各自造假目标，"零目标"不可达 | 修复面更大 |

**结论**：0901 PRD §15「代码影响面」表**不能直接派给执行代理**。
必须用本文档 §2 的 file:line 作为施工依据。

---

## 4. 目标数据契约

```ts
// —— 生成 ——
type GenerationIntent = {
  intentId: string;              // 稳定，重试/刷新/replay 复用
  ownerUserId: string;
  workspaceId: string;
  setupRevision: string;
  fingerprint: string;           // owner+workspace+资产身份+方向+model+format+count+retryTarget
  retryOfIntentId?: string;
  state: "drafting" | "persisting" | "accepted" | "generating"
       | "partial" | "completed" | "failed" | "unknown" | "cancelled";
  expectedOutputCount: number;   // = max(products,1) × max(refs,1)  ← 09-03 改为矩阵组合
  groups: GenerationGroup[];
  toastId: string;               // `generation:${ownerScope}:${intentId}`
};

type GenerationSlot = {
  groupId: string;
  referenceImageKey: string | null;
  slotIndex: number;             // 组内序号，不是全局数组下标
  placeholderDraftId: string;
  status: "pending" | "done" | "failed";
  resultDraftId?: string;
  errorCategory?: string;        // 安全类别，不是 raw provider body
};

// —— 草稿同步 ——
type DraftSyncOutcome = {
  draftId: string;
  status: "applied" | "stale" | "rejected" | "deferred";
  updatedAt?: string;
  code?: "payload_too_large" | "destination_not_schedulable"
       | "destination_unavailable" | "quota_exceeded" | "stale" | "storage_unavailable";
  userMessageKey?: string;
  retryable: boolean;
};

// —— 发布目标 ——
type PublishDestination = {
  id: string;
  provider: "pinterest" | "instagram" | "facebook";
  connectionId: string;          // 必填，不再允许凭空构造
  accountIdentity: { id: string; label: string };
  boardId?: string;              // Pinterest
  pageId?: string;               // Facebook
  capabilityRevision: string;
  disabledReason?: string;
};
```

**`fingerprint` 禁止包含**：完整 prompt、完整 URL、图片 bytes、任何 secret。
它不得出现在 DOM、console 或 analytics 里。

---

## 5. 实施分期与派工

| Phase | 内容 | 建议执行模型 | 依赖 |
|---|---|---|---|
| **P-0** | 基线裁决（业务 PRD §7）+ 迁移取号 | **Fable + 用户** | 阻塞全部 |
| **0A-1** | CP-12b Hook 移位 | Sonnet | 无（最小、独立、先做拿信心） |
| **0A-2** | CP-10 原子保存 setup | Sonnet | 无 |
| **0A-3** | CP-11 单 toast + unknown 态 | Sonnet | 0A-2（共享 intentId） |
| **0A-4** | CP-12a group/slot + 服务端上限 | **Opus** | D-2 裁决 |
| **0C** | CP-14 / CP-14b destination 真实性 | **Opus** | Multichannel canonical 模型 |
| **0D-1** | CP-13a 服务端逐条 outcome | **Opus** | 无 |
| **0D-2** | CP-13b 客户端逐条 ack | Sonnet | 0D-1 |
| **0D-3** | CP-13c owner scoping + 登出清理 | **Opus** | 无（安全项，可与 0D-1 并行） |
| **1** | P1：CP-01..09、ST-01..05 | Sonnet | P0 全绿后 |
| **2** | 集成 + 两轮 USER E2E | Fable 主导 | 全部 |

**派工纪律**（依据 `feedback_model_allocation_subagents`）：
- 执行一律派 Sonnet/Opus，Fable 只做 advisor + 终审
- 任何执行代理**连续两次修复失败 → 停止重试**，把失败现场带回主对话由 Fable 裁决
- 每个 Phase 完成后 Fable 独立复核（不轻信子代理自述的"N/N 通过"，必须主对话复跑一次）

---

## 6. 检测、验证与测试

这一节是本文档的核心交付。分三层：**自动化**（可重复、进 CI）、
**人工 USER 验收**（不可自动化的真实感知）、**副作用审计**（证明没有意外写入）。

### 6.1 基线：先量出"当前的红"

**任何修复动作之前**，必须先在 clean worktree 上跑一次并存档，
否则无法区分"我引入的失败"和"本来就红的"。

```bash
# 在干净 worktree 里（不要在脏树上跑 —— 见 CLAUDE.md 验证纪律）
cd web
npm run typecheck                 # 期望 0 error
npm test                          # core + studio + plan
npm run validate:i18n
npm run validate:i18n-coverage
```

**已知基线**：`npm test` 当前红 4（记忆 `project_reference_recs_p0_impl_20260828`
记录为基线失败，非本期引入）。修复后必须仍是**同样这 4 条**，
新增任何一条都要当场定位，不许用"重跑一次绿了"糊弄。

### 6.2 新增自动化测试（逐 P0 对应）

每个新 `scripts/test-*.ts` **必须**注册进 `scripts/test-registry.ts`
的 CORE / STUDIO / PLAN / EXCLUDED 之一，否则 `npm run check:test-registry` 会挂。

| 测试脚本 | 覆盖 | 断言要点 | 组 |
|---|---|---|---|
| `test-generation-setup-atomic.ts` | CP-10 | 调用 `doGenerate` 后 `onSetupChange` 已被调用且携带当前 `referenceUrls`；顺序在 `onGenerate` **之前** | STUDIO |
| `test-generation-single-toast.ts` | CP-11 | 一次 attempt 内所有 toast 调用共享同一 `id`；pending 用 `loading` 不用 `success`；全失败后不残留 pending | STUDIO |
| `test-generation-groups.ts` | CP-12a | `expected=max(products,1)×max(refs,1)`；3×2 → 6 slot；每 slot 有 `{productImageKey,referenceImageKey}` 且组合唯一不重复；**下标不参与身份**；占位在首个结果返回前已全部创建 | STUDIO |
| `test-generation-count-cap.ts` | CP-12a | **守"不截断"**：给定 6 个组合的请求，服务端不得夹成 2；`MAX_IMAGES_PER_REQUEST` 只影响切几批，不影响最终产出总数 | CORE |
| `test-batch-edit-hook-order.ts` | CP-12b | **运行时**渲染 closed→open→closed，捕获 React 错误；**不得**只做源码字符串断言 | STUDIO |
| `test-pin-drafts-per-draft-outcome.ts` | CP-13a | 混合批次（1 合法 + 1 超限）→ 合法条 `applied`、坏条 `rejected`；响应含 `outcomes[]` | CORE |
| `test-pin-draft-sync-partial-ack.ts` | CP-13b | 收到混合 outcome 后只 ack `applied`；`rejected` 移出重试队列且**不再自动重试**；`deferred` 有界退避 | CORE |
| `test-pin-draft-owner-scope.ts` | CP-13c | store key 含 owner；A 写入后切 B，B 读到空；`stopPinDraftSync()` 后无 in-flight | CORE |
| `test-explicit-destinations.ts` | CP-14 | 只有 legacy `boardId` 的草稿 → `explicitPublishDestinations()` 返回 `[]`；卡片不渲染可发布 chip；`customerFacingBoardName` 不再返回 `"Pinterest"` 兜底 | STUDIO |

**测试写法纪律**（0901 PRD §16 的要求，本版保留）：
源码字符串断言可以做 guard，但**不能是** Hook order、44px 触控热区、single toast、
矩阵数量、owner 隔离、recovery 这六项的**唯一**证据。这些必须有运行时行为断言。

### 6.3 人工 USER 验收（两轮 × 两个视口）

同一个 runtime/deployment，`1440×900` → `390×844`，Round 2 必须刷新重开，
不能沿用 Round 1 的 DOM。

#### 核心 12 例（P0 直接对应，不可省）

| Case | 覆盖 | 操作 | PASS 判据 |
|---|---|---|---|
| **U-01** | 环境 | 登录 Preview 进 `/app/studio` | runtime/deployment/测试库 ref 可核；owner 正确；**无生产 ref** |
| **U-02** | CP-10 | 选 2 张参考图 → 关闭抽屉 → 重开 | 2 张参考图仍选中 |
| **U-03** | CP-10 | 选参考图 → 直接 Generate → 生成结束后重开抽屉 | 参考图/方向/model/count **全部回填** |
| **U-04** | CP-11 | 触发全部成功的生成 | **只有一条** toast，原地从"正在生成"变绿 |
| **U-05** | CP-11 | 触发全部失败的生成 | **只有一条** toast 原地变红；绿色"正在生成"**已消失**；无孤儿占位卡 |
| **U-06** | CP-11 | 触发部分成功 | 一条中性终态，成功数+失败数与占位卡一致；成功结果保留 |
| **U-07** | CP-11 | 快速双击 Generate | 只有一个 intent / 一批占位 / 一次扣量；**无第二条 toast** |
| **U-08** | CP-12a | 选 3 张产品图 + 2 张参考图 | UI 明确显示 **6**；**点击后立刻**出现 6 个占位并逐张填入（不等全部跑完）；组合归属稳定；超量时先提醒不阻止 |
| **U-09** | CP-12b | Batch 关→开→关，单选→双选→清空，刷新 | 控制台 **0 个 React #310** |
| **U-10** | CP-13a/b | 同批 1 条正常 + 1 条超 200KB | 正常那条**服务器已保存**；坏那条显示"需要处理"并指出是哪个 Pin；**不无限重试** |
| **U-11** | CP-13c | A 建草稿 → 登出 → B 登录 → A 重登 | B 侧对 A 内容 **0 请求 / 0 job / 0 扣量**，界面看不到 A 内容；A 重登后自己的待同步还在 |
| **U-11B** | CP-13c / D-6 | A 在浏览器 1 建草稿并等同步完成 → **换全新浏览器配置**登录 A | **草稿全部可见**；不出现"先空一下再填上"的闪烁；加载期显示"正在同步你的草稿"而非空状态 |
| **U-12** | CP-14 | 准备三类草稿：仅 legacy Board / 明确零目标 / 一个合法目标 | 前两类显示"尚未选择发布目标"**且可点击进选择器**；第三类显示真实 provider+账号+Board；点发布被拦时**卡片上有持久原因** |

#### 补充例（P1 / 通用门禁）

| Case | 覆盖 | PASS 判据 |
|---|---|---|
| U-13 | ST-01..05 桌面 | 无常驻全宽 Banner；≥2 列；Plan 只有一个控制；Publish 是唯一主 CTA |
| U-14 | ST-02/04 移动 390 | `documentElement.scrollWidth ≤ 390`；单列；触控热区 ≥44×44 |
| U-15 | CP-03/ST-05 | missing / decode error / 1×1 / broken URL / loading 超时 → **统一深灰**；无粉紫、无乱码 alt、无永久 spinner |
| U-16 | i18n | 切 简中 / 繁中 / English，无 `Review` `No image` `No board` `Studio Board V2` `QA Board` 等内部词 |
| U-17 | A11y | 键盘可达全部主要控件；焦点可见；toast 用同一 live-region；不靠颜色单独区分状态 |
| U-18 | 汇总 | 每轮结束：console 无 uncaught / 无 React invariant / 无敏感信息；意外写请求 **= 0** |

### 6.4 HTTP 与副作用审计

每轮记录**脱敏后**的 method / path / status / duration / requestId / 结果类别。

| 阶段 | 关键请求 | 判据 |
|---|---|---|
| Studio 载入 | `/app/studio`、session、draft GET | 200 或明确 redirect；owner 一致 |
| 生成提交 | `POST /api/generate` | intent/fingerprint replay 类别、group/slot 数、HTTP |
| 草稿同步 | `PUT /api/pin-drafts` | 逐 draft outcome/code、applied/rejected/deferred 计数 |
| 对照 | `PUT /api/user-store` | **单独判定**，202 不得计作 draft synced |
| 计量 | `/api/billing/usage` 或测试库 ledger | reservation / settle / replay 与净变化对账 |

**副作用边界表**：

| 动作 | 允许的副作用 |
|---|---|
| 打开 Studio、切 tab、开关 Drawer/Picker/Batch/Plan、单选双选、编辑后取消 | **零服务端写入** |
| 保存本地 setup | 仅 owner-scoped 本地状态；不触 provider / job / usage |
| 测试生成 | 测试 job / assets / reservation / usage；一次 intent；**不发布** |
| 草稿同步 | 仅对应 draft 的 `pin_drafts` 行；**不触** schedule / publish / generation / usage |
| 发布、OAuth、付款 | **本期全部禁止**，需另行 action-time 授权 |

### 6.5 数据库验证纪律（不可绕过）

```bash
# 任何写操作前，先打印并断言
echo "target project_ref = $REF"
test "$REF" != "jaxteelkecvlozdrdoog" || { echo "ABORT: production ref"; exit 1; }
```

- 一切 E2E / seed / 造用户 → **只用** `web/.env.test.local`（ref `snulmwprsahzqvdbyenc`）
- 不把生产数据复制进测试库；测试库只灌 schema + 合成数据
- 不用测试库凭据覆盖 `.env.local`
- 清理只在测试库执行；**永不**对生产库批量删除
- 若本期需要 migration：先 `git ls-files "backend/db/migrate_v*.sql"` 并扫
  `D:/wt/*`、`D:/代码/wt-*`、`C:/…/Temp/*` 全部 worktree 取号
  （记忆记录**下一个空号 v69**，但**必须现场复查**，不要照抄）

### 6.6 最终门禁清单

```
[ ] clean worktree（不是脏树）跑出的绿灯
[ ] tsc --noEmit           0 error
[ ] npm test               仅剩基线红 4，无新增
[ ] validate:i18n          绿
[ ] validate:i18n-coverage 绿（19 个语言包全覆盖新 key）
[ ] check:test-registry    绿（新测试已注册）
[ ] next build             成功
[ ] git diff --check       无空白错误
[ ] 9 项 P0 各有：行级 diff + 自动化测试 + USER 证据
[ ] 两轮 USER E2E，同一 runtime，1440×900 + 390×844
[ ] 副作用账本：意外写请求 = 0
[ ] Fable 终审 + Codex 裁决（不可用则记 NO VERDICT，不伪造 PASS）
```

---

## 7. 待裁决点（施工前必须由用户拍板）

| ID | 问题 | Fable 建议 |
|---|---|---|
| **D-1** | 在哪条世系施工？ | ✅ **已定：在当前 `feat/pinterest-production-transition` 上修，上线前再合并 5 条分支。**线上 = `dpl_GdtGTzX3`（`/api/version` 实测）；5 条分支实测均不在当前分支里；`2142aeeb` 已独立核实为纯视觉改动。**本轮不部署。** |
| **D-2** | 生成数量上限 | ✅ **已定（用户改写需求）：不写死上限**——API 有限制就排队分批；**数量 = 产品图 × 参考图**（矩阵组合，不是"参考图×每组N张"）；**界面上限不按套餐分级**；超量先提醒不阻止。详见 §2.3 修订说明 |
| **D-3** | CP-12a 的 provider 调用形态 / 单批能放几个组合 | ⏳ **仍未决**。需执行代理开工第一步取证（`generateAiVersions` 打的哪个后端、能否一次带多参考图、并发上限）。**不要凭推断** |
| **D-4** | `vp:pin_drafts:v1` → v2 的迁移策略 | ✅ **已定：能确认 owner 的迁移，认不出的丢弃。**跨账号污染风险高于丢失本地草稿 |
| **D-5** | P1（CP-01..09、ST-01..05）本轮做还是延后？ | ✅ **已定：分开做，先修 9 个 P0。**混在一起验收会互相掩盖 |
| **D-6** | 账号数据是否必须跨浏览器 | ✅ **已定（用户新增要求）：必须。**账号数据跟着账号走，换浏览器/电脑登录草稿仍在。服务器是事实源，本地只是离线缓冲。详见 §2.7 修订说明 |

---

## 8. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| 在错误世系施工 | 成果与线上/其他分支互相清洗 | D-1 先裁决；参考 `project_prod_rollback_incident_20260716` |
| 多会话并行改同一批文件 | 冲突 / 覆盖 | 本期文件面已列全（§2），开工前在主对话登记占用 |
| 新 i18n key 漏语言 | `validate:i18n-coverage` 红，阻断门禁 | 每个新 key 一次性补齐 19 个语言包 |
| 只改前端算法，服务端仍截断请求 | CP-12a 看似修好实则没修 | `test-generation-count-cap.ts` 专门守这条 |
| 用源码字符串断言冒充运行时证据 | Hook order / single toast 假绿 | §6.2 明确禁止；Fable 终审时逐项复核证据类型 |
| CP-13c 修一半（只改 key 不改登出） | 跨账号泄露仍然存在 | 三项（key + stop + logout）必须同时完成才算关闭 |

---

## 9. 附：不做的事（P2 预留）

多图 Content 模型、Link to Pin、Brand Kit、文字图层、发布前检查器、三方向 Fresh Pin。
本期任何实现都**不得**为这些预埋半成品状态或第二套事实源。
