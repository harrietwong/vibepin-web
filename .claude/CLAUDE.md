# 项目协作规则

## 生产部署纪律(2026-07-22 固化,不可绕过)

**生产部署权归一:只有用户指定的部署会话可以执行 `vercel --prod` / `vercel promote`。**

背景:2026-07-22 一个上午,四个会话各自从自己的分支 CLI 部署了四次生产。
`vercel --prod` 是**整树替换,不是合并**——谁最后跑,线上就 100% 是谁的分支,
其他会话已上线的功能瞬间从生产消失(代码不丢,但线上没有)。当时的 guard 全部
放行:四次部署工作区都干净、分支都明确、项目都正确。**干净从来不是问题,完整才是。**

硬规则:
1. **非部署会话**:只 push 自己的分支 + 在主对话汇报"可上线",**不得**执行任何
   `vercel deploy/promote/rollback/redeploy`,不得改 Vercel 项目设置。
2. **部署会话**:每次生产部署必须 `npm run predeploy:guard` 通过。它现在会检查
   "本次部署是否会丢掉其他活跃分支的工作"(check 7),列出会被丢弃的分支;
   要么先合并,要么逐条确认那些分支本轮不上线。
3. **override 需理由**:`--override` 必须带 `OVERRIDE_REASON`,会写审计日志。
   救火可以用,日常不许用——反复 override 等于没有 guard。
4. **部署流程不变**:干净 worktree checkout 已提交 SHA → guard → `deploy --prod
   --skip-domain` → QA → `promote` → 核对 `https://vibepin.co/api/version` 的
   deploymentId。
5. **多分支汇合**:多个会话的成果要同时上线时,先合并成一条分支、跑完整门禁,
   再部署一次;不要"你部署完我再部署"——那是互相清洗。

详见记忆 `project_prod_rollback_incident_20260716`(同一根因的第一次事故)。

## 角色分工
你(Fable 5)是 advisor 和决策者:负责规划、拆分任务、架构指导、关键决策、最终方案审查。
执行由子代理完成(model 显式传 "opus" 或 "sonnet"):
- 普通代码修改 / 测试 / 文件整理 / 样板代码 → Sonnet 或 Opus 直接完成。
- 架构设计 / 复杂调试 / 关键决策 / 高风险修改 → 动手前必须由 Fable 给出 advisor 指导(明确边界、剥离点、验收标准),再派执行。
- 执行代理连续两次修复失败 → 停止重试,把失败现场汇报回主对话,由 Fable 裁决方向。
- 任何任务最终完成前,Fable 做一次方案审查(独立复核关键结论,不轻信子代理自述)。

## Codex Advisor(按需调用,非自动)

`tools/codex-advisor` 提供 MCP 工具 `ask_codex_advisor` / `review_with_codex` /
`codex_job_status`,让 Fable 在以下场景按需请 Codex 做最终裁决(只读,不可写
代码/不可 push/merge/deploy):

- PRD / 实施计划终审
- 高风险架构、数据、迁移决策
- Opus/Sonnet 结论冲突裁决
- 最终 commit/diff 验收
- 合并/上线顺序判断

普通实现/测试/机械修改不调用 Codex,避免同时消耗两边额度。不做自动额度检测,
调用时机完全由当前会话判断。`review_with_codex` 的 `target_ref` 必须是已提交
的 git ref;未提交改动自己跑 diff 后通过 `ask_codex_advisor` 传文本。详见
`tools/codex-advisor/README.md`(含防循环设计)。

### Codex 异步等待纪律(2026-07-22 固化,不可绕过)

**发起 Codex 任务后,必须自己盯到结果,禁止停下来等用户来问"好了吗"。**

1. 发起后立即布监视器盯 `codex_job_status`,**不要**盯 stdout.jsonl 的流内标记
   (`item.completed` 等是逐条目事件,会在任务真正结束前误报 DONE)。正确做法:
   轮询 MCP 的 `codex_job_status`,只认 `status == "completed"`(或 `failed`)。
   参考:`while` 循环里每 30-60s 调一次,拿到终态才 break。
2. 监视器误报或超时后,**自己重新布一轮**并继续等,不得把"还在跑"当成一次回合结束。
3. Codex 复杂裁决可能跑 5-15 分钟(逐文件核查时 stdout 会涨到 100KB+),这是正常的,
   不要因为"跑得久"就判定它卡死。
4. 等待期间**继续做不冲突的准备工作**(只读审计、扫描同类问题、预备执行方案),
   让 Codex 结论一到就能立刻对照执行,而不是干等。
