# VibePin Agent UI Checklist

适用范围：任何修改 `web/src/app/app/**`、`web/src/components/**` 或登录后主题的 Agent。

执行前必须阅读：

- `docs/design/VIBEPIN_DESIGN_SYSTEM.md`
- `docs/design/VIBEPIN_UI_AUDIT_2026-09-06.md`
- `web/AGENTS.md`
- `web/tests/e2e/TESTING.md`（只要涉及登录态浏览器测试）

## 开始前

- [ ] 明确这次改动位于“发现 → 创建 → 编辑 → 排期 → 复盘”的哪一段。
- [ ] 检查现有共享组件、相邻页面和 Token，确认没有重复造轮子。
- [ ] 记录目标页面当前截图、视口和状态；视觉改造必须有对照基线。
- [ ] 确认工作树中的既有改动归属，避免覆盖其他 Agent 或用户文件。
- [ ] 写清楚此次不改变的业务行为和数据边界。

## 设计与实现

- [ ] 每页只有一个 H1，使用 `PageHeader` 规定的层级。
- [ ] 页面级布局使用 `AppPage`；搜索与筛选使用共享 `Toolbar` / `FilterBar`。
- [ ] Button、MediaCard、Empty/Error/Loading State、Drawer 优先复用公共组件。
- [ ] 页面代码没有新增任意 hex、rgb/rgba 品牌色、阴影或私有 radius。
- [ ] CSS module 同样受 UI 合同约束；不得用样式表绕过颜色、阴影、圆角和 12px 最小功能文字规则。
- [ ] 品牌渐变只用于当前唯一的 Create / Generate 主动作。
- [ ] 功能文字 ≥12px；Icon-only 控件 ≥40×40px 且有 accessible name。
- [ ] 没有使用 emoji、ASCII、自制 SVG 或占位框冒充正式视觉资产。
- [ ] 文案是用户语言，不暴露表名、schema、provider code 或堆栈信息。

## 状态

- [ ] Loading 保留最终布局，不造成大幅跳动。
- [ ] Empty 给出一个清楚下一步。
- [ ] Error 说明未完成的动作并提供 Retry / Back / Support 中合适的一项。
- [ ] Partial success 保留成功内容，并允许只重试失败项。
- [ ] Success 在原位置保留结果，Toast 只做补充。
- [ ] Disabled 说明原因，不能只降低透明度。
- [ ] Hover、focus、selected、pressed 可分别识别。

## 响应式

- [ ] 1440px：信息密度合理，内容不被无意义拉宽。
- [ ] 1024px：主要编辑区仍可用，没有被侧栏和多列压碎。
- [ ] 768px：两列仅在每列可保持 ≥320px 时存在。
- [ ] 390px：单列；主要动作可见；没有桌面七列/宽表硬缩放。
- [ ] 不用 `overflow: hidden` 掩盖溢出；必要横向滚动有视觉提示。
- [ ] 移动端不依赖 hover 才能发现关键操作。
- [ ] 桌面表格转移动卡片后，每个值保留本地化字段标签；触控布局的主动作和 Retry 始终可见，不能只在 hover 时出现。
- [ ] Modal / Drawer 在移动端可关闭，且不会裁掉提交按钮。
- [ ] Settings 新入口仍打开唯一全局设置弹窗，不新增平行设置页面或第二套导航。

## 可访问性与动效

- [ ] Tab 顺序与视觉顺序一致，所有功能可由键盘完成。
- [ ] focus ring 可见且不被裁切；关闭浮层后焦点回到触发控件。
- [ ] 嵌套 Modal 只让最上层处理 Escape/Tab，关闭后焦点逐层返回。
- [ ] 新增 `aria-modal` 时必须复用 `useModalFocus`；非阻断 popover/hover preview 不得设置 `aria-modal`。
- [ ] 桌面非模态面板与移动端模态 sheet 的语义分开；仅移动端 sheet 锁背景和焦点。
- [ ] Tab 组件使用 `tablist/tab/tabpanel`、roving `tabIndex`，并支持方向键、Home、End。
- [ ] 表单有 label、错误关联和明确帮助文字。
- [ ] 状态不仅依赖颜色；对比度达到 WCAG AA。
- [ ] 200% zoom 下内容不丢失，关键操作不重叠。
- [ ] `prefers-reduced-motion` 下取消位移、缩放和循环动画。
- [ ] 动效遵循 120/180/240/280ms 节奏，不阻塞输入。

## 验证

- [ ] 对本任务拥有的精确文件运行 `npm run check:ui-contract -- <paths...>`；如只检查 staged diff，加 `--staged`。
- [ ] `check:ui-contract` 必须同时通过样式 Token、最小功能字号和 modal focus 合同；不得用 allow 注释绕过交互语义。
- [ ] 修改共享 UI 基础时运行 `npm run typecheck:ui-foundations` 与 `npm run test:ui-foundations`。
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:core`
- [ ] 运行与改动页面对应的专项测试。
- [ ] 登录态 E2E 使用 `npm run dev:testdb` 与唯一共享测试账号；绝不连接生产库。
- [ ] 全站结构回归使用 `npm run capture:ui-matrix`；脚本输出必须满足 manifest 无失败、无 `/login` 重定向、无缺失文件，每个主题/视口/路由键唯一。
- [ ] 截图前验证页面 ready selector：普通页面必须有唯一可见 H1；Settings 是由 App Shell 打开的全局弹窗，使用 `[data-testid="settings-modal-title"]`，不能等待不存在的页面 H1。
- [ ] 截图记录实际 `window.innerWidth/innerHeight` 和 `document.documentElement.dataset.theme`；不能只凭目录名或颜色观感推断视口与主题。
- [ ] 在相同视口、主题和数据状态下对照“改前 / 目标 / 改后”截图。
- [ ] 明确每张证据属于 loading、skeleton、empty、safe error 还是 success；不得用前四类替代真实数据 success-state 验收。
- [ ] 检查至少一个真实错误恢复路径，而不是只看成功态。

## 交付

- [ ] 列出修改页面、共享组件、Token 和测试结果。
- [ ] 说明仍未覆盖的页面或状态，不用窄测试宣称全站完成。
- [ ] 新增视觉模式时同步更新 `VIBEPIN_DESIGN_SYSTEM.md`。
- [ ] 不推送、合并或部署，除非任务明确要求。

## 禁止项

- 禁止在页面内复制一套已有公共组件。
- 禁止维护两套相同业务入口却行为不同的界面。
- 禁止用纯视觉改动掩盖加载失败、404 或内部错误泄漏。
- 禁止为了通过窄屏截图而隐藏功能或数据。
- 禁止只验证一个视口、一个主题或成功态后宣布完成。
