# Create Pin × Reference Seam 用户验收用例（2026-09-01）

## 1. 范围与候选绑定

- 目标路径：`/app/studio`。
- 仅验收包含本工作包最终 commit 的 Preview；必须先记录 deployment id、source commit、URL、title 和测试账号标识。
- 本文是验收步骤，不是已执行的浏览器证据。代码门禁通过不能替代 USER PASS。
- Create Pin 只负责 attempt/job/toast/lock/terminal；Reference 的 `creativeSetupStore` 是普通 UI setup 唯一恢复源，`generationSetupStore` 只保存一次 attempt 的不可变快照。

## 2. 前置条件

- Preview 测试账号 A；owner-isolation 用独立测试账号 B。代理不得读取、记录或回显密码、OTP、token。
- 两张安全图片 fixture：产品图 P1、风格参考图 R2；执行前记录本地绝对路径、文件大小、SHA-256，不记录图片二进制或上传凭据。
- 一个可选商品记录，必须包含公开商品 URL、source、稳定 product id；不得使用后台 Admin URL。
- DevTools Console 与 Network/HTTP 记录可用；敏感 header/body 必须脱敏。
- Round 1 使用 1440×900；Round 2 使用 390×844。每轮开始前刷新 `/app/studio`，结束后恢复默认 viewport。

## 3. 动作授权边界

| 动作 | 默认权限 | 可能副作用 | 动作前要求 |
|---|---|---|---|
| 浏览 Studio、开关抽屉、选择/取消 Pin、编辑但不提交 | 允许只读验收 | 可能写浏览器本地 UI 状态 | 无额外授权 |
| 选择本地文件、上传产品/参考图 | 未默认授权 | 写测试 Storage、分析状态或草稿 | 必须在 file chooser 前再次取得明确授权 |
| 点击“生成 N 个 Pin” | 未默认授权 | 创建 intent/job/placeholders/assets，消耗测试配额/usage | 必须在最终 Generate 点击前再次取得明确授权 |
| 排期、立即发布、删除、OAuth、付款 | 禁止 | 外部平台/测试数据/计费副作用 | 本用例不得执行 |
| env、DB migration、Production | 禁止 | 环境或生产状态变更 | 本用例不得执行 |

## 4. Round 1 — 桌面 1440×900

| ID | 点击步骤 | 预期 UI | 预期 HTTP/状态 | Console / 副作用 | PASS / FAIL |
|---|---|---|---|---|---|
| D-01 | 打开 `/app/studio` | 已认证 Studio；Draft/Scheduled/Posted/Failed/All、卡片、PREVIEW 可见；无水平溢出 | 只允许 session/draft/history 等 GET | 0 个新 error；无 provider POST |  |
| D-02 | 选 1 张 Draft，再选第 2 张，点 Batch Edit，关闭，再重复一次 | 单选不显示 Batch Edit；双选显示；closed→open→closed 两次无 React #310；关闭后选择状态可控 | 选择/开关抽屉不得产生 POST/DELETE | 无 hook-order error |  |
| D-03 | 检查媒体 fallback、卡片密度、Schedule/Publish、Plan | broken/缺图统一深灰；无大失败 banner；quiet Pin notice 数量正确；Schedule 次要、Publish 主 CTA；Plan 同一按钮开/关 | 只读 GET；不得发布/排期 | 无 provider 请求 |  |
| D-04 | 打开“用 AI 创建” | 可看到商品图、风格参考、方向、模型、format、count 1/2/3/4；无输入时 Generate disabled | 打开抽屉不请求 provider | 无副作用 |  |
| D-05 | 选择商品 P1、参考 R1/R2，设置 count=4、模型、format、方向与 Creative direction；关闭并重开 | 完整恢复商品 id/URL/source、两张参考的 id/source/sourceUrl/reason/patternTags、有效方向、模型、format、count=4；不退化为裸 URL | setup key 不含原始 URL/prompt；普通 restore 不创建 job | localStorage 无 token、usage、reservation、provider response |  |
| D-06 | 刷新页面，再打开同一 setup | Reference setup 仍是唯一 UI 恢复源；Create Pin attempt store 不覆盖或竞争普通 restore | 0 个 generation POST | 无重复 toast/placeholder |  |
| D-07 | 在取得上传/生成授权后点击 Generate | 点击前必须先完成 setup/attempt 持久化；pending 仅一个 loading/info toast；2 refs×4 显示 8 placeholders，按 2 个 group 各 4 个 slot | 每组一个稳定 intent；`X-Request-Id` 与 intent 一致；无持久化则 0 POST | 不出现“正在生成”与“未生成”并存 |  |
| D-08 | 等待 terminal | 0/partial/all success 在同一 toast id 原位更新；8 个 slot 与两组 reference provenance 对齐 | job/result/usage 可按 request/job id 对账；不得多 job、多 charge | terminal 后 Generate lock 释放 |  |
| D-09 | 让一个卡片/组失败后点该卡 Retry | Retry setup 只含该失败 group/reference，count=1；不扩成原 2×4 batch | 新用户动作只请求 1 个 slot；不复用为 8 个 placeholder | 原 attempt snapshot 保持 count=4、2 refs 不变 |  |

