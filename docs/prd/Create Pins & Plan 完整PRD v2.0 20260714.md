# Create Pins & Plan 完整 PRD

**版本：** v2.0（整合版 — 取代 V1.0 与失败优化初稿 0713）
**日期：** 2026-07-14
**状态：** V1.0 + V1.1 已实施并部署；V1.2（本版新增需求）实施中
**取代：**
- 《Create Pins & Plan 工作流优化 V1.0》（含其附录 A）
- 《create pin和plan的失败情况优化 prd 初稿0713》

> 本文档描述 **当前代码的真实状态** + **本轮新增需求**。已实施项标 ✅，实施中标 🔨。

---

## 1. 产品原则

Pinterest-first · Pin-draft-first · Upload-first · Minimal UI · Cross-device persistence

**核心分工：**
- **Create Pins** = 未排程工作区（还没排上日程的活儿）
- **Plan** = 排程执行区（已上日历的内容）
- **Failed** = 失败恢复区（活在 Create Pins 的 Failed 筛选里，不单独建页）

---

## 2. 核心对象与生命周期

核心对象：**Pin Draft Card**

```
generating | failed | unscheduled | scheduled | posted
```
（`web/src/lib/studio/pinLifecycle.ts`）

**不新增 Publishing 生命周期** — 发布中用临时 in-flight UI 表达。

### 2.1 失败数据模型 ✅
```ts
failureType?:           "generation" | "publish"
errorCategory?:         "transient" | "content" | "auth"
previousScheduledTime?: string   // ISO
publishErrorCode?:      string   // needs_reconnect / board_not_owned / invalid_link …
```
全部走 `pin_drafts.payload` jsonb，零迁移。

### 2.2 服务端持久化 ✅
- 权威副本：`pin_drafts` 表（v38），payload jsonb + promoted 列
- v42 迁移新增：`scheduled_at`、`publish_claimed_at`（认领锁）+ partial index
- **铁律：任何服务端直写 payload 的路径必须 bump `payload.updatedAt`**，否则客户端 LWW 合并不收敛（曾导致重复发布的 blocker）

---

## 3. Create Pins 工作区

### 3.1 默认筛选 ✅
默认落 **Unscheduled**（不是 All）。筛选：`All / Unscheduled / Scheduled / Posted / Failed`。
会话内记住手动切换（sessionStorage `vp:studio:filter`）。

**空状态引导**：Unscheduled 为空但有 Scheduled 内容时 → "All pins are scheduled — view them in Plan"，而非通用上传空状态。

### 3.2 Header 布局 ✅
```
[Upload more]  [Select product]                    [History]
```
Upload 是 primary（渐变），Select product 是 secondary（描边），二者**并排**。

### 3.3 卡片操作矩阵 ✅
| 生命周期 | 展开态 footer |
|---------|--------------|
| unscheduled | Schedule 按钮 |
| scheduled | "Scheduled for …" + Open in Plan（**无 Schedule 按钮**） |
| posted | View Pin |
| failed | 见 §6 恢复矩阵 |

### 3.4 hover 自动展开编辑 🔨（本轮新增）
鼠标移入卡片 → 延迟 ~400ms（防误触）→ 自动展开编辑态（等同点 Edit）。
- 移出**不自动收起**（可能正在编辑）
- 一次只展开一张（沿用 activeId）
- hover 卡内按钮不干扰

---

## 4. 必填校验（本轮重大修订）🔨

### 4.1 真实约束
**只有两项阻断发布：**
| 字段 | 必填 | 理由 |
|------|------|------|
| **图片** | ✅ 必填 | 没有媒体无法成 Pin；且必须是 public http(s) |
| **Board** | ✅ 必填 | Pinterest create-Pin API 唯一的 required（publishPin.ts:75） |
| Title | ❌ 可选 | 服务端 `?:` 可选，Pinterest 不要求 |
| Description | ❌ 可选 | 同上 |
| Alt text | ❌ 可选 | 同上 |
| Website URL | ❌ 可选 | PRD §7，推荐但从不阻断 |

**修订理由**：前端此前把 title/description/altText 列为必填，与服务端真实契约（`publishPinForUser` 全部可选）矛盾，是纯前端的过度限制。

