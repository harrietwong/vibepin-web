# 指令 1：新窗口完整采集 IG 两个号（视频 + 商品一起交）

你是一个新会话。不要问要不要开始，按本文一次做完。做完把**视频清单和对应商品**一起交给用户。不要只交视频、不要只交链接堆。

## 目标

从下面两个 Instagram 账号采集过线 **Reels**，每条对齐 **一个可上架商品**（英文标题、描述、详情图、标价、商品页）。结果要能拿到 Pinterest 去发。

## 账号（只这两个，禁止自行加号）

1. https://www.instagram.com/simpletechfinds/  
   约 133.6 万粉。Amazon Finds。简介店：https://linktr.ee/simpletechfinds
2. https://www.instagram.com/anya_bumag/  
   约 74.9 万粉。Gadgets / Decor。**优先这个号。**  
   简介店：https://bio.site/anyabumag  
   主页精选优先打开：VIDEO LINKS、Links、New Apartment、Vintage Finds。不要采 Trip to India。

## 采什么

1. 只采 **Reels** 竖屏商品演示。不采静图、合拍、旅行 vlog。
2. 近 **12 个月**。
3. 每个号最多交 **40 条过线**（先 A 后 B，按评论从高到低）。
4. 一条 Reel = 一个 SKU。合集/haul（一条里好几个货）整条丢弃。
5. 同一商品多条视频：只留评论最高那条，其余标 `duplicate_sku`。

## 互动门槛（不要用 Pinterest 的 100 评）

评论为主，点赞为辅。播放数只记录，不当硬门槛。

**anya_bumag**

1. A：评论 ≥ 40，或点赞 ≥ 8,000
2. B：评论 ≥ 15，或点赞 ≥ 3,000
3. 评论含 link / where / need this / Amazon 时，评论门槛降到 10

**simpletechfinds**

1. A：评论 ≥ 50，或点赞 ≥ 15,000
2. B：评论 ≥ 20，或点赞 ≥ 6,000
3. 购买意向评论时，评论门槛降到 15

先交 A；A 不够 40 再补 B。

## 品类（Pinterest 主力是女性）

要：家居清洁/收纳、床品、灯饰软装、美妆个护工具（含磨脚仪）、沙发/织物修复套装、园艺工具、户外廊架、母婴浴室、免打孔门。

不要：纯 DIY 教程、Dollar Tree 材料包、低俗整蛊（便便/马桶杯）、品牌漆/木器脱漆、男向硬核数码/游戏外设、口服补剂、一条视频多个货。

独立站售价 **≥ $25、不设上限**。利润目标 >50%（算不出就写 unknown，不要编）。

## 找品顺序

1. Reel 自己的商品标签、简介、link in bio、精选专辑链接。
2. 本机浏览器 Google 智能镜头网页。截帧必须是商品本体 ≥60% 画面，裁掉人脸、宠物、字幕、Instagram UI。
3. Google 空了再 Amazon 网页以图搜。
4. 还没有才 1688 以图搜。
5. 每条只留 **1 个标题对得上的 listing**。禁止丢 20 条 eBay/T 恤充数。

## 交付（必须同时有视频和商品）

保存到：

`D:\代码\社媒\picks-0911\output\指令1-simpletechfinds-anya_bumag-视频和商品.md`

`D:\代码\社媒\picks-0911\output\指令1-simpletechfinds-anya_bumag-视频和商品.jsonl`

每行字段：

```
handle
reel_url
posted_at
likes
comments
buy_intent          # 评论里是否在问 link
product_name
listing_url         # 只 1 条
listing_title
listing_price
description_en      # 可从 listing 摘
detail_image_urls   # ≥3，没有就写缺几张
frame_path
source_method       # bio / google_lens / amazon_visual / 1688
skip_reason         # 过线但丢弃时必填
```

另外给用户一份短摘要：每个号交了多少条、多少条已经对上商品、哪些是只有视频没有 listing。

禁止：编造点赞/评论/价格；数据中心爬 Google Lens 网页；只交视频不找品。
