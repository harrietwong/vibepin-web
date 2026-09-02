# 0901 Reference / Create Pin Seam USER Acceptance Case File

状态：`TEMPLATE — NO USER VERDICT`

范围：`creativeSetupStore` sole general restore、owner/workspace 隔离、generation intent 原子持久化、single-card retry、recovery、single-toast seam、analytics 与 `X-Request-Id`。

本文件是同一个最终 Preview candidate 的执行记录模板。它不构成 Preview 部署、provider 生成、Production 放行、发布、排期、OAuth、付款或任何外部动作授权。机械测试通过不能替代本文件要求的真实 USER 证据。

## Candidate Binding

| 字段 | Round 1 | Round 2 |
|---|---|---|
| exact commit SHA | `[填入]` | `[必须与 Round 1 相同]` |
| Preview runtime/deployment | `[填入]` | `[必须相同]` |
| Preview/test backend binding | `[填入]` | `[必须相同]` |
| verified workspace/user owner | `[填入脱敏标识]` | `[填入；A→B→A 另记录]` |
| browser/OS | `[填入]` | `[填入]` |
| test fixture path + SHA-256 | `[填入；不得上传未登记 fixture]` | `[填入不同 fixture]` |
| start/end timestamp | `[填入]` | `[填入]` |
| final verdict | `PASS / FAIL / BLOCKED / NOT_OBSERVED / NO VERDICT` | `PASS / FAIL / BLOCKED / NOT_OBSERVED / NO VERDICT` |

判定规则：P0 失败、React invariant、uncaught error、跨 owner 内容、重复 POST/job/placeholder/reservation/usage、Production ref 或不能绑定 exact candidate，均为 `FAIL` 或 `BLOCKED`，不得以“未观察到”推断通过。自然未出现的 partial/429/failed 分支记 `NOT_OBSERVED`。

## Action-Time Authorization Boundary

执行人每次到达动作前，重新确认下表；确认只覆盖该动作及其明确测试副作用，不扩展到其他动作。

| 动作 | 本 case 可执行 | 必须在动作时确认 | 明确禁止 |
|---|---|---|---|
| 打开 Studio、切 tab、打开/关闭 Drawer、选择/取消 Reference、编辑并 Cancel | 是 | 不需要外部授权；应为零写请求 | upload、generation、schedule、publish、usage 写入 |
| Save Creative direction / Save 本地 setup | 仅限 Preview test backend | owner/workspace 已 verified，记录 setup key/scope | provider job、usage、Production storage |
| 使用已登记 fixture 上传 | 仅限用户明确授权的 test fixture | exact runtime、fixture SHA、Preview storage boundary | 真实商店、Production bucket、未登记文件 |
| analysis / recommendation / Retry failed stage | 仅限 Preview test backend | 上传已完成；新 requestId；记录 exact status/code | 重传成功上游阶段、OAuth、发布 |
| 点击 Generate（count=1 的 seam case） | 仅限 Preview test provider | 用户在本步骤明确确认；setup、owner、scope、count、reference 已复核 | 未确认 POST、探测性 POST、Production provider、发布/排期 |
| Generation recovery / poll / reload | 是，限已存在的 test intent | 原 owner/workspace 与 intent/job 仍匹配 | 新建 intent、盲重发、重复 charge |
| 失败卡 Try again | 仅限用户明确点击 | 只允许失败 group、`count=1`、保留 snapshot provenance | 重放全 batch、重发成功 slot |
| 429 重试 | 仅自然发生时 | exact `Retry-After` 倒计时归零且用户再次点击 | flood、人为制造 429、自动循环 |
| Publish、Schedule、OAuth、付款、Production、push/merge/deploy | 否 | 另行流程与另行授权 | 本文件任何步骤均不得执行 |

## Evidence Capture Contract

每个 case 都填写以下字段；所有值脱敏，不记录 token、Cookie、provider key、图片 bytes、完整自由文本、完整 URL query 或 raw provider body。

| 证据 | 记录字段 |
|---|---|
| UI | viewport、点击路径、截图路径、可见阶段/错误/按钮、fallback、aria 状态 |
| HTTP | method、path、status、duration、`X-Request-Id`/requestId、safe error code、结果类别；记录 GET/POST 数量 |
| Console | error/warn、unhandled rejection、React invariant；标明 `none` 或完整脱敏摘要 |
| Generation | intentId、toastId、jobId、groupId/slotId、expected/succeeded/failed；不得记 prompt/secret |
| Side effects | upload、analysis、recommendation、generation、job、placeholder、reservation、usage、draft 变化的 before/after |
| Cleanup | 仅记录用户明确选择的 test cleanup；默认保留用户要求保留的 test data；禁止清理其他 owner 或 Production 数据 |
| Result | `PASS / FAIL / BLOCKED / NOT_OBSERVED`、失败条件、复核人、时间 |

