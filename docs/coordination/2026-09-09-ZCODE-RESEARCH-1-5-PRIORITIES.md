# 调研1–5、调研总：进度审计与统一接管优先级

核对日期：2026-09-09（用户工作日期）。主模型负责优先级及证据复核；两名 Luna 子 Agent 只读盘点。接管任务：**最新的调研**，Codex thread `01a0894d-baa0-7a60-a3ba-9e7d74a45b43`，GPT-5.6 Sol。

本文件更新此前接管书的执行顺序；保留其交付要求及安全边界。旧会话作为历史证据，不重启，不并行覆盖旧报告。本次盘点不等于重新实测全部产品。

## 一、证据位置与阅读方式

- 原始对话：`C:/Users/44740/.zcode/cli/db/db.sqlite`，仅使用 SQLite `mode=ro`，以精确 session_id 与 message.sequence 检索 message/part。不要导出全库、凭据或全量工具日志。
- 旧报告：`D:/代码/Pinterest flow/docs/调研报告/create-pin-competitors/`。
- 旧截图：`D:/代码/Pinterest flow/docs/调研报告/assets/create-pin-competitors/`。
- 旧工作目录：`D:/代码/Pinterest flow`。新任务在 worktree 内，未跟踪文件未必被复制，必须按上述绝对路径读取。
- 尚未确认任何旧 Zcode 终端/PID 正在运行；历史 Git Bash 路径不是可直接操控的现役终端。接管材料，不向未知终端输入。
- 证据类型：本地原始对话、实际文件清单、旧报告。历史 Agent 的“完成”只说明自报状态；截图文件数量不等于有效界面数量，不等于实测闭环。价格、免费额度、登录态必须重新观察后才称当前有效。

## 二、六会话进度

| 会话与精确 ID | 实际产品/范围 | 已有成果 | 关键缺口及接管方式 |
|---|---|---|---|
| 调研1 `sess_8d79f07f-4040-491b-a62a-ec8d9841c86a` | PixPix、Photoroom、Pixelcut | 三份报告在盘；PixPix 8张图，主要公开入口/登录墙；Pixelcut 16张图+3操作日志，已有登录后 Generate/Edit/Batch 等入口操作 | Pixelcut 0 credits导致生成付费墙，无真实生成结果。Photoroom目录0图，只有公开文本证据；用户后续明确剔除Photoroom，不再补测。seq381用户要求点Generate/Edit/Batch；seq405汇总；seq413明确Photoroom无图，seq414报错。 |
| 调研2 `sess_9ea15e82-a821-43fd-b5eb-5af234df6d7d` | **Flair AI、Pebblely、Pic Copilot** | 三份报告在盘；Flair 5图，主要公开页/登录墙；Pebblely 4图含付费墙；Pic Copilot 3文件含一张黑图 | 不是B组！主模型独立检查seq0确认归属。Flair内部未验证；Pebblely用户曾要求停止付费深测，不擅自购买；Pic Copilot未完成内部实测，自动化/渲染失败不能写成产品缺陷。seq174指出黑图与误名，seq178修订台账。 |
| 调研3 `sess_7475f436-7e69-4a7b-a630-aeb94bb7f89e` | Claid、insMind、SellerPic、ProductScope/UGC Engine | 四报告在盘；共享目录Claid7文件、insMind4文件（含故障图）、SellerPic24图（含重复/临时图）、ProductScope2图 | SellerPic有登录后成果可复用；Claid内部未验证；insMind生成/Library/扣费未验证；ProductScope两张图尚未一致整合进旧报告。seq149–151报告复核，seq153–157取得UGC Engine页面截图，seq159用户愿登录，seq180请求失败。这些文件也被调研总写过，不能重复计算产出。 |
| 调研4 `sess_9a92a90d-35cb-48d3-a018-2a8877fe4c5f` | Pinterest原生、Tailwind SmartPin、Canva Bulk Create、Pin Generator | 仅旧资料阅读及部分Pinterest帮助页；pinterest-native目录7文件，含重复与404 | 四份预期产品报告均未找到；其他三产品截图目录0文件。seq35记录错误URL/失败；seq38限流终止。当前与Create Pin最相关却缺口最大，应优先接手。 |
| 调研5 `sess_ee199677-c786-4448-b25d-bb5404c33a1c` | VibePin As-Is：Create Pin、Studio、Product Opportunities、Plan、Insights、草稿/计费/发布数据流 | 仅任务书与仓库摸底 | `99-vibepin-asis-audit.md`不存在；无已完成代码行号审计。seq20/23子Agent失败，seq24限流终止。交给只读子Agent，与浏览器工作并行。 |
| 调研总 `sess_8729fb11-9f0a-4474-a0d0-4e72d7055f8c` | 原总研究；后半段实际深挖B组，特别SellerPic | SellerPic已有生成、详情、历史、批量下载、发布器、品牌入口观察；seq339/341自报报告与索引更新 | 不能把“调研总”理解为已交付总报告。seq336明确sellerpic.md被并行改动；seq341明确与调研3范围冲突。旧总报告未找到。只继承并逐图复核，不续启共享文件写入。 |

