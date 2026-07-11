# Shopify Phase 1 — WP8 终审报告与发布门禁（2026-07-12）

## 终审结论

**代码侧全部就绪。** WP0–WP7 完成并提交（096d921 → c6068f9，8 次提交），Fable 主会话对每包做了人工复审与测试复跑。

### 测试全景（2026-07-12 全量复跑）

- 34 个 `test:*` 脚本：**27 过 / 7 失败**
- 7 个失败**全部为历史遗留，与 Shopify 工作无关**，归因方法与证据：
  - `test:settings`、`test:pin-details-modal-compact`、`test:i18n-runtime`、`test:i18n-all-locales`：WP4/WP5 实施期间即已存在（文案/i18n 回退类）
  - `test:smart-schedule-config`（2 failed）、`test:scheduling-consistency`（4）、`test:smart-schedule-rebalance`（16）：在干净 HEAD worktree 上同样失败；git 证实 WP2–WP8 未触碰 pinReadiness/smartScheduleStore/pinStore/pinLifecycle 及三个测试文件，且这些文件在 096d921 与预 Shopify 归档快照 dd34b37 **逐字节相同** → 失败先于本项目存在（此前 `npm test` 链在第一个 i18n 失败即中断，从未跑到它们）
- Shopify/草稿相关 11 个新测试脚本 + Pinterest OAuth 回归：全绿
- Playwright e2e：`shopify-settings.spec.ts` + `shopify-picker.spec.ts` 11/11（mock API，flag 门控）
- `tsc --noEmit` 与 `next build`：零错误

### 安全复查（人工）

- token/secret/state 不出现在任何日志、错误响应、测试快照（grep 全量核对）
- HMAC 验签（query hex / webhook base64）符合 Shopify 规范，timing-safe，缺密钥即拒
- OAuth state：AES-GCM 密封、单次使用（所有出口清 cookie）、uid/shop/state 三重匹配、returnTo 同源白名单
- shop 域名取自加密 cookie 而非查询参数；callback 有套餐二次校验
- 同步锁为 DB 级 CAS，跨实例安全；陈旧 run 拒写

## 发布门禁清单（按序执行）

| # | 项 | 负责 | 状态 |
|---|---|---|---|
| 1 | SQL Editor 执行 `backend/db/migrate_v38_pin_drafts.sql` | 用户 | ✅ 已执行（2026-07-11，另会话核实） |
| 2 | SQL Editor 执行 `backend/db/migrate_v39_shopify_store_sync.sql`，回读验证 4 表存在 + RLS on + 无 policy | 用户 | ⬜ |
| 3 | Shopify Partner dashboard：Scopes 改为仅 `read_products`，Release 新版本 | 用户 | ⬜ |
| 4 | Shopify Partner dashboard：3 个 GDPR compliance webhook URL 全部指向 `https://vibepin.co/api/integrations/shopify/webhooks` | 用户 | ⬜ |
| 5 | Vercel Production env 核对：`SHOPIFY_REDIRECT_URI=https://vibepin.co/api/integrations/shopify/callback`、`SHOPIFY_APP_URL=https://vibepin.co`（此前曾误填一次性部署域名） | 用户 | ⬜ |
| 6 | 部署代码到生产（沿用 ASCII-copy + hostname preload 的 vercel CLI 工作流） | 双方 | ⬜ |
| 7 | dev store 冒烟：连接→初次同步→picker 选品建卡→AI Copy 带产品 grounding→显式采用产品链接→排期；断开/重装；卸载 webhook；删除商品→tombstone→drawer 警告 | 双方 | ⬜ |
| 8 | 多账号隔离抽查（A 店与商品对 B 完全不可见，含 API 直调） | 我 | ⬜ |
| 9 | 灰度：Vercel 加 `NEXT_PUBLIC_SHOPIFY_INTEGRATION=true` 前，先用 localStorage `vp:shopify_integration` 内部账号验证 | 双方 | ⬜ |

## 已知遗留（不阻塞发布）

1. 发布/排期时刻的产品新鲜度 toast 未做（按钮位于禁触文件，推 1.1；drawer 内新鲜度徽标已覆盖主要价值）
2. 非 Shopify 来源仅挂 linkedProducts 时 AI Copy 拿不到产品上下文（既有缺口，非本项目引入）
3. 7 个历史遗留测试失败（清单见上）建议另开小任务修复，与 Shopify 无关
4. Phase 1.1 待办：增量 webhooks、ProductCollection、variant UI、多店管理 UI、商品级 active/inactive 勾选

## 风险提示（工作区状态）

2026-07-12 时点，仓库有 **63 个未提交文件**来自其他并行会话（客服系统、user-store 同步、v40–v42 迁移等），其中改到了 Shopify 提交过的文件（api/pin-drafts、ai-copy 路由、layout、pinDraftStore 等）。**建议让相应会话尽快自行提交**，避免与后续 Shopify 冒烟/修复工作互相踩踏。
