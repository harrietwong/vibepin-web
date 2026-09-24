# 0902 Supabase 安全告警与 RLS 补充 PRD v1.0

## 1. 背景

2026-09-02 用户提供了 Supabase Advisor 的 4 条安全告警：

- `security_definer_view`: `public.trend_opportunities_view`
- `rls_disabled_in_public`: `public.tasks`
- `rls_disabled_in_public`: `public.user_settings`
- `rls_disabled_in_public`: `public.audit_log`

本 PRD 用于把这些安全告警纳入 VibePin Preview/Production 发布门禁。当前状态是：已做源码审计与测试库只读核查，但未执行任何数据库写入、迁移、Production 变更或修复上线。

## 2. 范围边界

本 PRD 覆盖：

- `trend_opportunities_view` 的 invoker/definer 安全语义。
- `tasks`、`user_settings`、`audit_log` 的 RLS、owner isolation、token/credential handling。
- Preview/test Supabase 与 Production Supabase 的项目边界确认。
- 未来修复所需的迁移、回滚、测试、验收门禁。

本 PRD 不授权：

- Production migration、Production DB 写入或 Production env 修改。
- 删除或清理用户/测试数据。
- VPS、systemd、timer、provider、OAuth、payment、publish 等外部副作用。

## 3. 当前证据

### 3.1 测试 Supabase 只读核查

已确认当前被批准的测试 Supabase ref 是 `snulmwprsahzqvdbyenc`。在该测试 ref 上，用户报告中的 4 个对象未出现；对 `public.tasks` 的只读查询返回 `42P01 relation public.tasks does not exist`。

结论：用户截图里的 Supabase Advisor 告警不属于当前 Preview test ref，可能来自旧项目或 Production 项目。未拿到 exact project ref 前，不能把这些告警直接归因到当前 Preview 数据库。

### 3.2 源码审计

源码中存在 legacy schema 和 route 风险：

- `api/supabase_schema.sql` 定义了 `tasks`、`user_settings`、`audit_log`，但 RLS 语句被注释。
- `user_settings` 包含 Pinterest/Instagram access token 和 refresh token 字段。
- `api/app/core/database.py` 使用 service-role client，数据库 RLS 无法单独约束 FastAPI 路径。
- task routes 缺少可靠 owner predicate；publish 路径存在读取第一条 settings 的风险。
- auth route 有 token 加密和 OAuth state 持久校验 TODO。
- `backend/db/migrate_v9/v11/v12/v15/v16.sql` 中 `trend_opportunities_view` 使用普通 `CREATE VIEW`，未显式 `security_invoker = true`。

## 4. 风险分级

- P0: `tasks` 和 `user_settings` 必须具备 owner isolation。任何用户级任务、发布设置、provider token 都不得被其他用户读写或被 service-role route 错绑。
- P0: OAuth/provider token 必须加密存储、绑定 authenticated user，并验证 OAuth state，禁止 raw token 以未绑定方式 upsert。
- P1: `audit_log` 必须有明确 append/read 权限。默认应 owner/admin scoped，不应 public exposed 且无 RLS。
- P1: `trend_opportunities_view` 应显式使用 invoker-safe 语义或等价安全设计，避免 view owner 权限绕过调用者 RLS。

## 5. 产品要求

### SEC-01 项目归属确认

任何修复前必须先确认 Supabase project ref。测试修复只能作用于 `snulmwprsahzqvdbyenc`；Production 修复必须另行获得用户明确授权。

### SEC-02 RLS 默认开启

暴露在 public schema 且可能经 PostgREST/API 访问的用户级表必须启用 RLS。最小对象包括：

- `public.tasks`
- `public.user_settings`
- `public.audit_log`

### SEC-03 Owner Isolation

所有 user-scoped 读写必须以 authenticated user 为边界：

- 用户 A 不得读取、更新、发布、重放用户 B 的 task。
- 用户 A 不得读取或复用用户 B 的 social settings/token。
- service-role 路径必须显式校验 owner，而不是依赖数据库绕过权限。

### SEC-04 Credential Handling

OAuth/provider token 必须：

- 加密存储。
- 绑定 exact user/account/provider。
- 具备 refresh/expiry/reconnect 状态。
- 禁止日志、错误、receipt、analytics 输出 token、refresh token、authorization code、完整 state。

### SEC-05 OAuth State

OAuth state 必须持久化、一次性消费、绑定用户/session/redirect intent，并在 callback 中校验。缺失、过期、重复、跨用户 state 必须 fail closed。

### SEC-06 View Security

