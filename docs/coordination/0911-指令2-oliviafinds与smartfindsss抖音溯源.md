# 指令 2：新窗口用 IG 封面去抖音追高播放博主

你是一个新会话。不要问要不要开始，按本文做完。任务不是铺货找 1688，而是：**这两位 IG 博主的商品演示，在抖音上有没有播放/互动更高的同源或同款视频，是哪个抖音博主发的。**

查不到就写未找到，禁止编造抖音号。

## 账号（只这两个）

1. https://www.instagram.com/oliviafinds_/  
   约 37.5 万粉。OliviaFinds，Sharing My Favorite Finds。
2. https://www.instagram.com/smartfindsss/  
   约 189 万粉。Smart Finds。简介店 https://www.kurugadgets.com/  
   精选里有 Door Net、mattress cover、Camping Stool、Bed Headboard、kitchen rack、Mini Iron 等，说明是家居 gadget 分发号。

## 从 IG 先抽哪些 Reel

只抽 **Reels**。近 12 个月。每个号先取互动最高的 **25 条**（评论优先，其次点赞）。

门槛（低于此可跳过，除非封面商品极其清晰）：

1. oliviafinds_：评论 ≥ 10 或点赞 ≥ 1,500
2. smartfindsss：评论 ≥ 20 或点赞 ≥ 5,000

合集 haul、纯口播无商品画面的丢掉。

## 截什么图（给抖音搜用）

每条 Reel 出 **1 张封面级截图**：

1. 优先用 Reels 封面/第一帧里**商品最大、最清晰**的画面。
2. 商品面积 ≥ 60%。裁掉 Instagram 界面、头像、字幕、人脸、宠物。
3. 不要截博主自拍当封面。
4. 本地保存，文件名带 handle 和短 id。目录：

`D:\代码\社媒\picks-0911\douyin-covers\`

## 怎么在抖音搜

对每一张封面，按这个顺序，命中即记下证据 URL：

1. 抖音 App / 网页 **以图搜**（搜同款、扫一扫/图搜，以你当前环境能用的为准）。
2. 以图搜没有，就用商品中文短词搜，例如：门帘防蚊、床垫保护罩、露营凳、床头板、厨房置物架、迷你熨斗。词要从画面和 IG 文案来，不要乱编类目。
3. 搜出来后，只保留**同一商品、同一演示动作**的视频。长得像但不是这个货的丢掉。
4. 同一商品若有多条抖音，只留 **播放最高** 的 1–3 条，并写明博主。

互动高的定义（抖音侧）：优先播放 ≥ 50 万，或点赞 ≥ 1 万。低于这个但能钉死同源博主的，也可以记，标 `low_stats`。

## 要记什么

每条 IG Reel 对应一行：

```
ig_handle
ig_reel_url
ig_likes
ig_comments
cover_path
product_guess
douyin_found          # yes / no
douyin_creator        # 抖音昵称 + 抖音号，未找到写空
douyin_video_url
douyin_plays
douyin_likes
douyin_comments
match_type            # 同源成片 / 同款演示 / 仅关键词撞车 / 未找到
evidence_note         # 凭什么认为是同一货，一句话
```

禁止用「仅关键词撞车」冒充同源。画面对不上就 `未找到`。

## 交付

`D:\代码\社媒\picks-0911\output\指令2-oliviafinds-smartfindsss-抖音溯源.md`

`D:\代码\社媒\picks-0911\output\指令2-oliviafinds-smartfindsss-抖音溯源.jsonl`

摘要里列出：钉死了哪些抖音博主（号 + 主页链接）、各自对应哪条 IG、播放量。没找到的单独一节，不要用猜测填博主。

封面图目录一并告诉用户完整电脑路径。