### 主模型质量纠正

1. 子Agent初稿把调研3材料误归调研2，已由主模型直接读取调研2 seq0、seq174/178及实际目录纠正。以后不得根据相同文件路径反推会话归属。
2. SellerPic历史seq341称发布器仅看到TikTok/Instagram/Facebook，没有Pinterest；这只能说明当时该界面未见Pinterest，不能推出整个Pinterest市场没有竞品。
3. “登录过”“看到生成按钮”“已经生成出图”“已导出”“已发布”必须分别记录，不能互相替代。未做发布不得为了验证而发到用户账号。
4. 当前图片数量是文件盘点；黑图、404、同页重复、营销页不能凑登录后实测数量。共享截图只计一次。旧日期不可改成新实测日期。

## 三、执行优先级：按产品决策价值，而非旧编号排队

| 顺序 | 工作包 | 原材料 | 具体交付与停止条件 |
|---|---|---|---|
| 已移出范围 | Pin Generator、Pinterest原生、URL2Pin | 调研4；旧URL2Pin记录 | 用户于本轮明确要求“不测这几个”。不再登录、截图、补报告或复用URL2Pin观察作为本轮核心证据；旧材料仅保留归档，不纳入待办。 |
| P0-B，与A并行 | VibePin当前Create Pin窄范围只读审计 | 调研5；现有PRD、风格库与开发现状 | 先查输入/商品识别→参考与风格→生成→结果恢复→导出，输出文件行号、证据日期/commit、Top5摩擦与可复用能力；先不要扩成全站代码审计，不改代码/数据库。 |
| P0-C，低成本收尾 | SellerPic与Pixelcut证据验收、合并旧会话状态 | 调研1/3/总 | 复用SellerPic生成/结果/历史，复用Pixelcut登录态结构；抽验截图，明确付费墙，输出适用于VibePin的等待/版本/恢复/扣费交互。快速修正ProductScope报告“0图/2图”矛盾，不因此优先深挖UGC Engine。 |
| P0-1 | Foreplay | 新广告库调研 | 最优先研究“发现广告→筛选→广告详情→Swipe File/Board/Tag→落地页与素材留存”。它直接决定VibePin广告参考库的信息架构。 |
| P0-2 | Creatify | 新广告生成调研 | 验证商品URL/参考广告→方向/脚本/场景→生成/编辑/历史，把广告库和商品内容生成连接起来。若当前无法访问登录后产品，先保留精确阻塞并转下一项。 |
| P0-3 | SellerPic | 调研3/调研总 | 已有最完整登录后证据。复核商品输入、参考图模式、版本、反馈、批量下载、历史恢复、credits与发布入口，提炼可直接用于VibePin的交互。 |
| P0-4 | VibePin As-Is | 调研5 | 只读审计Create Pin现状，将前三项证据映射到现有页面、数据模型和最小改版；先完成Top5摩擦及验收标准。 |
| P1-1 | BigSpy | 新广告库调研 | 研究搜索/筛选/保存/落地页/指标口径，用于补充Foreplay的数据侧；避免研究其全部平台和大型企业功能。 |
| P1-2 | Adobe Express | 风格调研 | 复核已存在的01–07证据，重点是模板/变体/编辑器的连续操作，不重复做首页介绍。 |
| P1-3 | Kittl、Canva中择优 | 风格调研/调研4 | 只选择能补齐模板变量、批量生成或编辑器交互的一个先深测；另一个做轻量对照。 |
| P1-4 | Pixelcut | 调研1 | 复用登录后Generate/Edit/Batch结构，付费墙即止；不为补真实结果购买credits。用于验证批量入口和收费提示，不作为核心差异化来源。 |
| P2 | Claid、insMind、PixPix、Flair AI、Pic Copilot、Minea | 调研1/2/3与新资料 | 仅在P0/P1存在明确证据缺口时补测。Claid关注API/批量，insMind关注批量和模板，其他保留轻量对照；不追求产品数量。 |
| 剔除/归档 | Photoroom、Pin Generator、Pinterest原生、URL2Pin、Tailwind、MagicBrief | 用户最新指令与产品状态 | 不登录、不截图、不补报告、不进入核心对比或登录清单。MagicBrief已关闭，只能标历史归档。 |
| 暂缓 | Predis、Pebblely付费深测、UGC Engine/ProductScope、大量新摄影工具 | 风格调研seq102；调研2 | 尊重用户Predis晚点和Pebblely不付费的要求；保留旧资料。没有核心决策缺口不要为凑数量继续研究。 |

