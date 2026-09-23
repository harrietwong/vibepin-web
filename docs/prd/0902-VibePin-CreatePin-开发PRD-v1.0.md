> ⚠️ **已被取代（2026-09-03）**
>
> 本文档的「代码影响面」与当前工作树不符：它列出的 7 个文件
> （`explicitPublishDestinations`、`scheduledDestinations`、`runAiGeneration.ts`、
> `selectedReferences.ts`、`generationRecovery.ts`、`meterGeneration.ts` /
> `settleGenerationJob.ts`、`/api/generation-jobs/[id]`）在
> `feat/pinterest-production-transition` 上**并不存在**，`pin-drafts/route.ts` 也没有任何 422。
> 按本文档派活会去改不存在的文件。
>
> 请改用：
> - `0903-VibePin-CreatePin-业务PRD-v2.0.md`（为什么做）
> - `0903-VibePin-CreatePin-开发PRD-v2.0.md`（是什么 / 行级证据）
> - `0903-VibePin-CreatePin-实施PRD-v1.0.md`（怎么做 / 工单）

# VibePin Create Pin 开发 PRD v1.0

> 日期：2026-09-02
> 
> 类型：**开发需求文档（Development Requirements）**
> 
> 目标读者：开发工程师、技术 Lead
> 
> 状态：`DEVELOPMENT SPECIFICATION`
> 
> 授权范围：测试 Supabase；不授权 Production promote、真实发布或付款

---

## 1. 概述

### 1.1 产品目标

Create Pin 是 VibePin 的核心工作台，让用户从"选来源"到"生成、编辑、排期、发布"始终操作同一条可追踪的 Content。

### 1.2 设计原则

1. **单一事实源**：所有 UI 消费同一 canonical 数据模型
2. **诚实展示**：仅显示有明确来源的数据
3. **原子操作**：Generate 前原子保存，失败可恢复
4. **Owner 隔离**：账户数据隔离
5. **逐项失败**：一个坏 Draft 不阻断同批合法 Draft
6. **可选排期**：发布时间默认折叠

### 1.3 本次开发范围

| 类别 | 功能 |
|------|------|
| **P0 阻塞项** | 生成单次执行、Destinations 一致性、Draft sync 逐项失败、Style Reference 持久化、单一 Toast |
| **P1 核心功能** | 统一创建入口、商品来源展示、深灰 Fallback、选品灵感、AI Direction、Creative Direction 输入、Batch Edit 稳定性、Optional Schedule |
| **P2 扩展功能** | 多图 Content 模型、Link to Pin、Brand Kit、文字图层、发布前检查器、三方向 Fresh Pin |

### 1.4 非目标

1. 不建设 Insights、效果分析
2. 不在 Create Pin 内实现 OAuth 连接管理
3. 不创建第二套 Product catalog、generation lifecycle
4. 不授权 Production 部署、真实发布、付款
5. **暂不实现**：Brand Kit、文字图层、发布前检查器、三方向 Fresh Pin、CSV 批量、Pinterest Carousel 验证

---

## 2. 数据模型

### 2.1 Content 模型

```typescript
// 一条 Content 可以包含 1 到 N 张媒体
interface Content {
  id: string;
  ownerUserId: string;
  workspaceId: string;
  
  // 媒体
  media: Media[];  // 共享 Title, Description, Website URL
  primaryMediaIndex: number;  // Cover 索引
  
  // 内容字段
  title: string;
  description: string;
  websiteUrl: string;
  
  // 发布目标
  destinations: PublishDestination[];
  
  // 排期
  publishMode: "now" | "scheduled";
  scheduledAt?: string;  // ISO 8601
  
  // 状态
  status: "draft" | "scheduled" | "posted" | "failed";
  
  // 失败信息
  failureType?: "generation" | "publish";
  failureReason?: string;
  
  // 元数据
  createdAt: string;
  updatedAt: string;
}

interface Media {
  id: string;
  contentId: string;
  url: string;
  width: number;
  height: number;
  altText?: string;
  order: number;
  isPrimary: boolean;
}

interface PublishDestination {
  id: string;
  provider: "pinterest" | "instagram" | "facebook";
  connectionId: string;
  accountName: string;
  boardId?: string;
  boardName?: string;
  pageId?: string;
  pageName?: string;
  capability: string;
  disabledReason?: string;
}
```