## Round 1 — Desktop 1440×900

### R1-A Setup and provenance restore

前置：绑定 exact candidate，登录 verified owner A/workspace W，记录 `/app/studio` 与初始 draft/history GET。

步骤：

1. 打开统一 AI Drawer，选择一个有 stable product id 的商品；确认商品图片、source、public URL、selection origin 可见。
2. 选择最多 2 个 Reference，至少一个带 `source/sourceUrl/reason/patternTags`；选择 Direction。
3. 编辑 Creative direction，记录 committed 值长度 bucket；点击 Cancel，确认恢复旧 committed 值；再次编辑并 Save。
4. 关闭 Drawer，重开同一 draft/product；刷新页面后再次打开。

预期 UI：同一 owner/workspace 的 product/reference/direction/model/count/variation 恢复；Direction input 是真实可聚焦控件，有 label/focus/helper；Cancel 不改变 committed 值；缺图为统一深灰 fallback，不出现 URL、乱码、白块或永久 spinner。

预期 HTTP/Console：普通打开、选择、Cancel、close/reopen/reload 无 generation/upload/publish/schedule/usage POST；若有 setup persist，必须是 owner-scoped test state；无 uncaught error、React #310、敏感字段。

预期副作用/清理：允许 setup 的 Preview test 状态更新；不创建 job、placeholder、reservation、usage；不清理 setup。记录 owner scope、storage key 是否 opaque，不能把 merchant URL 出现在 key/console。

| 字段 | 记录 |
|---|---|
| screenshot(s), viewport | `[填入]` |
| exact UI result | `[填入]` |
| HTTP ledger | `[填入]` |
| Console ledger | `[填入]` |
| side-effects before/after | `[填入]` |
| cleanup performed | `[none / 说明]` |
| PASS/FAIL + reason | `[填入]` |

### R1-B Recommendation, selection and provenance

步骤：

1. 对当前商品触发 analysis；等待 pending→ready 或安全失败。
2. 请求 recommendation；记录第一次 requestId、daily seed、`limit=9`、`excludeIds=[]`。
3. 选择一个 Reference，记录 selected tray、exact source/linkback/reason/patternTags。
4. 点击换一批；记录新 requestId、served ids、excludeIds 与 selected tray。
5. 点击一个 linkback，仅验证 exact response `sourceUrl/pinterestUrl`；返回 Drawer。

预期 UI/HTTP：已选 Reference 保留；换一批使用新 requestId、同 daily seed、bounded deduplicated `excludeIds≤72`，不重复仍在屏幕或已选项；200 空列表显示诚实空态；401/429/5xx/network 显示阶段化错误与 safe code，不伪装为空。Retry 只重试失败阶段。

预期副作用：选择/换一批/linkback 不创建 generation job、placeholder、usage、publish、OAuth；linkback 打开不写入外部服务。

| 字段 | 记录 |
|---|---|
| analysis/recommendation HTTP evidence | `[填入]` |
| selected/reference provenance | `[填入]` |
| excludeIds count and sample IDs | `[填入；仅脱敏 ID]` |
| screenshot(s) | `[填入]` |
| Console/side-effects | `[填入]` |
| PASS/FAIL/NOT_OBSERVED | `[填入]` |

### R1-C Generate seam: count=1, one frozen attempt

动作前确认：用户明确确认本次测试 generation；verified owner A/W、model、count=1、committed direction、selected Reference 与 Preview provider binding 均正确。不得从本步骤延伸到 publish/schedule。

步骤：

1. 点击 Generate 一次；在确认前记录 setup fields 与 selected Reference provenance。
2. 检查先后顺序：setup/intent 持久化成功 → placeholders 出现 → 唯一 `/api/generate` POST。
3. 记录 `X-Request-Id=generation:{intent/group}`、intentId、toastId、jobId（如 worker）、group/slot、usage/reservation correlation。
4. 观察 pending/accepted/running；确认同一 toast id 使用中性 loading，不显示成功色。
5. 等待 completed/partial/failed/unknown；对 unknown 仅刷新/reconcile，不点击新 Retry。

预期 UI/HTTP：一次 Generate 只交付一份 immutable effective setup snapshot；setup 含最终可见 direction 和完整 Reference provenance；每个 selected Reference 对应 group；count=1 对应一个 slot；唯一 toast id `generation:{intentId}` 原位更新且仅一个 terminal。intent persist 失败时 POST 数为 0，orphan placeholders 被释放，用户看到固定 safe machine error；不会继续下一个 group。

