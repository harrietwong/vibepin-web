# Task 8 — Video Pin P0 最终验收执行清单

本清单针对 `codex/video-pin-p0-0916-final`。当前基线包含 Task 4/5；Task 3（批量上传）和 Task 7（v76 视频发布）仍待各自 review 通过后合入。所有命令均应在最终合入 HEAD 上重新执行。

## 1. 命令矩阵

### 数据库迁移（只读 PGlite，不连接 Supabase）

```powershell
cd backend/tests/pglite_v37
npm ci
npm run test:v75-media-provenance
npm run test:v76-publish-assets
npm run test:v77-video-media
npm run test:integrated-rollbacks
```

这些 verifier 在临时 PGlite 数据库中 apply twice、检查旧数据与回滚/重放；不得改真实数据库。`migrate_v75_media_provenance.sql`、`migrate_v76_publish_asset_materializer.sql`、`migrate_v77_video_media.sql` 与对应 rollback 文件均应纳入 review package 的 hash。

### Web 定向合同与安全测试

```powershell
cd web
npm run test:media-privacy-architecture
npm run test:video-upload-private
npm run test:pinterest-video-adapter
npx tsx scripts/test-video-media-rendering.ts
npx tsx scripts/test-ai-copy-v2-video-cover.ts
npx tsx scripts/test-ai-copy-v2-video-cover-hardening.ts
npx tsx scripts/test-ai-copy-v2-video-cover-production-boundaries.ts
npx tsx scripts/test-ai-copy-v2-facts.ts
npx tsx scripts/test-ai-copy-v2-keyword-evidence.ts
npx tsx scripts/test-ai-copy-v2-routes.ts
npx tsx scripts/test-ai-copy-v2-ui.ts
```

Task 3 合入后必须补跑：

```powershell
npx tsx scripts/test-video-batch-upload.ts
npx tsx scripts/test-video-batch-upload-ui.ts
```

Task 7 合入后必须补跑：

```powershell
npx tsx scripts/test-v76-pinterest-video-publish.ts
npx tsx scripts/test-v76-pinterest-video-recovery.ts
npx tsx scripts/test-publish-due-video-races.ts
npx tsx scripts/test-pinterest-video-legacy-route.ts
```

另外，Task 7 的回归范围需覆盖已有 publish/scheduler 合同：

```powershell
npx tsx scripts/run-tests.ts core studio plan
```

其中 `test-publish-due-claim`, `test-publish-due-fanout-failures`, `test-publish-attempt-ordering`, `test-publish-in-flight`, `test-publish-durable-intent`, `test-publish-confirmation`, `test-publish-content`, `test-scheduled-destinations`, `test-publish-fanout` 和 `test-scheduled-image-url` 由 registry 聚合执行。

### Registry、类型、lint、完整 Web gate

```powershell
cd web
npm run check:test-registry
npm run typecheck
npm run lint -- src/components/studio/StudioBoard.tsx src/components/pins/PinAICopyPanel.tsx src/lib/studio/videoBatchUpload.ts src/lib/studio/videoBrowserMedia.ts src/lib/server/media src/lib/server/publish src/lib/server/pinterest
npm test
npm run build
npm run scan:secrets
```

`npm test` 是 hermetic node-only 聚合（core/studio/plan）；`check:test-registry` 必须在 Task 3/7 测试合入后仍为绿。若项目的 ESLint CLI 不接受目录/文件参数，则使用 `npx eslint` 加同一 owned-file 列表，并记录实际命令。

### 浏览器 QA（仅测试库、mock provider）

在一个终端启动：

```powershell
cd web
npm run dev:testdb
```

启动后先验证未登录守卫（期望 `307`，目标只应是测试库）：

```powershell
curl.exe -s -o NUL -w "%{http_code} %{redirect_url}\n" --noproxy "*" http://127.0.0.1:3000/app/studio
```

另一个终端使用文档测试账号（`e2e-purchase-intent@vibepin.test` / `E2ePurchaseIntent!2026`），并显式绑定测试库：

