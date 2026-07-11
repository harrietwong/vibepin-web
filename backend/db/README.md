# Pinterest Vibe Library — 数据库使用说明

## 文件结构

```
db/
  schema.sql              — 6 张表的建表语句
  indexes.sql             — 所有索引
  db.py                   — 连接工具（自动处理密码特殊字符）
  migrate.py              — 执行迁移（建表 + 索引）
  upsert_trend_keywords.py — 写入趋势关键词
  upsert_pin_samples.py   — 写入爬虫抓取的 Pin 数据
  import_style_library.py — 导入 Vision LLM 风格分析结果
```

---

## 第一步：安装依赖

```bash
pip install psycopg2-binary python-dotenv
```

---

## 第二步：配置 .env

复制 `.env.example` 为 `.env`，填入 Supabase 连接信息：

```bash
copy .env.example .env
```

**在 Supabase 控制台找到连接信息：**
1. 进入项目 → Project Settings → Database
2. 找到 Connection string → URI 模式
3. 复制填入 `DATABASE_URL`

> ⚠️ 密码含特殊字符（如 `[` `]` `!`）不需要手动编码，`db.py` 会自动处理。

---

## 第三步：建表（迁移）

```bash
py db/migrate.py
```

成功输出：
```
▶  执行 schema.sql …
▶  执行 indexes.sql …
✅ 迁移完成
```

---

## 第四步：写入趋势关键词

```bash
# 写入内置的 10 个默认家居关键词
py db/upsert_trend_keywords.py

# 从自定义文件写入
py db/upsert_trend_keywords.py --file my_keywords.txt --category home

# 指定 region 和 season
py db/upsert_trend_keywords.py --region US --season summer_2026
```

---

## 第五步：写入爬虫抓取的 Pin 数据

先跑爬虫生成 `vibe_library/output/all_pins.jsonl`，然后：

```bash
# 默认读取 vibe_library/output/all_pins.jsonl
py db/upsert_pin_samples.py

# 指定文件（也支持 aesthetic_trends.json / product_leads.csv 不行，用 .jsonl 或 .json）
py db/upsert_pin_samples.py --input vibe_library/output/all_pins.jsonl
```

这个脚本会同时写入：
- `pin_samples` 表（Pin 基础数据）
- `pin_style_analysis` 表（爬虫启发式评分，model_name = `scraper_heuristic`）

---

## 第六步：导入 Vision LLM 风格分析（可选）

当你对 Pin 图片做了 Vision LLM 分析后，将结果输出为 JSONL，再导入：

```bash
py db/import_style_library.py --input vibe_library/output/style_library.jsonl
```

**style_library.jsonl 的每条记录格式：**

```json
{
  "pin_id": "123456789",
  "source_keyword": "living room decor ideas",
  "title": "...",
  "image_url": "...",
  "save_count": 1200,
  "pin_type": "aesthetic_trend",
  "style_tags": ["minimalist", "neutral", "cozy"],
  "layout_type": "single_image",
  "dominant_colors": ["#F5F0EB", "#D4C5B0"],
  "has_text_overlay": false,
  "visual_hook": "warm neutral tones with layered textures",
  "best_for_products": ["throw pillows", "rugs"],
  "commercial_intent_score": 6.5,
  "make_similar_score": 8.0,
  "prompt_template": "A cozy minimalist living room, warm neutral tones...",
  "negative_prompt": "cluttered, dark, low quality",
  "model_name": "gemini-2.5-flash"
}
```

---

## 常见错误排查

| 错误 | 原因 | 解决 |
|------|------|------|
| `DATABASE_URL 未设置` | .env 文件没有该字段 | 检查 .env |
| `FATAL: password authentication failed` | 密码错误或 URL 格式问题 | 确认 Supabase 密码正确 |
| `relation "pin_samples" does not exist` | 没有先建表 | 先运行 `py db/migrate.py` |
| `UniqueViolation` | pin_id 冲突但脚本正常应该 upsert | 检查 pin_id 是否为 None |

---

## 推荐运行顺序

```bash
py db/migrate.py                    # 1. 建表
py db/upsert_trend_keywords.py      # 2. 写关键词
py pinterest_ultimate_scraper.py    # 3. 爬数据
py db/upsert_pin_samples.py         # 4. 写 Pin 数据
# （可选）运行 Vision LLM 分析脚本
py db/import_style_library.py       # 5. 写风格分析
```