预期 Console/副作用：不输出完整 prompt、URL、图片 bytes 或 secrets；test provider job/placeholder/reservation/usage 只能在用户确认后出现，且能用 owner+intent/job 对账；不发生 publish/schedule/OAuth/Production 写入。

| 字段 | 记录 |
|---|---|
| action-time confirmation | `[user/time/scope，填入]` |
| setup snapshot fingerprint/correlation | `[仅安全摘要，填入]` |
| POST count and request IDs | `[填入]` |
| intent/job/group/slot/toast IDs | `[脱敏填入]` |
| terminal state | `[completed/partial/failed/unknown]` |
| usage/reservation delta | `[填入；若未授权/未观察说明]` |
| Console | `[填入]` |
| PASS/FAIL/NOT_OBSERVED | `[填入]` |

### R1-D Failure/recovery and exact single-card retry

步骤：

1. 仅在自然生成失败、已登记安全 failure fixture 或 test backend 明确返回失败时继续；否则记 `NOT_OBSERVED`。
2. 关闭/刷新后重开同一 owner A/W；确认失败 setup、reference provenance、direction 与 intent recovery metadata 仍在。
3. 对一张失败 card 点击 Try again；记录 retry payload 的 reference 数、`count=1`、`retryOfIntentId`。
4. 确认成功 slot 不重发，失败 slot/group 才有新动作；确认旧 attempt snapshot 未被修改。

预期：orphan persisting release 后不存在可重试的假失败卡；unknown 保留 recoverable intent 并锁住重复生成；terminal failed/partial 使用原 toast id；Try again 只恢复 one failed card/group，绝不重放原 multi-reference × count batch。

| 字段 | 记录 |
|---|---|
| failure condition and safe code | `[填入/NOT_OBSERVED]` |
| reload/recovery UI and HTTP | `[填入]` |
| retry count/reference/retryOf | `[填入]` |
| old snapshot unchanged evidence | `[填入]` |
| side-effects/job/usage delta | `[填入]` |
| PASS/FAIL/NOT_OBSERVED | `[填入]` |

## Round 2 — Mobile 390×844

Round 2 必须重新加载 exact candidate、重新打开关键表面，不能沿用 Round 1 DOM 或仅复制截图。使用不同登记 fixture；若测试 owner 切换，按 R2-C 的 A→B→A 记录。

### R2-A Responsive restore and media fallback

步骤：

1. 将 viewport 设置为 390×844，刷新 `/app/studio`，打开统一创建入口与 AI Drawer。
2. 重复 R1-A 的选择、Direction edit/Cancel/Save、close/reopen、reload。
3. 检查 `documentElement.scrollWidth`、`body.scrollWidth`、drawer 与主要容器宽度。

预期：单列、Drawer 内无横向溢出；CTA、Save/Cancel、linkback 与 retry 可触控；触控热区至少 44px；长中文/英文/繁中换行；fallback 保持深灰固定比例，不改变按钮位置或 selection/provenance。

| 字段 | 记录 |
|---|---|
| screenshots and width measurements | `[填入]` |
| keyboard/touch/a11y result | `[填入]` |
| HTTP/Console | `[填入]` |
| side-effects/cleanup | `[填入]` |
| PASS/FAIL | `[填入]` |

### R2-B New fixture upload, analysis and recommendation isolation

步骤：

1. 用不同 fixture 执行安全上传；记录 fixture SHA、asset/imageKey、productRevision。
2. 观察 analysis/recommendation pending/ready/failed；在 pending 中换图一次。
3. 检查旧响应迟到时不会覆盖新 imageKey/revision；记录 stale discard event 与新 requestId。

预期：Retry 只重试失败 stage；旧请求取消或迟到响应丢弃；exact stage/http/safe code/requestId 可追溯；无永久 spinner、broken alt 或跨 Round 1 状态。

| 字段 | 记录 |
|---|---|
| fixture/imageKey/revision | `[填入]` |
| HTTP sequence | `[填入]` |
| stale guard evidence | `[填入]` |
| screenshots/Console | `[填入]` |
| side-effects and cleanup | `[填入]` |
| PASS/FAIL | `[填入]` |

### R2-C Owner/workspace A→B→A

步骤：

1. 登录 verified owner A/workspace W1，确认只看到 A 的 setup/reference/intent；记录 scope。
2. 在 generation pending/unknown 或有 recoverable setup 时切换到 verified owner B/workspace W2；等待页面稳定并刷新。
3. 检查 B 的 UI、local storage namespace、HTTP ledger、console 和 side-effects。
4. 切回 A/W1，刷新并 reconcile；检查 A 原 intent/job/setup 是否恢复。

