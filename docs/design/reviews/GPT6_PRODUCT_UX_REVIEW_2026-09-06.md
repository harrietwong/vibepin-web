# GPT-6 Product / UX Review — 2026-09-06

审查模型：`gpt-6-astra`（当前环境没有单独名为 `gpt-6` 的可用模型，因此使用同系列最高能力模型完成产品审查）。

范围：登录后 11 条路由的桌面与手机、亮暗主题截图，设计规范、Agent 检查清单、Refero 的 AI Product Generation / VEED / Morphic 参考，以及 Luna 静态债务报告。

结论：没有证据确认 P0；暂不通过全产品 UI 验收。本轮建议处理 7 项，并保留成功态、键盘、缩放和读屏证据缺口。

## 优先问题

| 优先级 | 问题与用户影响                                                                                            | 证据                                                                                       | 最小验收标准                                                                           |
| ------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| P1     | 8 张 `light` 目录截图视觉仍为深色，可能是采集错标、主题状态竞态或页面未遵循主题 Token，当前证据不足以区分 | `evidence/ui-2026-09-06/light/1440/weekly-plan.png`；`web/scripts/capture-vp-ui-matrix.ts` | 由代码审查判定根因；逐尺寸重新导航，记录实际主题与页面状态；不能仅凭目录名验收亮色主题 |
| P1     | Weekly Plan 手机主动作可能在屏外，日期按钮点击区偏小                                                      | `dark/390/weekly-plan.png`；`globals.css`；`plan/page.tsx`                                 | 390px 下创建动作无需横滑即可看到；日期按钮至少 40×40px 且有明确名称                    |
| P1     | My Pins 搜索与筛选挤在横向滚动行，后部筛选不易发现                                                        | `dark/390/my-pins.png`；`globals.css`                                                      | 搜索独占一行；筛选独立排列，当前选项可见；保留 `aria-pressed`                          |
| P1     | Settings 浅色提示、Reconnect 与帮助链接对比度不足                                                         | `light/390/settings.png`；`PinterestSettingsPanel.tsx`                                     | 使用分主题语义文字色，普通文字达到 4.5:1；连接判断逻辑不变                             |
| P1     | Pin Ideas 默认空态没有清晰下一步，发现路径中断                                                            | `dark/390/pin-ideas.png`；`discover/page.tsx`                                              | 默认空态增加说明和进入 Studio 的动作；筛选无结果继续提供 Clear filters                 |
| P2     | Product Opportunities 深色骨架出现大面积亮白块，占位内容抢过主要控件                                      | `dark/1440/product-opportunities.png`；`products/page.tsx`                                 | 骨架使用语义表面 Token，保持尺寸与网格；复核双主题及 reduced motion                    |
| P2     | Help Article 桌面标题摘要与正文阅读轴断裂                                                                 | `light/1440/help-article.png`；`help/[slug]/page.tsx`；`globals.css`                       | 标题、摘要、步骤与支持卡共用阅读列；手机保持 16px gutter                               |

## Luna Findings 裁决

| Luna 项                                 | 裁决       | 收敛意见                                             |
| --------------------------------------- | ---------- | ---------------------------------------------------- |
| 1. Trends 状态与颜色映射                | Defer      | 债务存在，但不同指标含义不能机械合并；等待填充态证据 |
| 2. Trends 小字号                        | Accept，P2 | 关键指标、来源与说明提升至至少 12px                  |
| 3. Trends Unicode 状态图标              | Accept，P2 | 局部替换为 Lucide；已有文字，不认定为仅靠颜色表达    |
| 4. Trends 伪元素字段标签                | Accept，P2 | 改为真实文本节点；读屏故障尚未实测                   |
| 5. My Pins 筛选样式                     | Accept，P1 | 优先修复手机排列，不要求全面迁移全部内联样式         |
| 6. SessionCard 独立视觉系统             | Defer      | 缺少卡片详情证据，暂缓整体迁移                       |
| 7. My Pins 键盘操作缺失                 | Accept，P1 | 使用真实 checkbox 和独立打开操作，补键盘验收         |
| 8. Pin Ideas Analysis 动作仅 hover 显现 | Accept，P1 | 增加 focus 可见性，保留手机常显；补有数据行证据      |
| 9. Demo / 正式页标题分叉                | Defer      | 缺少 Demo 截图，本轮不扩大范围                       |
| 10. Discover 控件字面样式               | Defer      | 属代码债务，尚无独立用户影响证据                     |
| 11. Discover 伪元素字段标签             | Accept，P2 | 同第 4 项，不宣称已确认读屏故障                      |
| 12. History 详情小字号等                | Defer      | 缺详情打开态截图，后续优先处理任务按钮               |

## 证据不足

- Studio、My Pins、Opportunities、Trends、Products、Insights 的指定截图主要或全部为 loading / skeleton，不能证明真实数据成功态与核心任务可完成。
- Weekly Plan 的手机 Calendar 来自桌面进入后缩窄，不能据此否定手机首次进入默认 List。
- Settings 只覆盖 Pinterest 标签；Pin Ideas 未覆盖填充 Gallery、Analysis 和 Studio 交接。
- 视觉为深色的 8 张 `light` 截图包括 Weekly Plan、My Pins、Opportunities 各两张，以及 Help、Help Article 各一张 390px；必须由代码审查判定是采集还是主题实现问题。
- 未验证加载持续时间、完整错误恢复、完整键盘流程、200% 缩放、读屏以及生成 / 发布成功。

## 参考方向

继续采用 Editorial Creator Studio：借鉴 AI Product Generation 的媒体优先与安静表面、VEED 的集中创建入口、Morphic 的媒体预览层级；不照搬其品牌色、营销大标题、小字号或全站纯黑。