### 2.2 ProductSource 类型

```typescript
type ProductSource =
  | "user_upload"
  | "url_import"
  | "shopify"
  | "amazon"
  | "product_opportunity"
  | "community_inspiration";
```

### 2.3 GenerationSetup 类型

```typescript
interface GenerationSetup {
  ownerUserId: string;
  workspaceId: string;
  setupRevision: string;
  productSelections: ProductSelectionSnapshot[];
  selectedReferences: ReferenceSnapshot[];
  referenceSelections: ReferenceSelectionSnapshot[];
  selectedDirectionId: string | null;
  committedDirectionBrief: string;
  modelKey: string;
  format: string;
  pinsPerReference: 1 | 2 | 3 | 4;
  variationMode: string;
}
```

### 2.4 GenerationAttempt 类型

```typescript
interface GenerationAttempt {
  generationIntentId: string;
  ownerUserId: string;
  workspaceId: string;
  immutableFingerprint: string;
  setupRevision: string;
  retryOfIntentId?: string;
  state: "drafting" | "persisting" | "accepted" | "generating" |
    "partial" | "completed" | "failed" | "unknown" | "cancelled";
  expectedOutputCount: number;
  groups: GenerationGroup[];
  jobId?: string;
  toastId: string;
  usageReservationId?: string;
}
```

### 2.5 DraftSyncOutcome 类型

```typescript
interface DraftSyncOutcome {
  draftId: string;
  status: "applied" | "stale" | "rejected" | "deferred";
  updatedAt?: string;
  code?: "destination_not_schedulable" | "destination_unavailable" |
         "quota_exceeded" | "stale" | "storage_unavailable";
  userMessageKey?: string;
  retryable: boolean;
}
```

### 2.6 Group 与 Slot 计算

```
groupCount = max(selectedReferences.length, 1)
expectedOutputCount = groupCount × pinsPerReference
```

**2 refs × count4 = 8 placeholders**，分 2 组，每组 4 个 slot。

---

## 3. 功能规格

### 3.1 P0: 生成单次执行 (CP-P0-01)

**问题**：`StudioBoard.handleAiGenerate` 把会改变状态的 `enqueueGeneration()` 当作探针，后续又执行一次。

**修复要求**：
```typescript
// handleAiGenerate 必须只执行一次
const handleAiGenerate = async () => {
  // 1. 先读取并规范化当前可见 setup
  const setup = readCurrentSetup();
  
  // 2. 校验 owner/workspace 与资产可访问性
  if (!validateAccess(setup)) return;
  
  // 3. 原子保存 setup snapshot
  const { intentId, fingerprint } = await saveSetupAtomic(setup);
  
  // 4. 只有保存成功后才提交生成
  await submitGeneration({ intentId, fingerprint });
  
  // 5. 一个 intentId 只对应一个 job
};
```

**禁止**：
- 先调用 `enqueueGeneration()` 探测模式，再调用一次真实执行
- 重复点击产生多个 job 或 placeholder

**测试验证**：
- 快速双击 Generate 按钮，只有一个 job 被创建
- Console 无 "Duplicate generation" 警告

---

### 3.2 P0: Style Reference 持久化 (CP-10)

**问题**：`AiVersionDrawer.closeDrawer()` 会 `saveSetup()` 但 `doGenerate()` 直接调用 `onGenerate`，导致 references 未写入 cache。

**修复要求**：
```typescript
// doGenerate 必须先完成原子保存
const doGenerate = async () => {
  // 1. 读取当前选中的 references、direction、model、count
  const setup = {
    selectedReferences: selectedRefs,
    selectedDirectionId: directionId,
    modelKey: model,
    pinsPerReference: count,
    // ...
  };
  
  // 2. 原子保存到 aiSetupCache
  await saveSetupAtomic(setup);
  
  // 3. 然后才执行生成
  await submitGeneration(setup);
};

// closeDrawer 不再是必需的保存时机
// 保存由 doGenerate 或 explicit save action 触发
```

**Owner 隔离**：
```typescript
// aiSetupCache 必须按 owner scope 隔离
interface AiSetupCache {
  [ownerUserId: string]: {
    [workspaceId: string]: GenerationSetup;
  };
}
```

**测试验证**：
- 选择 2 refs → 关闭 Drawer → 重新打开 → refs 仍然选中
- 生成失败 → 刷新页面 → 重开 Drawer → refs 仍然存在