### 4.2 仍然保留的硬校验
- 图片必须 public http(s)（非 blob/data/localhost）
- Board 必填
- Website URL 非空时必须是合法 http(s)
- 字符上限：title ≤100、description ≤500（服务端同步截断）
- Pinterest 连接有效 / token 未失效

### 4.3 校验体系统一 ✅
唯一入口 `web/src/lib/pinReadiness.ts` 的 `pinMissingFields()`。
`pinDetailsModel.getPinReadiness` 只是转接层（内部调 canonical），Studio / Plan 抽屉 / Batch Edit 全部共用——**不允许第二套校验**。

---

## 5. AI Copy ✅

**UI 只有一个操作：`Generate copy`**（长度/语言控件已收起，API 参数保留供未来 Settings 恢复）。

写入规则：
| 场景 | 行为 |
|------|------|
| title + description 都空 | 全部生成 |
| 只有一个空 | **只填空字段**，不覆盖已有 |
| 都有内容 | 弹确认："Replace existing text with AI copy?" → [Cancel] / [Replace with AI copy] |

失败：保留现有字段、不写 filler、不清空手输内容。

---

## 6. 失败处理（V1.1 核心）✅

### 6.1 Banner — 温和且会消失
- **视觉**：琥珀色圆角警示卡（非全宽深红横幅）
- **文案**：`{n} Pins failed to publish` + "Review the errors and choose how to continue." + `Review failed Pins` + `×`
- **消失语义**（关键修订）：
  - **点击 CTA = 等同 dismiss**（用户已在处理，不再纠缠）
  - 处于 Failed 视图时**无条件不渲染**
  - `×` = 会话级 dismiss
  - **新失败（计数上升）时重现**
  - 计数归 0 时彻底消失
- **只统 publish failure**，不含 generation failure

### 6.2 统计区常驻小提醒
Plan 的 `CompactSummaryBar` 显示 `⚠ N failed`（警示色、可点击、与 Banner 同源计数）。
点击行为与 Banner CTA **统一**：跳 Create Pins Failed 视图（Publish failures 子筛选）。

**设计意图**：Banner 可关闭，但失败数永不消失 —— 解决"可关闭"与"不能遗忘"的矛盾。

### 6.3 Failed 子筛选
二级 chips：`Publish failures (n)` / `Generation failures (n)` / `All (n)`
- Banner CTA / 统计区进入 → 默认 **Publish failures**（数字与 Banner 一致）
- 手动点 Failed chip → 默认 **All**

### 6.4 失败卡文案（收紧版）
| 元素 | 文案 |
|------|------|
| 徽章 | `Publish failed` / `Generation failed` |
| 错误标题 | 具体 publishError 原文 |
| transient 提示 | Usually temporary — try publishing again. |
| content 提示 | Fix the Pin details, then retry. |
| auth 提示 | Reconnect Pinterest, then retry. |
| 原排程 | `Was scheduled: Jul 10, 09:38` |

### 6.5 恢复操作矩阵
| errorCategory | 主按钮 | 次按钮 | More |
|--------------|-------|-------|------|
| transient | **Retry publish** | Edit | Move to Unscheduled / Delete |
| content / 未知 | **Edit** | Retry publish | Move to Unscheduled / Delete |
| generation 失败 | Try again（重新生成） | Edit | Regenerate / Delete |

**Move to Unscheduled**：清排程 + 清活跃错误，保留 `previousScheduledTime` 作历史；Draft 字段与 Product 关联不变。

### 6.6 图片兜底 🔨
图片加载失败（死链/过期）→ 显示居中 `ImageOff` 图标（复用 studio 缩略图兜底样式），**不再露出纯色底块**。

---

## 7. Product 与 URL ✅

**铁律：Product URL 与 Website URL 严格分离。**

1. 选择 Product **不自动填** Website URL
2. 解除 Product 关联**不清空** Website URL
3. Shopify Product URL 更新**不回写**已有 Draft
4. 想用 Product 链接 → 显式点 `[Use product link as destination]`
   - URL 为空 → 直接填入
   - URL 已有值 → 确认弹窗 "Replace the current destination URL?" → [Keep current URL] / [Use product link]

Batch Edit 的 URL 四模式保留：`fill_empty` / `replace` / `product` / `clear`

---

## 8. 发布 ✅

### 8.1 命名统一
全产品只用 **`Publish now`**（已删除 "Pin now" 残留）。

