# VibePin 登录后 UI 证据矩阵

本目录是 2026-09-06 登录后界面审查的可复现截图证据，不是产品数据正确性的替代测试。

## 覆盖范围

- 路由：Studio、Weekly Plan、My Pins、Opportunities、Keyword Trends、Pin Ideas、Product Opportunities、Insights、Settings、Help、Help Article。
- 视口：1440×1000、1024×900、768×900、390×844。
- 主题：dark、light。
- 技术采集结果：88/88 张截图，0 失败、0 登录页重定向、0 缺失文件。

机器可读记录见 `manifest.json`。每条记录包含路由、最终 URL、标题、主题、视口与文件位置。

## 采集方式

在 `web` 目录使用隔离测试库启动应用，然后运行 `npm run capture:ui-matrix`。脚本拒绝生产 Supabase ref，使用真实测试会话，并逐张验证实际 viewport 和根节点 theme。

普通页面以可见 H1 作为 ready contract；Settings 路由由 App Shell 打开唯一全局设置弹窗，因此以 `[data-testid="settings-modal-title"]` 作为 ready contract。

manifest 的 `theme` 表示采集时根节点 `data-theme` 与目标一致。独立产品审查发现 8 张 `light` 目标在视觉上仍呈深色；这可能来自页面硬编码、主题状态竞态或采集问题，在代码审查和重拍完成前不能计作亮色视觉通过。

## 证据边界

截图覆盖当前测试库能够到达的登录后 Shell、响应式布局、主题和 loading / skeleton / empty / safe error 状态。部分页面因测试库缺表或缺填充数据，没有形成真实数据 success-state：

- Keyword Trends：缺趋势数据表。
- Pin Ideas：无 viral pin。
- Product Opportunities：缺商品结果数据。
- Opportunities：缺对应聚合视图。

这些页面在具备填充数据的隔离环境补拍前，不能标记 success-state 视觉验收完成。开发服务器的编译等待或内存恢复也不应直接归类为产品性能缺陷。