---

### 3.3 P0: 单一 Generation Toast (CP-11)

**问题**：`onPlaceholdersReady` 使用 `toast.success` 表达 pending；`onSettled` 全失败时另建 `toast.error`，两条提示无稳定共享 id。

**修复要求**：

```typescript
// 生成流程
const handleGenerate = async () => {
  // 1. 创建稳定 toast id
  const toastId = `generation:${ownerId}:${intentId}`;
  
  // 2. 显示 pending toast（info 样式，不是 success）
  toast.loading(t("generating"), { id: toastId });
  
  // 3. 提交生成请求
  const result = await submitGeneration({ intentId, toastId });
  
  // 4. 同一 toast id 更新为终态
  if (result.state === "completed") {
    toast.success(t("generated_success", { count: result.successCount }), { id: toastId });
  } else if (result.state === "partial") {
    toast.warning(t("generated_partial", { 
      success: result.successCount, 
      failed: result.failedCount 
    }), { id: toastId });
  } else if (result.state === "failed") {
    toast.error(t("generation_failed"), { id: toastId });
  } else if (result.state === "unknown") {
    toast.info(t("confirming_results"), { id: toastId });
  }
};
```

**Toast 状态映射**：

| Attempt 状态 | Toast 类型 | 文案 |
|-------------|-----------|------|
| persisting / accepted / generating | loading/info | 正在生成... |
| completed | success | 生成完成，已创建 N 张图片 |
| partial | warning | 生成完成：N 张成功，M 张失败 |
| failed | error | 生成失败，请重试 |
| unknown | info | 正在确认结果... |

**禁止**：
- pending 状态使用 `toast.success()`
- 同时存在两条互相矛盾的 toast

**测试验证**：
- 生成中只显示一个 toast
- 完成后 toast 更新，不是新增
- 失败后无 "正在生成" 和 "未生成" 同时存在

---

### 3.4 P0: Draft Sync 逐项失败 (CP-13)

**问题**：服务端发现一个坏 Draft 就拒绝整批，导致合法 sibling 也失败。

**服务端修复** (`/api/pin-drafts/route.ts`)：

```typescript
// 批量 PUT 必须返回逐 Draft outcome
interface BatchDraftResponse {
  outcomes: DraftSyncOutcome[];
  failed: number;
  applied: number;
}

// 实现
const handleBatchPut = async (drafts: PinDraft[]) => {
  const outcomes: DraftSyncOutcome[] = [];
  
  for (const draft of drafts) {
    // 逐 Draft 验证
    const validation = validateDraft(draft);
    
    if (validation.ok) {
      // 写入数据库
      await upsertDraft(draft);
      outcomes.push({
        draftId: draft.id,
        status: "applied",
        updatedAt: new Date().toISOString(),
        retryable: false,
      });
    } else {
      // 验证失败，不阻断其他 Draft
      outcomes.push({
        draftId: draft.id,
        status: "action_required",
        code: validation.code,
        userMessageKey: validation.messageKey,
        retryable: validation.retryable,
      });
    }
  }
  
  // 只有 malformed JSON、缺失认证等 request-level 错误才拒绝整批
  return { outcomes, applied: outcomes.filter(o => o.status === "applied").length };
};
```

**客户端修复** (`pinDraftSync.ts`)：

```typescript
// 处理响应中的逐项结果
const handleSyncResponse = (response: BatchDraftResponse) => {
  for (const outcome of response.outcomes) {
    if (outcome.status === "applied") {
      // 移除 outbox 中对应的 item
      outbox.remove(outcome.draftId);
    } else if (outcome.status === "action_required") {
      // 标记本地 Draft 为需要处理
      localDrafts.update(outcome.draftId, {
        syncStatus: "action_required",
        actionCode: outcome.code,
        actionMessage: outcome.userMessageKey,
      });
    }
  }
  
  // 如果有 applied 项，触发 UI 更新
  if (response.applied > 0) {
    emit("drafts-applied", response.applied);
  }
};
```

**状态机**：

```
local_dirty → queued → syncing → synced
                         ├→ action_required（确定性语义拒绝）
                         ├→ deferred → retrying（有限自动重试）
                         └→ stale → merge_required → queued | synced
```

