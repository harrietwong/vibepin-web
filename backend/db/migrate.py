"""
migrate.py — 测试连接 + 打印迁移说明。

Supabase 直连 PostgreSQL（端口 5432）在部分网络环境下不可用，
建表请直接在 Supabase SQL Editor 中执行 schema.sql 和 indexes.sql。

运行：
    py db/migrate.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from db import test_connection  # noqa: E402

HERE = Path(__file__).parent


def main() -> None:
    # ── 测试连接 ────────────────────────────────────────────────────────────
    print("▶  测试 Supabase 连接 …")
    ok, msg = test_connection()
    if ok:
        print(f"✅ {msg}")
    else:
        print(f"❌ {msg}")
        sys.exit(1)

    # ── 打印建表说明 ─────────────────────────────────────────────────────────
    print()
    print("=" * 60)
    print("  如果表还未建，请按以下步骤在 Supabase 执行迁移：")
    print("=" * 60)
    print()
    print("  1. 打开 https://supabase.com/dashboard")
    print("  2. 进入你的项目 → 左侧菜单 SQL Editor")
    print("  3. 点击 New query")
    print("  4. 粘贴并运行以下文件内容（按顺序各运行一次）：")
    print()

    for f in ["schema.sql", "indexes.sql"]:
        fpath = HERE / f
        print(f"     📄 {fpath}")

    print()
    print("  运行成功后，再执行数据导入脚本：")
    print()
    print("     py db/upsert_trend_keywords.py")
    print("     py db/upsert_pin_samples.py")
    print()


if __name__ == "__main__":
    main()
