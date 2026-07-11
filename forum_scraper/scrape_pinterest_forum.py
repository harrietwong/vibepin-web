"""
抓取 Pinterest 开发者社区帖子的全部楼层评论：
https://community.pinterest.biz/t/update-developer-app-approvals/45527/152

运行说明：
    1. 安装依赖：
        pip install -r requirements.txt
    2. 运行脚本：
        python scrape_pinterest_forum.py
    3. 输出文件（生成在脚本所在目录）：
        comments.csv
        comments.json

抓取逻辑：
    1. 请求主题 JSON 接口 /t/{slug}/{id}.json，拿到 post_stream.stream（全部楼层的 post_id 顺序列表）
       以及 post_stream.posts（首批已经内联返回的楼层数据）。
    2. 对 stream 中还没有内容的 post_id，按批次调用 /t/{id}/posts.json?post_ids[]=... 补全。
    3. 按 post_number 去重、排序后写出 CSV / JSON。
"""

import csv
import json
import re
import time
from html import unescape

import requests

BASE_URL = "https://community.pinterest.biz"
TOPIC_SLUG = "update-developer-app-approvals"
TOPIC_ID = 45527
TOPIC_JSON_URL = f"{BASE_URL}/t/{TOPIC_SLUG}/{TOPIC_ID}.json"
POSTS_BATCH_URL = f"{BASE_URL}/t/{TOPIC_ID}/posts.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": f"{BASE_URL}/t/{TOPIC_SLUG}/{TOPIC_ID}",
    "X-Requested-With": "XMLHttpRequest",
}

MAX_RETRIES = 5
RETRY_BACKOFF_SECONDS = 2
BATCH_SIZE = 30  # 每次 posts.json?post_ids[]= 携带的楼层数量
REQUEST_TIMEOUT = 20
EXPECTED_TOTAL_POSTS = 151


def request_json_with_retry(url, params=None):
    """带重试的 GET 请求，遇到 403/429 等反爬响应时退避重试。"""
    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.get(url, headers=HEADERS, params=params, timeout=REQUEST_TIMEOUT)
        except requests.RequestException as exc:
            last_error = exc
            wait = RETRY_BACKOFF_SECONDS * attempt
            print(f"[WARN] 请求异常: {exc!r}，{wait}s 后重试（第 {attempt}/{MAX_RETRIES} 次）")
            time.sleep(wait)
            continue

        if resp.status_code == 200:
            return resp.json()

        if resp.status_code in (403, 429, 503):
            wait = RETRY_BACKOFF_SECONDS * attempt
            print(f"[WARN] 状态码 {resp.status_code}（可能被限流/反爬拦截），{wait}s 后重试")
            time.sleep(wait)
            continue

        last_error = RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")
        wait = RETRY_BACKOFF_SECONDS * attempt
        print(f"[WARN] 意外状态码 {resp.status_code}，{wait}s 后重试")
        time.sleep(wait)

    raise RuntimeError(f"请求 {url} 重试 {MAX_RETRIES} 次后仍然失败: {last_error}")


def clean_html(html_text):
    """把 cooked 字段（HTML）转换成规整的纯文本。"""
    if not html_text:
        return ""
    text = re.sub(r"<br\s*/?>", "\n", html_text)
    text = re.sub(r"</p\s*>", "\n\n", text)
    text = re.sub(r"</li\s*>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    lines = [line.strip() for line in text.splitlines()]
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_like_count(post):
    """Discourse 的点赞数没有单独的 like_count 字段，需要从 reactions / actions_summary 里推导。"""
    reactions = post.get("reactions") or []
    if reactions:
        return sum(r.get("count", 0) for r in reactions)

    for action in post.get("actions_summary") or []:
        if action.get("id") == 2:  # id == 2 对应 Discourse 的 "like" 行为
            return action.get("count", 0)

    return post.get("reaction_users_count", 0) or 0


def build_post_url(post_number):
    return f"{BASE_URL}/t/{TOPIC_SLUG}/{TOPIC_ID}/{post_number}"


def fetch_all_posts():
    print(f"[INFO] 请求主题接口: {TOPIC_JSON_URL}")
    topic_data = request_json_with_retry(TOPIC_JSON_URL)

    post_stream = topic_data.get("post_stream", {})
    stream_ids = post_stream.get("stream", [])
    posts_by_id = {p["id"]: p for p in post_stream.get("posts", [])}

    print(f"[INFO] 主题共 {len(stream_ids)} 个楼层，首批已返回 {len(posts_by_id)} 个")

    missing_ids = [pid for pid in stream_ids if pid not in posts_by_id]

    for i in range(0, len(missing_ids), BATCH_SIZE):
        batch = missing_ids[i:i + BATCH_SIZE]
        params = [("post_ids[]", pid) for pid in batch]
        batch_no = i // BATCH_SIZE + 1
        total_batches = (len(missing_ids) + BATCH_SIZE - 1) // BATCH_SIZE
        print(f"[INFO] 补全楼层批次 {batch_no}/{total_batches}（{len(batch)} 个 post_id）")

        batch_data = request_json_with_retry(POSTS_BATCH_URL, params=params)
        batch_posts = batch_data.get("post_stream", {}).get("posts", [])
        for p in batch_posts:
            posts_by_id[p["id"]] = p

        fetched_ids = {p["id"] for p in batch_posts}
        not_returned = set(batch) - fetched_ids
        if not_returned:
            print(f"[WARN] 本批次有 {len(not_returned)} 个 post_id 未返回内容: {sorted(not_returned)}")

        time.sleep(0.6)  # 避免请求过快触发限流

    ordered_posts = [posts_by_id[pid] for pid in stream_ids if pid in posts_by_id]

    still_missing = [pid for pid in stream_ids if pid not in posts_by_id]
    if still_missing:
        print(f"[WARN] 抓取结束后仍缺失 {len(still_missing)} 个楼层: {still_missing}")

    return ordered_posts, len(stream_ids)


def main():
    posts, expected_total = fetch_all_posts()

    seen_post_numbers = set()
    rows = []
    for p in posts:
        post_number = p.get("post_number")
        if post_number in seen_post_numbers:
            continue
        seen_post_numbers.add(post_number)

        reply_to = p.get("reply_to_post_number")
        rows.append({
            "post_number": post_number,
            "username": p.get("username", ""),
            "name": p.get("name") or "",
            "created_at": p.get("created_at", ""),
            "content": clean_html(p.get("cooked", "")),
            "reply_to_post_number": reply_to if reply_to is not None else "",
            "like_count": extract_like_count(p),
            "post_url": build_post_url(post_number),
        })

    rows.sort(key=lambda r: r["post_number"])

    with open("comments.json", "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)

    fieldnames = [
        "post_number", "username", "name", "created_at",
        "content", "reply_to_post_number", "like_count", "post_url",
    ]
    with open("comments.csv", "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    total = len(rows)
    print(f"\n[DONE] 共抓取 {total} 条评论（主题声明楼层总数: {expected_total}）")

    if abs(total - EXPECTED_TOTAL_POSTS) <= 2:
        print(f"[CHECK] 数量与预期的 {EXPECTED_TOTAL_POSTS} 条接近，抓取基本完整。")
    else:
        diff = total - EXPECTED_TOTAL_POSTS
        print(f"[CHECK] 数量与预期的 {EXPECTED_TOTAL_POSTS} 条相差 {diff}，请检查日志中的 WARN 是否有遗漏楼层。")


if __name__ == "__main__":
    main()