**测试验证**：
- 提交 1 合法 + 1 不可排期 Draft → 合法项 saved，坏项 action_required
- CP-A32、CP-A33 通过

---

### 3.5 P0: Destinations 一致性 (CP-01, CP-14)

**问题**：卡片使用 `contentDestinations()` 投影 legacy Board；发布确认只接受 `scheduledDestinations[]`。

**修复要求**：

```typescript
// PinBoardCard 必须只显示明确保存的 destination
const PinBoardCard = ({ draft }) => {
  // 获取明确保存的 destination
  const explicitDestinations = draft.scheduledDestinations ?? [];
  
  if (explicitDestinations.length === 0) {
    // 无明确 intent，显示引导文案
    return (
      <div className="no-destination">
        <span>尚未选择发布目标</span>
        <button onClick={() => openDestinationPicker(draft.id)}>
          选择发布目标
        </button>
      </div>
    );
  }
  
  // 只显示有明确保存的 destination
  return (
    <div className="destinations">
      {explicitDestinations.map(d => (
        <DestinationChip key={d.id} destination={d} />
      ))}
    </div>
  );
};
```

**Destinations 三态显示**：

| Draft 状态 | 卡片显示 | 发布行为 |
|-----------|---------|---------|
| 仅有 legacy Board/category | "尚未选择发布目标" | 需先保存明确 intent |
| 零 canonical destination | "尚未选择发布目标" | 需先保存明确 intent |
| 有合法 canonical destination | 真实 provider/account/Board chip | 进入确认框 |

**测试验证**：
- CP-A37 三类 Draft 对比通过
- Settings/单卡/Batch 三处 destination 一致

---

### 3.6 P1: 统一创建入口 (CP-04)

**桌面入口**：
```tsx
// StudioBoard.tsx
<CreatePinEntry>
  <EntryButton icon="upload" label="上传图片" onClick={() => openUpload()} />
  <EntryButton icon="link" label="从 URL 导入" onClick={() => openUrlImport()} />
  <EntryButton icon="product" label="从我的商品" onClick={() => openProductPicker()} />
  <EntryButton icon="ai" label="使用 AI 创建" onClick={() => openAiDrawer()} />
</CreatePinEntry>
```

**移动端入口**：
```tsx
// MobileActionSheet
<ActionSheet>
  <ActionSheetItem icon="upload" label="上传图片" onSelect={handleUpload} />
  <ActionSheetItem icon="link" label="从 URL 导入" onSelect={handleUrlImport} />
  <ActionSheetItem icon="product" label="从我的商品" onSelect={handleProductSelect} />
  <ActionSheetItem icon="ai" label="使用 AI 创建" onSelect={handleAiCreate} />
</ActionSheet>
```

**统一数据模型**：所有入口最终都创建 `Content` 或更新 `PinDraft`。

---

### 3.7 P1: Product Taxonomy (CP-05)

**来源文案对照**：

| 内部值 | 用户可见文案 | 图标 |
|--------|-------------|------|
| `user_upload` | 我的上传 | Upload icon |
| `url_import` | URL 导入 | Link icon |
| `shopify` | Shopify | Shopify icon |
| `amazon` | Amazon | Amazon icon |
| `product_opportunity` | 选品机会 | Lightbulb icon |
| `community_inspiration` | 社区灵感 | Users icon |

**产品选择后自动带入**：
```typescript
const handleProductSelect = (product: Product) => {
  // 自动带入图片
  setMedia(product.imageUrl);
  
  // 自动带入 URL（仅当为空时）
  if (!websiteUrl.trim() && product.publicUrl) {
    setWebsiteUrl(product.publicUrl);
    setUrlSource("product");
  }
  
  // 不覆盖用户已编辑的内容
};
```

---

### 3.8 P1: Media Fallback (CP-03, ST-05)

**统一深灰 Fallback**：

```tsx
const MediaFallback = ({ reason, label }) => (
  <div 
    className="media-fallback"
    data-reason={reason}
    style={{ background: "#1a1a1a" }}
  >
    <FallbackIcon reason={reason} />
    <span className="sr-only">{label}</span>
  </div>
);

// Fallback 场景
type FallbackReason = 
  | "missing"      // 资源不存在
  | "loading"       // 加载超时
  | "decode"        // 解码失败
  | "tiny"          // 尺寸太小
  | "broken"        // URL 无效
  | "generation";   // 生成失败
```