`trend_opportunities_view` 必须满足以下之一：

- 使用 `WITH (security_invoker = true)` 并验证 underlying tables 的 RLS/role grants。
- 或替换成经过审计的等价 invoker-safe 查询/RPC，且具备调用者权限矩阵测试。

### SEC-07 回滚安全

迁移必须配套 rollback，并在以下情况拒绝执行 destructive rollback：

- project ref 不匹配。
- unexpected owner、unexpected grants、unexpected policies。
- protected data 非空且 rollback 会丢失数据。
- view/table definition 与预期不一致。

## 6. 技术实现建议

建议新增独立迁移，不混入 Preview UI 或发布流程修复：

- `backend/db/migrate_vXX_security_invoker_rls.sql`
- `backend/db/rollback_vXX_security_invoker_rls.sql`
- `backend/tests/test_security_invoker_rls_contract.py`
- `backend/tests/pglite_vXX/verify-security-invoker-rls.mjs`

FastAPI legacy route 如仍保留，必须同步修：

- task list/get/update/publish 均加 authenticated owner predicate。
- settings read/write 按 user_id/provider/account scoped。
- publish 不能 `limit(1)` 读取任意 settings。
- OAuth token upsert 前完成 state/user/provider/account 校验。

## 7. 验收标准

### SEC-A01 Project Ref Gate

在执行任何 DB 写入前，脚本必须打印并校验 exact project ref；测试只允许 `snulmwprsahzqvdbyenc`，Production 必须停止并等待单独授权。

### SEC-A02 Static SQL Gate

SQL 静态检查必须通过：

- 无 broad `GRANT ... TO public`。
- user-scoped public tables 启用 RLS。
- policies 明确 `auth.uid()` 或等价 owner predicate。
- view 显式 invoker-safe。
- security definer function 如存在，必须 pin `search_path` 并限制 grant。

### SEC-A03 Role Matrix Gate

在测试 ref 执行 role matrix：

- anon 只能看到允许公开的数据。
- authenticated user A 不能读写 user B 的 rows。
- service-role route 也必须在应用层校验 owner。
- trend view 不泄漏 underlying table 中调用者无权读取的 rows。

### SEC-A04 Token Redaction Gate

日志、错误、console、receipt、analytics 均不得出现：

- access token
- refresh token
- authorization code
- OAuth state 原文
- connection id 完整值
- user id 完整值

### SEC-A05 Rollback Gate

rollback 在测试 ref 上必须证明：

- unrelated row counts 不变。
- unrelated grants/policies 不变。
- view definition 恢复到预期状态。
- protected data 不被删除。

## 8. 与其他 PRD 的关系

- Create Pin CP-13/CP-14 负责前端 durable draft sync、destination truth、confirm-before-publish。
- Multichannel OAuth PRD 负责 provider/account/Board/Page 的连接、确认与发布前门禁。
- Product/Product Picker PRD 负责产品来源、provenance、picker 数据诚实展示。
- 本 PRD 只负责 Supabase Advisor 报错对应的数据库安全与 legacy route 隔离问题。

## 9. 当前结论

当前结论是：

- 测试 Preview ref `snulmwprsahzqvdbyenc` 未复现这 4 个对象的 Advisor 告警。
- 源码中仍存在 legacy schema/route 安全风险，需要作为发布前安全门禁处理。
- 未拿到告警所属 exact Supabase project ref 前，不得对任何非测试库执行修复。

## 10. 0904 源码证据补充

以下证据来自本地只读审计，不等于目标数据库现状：

- `api/supabase_schema.sql` 定义了 `tasks`、`user_settings`、`audit_log`，但第 81–85 行的 RLS 与 policy 仍全部注释；`user_settings` 同时含 Pinterest/Instagram access token 与 refresh token 字段。
- `api/app/api/routes/tasks.py` 的 create/list/get/SSE/PATCH/publish 路径没有可靠 authenticated owner predicate；publish 路径还通过 `limit(1)` 读取任意一条 settings。
- 同文件 `_get_user_id` 只截取 Bearer token 前 36 字符、未验证 JWT，而且没有被上述路由作为权限边界使用。
- `api/app/api/routes/auth.py` 的 Pinterest/Instagram callback 直接 upsert token，没有绑定已验证 user；status 同样读取任意第一条 settings。
- `api/app/core/database.py`、`backend/db/db.py` 与 Next server helper 使用或优先使用 service-role；因此单独开启 RLS 不能修复这些应用层 owner 漏洞。
- `backend/db/migrate_v9.sql`、`v11.sql`、`v12.sql`、`v15.sql`、`v16.sql` 多次以普通 view 重建 `trend_opportunities_view`，最后的 v16 仍没有显式 `security_invoker=true`。
- `audit_log` 除 schema/index 外没有本地读写引用；它是否存在、是否暴露以及实际 ACL 只能由 exact project 的 catalog inventory 证明。