### 8.2 确认弹窗
```
Publish this Pin now?
This will publish the Pin to Pinterest immediately instead of at its
scheduled time. The scheduled time will be removed.
[Cancel] [Publish now]
```
（第二句仅当有排程时间时显示）

### 8.3 失败落库统一
**三条发布路径（Studio 单卡 / Plan 抽屉 / cron）失败时字段必须一致**：
```
publishError + failureType:"publish" + errorCategory + publishErrorCode
+ previousScheduledTime + 清除 scheduledDate/scheduledTime
```
成功时清理全部失败字段。（曾有 Studio 单卡漏写 failureType 导致 Banner 漏统的 bug）

---

## 9. 自动到期发布 ✅（V1.0 新建能力）

**架构**：
```
排程 → promote scheduled_at 列
     → VPS crontab (*/5min, Bearer CRON_SECRET)
     → GET /api/cron/publish-due
     → 原子认领（条件 UPDATE … RETURNING，10min 锁过期）
     → publishPinForUser()
     → 回写 posted / failed（必须 bump payload.updatedAt）
```

- **Vercel Hobby cron 一天只能一次，不可用** → 用阿里云 VPS crontab
- 单次限批 ≤20（maxDuration 300s 内）
- 逐行独立 try/catch，一个账号失效不影响整批
- Trial-access 错误**不算失败**（只释放锁、保留排程，等权限批准）

**已知 MVP 限制**：
- 认领后崩溃、Pinterest 已建 Pin 但未落库 → 10min 后重发（无幂等键）。durable idempotency = P1
- `plannedAt` 无时区，服务端按 UTC 解释。每用户时区 = P1

---

## 10. 非目标

- 独立 Failed Pins 页面
- Products 一级导航
- 自动创建 Shopify Pin Draft / 自动发布商品
- Pinterest Catalog
- 失败邮件通知（下一轮 P1）
- AI Copy 长度/语言 UI（API 已保留，未来进 Settings）
- Carousel（功能不存在，相关校验条款作废）
- Creative Intelligence Layer / 模型训练

---

## 11. 验收清单

### Create Pins
- [x] 默认 Unscheduled；空状态有引导
- [x] Upload more 与 Select product 并排
- [x] Scheduled 展开卡无 Schedule 按钮
- [ ] hover ~400ms 自动展开编辑；移出不收起 🔨

### 必填校验 🔨
- [ ] 无 title / description / alt text 也能 Schedule 和 Publish
- [ ] 缺图片或缺 Board 时才阻断，提示文案不再提 title/description
- [ ] Batch Edit 的 "Publish ready" 计数按新规则
- [ ] Plan 抽屉同步放开（共用 pinReadiness）

### AI Copy
- [x] 只有 Generate copy；填空不覆盖；双字段有值时确认

### 失败处理
- [x] Banner 琥珀警示卡；CTA 点击后消失；Failed 视图内不渲染
- [x] 新失败重现；计数归 0 消失
- [x] 统计区 `N failed` 常驻；点击同跳
- [x] 子筛选三态；Banner 入口默认 Publish failures
- [x] 徽章区分；文案收紧；操作矩阵按 errorCategory
- [ ] 图片死链显示 ImageOff 而非纯色块 🔨

### 发布 / 自动发布
- [x] 全局 Publish now；确认弹窗；双击只发一次
- [x] 三路径失败落库字段一致
- [x] 排程到点 5 分钟内自动发布（沙盒已验证）

---

## 12. 关键实现文件

| 域 | 文件 |
|----|------|
| 校验（唯一入口） | `src/lib/pinReadiness.ts` |
| 生命周期/失败分类 | `src/lib/studio/pinLifecycle.ts` |
| 卡片 | `src/components/studio/PinBoardCard.tsx` |
| 工作区 | `src/components/studio/StudioBoard.tsx` |
| 失败 Banner | `src/components/shared/FailureBanner.tsx` |
| Plan 抽屉 | `src/components/plan/DraftDetailsDrawer.tsx` |
| 批量编辑 | `src/components/studio/BatchEditDrawer.tsx` |
| 发布核心（HTTP-free） | `src/lib/server/pinterest/publishPin.ts` |
| 自动发布 cron | `src/app/api/cron/publish-due/` |
| 迁移 | `backend/db/migrate_v42_scheduled_publish.sql` |