**禁止**：红、粉、紫背景；乱码；`No image`；永久 spinner。

---

### 3.9 P1: Product Inspiration (CP-06)

**状态机**：
```
idle → loading → ready(items>0)
                 → empty(items=0, request succeeded)
                 → error(auth|network|server|schema)
error → retrying → ready | empty | error
```

**错误文案**：

| HTTP | 用户文案 |
|------|---------|
| 401/403 | 登录已过期，请重新登录 |
| 404 | 资源不存在 |
| 429 | 请求过于频繁，请稍后重试 |
| 5xx | 服务暂不可用，请稍后重试 |
| timeout | 请求超时，请重试 |
| 200+[] | 暂无灵感 |

---

### 3.10 P1: AI Direction (CP-08, CP-09)

**Direction 卡片**：
```tsx
const DirectionCard = ({ direction }) => (
  <Card 
    selected={direction.id === selectedId}
    onClick={() => selectDirection(direction.id)}
  >
    <RepresentativeImage 
      src={direction.representativeImage} 
      fallback={<MediaFallback reason="generation" />}
    />
    <SourceTag>{direction.source}</SourceTag>
    <WhyItFits>{direction.rationale}</WhyItFits>
    <SelectionIndicator selected={direction.id === selectedId} />
  </Card>
);
```

**Creative Direction 输入**：
```tsx
const CreativeDirectionInput = ({ value, onSave, onCancel }) => {
  const [draft, setDraft] = useState(value);
  const [dirty, setDirty] = useState(false);
  
  return (
    <div className="creative-direction-input">
      <Label>Creative direction</Label>
      <Textarea 
        value={draft}
        onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
        onFocus={(e) => e.target.classList.add("focus")}
      />
      {dirty && (
        <ActionRow>
          <Button variant="ghost" onClick={() => { setDraft(value); setDirty(false); }}>
            Cancel
          </Button>
          <Button 
            variant="primary" 
            onClick={() => { onSave(draft); setDirty(false); }}
          >
            Save
          </Button>
        </ActionRow>
      )}
    </div>
  );
};
```

---

### 3.11 P1: Batch Edit 稳定性 (CP-12)

**出现条件**：`selectedIds.size >= 2`

**全屏表格布局**：
```tsx
const BatchEditDrawer = ({ selectedIds }) => (
  <Drawer fullscreen>
    <BatchEditHeader count={selectedIds.size} onClose={handleClose} />
    
    <BatchEditTable>
      <Column header="Image">
        {selectedIds.map(id => (
          <MediaCell key={id} draftId={id} />
        ))}
      </Column>
      <Column header="Title">
        {selectedIds.map(id => (
          <EditableCell key={id} field="title" draftId={id} />
        ))}
      </Column>
      {/* ... 其他字段 */}
    </BatchEditTable>
    
    <BatchEditFooter>
      <ImpactPreview />
      <BatchActions />
    </BatchEditFooter>
  </Drawer>
);
```

**React #310 防护**：
```typescript
// 所有 hooks 必须在任何 early return 之前
const BatchEditDrawer = ({ isOpen, selectedIds }) => {
  // 1. 先声明所有 hooks
  const [rowEdits, setRowEdits] = useState({});
  const [saving, setSaving] = useState(false);
  
  // 2. 然后才做条件判断
  if (!isOpen) return null;
  
  // 3. 使用 hooks 的逻辑
  const handleCellEdit = (draftId, field, value) => {
    setRowEdits(prev => ({ ...prev, [draftId]: { ...prev[draftId], [field]: value } }));
  };
  
  // ...
};
```

---

### 3.12 P1: Optional Schedule (CP-02)

**默认折叠**：
```tsx
const ScheduleSection = ({ publishMode, scheduledAt, onChange }) => {
  const [expanded, setExpanded] = useState(false);
  
  if (!expanded) {
    return (
      <button 
        className="schedule-toggle"
        onClick={() => setExpanded(true)}
      >
        <ClockIcon />
        <span>设置发布时间</span>
      </button>
    );
  }
  
  return (
    <div className="schedule-expanded">
      <ScheduleModeSelector
        value={publishMode}
        onChange={onChange}
      />
      {publishMode === "scheduled" && (
        <DateTimePicker
          value={scheduledAt}
          onChange={onChange}
        />
      )}
      <button 
        className="schedule-cancel"
        onClick={() => { onChange({ publishMode: "now", scheduledAt: null }); setExpanded(false); }}
      >
        取消
      </button>
    </div>
  );
};
```