```powershell
cd web
$env:E2E_USER_EMAIL='e2e-purchase-intent@vibepin.test'
$env:E2E_USER_PASSWORD='E2ePurchaseIntent!2026'
$env:PLAYWRIGHT_TEST_BASE_URL='http://127.0.0.1:3000'
npx playwright test --project=setup --project=authenticated --reporter=list
```

当前 Playwright 配置只有 Desktop Chrome 与 authenticated lane，没有现成的视频 E2E spec，也没有自动生成 1440/1024/768/390、light/dark 矩阵。因此最终 QA 必须通过 Playwright CLI/config override 或新增受控 spec，逐一记录四个 viewport、两种主题、键盘 focus/escape、partial/error/cancel/retry/reload、flag-off 回退。Storage 与 Pinterest 必须在 browser context route/mock boundary 拦截；不得让上传字节、signed token、真实 Pinterest URL 或生产 Supabase 请求出网。`tests/e2e/TESTING.md` 明确规定真实登录只能用测试库账号，不可伪造 JWT。

## 2. 网络、数据库与安全边界

- PGlite verifier、`npx tsx scripts/test-*.ts`、registry、typecheck、owned lint、`npm test`、build、secret scan：不应有真实业务网络/数据库副作用；provider/storage 均应为 fake/injectable boundary。
- `npm run test:db` 是真实 Supabase Postgres 集成测试，会写测试库并清理，当前 Task 8 不把它当作 hermetic gate；除非另行明确安排并再次确认 ref，否则不运行。
- `npm run dev:testdb` 会读取 `.env.test.local`，硬断言 ref `snulmwprsahzqvdbyenc` 且拒绝生产标记；它会启动真实测试库认证服务，所以只允许测试账号和测试数据。
- Playwright 的 authenticated setup 会真实登录测试库；测试中必须 route mock Storage/Pinterest/provider 边界。禁止普通 `npm run dev` 进行登录类 QA，因为 `.env.local` 指向生产。
- 禁止运行 `git push`、部署、真实 Pinterest publish、生产 migration、生产 bucket/token/payment 操作。最终报告记录“未部署、未 push、未外部变更”。

## 3. Task 3/7 合入前后的缺口

当前 final HEAD 没有 Task 3 的 `videoBatchUpload.ts`、`videoBrowserMedia.ts`、`test-video-batch-upload.ts`、`test-video-batch-upload-ui.ts`；这些会由 Task 3 commit 添加并移动到 STUDIO registry。

当前 final HEAD 也没有 Task 7 的 `v76PinterestVideoPublish.ts`、`v76PinterestVideoRuntime.ts`、`test-v76-pinterest-video-publish.ts`、`test-v76-pinterest-video-recovery.ts`、`test-publish-due-video-races.ts`、`test-pinterest-video-legacy-route.ts` 及对应 route/wrapper 变更；这些必须在 reviewer Go 后合入，并重新跑 registry/typecheck/full gate。

## 4. Final review package 必备内容

1. 精确 final HEAD、各 Task commit/reviewer verdict、无部署/无 push/无真实 provider 变更声明。
2. v75/v76/v77 migration 与 rollback 文件的 SHA-256、apply-twice/rollback verifier 原始结果；包含已知 v75 broad legacy Storage policy blocker（若仍存在）。
3. `ContentMedia` image/video discriminated contract、`VideoContentMedia`、`FactCardV1`/AI Copy cover evidence、batch item/aggregate state、publish receipt/unknown contracts 的文件路径与接口摘要。
4. privacy/upload、batch、rendering、AI Copy、Pinterest adapter、v76 immediate/due/recovery 的逐命令结果，失败项及修复轮次。
5. registry/typecheck/owned lint/full Web tests/build/secret scan 的退出码与计数。
6. Playwright 配置、测试账号只指向测试 ref 的证据；四 viewport × light/dark、keyboard、partial/error/cancel/retry/reload、flag-off 的截图/trace 路径与 mock 说明。
7. 明确已知风险：视频真实 provider 尚未调用；浏览器 QA 若没有新增 video spec，只能报告“未覆盖”，不能声称通过。

本文件是执行计划，不是测试通过证明；所有“通过”结论必须由最终 HEAD 上的新鲜命令输出支持。
