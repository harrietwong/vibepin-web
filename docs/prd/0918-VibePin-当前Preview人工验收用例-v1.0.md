# 0918 VibePin 当前 Preview 人工验收用例 v1.0

## 1. 本次可以验收什么

- 稳定地址：<https://vibepin-fb-preview.vercel.app>
- 当前已验证源码：`ffdd9b791c136dd99b1611af5c3eb2496fb0938e`
- 当前已验证部署：`dpl_BUcnZ2qVLSGSTFs4yYXtA6b5Ussm`
- 当前已验证唯一地址：<https://web-ml5o81t4u-harriets-projects-86e9e358.vercel.app>
- 环境：Preview + Test Supabase，不是 Production。
- 本轮人工验收范围：Studio 历史粉色 QA 图片处理、深灰渐变兜底、Schedule/Publish 主次关系、Pricing 三语完整性、Pricing 登录态表头、桌面与 390px 响应式。

> 注意：如果稳定地址和唯一地址显示的内容不一致，立即停止验收并记录截图，不要继续执行带写入的操作。

## 2. 验收规则

1. 桌面轮使用 1440×900 左右窗口。
2. 移动轮使用 390×844。
3. 每个用例执行两轮：第一轮英文，第二轮简体中文；Pricing 另加繁体中文检查。
4. 不点击真实付款、真实发布、真实 OAuth 授权、删除或 Production 操作。
5. 每个失败项记录：用例编号、URL、步骤、预期、实际、截图、Console 红色 error 数。

## 3. 第一组：Create Pin 当前已发布修复

### CP-UAT-01 历史粉色 QA 图片不再当作正常图片

入口：<https://vibepin-fb-preview.vercel.app/app/studio?filter=failed&sub=all>

步骤：

1. 登录 Preview 测试账号。
2. 打开 Failed → All。
3. 找到以前出现整块粉色的历史失败卡。
4. 同时观察相邻的正常人物、家居、商品或生成图片。

预期：

- 历史 `qa-slide-*` / QA 占位图片不得再显示为整块粉色正常图片。
- 没有可用媒体时显示中性深灰分层渐变或轻微光晕，并有“生成失败 / 图片不可用”等语义。
- 正常图片仍显示原图，不能因为图片颜色偏粉或为纯色就被误判为兜底。
- 页面不出现破图图标或空白媒体区。

### CP-UAT-02 媒体切换与恢复

步骤：

1. 在失败卡、正常卡之间切换筛选或刷新页面两次。
2. 返回原失败卡。

预期：

- 原失败卡不会因先前加载失败永久卡死。
- 正常图片加载后不应被超时计时器错误替换为兜底。
- 刷新后结果与刷新前一致。

### CP-UAT-03 Schedule 为主操作

入口：<https://vibepin-fb-preview.vercel.app/app/studio?filter=unscheduled>

步骤：

1. 找到同时显示 Schedule 和 Publish 的卡片。
2. 只观察，不点击提交。

预期：

- Schedule 是粉紫渐变主按钮。
- Publish 是较安静的边框或次级按钮。
- 不再把 Publish 作为视觉重点。

### CP-UAT-04 Studio 失败提示与页面宽度

步骤：

1. 在 Drafts、Failed、All 三个筛选之间切换。
2. 从顶部滚动到卡片底部。
3. 查看页面顶部和筛选行。

预期：

- 不出现占满页面宽度的大型失败横幅。
- 仅显示边界清楚、较轻量的 Pin 级提醒。
- 桌面端无水平滚动条，页面可向下滚动到底。

## 4. 第二组：Pricing 当前已发布修复

### PR-UAT-01 四套餐和金额

入口：<https://vibepin-fb-preview.vercel.app/pricing>

步骤：

1. 检查 Free、Starter、Pro、Business 四张卡。
2. 检查月付：`$0 / $19 / $49 / $99`。
3. 切换年付，检查 Starter `$15/月`、Pro `$39/月`、Business `$79/月`。
4. 向下检查比较表金额与卡片同步。

预期：

- 卡片与比较表一致。
- 支持平台仅显示 Pinterest、Instagram、Facebook Page；不显示 TikTok。
- 不点击任何付费 CTA。

### PR-UAT-02 简体中文整页切换

步骤：

1. 右上角切换为简体中文。
2. 从页面顶部滚动到底部。
3. 检查导航、套餐卡、比较表、企业方案、FAQ、底部 CTA、页脚。

预期：

- 以上区域全部切换为简体中文。
- 比较表显示“每月 n”“不限量”，不得残留 `/ month` 或 `Unlimited`。
- 品牌名、套餐名和平台名可以保留英文。