---

### 3.13 P1: Studio 视觉 (ST-01..05)

| 台账 | 要求 |
|------|------|
| ST-01 | 移除常驻全宽失败 Banner；Failed badge 按 Pin 数计数 |
| ST-02 | 1440 多列，390 单列无横溢 |
| ST-03 | Plan 单按钮控制 hover/固定/关闭 |
| ST-04 | Publish 主 CTA；Schedule 次级 |
| ST-05 | 日常兜底统一深灰 |

---

## 4. i18n 与 A11y

### 4.1 i18n 要求

- 覆盖语言：English、简体中文、繁体中文
- 中文界面不能夹杂 `Review`、`Publish to`、`No image` 等英文
- Pin 计数按 Pin 使用正确单复数

### 4.2 A11y 要求

- 所有主要操作均可键盘操作
- 单一 generation toast 使用同一 live-region 节点
- 390px 触控目标 ≥44px
- 状态不能只靠颜色区分

---

## 5. HTTP 与可观测性

### 5.1 关键请求记录

| 阶段 | 记录 |
|------|------|
| Studio/auth | `/app/studio`、session、draft history |
| Product inspiration | GET；区分 200 empty、401/403、429、5xx |
| Upload | `/api/studio/upload` |
| Generation submit | `/api/generate` |
| Draft sync | `/api/pin-drafts` GET/PUT |

### 5.2 Console 禁止

- token、secret、password
- 完整 prompt、完整 URL query
- 图片 bytes、raw provider body

---

## 6. 代码影响面

| 责任 | 文件 |
|------|------|
| Drawer setup、Direction | `web/src/components/studio/AiVersionDrawer.tsx` |
| Toast、lifecycle | `web/src/components/studio/StudioBoard.tsx` |
| Batch Hook | `web/src/components/studio/BatchEditDrawer.tsx` |
| Generation request | `web/src/lib/studio/generateAiVersions.ts` |
| Recovery | `web/src/lib/studio/generationRecovery.ts` |
| Draft sync | `web/src/lib/pinDraftSync.ts`、`web/src/lib/pinDraftStore.ts` |
| Draft API | `web/src/app/api/pin-drafts/route.ts` |
| Generation API | `web/src/app/api/generate/route.ts` |
| Media fallback | `web/src/components/pins/PinFallbackArtwork.tsx` |

---

## 7. 测试矩阵

### 7.1 核心测试 Case

| Case | 覆盖 | 操作 | 验证点 |
|------|------|------|--------|
| CP-A01 | 全部 | 登录 Preview，进入 `/app/studio` | runtime/deployment 可核 |
| CP-A10 | CP-09 | 编辑、Cancel、Save Creative direction | 输入可编辑；Generate = committed 值 |
| CP-A11 | CP-10 | 选择 refs，关闭/重开 Drawer | 同 owner 恢复 |
| CP-A13 | CP-11 | 0→all success | 同一 toast id 原位变 success |
| CP-A14 | CP-11 | 0 success / all failed | 同一 toast id 原位 error |
| CP-A21 | CP-12 | UI 选择 2 refs×count4 | 明确总数 8 |
| CP-A22 | CP-12 | Batch closed→open→closed | 无 React #310 |
| CP-A28 | ST-01..05 | 桌面检查失败入口、Plan | 低噪声、单 Plan 控制 |
| CP-A32 | CP-13 | 1 合法 + 1 不可排期 Draft | 合法 applied，坏项 action_required |
| CP-A37 | CP-14 | 零目标/legacy/合法目标三类 Draft | 零目标显示"尚未选择" |

### 7.2 回归测试

- focused: CP-10/11/12 所有场景
- Studio: 完整 registry
- Backend: generation worker、slot attribution
- TypeScript: `tsc --noEmit`
- Build: Next webpack

---

## 8. 实施分期

### Phase 0A — 生成原子状态 (P0)
- 关闭 CP-P0-01：生成单次执行
- 关闭 CP-10：Style Reference 持久化
- 关闭 CP-11：单一 Toast
- 完成 focused + Studio + typecheck 全绿

### Phase 0B — 创建来源 (P0)
- 关闭 CP-03：深灰 Fallback
- 关闭 CP-06：选品灵感真实状态
- 关闭 CP-07：Upload→Recommend 链路

