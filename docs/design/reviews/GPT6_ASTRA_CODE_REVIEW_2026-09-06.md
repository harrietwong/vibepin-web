# GPT-6 Astra UI Code Review — 2026-09-06

范围：GPT-6 产品审查的 7 项问题、Luna 静态债务、截图采集脚本、主题状态和相关登录后页面源码。审查只读，未修改文件。

结论：未确认 P0；保留 7 条 P1 与 3 条 P2。本轮采用精确局部修复，不进行整页重写、指标映射合并、SessionCard / 详情弹窗重做或主题优先级变更。

## Findings

1. **P1 — 亮色截图混入旧深色证据（Modify）**
   - 证据：`web/scripts/capture-vp-ui-matrix.ts:179-194,287-322`；`web/src/lib/theme/ThemeProvider.tsx:72-84`；文件时间显示 Studio / Settings 在后续单独重拍，其余异常图仍来自早期整批运行。
   - 根因判断：早期 full-run 的 light 阶段最可能被会话 dark metadata 回写，随后 manifest 保留目标主题但部分图片没有重拍。现有证据不支持“页面硬编码导致整页深色”，不修改 ThemeProvider。
   - 修复：每个主题使用独立 context，同步克隆会话主题；每个 viewport 重新导航；截图前后记录实际主题、计算背景色、时间和页面状态；重拍旧图。

2. **P1 — Weekly Plan 手机创建动作在屏外、日期按钮过小（Accept）**
   - 证据：`web/src/app/globals.css:1215-1221`；`web/src/app/app/plan/page.tsx:2245-2292`。
   - 根因：操作行强制不换行，Create Pin 排在末尾；日期箭头点击区过小且没有明确名称。
   - 修复：创建入口在 390px 保持可见；日期控件至少 40×40px并使用现有本地化文案作为 accessible name；保留周/月偏移与深链。

3. **P1 — My Pins 手机搜索挤走筛选项（Accept）**
   - 证据：`web/src/app/globals.css:1482-1488`；`web/src/app/app/history/page.tsx:1199-1243`。
   - 根因：搜索最小宽度 280px，外层禁止换行，筛选组不能收缩。
   - 修复：仅普通筛选区域改为搜索独占一行、筛选组独立排列；保留 `aria-pressed`，不影响批量工具栏。

4. **P1 — My Pins 单卡勾选缺少键盘语义（Modify）**
   - 证据：`web/src/app/app/history/page.tsx:839-863,1021-1024,1134-1136`。
   - 根因：checkbox 是不可聚焦的点击 `div`。现有 Open 按钮可键盘打开详情，因此不把整卡改成按钮。
   - 修复：使用带名称的原生 checkbox，扩大点击区并阻止事件冒泡；保留 Open 按钮与业务回调。

5. **P1 — Settings 浅色状态文字对比度不足（Modify）**
   - 证据：`web/src/components/pinterest/PinterestSettingsPanel.tsx:143-157,179-200,215-221,557-573,612-624`。
   - 根因：固定亮黄、浅蓝和浅红文字用于浅色背景；警告正文约 1.34:1，Reconnect / 帮助链接约 1.80:1。
   - 修复：使用分主题语义文字色；必要时增加文字专用 Token。连接、权限和重连判断保持不变。

6. **P1 — Pin Ideas 默认空态没有继续入口（Accept）**
   - 证据：`web/src/app/app/discover/page.tsx:1736-1760`。
   - 修复：默认空态增加简短说明和进入 Studio 的真实链接；保留 Show all trends / Clear filters 分支，不伪造参考图或 prefill。

7. **P1 — Analysis 操作获得键盘焦点后仍透明（Accept）**
   - 证据：`web/src/app/app/discover/page.tsx:903-917`；`web/src/app/globals.css:1339-1350`。
   - 修复：增加 `focus-within` / `focus-visible`；无 hover 设备常显；保留现有 Studio 交接逻辑。

8. **P2 — Product skeleton 未适配深色（Accept）**
   - 证据：`web/src/app/app/products/page.tsx:1175-1183`；`web/src/app/globals.css:1566-1571`。
   - 修复：只为该骨架使用语义表面 Token并遵守 reduced motion；不增加全局 `gray-100` 覆盖。

9. **P2 — Help Article 标题与正文阅读列错位（Accept）**
   - 证据：`web/src/app/app/help/[slug]/page.tsx:31-49`；`web/src/app/globals.css:965-980`。
   - 修复：仅文章页让页头内容和正文共用阅读列，手机保持 16px gutter；不改变通用 PageHeader 或 Help 首页。

10. **P2 — Trends 小字号、Unicode 图标与移动标签（Accept / Modify）**
    - 证据：`web/src/app/app/trends/page.tsx:127-175,215-220,250-269,289-301,1356-1360`；`web/src/app/globals.css:1333-1337,1402-1407`。
    - 修复：功能文字升至至少 12px；局部替换为 Lucide并保留状态文字；为 Trends / Discover 增加真实本地化标签节点。读屏故障尚未实测，不能写成已确认事实。

## 建议验证

- `npm run check:ui-contract -- <owned paths>`
- `npm run typecheck:ui-foundations`
- `npm run test:ui-foundations`
- `npm run validate:i18n`
- 页面专项 ESLint / 类型检查
- 使用独立主题 context 重拍截图矩阵；逐张验证最终 URL、viewport、前后主题、计算背景色、页面状态与文件存在性
- 浏览器补测 390px Weekly Plan、My Pins、Pin Ideas；Settings light；Product skeleton dark；Help Article 1440；键盘与 reduced motion