### PR-UAT-03 繁体中文整页切换

步骤：

1. 右上角切换为繁體中文。
2. 重复 PR-UAT-02 的全页检查。

预期：

- 以上区域全部使用繁体中文。
- 同一模块内不得出现中英混排的额度文案。

### PR-UAT-04 主题切换和刷新保持

步骤：

1. 分别切换浅色与深色。
2. 刷新页面。
3. 再切换语言并刷新。

预期：

- 右上角主题和语言控件始终可见、可点击。
- 刷新后不闪回错误主题或错误语言。
- 文字与背景对比清晰，按钮边界可见。

### PR-UAT-05 登录态表头

步骤：

1. 已登录时打开 Pricing。
2. 检查右上角操作。
3. 退出登录后重新打开 Pricing。

预期：

- 已登录时显示进入 Studio/Create Pin 的入口，不同时显示误导性的“登录”。
- 退出后恢复“登录 / 开始使用”。
- 旧 Cookie 不能直接让结账按钮绕过真实用户验证。

## 5. 第三组：390×844 移动端

### MB-UAT-01 Pricing 移动端

步骤：

1. 将视口设为 390×844。
2. 打开 Pricing，分别检查英文、简体中文、繁体中文。
3. 从顶部滚动到底部。

预期：

- 无水平滚动条。
- 套餐卡单列展示，文字不裁断。
- 主题、语言和主要 CTA 可操作。

### MB-UAT-02 Studio 移动端

步骤：

1. 在 390×844 打开 Failed → All。
2. 检查失败标签、深灰渐变兜底、Schedule/Publish 按钮。
3. 向下滚动到底。

预期：

- 无水平滚动条，所有卡片内容可达。
- 历史粉色 QA 图不重新出现。
- Schedule 仍是主按钮，Publish 仍是次按钮。
- 主按钮触控高度约 44px，不难点击。

## 6. 已由自动化完成，不要求人工重复造数据

### CR-AUTO-01 四套餐额度

已完成 4 套餐 × 3 状态 × 2 轮，共 24 个场景：

- Free：AI 图片 10、AI 文案 20、排期 5、每平台账号 1。
- Starter：AI 图片 150、AI 文案 500、排期 150、每平台账号 1。
- Pro：AI 图片 800、AI 文案 2000、排期 300、每平台账号 2。
- Business：AI 图片 3000、AI 文案 10000、排期不限量、每平台账号 3。
- 额度桶 120 条 PASS、0 FAIL；账号上限 24 条 PASS、0 FAIL。
- 临时 Auth、订阅、customer、social connection 均已清理为 0 残留。

边界：真实 AI Provider、真实发布、真实 OAuth callback、真实付款，以及 Studio 产品按钮触发额度耗尽后的最终 toast/modal UI 未执行。

## 7. 目前没有全部改好，暂不要按“应通过”验收的项目

下列反馈仍缺“代码合入当前 Preview + 两轮用户界面证据”中的至少一项，不能算完成：

1. Failed 卡片重复 Edit、Posted 与失败状态矛盾、Retry/Edit/目标恢复的完整链路。
2. “没有发布目标”确认框的轻量化、缺失字段就地定位、Board/账号必填字段不藏在 Details。
3. Batch Edit 输入框辨识度、整行紫色、混合账号/Board 长错误、Publish to 不能选账号。
4. Choose Pin References 按商品动态推荐、参考图定期更新、不同产品不再重复同一批图。
5. 仅产品图、不选 Reference 时的自动参考匹配或提示词生成，以及两张图同时失败的根因闭环。
6. Product Opportunities 非空数据；当前 Test catalog 为空，前端只能诚实显示空态。
7. Contact “Message sent” 成功态精修。
8. Creem Test Checkout 的真实完成；当前不得进行真实付款。
9. 四套餐额度耗尽后的最终 Studio toast/modal 视觉截图。
10. 全站 64 页面“去 AI 味”、动效/交互丝滑化和完整响应式审查的实施。
11. Supabase linter 的 Security Definer View 与 tasks/user_settings/audit_log RLS 修复是否已安全应用到目标环境。

如果在当前 Preview 看到以上问题，先按“已知未闭环”记录，不要把它误报为本轮已发布修复的回归。

## 8. 回传格式

- 用例编号：
- 轮次：第 1 轮 / 第 2 轮
- 页面 URL：
- 设备/尺寸：
- 预期结果：
- 实际结果：
- Console 红色 error 数：
- 截图：
- 是否发生数据副作用：
- 结论：PASS / FAIL / BLOCKED
