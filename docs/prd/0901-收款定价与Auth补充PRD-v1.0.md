# 0901 收款定价与 Auth 补充 PRD v1.0

**状态：** 验收基线冻结，待包含本 PRD 既有候选的最终 Preview 执行两轮 USER 验收

**日期：** 2026-09-01

**Owner：** Pricing / Billing / Auth

**输入台账：** `0901-统一Preview用户验收问题台账.md` 的 PB-01、PB-02、PB-03

**实现基线：** `codex/pricing-platform-icons-0901@e75676b8c6da288ba486bb546f23699ec7f6fcd1`

**PB-01 既有候选：** `e75676b8c6da288ba486bb546f23699ec7f6fcd1`；本文不重新实现

## 1. 一句话目标

让用户在同一个 test-bound Preview 上清楚理解套餐价格、Content 计量、社交账号额度与加购价格，能够安全进入 Creem Test checkout 边界并查看 Billing/Usage；同时把测试账号登录、Google OAuth 配置以及 B/C 隐私和伪造身份拒绝做成可复核的两轮门禁。

## 2. 不可协商边界

1. Preview 只连接测试 Supabase 与 Creem Test Mode；Production 的项目、域名、OAuth client、环境变量、数据库和支付数据不得混入。
2. 验收记录不得包含账号邮箱、密码、OTP、access/refresh token、cookie、Authorization header、OAuth code、Creem checkout session URL/query、Supabase key 或 provider secret。
3. 需要登录、Google OAuth 或权限确认时，由用户在浏览器中亲自输入或点击；代理只从登录后的非敏感页面状态继续。
4. 禁止真实付款、保存付款方式、最终提交订单、真实发布、Production 写入、Production migration、enforce 开关和 provider 账号生命周期操作。
5. 创建 Creem Test checkout session、触发测试生成或产生测试 usage/event 都属于外部副作用，必须在动作发生前单独确认；测试数据按用户要求保留，不擅自清理。
6. 两轮必须绑定同一个 exact runtime、manifest、deployment 和测试 Supabase ref；旧 deployment 证据只能作为历史背景。
7. HTTP `200/204/401` 只能证明对应运行时行为；不能用单次状态码替代 auth-before-body、零越权写入或日志隐私的代码/测试证据。

## 3. 产品规则

### 3.1 PB-01：每平台账号数的支持平台图标

1. `/pricing` 四张套餐卡的 `N account(s) per platform` 行必须同时显示 Pinterest、Instagram、Facebook 三个小图标。
2. Comparison table 的 `Accounts per platform` 行标题旁必须显示同一组三图标。
3. TikTok 不得出现在 Pricing 卡片、comparison 图标组或相关可见文案中。
4. 图标复用 canonical `PlatformIcon` 与 `VISIBLE_SOCIAL_PROVIDERS`，不得在 Pricing 中复制 provider 枚举或 SVG。
5. 图标为 14–16px 级别、`aria-hidden`；原有可读额度文字保留，并为读屏提供支持平台文本。
6. 桌面与 390px 均不造成页面横向溢出；图标组可 wrap/shrink。Comparison 可在自身容器内横向滚动，但不能撑宽 body。
7. PB-01 的代码候选为 `e75676b…`；只有纳入新的 final runtime 后，才能执行 USER PASS。

### 3.2 PB-02：Pricing、Content、extra account、Billing/Usage 与 Creem Test

#### 定价与周期

| 套餐 | Monthly | Yearly 页面月均价 | Creem Test 年付总额 |
|---|---:|---:|---:|
| Free | $0 | $0 | 不进入 checkout |
| Starter | $19/月 | $15/月 | $180/年 |
| Pro | $49/月 | $39/月 | $468/年 |
| Business | $99/月 | $79/月 | $948/年 |

卡片和 comparison header 必须随同一个 Monthly/Yearly toggle 同步变化，不能出现卡片已切换而 comparison 仍显示另一周期价格。

#### Content 计量

`One Content = 1 scheduled post`：同一个 Content 无论选择一个还是多个发布渠道，只计一条 scheduled post。Pricing 正文、comparison 下方说明和 FAQ 的口径必须一致。此文案验收不等于 shadow ledger 已产生事件；真实 shadow event 仍是单独的写入授权门禁。

#### Extra account

