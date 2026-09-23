# Slice 1 Implementation Plan — Foundations, App Shell, Studio

日期：2026-09-06  
状态：实施中（基础、App Shell、Studio 外层及首批核心页面已接入）  
目标：在不改变生成、编辑、排期、发布和同步行为的前提下，建立可复用基础并让 Studio 成为全站体验母版。

## 1. 当前工作树边界

### 可安全进入的文件

以下关键文件当前没有已发现的其他任务改动，可作为第一批写入点：

- `web/src/app/globals.css`
- `web/src/app/app/studio/page.tsx`
- 新增的 `web/src/components/ui/vp/AppPage.tsx`
- 新增的 `web/src/components/ui/vp/PageHeader.tsx`
- 新增的 `web/src/components/ui/vp/Button.tsx`
- 新增的 `web/src/components/ui/vp/FeedbackState.tsx`
- 新增的 `web/src/components/ui/vp/ResponsiveDrawer.tsx`
- 新增的 UI 合同测试文件

### 当前存在冲突风险的文件

以下文件已有 staged、unstaged 或 untracked 改动。开始 Slice 1 时不得直接覆盖，必须先重新核对 diff 和所属任务：

- `web/src/app/app/layout.tsx` — staged，约 +43/-3。
- `web/src/components/studio/AiVersionDrawer.tsx` — staged。
- `web/src/components/studio/BatchEditDrawer.tsx` — staged。
- `web/src/components/studio/PinBoardCard.tsx` — staged，较大改动。
- `web/src/components/studio/StudioBoard.tsx` — staged，较大改动。
- `web/src/components/studio/PinCardMedia.tsx` — unstaged。
- `web/src/components/studio/ProductPickerModal.tsx` — unstaged。
- `web/src/components/studio/StudioBoardFilters.tsx` — unstaged。
- `web/src/components/studio/ContentMediaStrip.tsx` — untracked。
- `web/src/components/studio/EtsyProductPickerPanel.tsx` — untracked。
- `web/src/components/studio/PinFallbackArtwork.tsx` — untracked。
- `web/src/components/studio/StudioPlanSidebar.tsx` — untracked。

原则：优先增加共享基础并从干净页面接入；对上述冲突文件采取“读取当前状态、最小补丁、保留所有业务改动”的方式，不能用旧版本重写。

## 2. 保留的 Studio 业务边界

下列现有组件和行为不是本轮重写对象：

- `CreateAssetPicker` / `InlineCreateAssetPicker`：素材与商品选择流程。
- `CreativeDirectionPanel`、`CreativeChips`、`AiUnderstandingPanel`：生成上下文和创意方向。
- `StudioBoard`、`PinBoardCard`、`PinCardMedia`、`PinCardActions`：草稿画布、媒体和操作状态。
- `PinDetailsDrawer`、`AiVersionDrawer`、`BatchEditDrawer`：详情、AI 版本和批量编辑。
- `ProductPickerModal`、`ProductUrlImportPanel`、Shopify/Etsy picker：商品来源流程。
- generation、partial success、retry、draft sync、schedule、publish、credit、destination 等状态机。

视觉重构通过外层布局、共享组件和样式 Token 进入；业务状态、事件处理和数据请求默认保持不变。

## 3. 实施步骤

### 1A — Token 与 Guard

写入范围：`globals.css`、新测试脚本、设计文档。

1. 补齐 spacing、radius、motion、semantic feedback、control height 等 `--vp-*` / `--app-*` Token。
2. 为 reduced motion、统一 focus、表面边框和媒体预览定义基础规则。
3. 保持现有 Token 名可用，新增别名后逐页迁移，不做一次性全局替换。
4. 为 `check-ui-contract.mjs` 增加正式 fixture/测试，确保它只检查新增行并能处理 untracked 文件。

验收：无页面视觉变化；自测、lint 和 typecheck 通过；新增 Token 在亮/暗主题均有值。

### 1B — 共享组件

写入范围：只新增 `web/src/components/ui/*` 和对应测试。

1. `AppPage`：`content | fluid | focus` 三种宽度和统一 gutter。
2. `PageHeader`：可选 eyebrow、description、actions；唯一 H1。
3. `Button`：primary、secondary、tertiary、danger、icon；统一 loading/disabled/focus。
4. `FeedbackState`：loading、empty、error、success，支持 action 与安全错误文案。
5. `ResponsiveDrawer`：桌面右侧、移动端全高 sheet，包含 focus/escape/restore 合同。

验收：组件不依赖 Studio 业务 store；props 由语义而不是视觉值驱动；键盘和 reduced motion 有测试。

### 1C — Studio 外层重构

首选写入范围：`web/src/app/app/studio/page.tsx` 与新共享组件；暂不修改冲突中的 Studio 子组件。

1. 用 `AppPage` 和 `PageHeader` 统一页头与页面节奏。
2. 把现有创建入口收拢为 Creation Rail，但保留现有事件、表单和值。
3. 宽屏保持媒体优先双区；低于 768px 让结果卡单列。
4. 详情编辑在窄屏切换到 `ResponsiveDrawer`，不让两张大型编辑卡横向挤压。
5. 保留现有 `data-testid`、事件和状态映射，避免破坏脚本测试。

验收：Create、generate、partial/retry、save、schedule、publish、drawer、返回页面均保持可用；390/768/1024/1440 无功能裁切。

### 1D — App Shell

写入范围：`web/src/app/app/layout.tsx` 和 Shell 子组件。只有在当前 staged 改动归属明确后进入。