“P0”是研究顺序，不意味着上述所有工具功能都应进入VibePin首版。最终产品功能仍需独立判断。

## 四、新任务执行分工与写入归属

- Sol：唯一研究负责人，控制共享Chrome，实测关键竞品，独立审查证据与优先级，写总报告与交互方案。
- 低成本Agent A：调研5的VibePin窄范围只读审计；只写自己的audit文件。不要触碰开发中的Create Pin任务。
- 低成本Agent B：调研1/2/3/总的证据台账与截图质量审计；每条结论附session/sequence或报告原文出处，不再误归会话。
- 低成本Agent C：Pinterest竞品/广告库的公开文档补证与待验证问题；不同时抢共享Chrome。已有子Agent正在工作时复用任务，不必重新开足三个。
- 各Agent在独立子目录写入；Sol拥有00-status、主报告及整合文档，旧目录只读。禁止两个Agent编辑同一产品报告。
- 默认Chrome，保留用户链接、草稿和生成结果。登录由用户亲自完成后自主体验；不购买、不绑定卡、不发布、不删除用户输入，不为分析尝试绕过权限。
- 明确排除：Photoroom、Pin Generator、Pinterest原生、URL2Pin、Tailwind、MagicBrief。不得重新加入登录、截图、体验或补报告任务；相关历史观察只归档。
- 先完成可操作部分并持续推进；仅登录、验证码、付费或关键选择需要用户接力。不建立无期限轮询，不把没启动的监控说成已启动。

## 五、统一产出与验收

输出根目录：`D:/代码/Pinterest flow/docs/research/create-pin-ad-library-2026-09-09/`，沿用已有新任务成果，不覆盖已完成新工作。

1. `00-status.md`先更新六旧会话映射、合并后的产品清单、唯一owner、完成/未验证/登录阻塞与本轮顺序。
2. 单品图文报告写到`products/`，真实截图写到`assets/`；旧图可引用或复制并注明来源日期，逐张打开验证。已有成果优先复用。
3. `EXPERIENCE_REPORT.md`与`.html`：必须含能打开的实测截图、步骤、观察、优缺点、VibePin可借鉴交互；图文验收不是文件存在检查。
4. `VIBEPIN_CREATE_PIN_REDESIGN.md`：As-Is→To-Be、交互摩擦排序、与多类目风格库的接法、分期任务与验收；不是实施授权。
5. `DECISION_BRIEF.md`：先做什么、暂不做什么、需要用户登录哪一个、付费是否有明确必要。不能因未登录伪造体验。

本次只读核查能确定旧任务产出与缺口，不证明当前浏览器登录态或网站功能仍和旧报告一致。Sol继续实测时须重新标时间。

## 接管任务实时状态补充

消息发送已由工具返回目标threadId确认。随后读取到新任务处于active/inProgress，最新进度说明本轮浏览器连接失败，正在分层整理历史截图、会话/代码证据和官方文档；明确不把历史截图冒称今天新实测。

该任务最新进度还明确“Tailwind不进入登录、截图或深测名单”。随后用户进一步明确排除Pin Generator、Pinterest原生、URL2Pin，并再次明确剔除Photoroom；MagicBrief因产品已关闭归档。因此这些产品均不进入登录、截图或深测名单；接管任务内用户的较新明确要求优先，不擅自恢复已排除产品。