1. 仅 Starter、Pro、Business 可购买；Free 显示 Upgrade，不显示可直接购买。
2. 一个 slot 可用于任意已支持平台，可购买多个；套餐自带 1/1/2/3 accounts per platform 不变。
3. 价格为 `$7/account/month`；年付总额 `$60/account/year`，页面可写为 `$5/account/month billed annually`。
4. 当前客户侧支持平台为 Pinterest、Instagram、Facebook；TikTok 不显示。
5. Pricing 文案、FAQ、Social Settings 的加购入口和 Creem Test 产品必须使用同一价格/资格口径。

#### Billing / Usage

1. exact path 为 `/app/settings/billing`；未登录时必须安全跳转 `/login?next=%2Fapp%2Fsettings%2Fbilling`，登录后回到 Billing。
2. Billing 显示当前测试账号的套餐、订阅状态、周期和可用操作；不得把 Free/inactive 与付费额度混合展示。
3. Usage 展示 AI images、AI text generations、scheduled posts 的 used/limit/remaining，并区分 `metered`、`unmetered`、`unavailable`。
4. `unmetered` 不得伪装成真实 `0 used`；`unavailable` 不得降级成 unmetered；Business unlimited 不做除法。
5. authenticated `GET /api/billing/usage` 应为 JSON；UI 与 API 对同一测试账号的 plan/period/used/limit 必须一致。读取前后测试库行数不变，GET 不得隐式 ensure/write。

#### Creem Test checkout 边界

1. 仅使用 Creem Test Mode；页面必须能识别为 test/sandbox，不得混入 live product。
2. 六个套餐映射：Starter/Pro/Business × month/year；两个加购映射：extra account × month/year。
3. 预期金额分别为 `1900/18000/4900/46800/9900/94800/700/6000` cents，币种 USD，recurring period 与选择一致。
4. USER 验收到 Creem Test checkout 页面显示正确产品、金额和周期即停止；禁止填写支付资料、点击最终支付或保存付款方式。
5. checkout session URL、session id 和查询参数不得写入截图、日志或 receipt；只记录 Test Mode、产品种类、金额、周期、HTTP 状态和是否到达边界。
6. 未登录点击 paid CTA 必须保留 plan + period intent：登录/注册后继续原选择，不得只回到无状态 Pricing。

### 3.3 PB-03：测试 Supabase 登录与 Google OAuth

#### Preview 推荐登录路径

Preview 验收的正式推荐路径是：

`/login?next=<经过 safeNextPath 校验的站内相对路径>` → 用户亲自使用专用测试账号 email/password 登录 → 返回原业务路径。

默认无来源时进入 `/app/studio`；Pricing paid CTA 必须保留 plan/period intent；禁止把密码、OTP 或 session 交给任何代理。Google OAuth 是独立门禁，不是 email/password 失败后的自动绕过方案。

#### Google OAuth 错误状态

1. 测试 Supabase 的 Google provider 未正确配置时，不能把 `Continue with Google` 视为可用或验收 PASS。
2. 错误回到 `/login?error=1` 时，只显示安全通用文案；不得显示 Google/Supabase 原始错误、OAuth code、用户邮箱或 token。
3. 若本轮没有用户亲自完成 Google 授权，则记 `GOOGLE_OAUTH_NOT_EXECUTED` 或 `USER_AUTHORIZATION_REQUIRED`，不能用 email/password PASS 代替 Google OAuth PASS。
4. 连续两次同一浏览器控制失败时停止，记浏览器工具阻断；不能判产品 FAIL，也不能第三次盲试。

#### Preview test 与 Production 配置矩阵

| 项目 | Preview / 测试 Supabase | Production |
|---|---|---|
| Supabase 项目 | test ref `snulmwprsahzqvdbyenc` | 独立 Production project；不得使用 test ref |
| Site URL | `https://vibepin-fb-preview.vercel.app` | 正式产品 canonical origin |
| Redirect allowlist | stable `/auth/callback` + 当前 exact unique deployment `/auth/callback`；本地开发如需加入，仅限 `http://localhost:3000/auth/callback` | 只允许正式 origin 的 `/auth/callback`；不得含 Preview、Vercel 通配或 localhost |
| App redirectTo | `${window.location.origin}/auth/callback?next=<safe-relative-path>` | 同一代码规则，但 origin 必须为正式域名 |
| Google OAuth callback | `https://snulmwprsahzqvdbyenc.supabase.co/auth/v1/callback` | Production Supabase 项目的 `/auth/v1/callback` |
| Google client | 独立测试 client；测试 consent screen/test users | 独立生产 client；正式 consent/brand verification |
| Provider 状态 | Client ID/secret、callback、test users 全部就绪后才宣称 enabled | 单独配置与验证；不得复制测试 secret |
| Scopes | 最小 `openid email profile` | 同样最小化；新增 scope 需单独审查 |