预期：B 看不到 A 的 product image/reference/direction/job/usage；切换后旧 await 的任何后续 store mutation、UI callback、toast terminal、provider POST/GET 均为零；A 返回后只恢复 A/W1 自己的未提交 setup/intent。workspace 变化同样隔离，即便 user id 相同。

| 字段 | 记录 |
|---|---|
| A/B verified scopes | `[脱敏填入]` |
| B visible data | `[必须为零 A 数据]` |
| post-switch request/mutation/callback counts | `[填入]` |
| A re-login recovery evidence | `[填入]` |
| screenshots/Console | `[填入]` |
| PASS/FAIL | `[填入]` |

### R2-D Mobile generation/recovery and analytics bounds

步骤：

1. 仅在 R2 action-time confirmation 后点击一次 Generate，count=1；记录唯一 intent/toast/POST。
2. 若出现 worker job，刷新或重开 Drawer；观察原 job polling/reconcile。
3. 若自然出现 429，等待合法整数 `Retry-After≥1` 倒计时归零后由用户手动点击一次；否则记 `NOT_OBSERVED`。
4. 导出脱敏 analytics 事件并验证 allowlist、关联字段与每事件 ≤4096 bytes。

预期：unknown 不变成失败，不创建新 job/placeholder/reservation/charge；poll GET 带稳定 `X-Request-Id`；terminal 只出现一次；analytics 仅含 bounded id/category/count/status/duration/safe code，不含完整 direction、prompt、URL query、token、Cookie、图片 bytes/raw provider body。

| 字段 | 记录 |
|---|---|
| action-time confirmation | `[填入]` |
| intent/job/slot/toast/usage evidence | `[填入]` |
| generation HTTP and X-Request-Id | `[填入]` |
| analytics allowlist/size result | `[填入]` |
| 429 evidence or NOT_OBSERVED | `[填入]` |
| Console/side-effects | `[填入]` |
| PASS/FAIL/NOT_OBSERVED | `[填入]` |

## Final Two-Round Receipt

| Gate | Round 1 | Round 2 | Notes/evidence |
|---|---|---|---|
| same exact candidate/runtime | `PASS/FAIL` | `PASS/FAIL` | `[填入]` |
| 1440×900 / 390×844 usable | `PASS/FAIL` | `PASS/FAIL` | `[填入]` |
| owner/workspace isolation | `PASS/FAIL` | `PASS/FAIL` | `[填入]` |
| setup provenance + committed direction | `PASS/FAIL` | `PASS/FAIL` | `[填入]` |
| intent-before-POST / zero POST on persist failure | `PASS/FAIL/NOT_OBSERVED` | `PASS/FAIL/NOT_OBSERVED` | `[填入]` |
| single-card retry count=1 | `PASS/FAIL/NOT_OBSERVED` | `PASS/FAIL/NOT_OBSERVED` | `[填入]` |
| unknown/recovery/orphan release | `PASS/FAIL/NOT_OBSERVED` | `PASS/FAIL/NOT_OBSERVED` | `[填入]` |
| single toast + terminal uniqueness | `PASS/FAIL` | `PASS/FAIL` | `[填入]` |
| X-Request-Id + analytics bounds | `PASS/FAIL` | `PASS/FAIL` | `[填入]` |
| Production/publish/OAuth/payment side-effects = 0 | `PASS/FAIL` | `PASS/FAIL` | `[填入]` |
| final verdict | `[填入]` | `[填入]` | `[复核人/时间]` |

## Cleanup Receipt

默认：保留用户要求保留的 Preview test data，尤其是 test generation intent/job/placeholder/result/usage receipt。只清理用户在 action-time 明确授权且本表记录的 test artifact；清理必须绑定 owner/workspace 与 artifact id。禁止删除其他 owner、Production、真实发布结果、外部账号或账单数据。

| Artifact | Owner/workspace | Action-time authorization | Performed? | Evidence |
|---|---|---|---|---|
| `[test setup/intent/job]` | `[填入]` | `[填入]` | `Y/N` | `[填入]` |
| `[test upload/asset]` | `[填入]` | `[填入]` | `Y/N` | `[填入]` |
| `[other]` | `[填入]` | `[填入]` | `Y/N` | `[填入]` |

签署：

- USER executor: `[填入]`
- Independent reviewer: `[填入 / NO VERDICT]`
- Date/time: `[填入]`
- Verdict: `USER_PASS / USER_FAIL / USER_E2E_BLOCKED / NO_VERDICT`