由此增加两个 P0：

- `SEC-P0-LEGACY-OWNER`：即使 DB RLS 正确，所有 service-role FastAPI/backend/Next server 路径仍必须显式验证 authenticated owner，禁止“任意第一条 settings”、未验证 Bearer 截断值或跨用户 task id。
- `SEC-P0-LEGACY-TOKEN`：legacy OAuth callback 必须一次性校验 state、绑定 exact authenticated user/provider/account，并以加密或 secret-manager 方案存储 token；旧明文字段不得继续作为发布权威。

## 11. 两阶段测试库迁移方案

### 11.1 Catalog preflight（只读）

外层 runner 必须先绑定 exact test ref `snulmwprsahzqvdbyenc`，然后记录四对象的：

- `relkind`、owner、列定义、RLS/FORCE RLS flags；
- view definition 与 `reloptions`；
- `pg_policies`、table/view ACL、PUBLIC/anon/authenticated/service_role grants；
- row count、`user_id` 类型/null/历史格式、FK 与依赖 RPC/role。

对象不存在时记为 `ABSENT` 并 no-op；对象类型、owner、shape、policy/grant 与预期不符时 fail closed。此阶段禁止 `DROP`、`CREATE OR REPLACE`、数据修复或任何 Production 连接。

### 11.2 Additive test-only apply

只有 preflight 通过后才允许在 exact test ref 上执行：

- 对确认存在的 `tasks`、`user_settings`、`audit_log` 启用 RLS；初始不启用 FORCE RLS。
- `user_settings` 与 `audit_log` 如确认仅供 service-role 使用，则不创建 permissive authenticated policy，保持默认拒绝。
- `tasks` 只有在 `user_id` 类型、真实写入方式及 owner 绑定全部确认后，才能添加 `auth.uid()::text = user_id` 的 SELECT/UPDATE/DELETE policy 与等价 INSERT `WITH CHECK`。
- `trend_opportunities_view` 仅在确认 PostgreSQL 版本、当前 definition/owner 与 underlying RLS 后，使用 additive `ALTER VIEW ... SET (security_invoker = true)`；不在盲状态下 drop/recreate。
- 每项变更写入 test-only metadata marker，保存 apply 前 flags/options/policy/grant fingerprint；相同定义可重复 apply，不同定义必须中止。

### 11.3 非破坏回滚

回滚只撤销本迁移确实创建的 policy、确实改变的 RLS flag 和确实设置的 view option；不删除表、view、row 或未知 grant。exact ref、marker、owner、ACL、policy、definition 任一不匹配时必须中止。任何 Production 回滚仍需单独授权。

## 12. 补充验收矩阵

| ID | 场景 | 必须结果 |
| --- | --- | --- |
| SEC-A06 | 四对象全部不存在 | apply 成功 no-op；无新对象、无数据变化 |
| SEC-A07 | 对象 relkind/列类型/owner 与预期不符 | fail closed；零 DDL/零数据变化 |
| SEC-A08 | authenticated A 访问 B 的 task | SELECT/UPDATE/DELETE/INSERT 全部拒绝 |
| SEC-A09 | service-role task/settings route | 应用层仍验证 exact owner；不得依赖 RLS bypass |
| SEC-A10 | settings token secrecy | anon/authenticated 不可直接读取 token 字段；日志/错误/receipt 零 token |
| SEC-A11 | OAuth callback state/user/account | missing/expired/replayed/cross-user state 全部 fail closed、零 token upsert |
| SEC-A12 | audit_log | anon/authenticated 默认无读取；若未来开放，只允许经审计 owner/admin append/read，禁止普通 update/delete |
| SEC-A13 | invoker view + underlying RLS | A 不能通过 view 看见 B 的 underlying rows |
| SEC-A14 | apply 两次 | policy/marker 不重复，row count 与无关 ACL 不变 |
| SEC-A15 | rollback 两次及 marker tamper | 合法回滚幂等；marker/definition/ACL 被改时拒绝回滚 |
| SEC-A16 | PGlite 能力不足 | 只记静态/fixture PASS，不得替代真实 Supabase role/RLS/view 证明 |
- READY_FOR_PRODUCTION: NO。