配置验收只记录“存在/缺失、匹配/不匹配、enabled/disabled、test/production”，绝不记录 credential 值。测试项目可以允许 exact stable 与 exact unique Preview callback；Production 不允许宽泛 Vercel wildcard。

## 4. B/C 安全补充门禁

### 4.1 B：生成失败的隐私输出

1. `/app/studio` 的失败卡片、toast、Network response、console 和可下载证据不得包含原始 prompt、keyword、category、creative direction、product/reference URL、provider response body、用户 id、request id、token、密钥或堆栈。
2. 用户只看到分类后的安全文案，例如 provider busy、safety blocked、configuration error、service unavailable 或通用 generation failed，并得到可恢复动作。
3. 服务端只允许结构化 metadata、计数、status、model、latency、error type 和不可逆 correlation hash；不得记录原始内容或 provider body。
4. 真实用户端触发一次可控失败可能产生 provider/usage/test-data 副作用，动作前必须单独确认；若不授权，B USER 记 `NOT_EXECUTED`，代码隐私测试单独报告，不冒充 USER PASS。

### 4.2 C：verified identity、private route 与 auth-before-body

1. 未登录或伪造 cookie/bearer 访问下列 private routes 必须被拒绝，且返回 JSON，不得读取或返回其他用户数据：
   - `GET /api/social/connections`
   - `GET /api/integrations/facebook/pages`
   - `GET /api/pinterest/boards`
   - `GET /api/pinterest/status`
2. 合法登录态必须通过 verified bearer-or-cookie identity，返回仅属于当前测试账号的数据；本地解码但未被 Supabase Auth 验证的 SSR session 不能成为身份。
3. `POST /api/analytics/events` 必须先验证身份再读取 body。未认证/伪造请求维持 best-effort `204` 也不能据此宣称顺序正确；auth-before-body 需由 frozen source/test 证明 `jsonCalls=0`、zero forged insert。
4. AI analyze/quality cost attribution必须复用已经通过认证的同一 user id，不能二次弱解析得到另一身份。
5. C 的验收禁止构造任何真实用户 token；只使用空身份、明确无效的测试哨兵和用户亲自建立的合法 Preview session。

## 5. 两轮 USER 验收协议

每轮开始记录：exact runtime、manifest、deployment、stable/unique URL、测试 Supabase ref、Creem mode、桌面/移动 viewport、登录态。每轮结束记录：每项 PASS/FAIL/BLOCKED、console error、关键 HTTP、测试数据副作用和最终登录态。Round 2 必须重新执行操作，不得复制 Round 1 截图或 DOM。