1. 把导航配置与表现拆分，保留现有权限和路由逻辑。
2. 桌面保留图标 rail；键盘 focus 与 hover 都显示标签。
3. 移动端使用顶部品牌栏 + Studio/My Pins/Discover/Plan/More 底部导航。
4. Settings / Help 进入 More；隐藏或未就绪路由不能留空入口。
5. 顶栏同步错误降低为可恢复状态，不用常驻全站高警告抢走 Studio 主任务。

验收：全部现有路由可达；返回键、深链、theme、language、sync、account menu 不回归。

## 4. 自动合同检查

已新增：

```bash
npm run check:ui-contract -- --self-test
npm run check:ui-contract -- <本任务拥有的 UI 路径...>
```

检查器只检查 git diff 中新增的客户 UI 行以及指定路径内的 untracked UI 文件，阻止新增：

- 硬编码 hex/rgb/hsl 色值；
- 内联或 arbitrary shadow；
- 内联或 arbitrary radius；
- 小于 12px 的功能文字。

规则同时覆盖 TSX 内联/Tailwind 与页面 CSS module；不得把字面量从组件移动到样式表来绕过检查。

历史债务不会因为全文件扫描阻塞渐进迁移。确需例外时必须使用 `ui-contract-allow: <具体原因>`，不得写无原因豁免。

## 5. 验证顺序

每小步按以下顺序执行，失败时不扩大修改范围：

1. `npm run check:ui-contract -- --self-test`
2. `npm run check:ui-contract -- <owned paths...>`
3. `npm run typecheck:ui-foundations`
4. `npm run lint -- <owned paths...>`（如脚本支持路径参数）
5. `npm run typecheck`
6. `npm run test:studio`
7. 与改动相关的 generation、sync、drawer、plan 测试
8. 按 `web/tests/e2e/TESTING.md` 启动测试库环境
9. 在 1440、1024、768、390 逐状态截图对照

本地登录环境恢复前，可以完成 1–6；不能把线上旧 preview 截图当成最新代码的 7–8 验收。

## 6. 2026-09-06 实施记录

已完成：

- Token：4px 间距、控件高度、圆角、动效、焦点、反馈色和浮层语义变量。
- 共享组件：`AppPage`、`PageHeader`、`Button`、`FeedbackState`、`ResponsiveDrawer`。
- App Shell：桌面图标 rail 增加键盘标签；窄屏固定为 Create Pins、Weekly Plan、My Pins、Pin Ideas、More；More 使用可聚焦、Escape 关闭、关闭后恢复焦点的全高抽屉。
- Studio：外层页头、主动作和加载状态接入共享组件，生成与编辑状态机保持不变。
- Weekly Plan：窄屏保留完整七日心智模型，以可读宽度横向浏览；页头动作不再压成多行碎片。
- My Pins：统一页头、创建 CTA、加载与空状态；筛选条在窄屏可横向浏览。
- Opportunities：统一加载、错误、空状态；分类标签在窄屏保持单行可滚动。
- Keyword Trends、Pin Ideas、Help：接入统一页面层级和窄屏布局；Help 移除重复 H1。
- Product Opportunities：修复深色主题下未选中产品类型卡的白底/低对比问题，不改其当前数据逻辑。
- Settings：统一为桌面双栏、移动端全屏的路由驱动弹窗；底部操作保持可达，Save 回归普通主按钮；标签补齐语义和方向键操作。
- Modal 基础：新增 `useModalFocus`，供 More drawer、Settings 和嵌套客服弹窗共享焦点锁定、Escape、body scroll lock、焦点恢复及最上层判断。
- Insights：接入 `AppPage`、`PageHeader`、`FeedbackState`；把 25 项 CSS/TSX 合同违规收敛到 Token，提升 10–11px 功能文字，并将平台返回的中英文混杂提示改为安全一致的英文产品文案。
- UI 合同检查器：补齐 CSS module 的 `font-size`、`border-radius`、`box-shadow` 检查，阻止通过样式表绕过 TSX 规则。

验证证据：

- `npm run check:ui-contract -- --self-test` 通过。
- UI 合同对本轮拥有的页面与组件通过。
- `npm run typecheck:ui-foundations`、`npm run test:ui-foundations` 通过。
- `npm run test:plan`：18/18 脚本通过。
- `npm run test:studio`：27/28 脚本通过；唯一失败为本轮前已存在的 publish failure consistency 断言。
- `npm run validate:i18n` 通过；coverage 仍被其他进行中的 custom-time / Studio Board 翻译缺口阻塞。
- 完整 `npm run typecheck` 仍被其他进行中的 Etsy URL import 类型改动阻塞，本轮文件未新增 TypeScript 错误。
- 使用 `npm run dev:testdb` 的隔离测试 Supabase 完成登录态目视检查；已核对 Studio、Weekly Plan、My Pins、Opportunities、Keyword Trends、Pin Ideas、Product Opportunities、Insights、Settings、Help，并验证 More 抽屉的键盘打开、Escape 关闭与焦点恢复。
- Settings 专项：暗色与亮色窄视口目视通过；方向键切换标签、Escape 回到账户入口、客服嵌套弹窗仅关闭最上层并恢复到 Contact support 均通过。
- `npm run test:settings` 11/11、Smart Schedule config 26/26、rebalance 37/37、sync 12/12 通过。
- Settings 合同扩展后为 13/13；Insights MVP 7/7 通过；Insights 新增 UI 行通过加强后的 CSS/TSX 合同检查。

## 7. 第一阶段完成条件

- 共享 Token 和组件实际被 Studio 使用，而不是只有未接入文件。
- Studio 在四档视口和双主题下完成创建主链路验证。
- App Shell 在桌面和移动端均可访问全部已上线页面。
- 没有覆盖当前 staged/unstaged/untracked 的其他任务改动。
- 自动 UI 合同检查、lint、typecheck、Studio 测试通过。
- 形成同视口“改前 / 目标 / 改后”视觉对照。