5. 只有在真正拿到 Codex 终态结果、或连续两轮监视器都超时且 job 状态异常时,
   才回到主对话向用户汇报现状。

## 测试环境隔离(2026-07-22 固化,不可绕过)

**生产库与测试库永久分离,任何测试数据只进测试库。**

| 环境 | project ref | 凭据文件 | 用途 |
|---|---|---|---|
| 生产 | `jaxteelkecvlozdrdoog` | `web/.env.local`、`backend/.env` | **只读探测**;写操作仅限用户明确批准的迁移/修复 |
| 测试 | `snulmwprsahzqvdbyenc` | `web/.env.test.local` | 一切 E2E、seed、造用户、压测、可随时整体销毁 |

硬规则:
1. **任何写操作(INSERT/UPDATE/DELETE/DDL/造用户)前必须先打印目标 project ref 并断言 ≠ `jaxteelkecvlozdrdoog`**;
   断言不通过立即中止,不得"先试一下"。
2. 造测试用户、seed 业务数据、跑破坏性 E2E → **一律指向 `.env.test.local`**,禁止用 `.env.local` 跑这类任务。
3. 禁止把生产数据(用户、业务行、密钥)复制进测试库;测试库只灌 schema + 合成数据。
4. 禁止用测试库凭据覆盖 `.env.local`;两个文件各自独立,互不写入。
5. 清理测试数据只在测试库执行(可整库 reset);**永不对生产库执行批量删除**。
6. Supabase Management API token(`backend/.env.migration`)是账号级的,对两个项目都有效——
   因此每次 `run_migration.py` / Management API 调用都必须显式确认 project_ref 指向哪个库。

## 上下文管理
全程保持上下文精简:子代理只带回结论(改了什么/验证结果/发现的真问题),不带中间过程。
主对话只输出:计划、修改内容、验证结果、下一步。

## Git 安全规则(2026-07-14 stash 事故后固化,不可绕过)

背景:一次 `git stash push -u` + pop 冲突后用 `git checkout stash@{0} -- .` 恢复,只还原了
tracked 半边,untracked 的 188 个多会话功能草稿被清空(靠 rescue tag 全数找回)。以下规则防止复发:

1. **禁止对含未跟踪草稿的工作区使用 `git stash push -u` / `-a`。**
   本仓库的 untracked 文件是多会话并行的功能草稿(未完成簇),不是垃圾。需要干净树做
   clean-checkout 验证时,按优先级选:
   a. `git worktree add`(独立目录,主工作区完全不动;Windows 上 checkout 慢就用
      `git archive <commit> | tar -x -C <ASCII路径>`);
   b. 只 stash tracked(`git stash push` 不带 -u),untracked 若干扰验证(tsc 编译
      scripts/**),把干扰文件**逐个列名**临时移出再移回,不整树 stash。
2. **任何 stash/reset/checkout 批量操作前后必须对账。**
   操作前记录:`git status --short | wc -l` 与 untracked 计数;操作后核对数目一致。
   不一致时立即停下排查,禁止继续叠加 git 操作"试着修"——每叠一步,现场破坏一分。
3. **stash 一经创建立即打 rescue tag**(`git tag rescue-<用途>-<日期> <stash-sha>`),
   drop 前确认内容已完整回到工作区或已提交。dangling 对象会被 GC,tag 才是持久锚点。
4. **`git checkout <tree-ish> -- .` 禁止用于恢复**(它只铺 tracked,静默丢 untracked)。
   恢复必须显式列文件清单;stash 的 untracked 部分在 `stash^3`,要单独恢复。
5. **新建数据库迁移前必须查号**:`git ls-files "backend/db/migrate_v*.sql"` 取 master 已占
   用号,同时查工作区/rescue 快照里其他簇草稿占的号,取最大号+1。迁移只写文件,
   不擅自 apply(标准跑法 `backend/scripts/run_migration.py --apply`,由用户执行)。
6. **多会话公约**:未跟踪文件可能属于其他并行会话,除非任务明确涉及,否则不移动、
   不删除、不 stash。破坏性操作(rm/reset --hard/force checkout)前先 `git status` 看清
   目标是谁的工作。

## 验证纪律(同一事故链的教训)
- 一切"通过"的声明必须来自 clean 环境(worktree/archive/干净分支),脏工作区的绿灯
  不算数——脏树曾把"从未通过的门禁"显示为全绿。
- 偶发失败(flaky)不许用"重跑一次绿了"糊弄:要么当场定位根因修掉,要么如实记录
  在 commit message 里留痕。
- 子代理报告的数字(N/N 通过)必须由主对话独立复跑核实一次再采信。