| ID | Exact 路径 / 方法 | 前置状态 | 用户操作 | 预期 UI | 预期 HTTP / 数据 | 测试副作用 | 禁止动作 |
|---|---|---|---|---|---|---|---|
| PB01-1 | `/pricing` | 未登录；Monthly；桌面与 390px | 逐张查看 Free/Starter/Pro/Business | 每张 account 行有 Pinterest/Instagram/Facebook 三图标；无 TikTok；文字可读 | 无关键写请求；body 不横溢 | 无 | 不改 viewport 后遗留；不把 DOM 字符串代替可见证据 |
| PB01-2 | `/pricing` comparison | 同上 | 定位 `Accounts per platform` | 标题旁同组三图标；note 与 1/1/2/3 可读；390px 只在表容器内滚动 | 无写请求 | 无 | 不允许页面级横向溢出 |
| PB02-1 | `/pricing` | Monthly | 读取卡片与 comparison | `$0/$19/$49/$99` 同步 | 无写请求 | 无 | 不创建 checkout |
| PB02-2 | `/pricing` | Monthly | 点击 Yearly，再切回 Monthly | Yearly `$0/$15/$39/$79`；comparison 同步；切回后恢复 Monthly | 无写请求 | 本地 UI state | 不因切换自动 checkout |
| PB02-3 | `/pricing` + FAQ | 任一周期 | 查看 Content 计量说明 | 明确 one Content = one scheduled post，跨渠道不倍增 | 无写请求 | 无 | 不用真实排程冒充文案验收 |
| PB02-4 | `/pricing` + Social Settings 加购入口 | 付费/Free 场景分别验证 | 查看 extra account 资格与价格 | paid-only；any platform；multiple；$7 monthly / $5 annual equivalent / $60 year；Free=Upgrade | 配置只读；金额一致 | 无 | 不创建加购订阅 |
| PB02-5 | `/login?next=%2Fapp%2Fsettings%2Fbilling` → `/app/settings/billing` | 用户亲自登录测试账号 | 登录并返回 Billing | 回到原路径；当前 plan/status/period 诚实一致 | `GET /api/billing/status`、`GET /api/billing/usage` 为 authenticated JSON | 仅登录 session | 不记录凭据/cookie/token |
| PB02-6 | `/app/settings/billing` | 已登录 | 查看 Usage 三类额度 | metered/unmetered/unavailable 语义正确；无假 0；无限额诚实 | API/UI 同一 plan/period/used/limit；GET 前后测试表行数不变 | 无 | 不调用 ensure/write；不查 Production |
| PB02-7 | `/pricing` paid CTA | 已登录；先 Monthly 后 Yearly | Starter/Pro/Business 分别进入 Test checkout 边界 | Creem 页面明确 Test；产品、金额、period 匹配 | checkout POST 200；六映射金额精确 | 每次可能创建 Test session；动作前确认 | 不填支付资料；不最终提交；不记录 session URL/id |
| PB02-8 | Social Settings extra account CTA | 已登录付费测试账号；monthly/yearly | 分别进入 extra account Test checkout 边界 | $7/month 与 $60/year，units 与选择一致 | checkout POST 200；700/6000 cents | 可能创建 Test session；动作前确认 | 不付款、不保存卡、不改真实连接 |
| PB02-9 | `/pricing` paid CTA → login/signup → return | 未登录 | 选择 plan/period 后登录 | 返回并保留原 plan + period intent，继续正确 Test checkout 边界 | redirect 链不丢 query/intent | 登录 + 可能 Test session | 不开放站外 next；不自动付款 |
| PB03-1 | `/login?next=%2Fapp%2Fsettings%2Fbilling` | 未登录 | 用户亲自 email/password 登录 | 安全返回 Billing；无来源默认 Studio | Supabase Auth 成功；session 只存浏览器 | 测试 session | 不向代理提供密码/OTP |
| PB03-2 | `/login` → Google → `/auth/callback` | Google test provider 配置完成且用户动作前确认 | 用户亲自选择测试 Google 账号并确认最小 scope | 成功回到 safe next；失败只显示通用错误 | callback 与 test Supabase/allowlist 匹配 | Google OAuth consent/session | 不记录邮箱、code、token；不扩大 scope |
| PB03-3 | Supabase/Google 配置只读检查 | 管理端由有权用户亲自查看 | 对照 §3.3 配置矩阵 | Preview 与 Production 清楚分离 | 只记录状态和 host/path，不记录值 | 无 | 不编辑 provider/env/allowlist |
| B-1 | `/app/studio` | 已登录；单次受控失败已单独确认 | 触发一次安全失败并查看卡片/toast | 仅安全分类文案和恢复动作 | response/console/server evidence 无原始 prompt/provider body/URL/id/token | 可能有 provider/usage/test-data | 不用 mock 冒充 USER；不重复盲试 |
| C-1 | private GET routes | 无登录 | 逐个请求四个 private GET | 不显示私有内容 | `401 application/json` | 无 | 不用真实 token 造伪造请求 |
| C-2 | private GET routes | 明确无效哨兵 cookie/bearer | 重复四个 GET | 同样无私有内容 | `401 application/json`；zero cross-user data | 无 | 不复制真实 cookie/header |
| C-3 | private GET routes | 合法测试登录态 | 读取当前测试账号数据 | 只显示该账号的 connection/Page/board/status | `200 application/json`；owner-scoped | 无 | 不 Connect/Reconnect/Disconnect/Remove |
| C-4 | `POST /api/analytics/events` | forged/unauth；malformed body | 发送一次 bounded probe | 无 UI 泄露 | 可为 `204`；frozen test 必须另证 auth-before-body、`jsonCalls=0`、zero insert | 无 | 不用 HTTP 204 单独判 PASS；不向 Production 发请求 |