## 5. Round 2 — 移动端 390×844

按 D-01 至 D-09 重复，另加以下检查：

| ID | 点击步骤 | 预期 | PASS / FAIL |
|---|---|---|---|
| M-01 | 记录 `innerWidth/body.scrollWidth/documentElement.scrollWidth` | 三者均为 390，无横向溢出 |  |
| M-02 | 双选→Batch Edit→关闭 | 操作区不拥挤；可见焦点；关闭后回到触发点；无 React #310 |  |
| M-03 | 打开/关闭 Plan 与 AI 抽屉 | 一个控制负责开关；Escape、关闭和返回路径一致；body scroll 正确恢复 |  |
| M-04 | 检查 count=4 与 2 refs | count=4 可点；CTA 文案显示 8 个 Pin；toast/live region 不遮挡主要操作 |  |
| M-05 | 检查 touch target | 移动端 Schedule 等交互命中区 ≥44px；视觉层级仍弱于 Publish |  |

## 6. 故障与恢复专项

| ID | 受控场景 | 必须观察到的结果 | PASS / FAIL |
|---|---|---|---|
| R-01 | attempt snapshot/local persistence 在 POST 前失败 | 0 个 `/api/generate` POST；所有本次 orphan placeholders 被释放；固定 code `generation_attempt_persist_failed`；不记录 prompt/URL |  |
| R-02 | 第一次 POST 已 commit 但响应丢失，第二次 exact replay 响应也丢失 | 页面保持 unknown/recoverable；刷新后按相同 intent 查回原 job/results；不创建第二 job/placeholders/usage/reservation/charge |  |
| R-03 | unknown 后服务端返回 terminal | 同一 attempt/toast 原位变为 completed/partial/failed；Generate lock 释放；无矛盾 toast |  |
| R-04 | A 在请求中途退出，B 登录 | A 的晚到响应对 B 产生 0 store mutation、0 UI callback、0 replay；B 看不到 A payload |  |
| R-05 | A 再登录 | A 原 attempt/intent 可继续恢复；不新建 job、不重复扣量 |  |
| R-06 | 双击 Generate / 重复 terminal callback | 单一 attempt、单一稳定 toast id；按钮互斥；usage/settle 仅一次 |  |
| R-07 | 429/timeout/0 success/partial success | fixed machine code 与 safe copy；HTTP、job、usage 可关联；不得泄漏 prompt、URL、token |  |

## 7. HTTP、Console 与无副作用证据

- 每轮记录 method、pathname、status、content-type、duration、脱敏 request id；不得保存 Authorization、cookie、原始 prompt、商品 URL 查询参数。
- 只读阶段不得出现 `/api/generate`、provider、publish、schedule、delete、OAuth、checkout 写请求。
- 生成阶段仅在动作时授权后记录：intent POST、job GET、terminal result 与 usage readback；不得通过 API 直调绕过 UI。
- Console 记录去重后的 error/warn 与 source/stack。React #310、重复 key、跨 owner payload、矛盾 toast 均为 FAIL。
- 测试数据按用户要求保留时，列出非敏感 draft/job/asset/usage id；不得清理用户可见数据。

## 8. A11y 与 i18n

- pending/terminal 消息使用一个稳定 `aria-live` 可读区域或 toast id；loading 不可标成 success。
- 抽屉打开后焦点进入，关闭后回触发按钮；Escape/Backdrop 不触发生成或发布。
- 验收英文、简中、繁中：数量、失败/部分成功、恢复提示语义一致；不混用 `Publish to`、乱码或 raw internal error。
- 所有图片 fallback 有非颜色状态语义与可读 alt；390px 触控目标 ≥44px。

## 9. 清理与最终裁定

- 关闭仅本轮自建标签；恢复 viewport；确认没有遗留 modal、selection、poller 或 agent-owned tab。
- 未执行上传/生成时，对 D-07 至 R-07 必须标 `NOT EXECUTED / ACTION AUTH REQUIRED`，不得宣称 USER PASS。
- 任一 owner 泄漏、重复 job/usage、持久化失败后仍 POST、矛盾 terminal toast、React #310 均是 Production blocker。
- 最终 verdict 仅可为 `PASS`、`FAIL`、`PARTIAL` 或 `BLOCKED`，并附 exact source/deployment 与证据路径。