### Phase 0C — Destinations (P0)
- 关闭 CP-01：Batch 与单卡 canonical parity
- 关闭 CP-14：Legacy Board 不伪装

### Phase 0D — Draft Sync (P0)
- 关闭 CP-13：服务端逐 Draft outcome

### Phase 1 — 信息架构 (P1)
- 关闭 CP-02、CP-04、CP-05、CP-08、CP-09、ST-01..05

### Phase 2 — 集成与验收
- 在 test-bound Preview 集成所有依赖
- Round 1/2 全部 CP-A 系列有证据

---

## 9. 发布门禁

以下全部成立前，状态固定为 `PRODUCTION BLOCKED`：

1. CP-P0-01、CP-03、CP-06、CP-07、CP-10、CP-11、CP-12、CP-13、CP-14 所有 P0 关闭
2. CP-02、CP-04、CP-05、CP-08、CP-09 与 ST-01..05 已完成或有明确处置
3. 同一 runtime/deployment 完成两轮 USER E2E
4. 无 React #310、无矛盾 Toast、无乱码 Fallback
5. 无意外 upload/generation/schedule/publish/usage 写入

---

## 10. 检测、验证和测试清单

### 10.1 功能验证

| # | 检查项 | 验证方法 |
|---|--------|---------|
| 1 | 生成单次执行 | 快速双击 Generate，F12 network 只有一个 `/api/generate` 请求 |
| 2 | Style reference 持久化 | 选中 refs → 关闭 → 重开，refs 仍选中 |
| 3 | 单一 toast | Generate 成功只显示一个 toast，无矛盾信息 |
| 4 | 深灰 fallback | 断网/损坏图片，统一深灰背景 |
| 5 | 选品灵感状态 | 模拟 401/429，观察文案 |
| 6 | Batch Edit React #310 | 快速双击 Batch 开关，控制台无 Error |
| 7 | Destinations 一致性 | Settings/单卡/Batch 三处对比相同 |
| 8 | Draft sync outcome | 提交 1 合法 + 1 坏 Draft，确认逐项结果 |

### 10.2 视觉验证

| # | 检查项 | 验证方法 |
|---|--------|---------|
| 1 | 桌面 1440px | DevTools 1440px，确认两列无横溢 |
| 2 | 移动 390px | DevTools 390px，确认单列无横溢 |
| 3 | Failed banner | 确认无全宽 Banner |
| 4 | Plan 控制 | 确认只有一个按钮 |

### 10.3 HTTP/Console 验证

| # | 检查项 | 验证方法 |
|---|--------|---------|
| 1 | 无意外写入 | F12 network，确认 open/close drawer 不触发 POST |
| 2 | Console 无敏感信息 | 搜索 `token`、`secret`，应为 0 结果 |
| 3 | Console 无 Error | 无 Error:、React invariant |

---

## 11. 附录：P2 功能预留（暂不实现）

以下功能在调研报告中有涉及，但本次开发暂不包含：

### 11.1 多图 Content 模型

**功能**：
- 一条 Content 支持多张图片
- 多图上传选择弹窗：Publish together / Publish separately
- 跨卡片拖拽图片
- Media strip 管理

**影响文件**：
- `Content` 类型增加 `media[]` 字段
- 新增多图上传选择组件
- Draft card 增加 media strip
- 跨卡片拖拽逻辑

**暂不实现原因**：需要较大架构调整，等 P1 功能稳定后再评估。

### 11.2 Link to Pin

**功能**：
- 粘贴 URL 提取标题、描述、主图
- 智能图片过滤
- 安全门：鉴权、限流、SSRF 防护

**影响文件**：
- 新增 `urlImportService` 扩展
- 新增 Link to Pin UI 组件

**暂不实现原因**：需要安全审计。

### 11.3 Brand Kit、文字图层、发布前检查器

**影响**：需要产品设计、较大数据模型变更。

**暂不实现原因**：等主流程稳定。

### 11.4 三方向 Fresh Pin

**功能**：
- Product/scene 方向
- Text-led 方向
- Collage/list 方向

**暂不实现原因**：需要生成流程重构。

---

**文档版本**：v1.0
**创建日期**：2026-09-02
**状态**：DEVELOPMENT SPECIFICATION
