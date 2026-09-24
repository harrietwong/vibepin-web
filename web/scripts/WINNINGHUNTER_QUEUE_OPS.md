# WinningHunter queue ops adapter

`winninghunter-queue-ops.ts` is a write-free planner for the 48-item
`ready_after_platform_gates` queue. It performs SHA-256, source-file, ad-id,
and product+destination deduplication; maps to the five existing Preview board
IDs; and emits `plannedAt` in `America/New_York` plus the corresponding UTC
`scheduledAt`.

The schedule is 12 items per day at 09:00 through 20:00 ET for four days.
Provider upload and database mutation are intentionally outside this adapter;
the generated JSON is the reviewed input to the existing Preview uploader.
The default command is dry-run. `--apply` is accepted only with the explicit
`--confirm-apply` flag and writes the reviewed local manifest; it never calls a
provider or publishes a Pin.

Example:

```powershell
npx tsx scripts/winninghunter-queue-ops.ts `
  --queue "D:/代码/社媒/视频+产品链接 交付文件夹/2026-09-21_winninghunter-outwardsk-christmas-krejova-filamniceent/agent-output/winninghunter-three-platform-priority-queue.json" `
  --now "2026-09-21T20:00:00-04:00" `
  --out "D:/vp-tmp/publish-prep/winninghunter-48-dry-run.json"
```