Round 1 与 Round 2 的上述用例都必须独立填写；任何一轮未执行即为 `NOT_EXECUTED`，登录/OAuth/副作用未获动作前确认即为 `USER_ACTION_REQUIRED`，浏览器连续两次失控即为 `BLOCKED_BROWSER_CONTROL`。这些状态都不能写成 PASS。

## 6. 机械与配置验收矩阵

| 门禁 | 必须证明 | PASS 条件 |
|---|---|---|
| Pricing contract | 四卡、comparison、canonical icons、无 TikTok、390px contract | focused test 全绿，changed-file ESLint/typecheck/build/diff-check 全绿 |
| Pricing amounts | Monthly/Yearly 和 comparison 同源 | 0/19/49/99 与 0/15/39/79；代码契约 + 两轮 UI 一致 |
| Creem Test products | 六套餐 + 两加购映射 | test/active/USD/recurring/period/price 8/8；无 live id 混入 |
| Billing/Usage | verified identity + honest tri-state | authenticated JSON；UI/API 对账；GET 零写入 |
| B privacy | 原始敏感内容不出 response/log/UI | sentinel 测试全绿 + 一次用户端受控失败（获单独确认） |
| C identity | verified auth、owner scope、auth-before-body | private route tests、forged tests、analytics ordering tests 全绿；USER probes 与契约一致 |
| Supabase binding | Preview bundle/runtime 指向 test ref | test ref 命中、Production ref 0；exact deployment debug/receipt 匹配 |
| Auth config | Site URL、redirect allowlist、Google provider/client 分环境 | 配置矩阵逐项读回；不记录 secret；Preview 与 Production 无交叉 |

## 7. 证据模板

每个用例至少记录：

- `candidate`: runtime / manifest / deployment / stable / unique / test ref
- `round`: 1 或 2
- `viewport`: desktop 与 390×844
- `startAuth` / `endAuth`: anonymous 或 authenticated test account；不记身份值
- `path`: exact path；含敏感 query 时只保留 host + route
- `actions`: 用户实际点击路径
- `visible`: 可见结果，不以源码字符串代替
- `http`: method / route / status / content-type；不记 header/token/session id
- `console`: error 数量与安全摘要；不复制敏感 payload
- `data`: read-only 对账、行数是否变化、是否产生 Test session/event
- `verdict`: PASS / FAIL / BLOCKED / NOT_EXECUTED / USER_ACTION_REQUIRED
- `sideEffects`: NONE 或精确的测试副作用类型；不记录秘密值

## 8. 放行规则

1. PB-01、PB-02、PB-03、B、C 必须在同一个包含 `e75676b…` 的最终 runtime/deployment 上完成两轮。
2. P0 任一用例为 FAIL、BLOCKED、NOT_EXECUTED 或 USER_ACTION_REQUIRED，统一 Preview 验收不得写 COMPLETE。
3. Creem Test product 8/8 只读映射 PASS 不等于 USER checkout PASS；email/password PASS 不等于 Google OAuth PASS；HTTP 204 不等于 auth-before-body PASS。
4. USER 证据、代码门禁、配置读回和测试数据对账四层全部闭合后，才可给 `PREVIEW ACCEPTANCE PASS`。
5. Preview PASS 仍不授权 Production 部署、Production migration、enforce、真实付款或正式发布；这些动作必须另立生产 release gate。

## 9. 回滚与风险

1. PB-01 只涉及 Pricing 呈现，回滚为移除 Pricing 图标渲染，canonical provider 与 entitlement 不变。
2. Auth 配置错误优先回滚/禁用测试 Google provider 入口，email/password 测试登录保持可用；不得通过放宽 Production redirect wildcard 解决 Preview 问题。
3. checkout 产品/周期/金额任一不匹配时立即停止，不测试付款；修正 Test 配置后重新执行两轮。
4. Billing/Usage 出现 plan/status/limit 矛盾时按产品缺陷记录，不通过手工改测试库掩盖。
5. 任何 receipt 发现凭据、token、cookie、OAuth code 或 checkout session URL，证据作废并按安全事件处理；不得把秘密继续复制到新的文档。
