# 给 WorkBuddy：只修这 6 条（可直接粘贴）

只做下面 6 条。不要重跑 50 条，不要动「能上架 14」和「丢掉」清单。裁定原文：[0911-收尾_三列裁定.md](file:///D:/%E4%BB%A3%E7%A0%81/%E7%A4%BE%E5%AA%92/picks-0910/output/0911-%E6%94%B6%E5%B0%BE_%E4%B8%89%E5%88%97%E8%A3%81%E5%AE%9A.md)

源片目录（脚本默认）：`D:\代码\社媒\视频原始\picks-0910-tiktok\<video_id>.mp4`  
现有抽帧：`D:\代码\社媒\picks-0910\output\lens_frames\`  
重截脚本可改：`D:\代码\社媒\picks-0910\scripts\recrop_v2.py`（改 JOBS 时间戳和 crop，输出到 `D:\代码\社媒\picks-0910\frames_v2\`）  
官方商城 listing **已经对**，#12/#15/#16/#20/#24 **不要再 Lens 猜 listing**。只有 #42 需要换 listing。

截帧硬规则（不满足就重截，禁止拿去搜、禁止当 Pin 封面）：

1. 画面主体是正在卖的那一件商品，面积 ≥ 60%。
2. 能看清外形和材质。允许手拿，手不能挡住关键外形。
3. 裁掉：人脸、半身人、宠物、大字幕、UI、多个不同商品。
4. 停在商品放稳、动作停住的那一帧。
5. 不看视频的人能说出「这是什么东西」。说不出 = 不合格。

交付每条必须有：

```
sku_id / product_name / video_url / frame_path / crop_note /
listing_url(只1条) / listing_title / listing_price / description_en /
detail_images(≥3) / proposed_store_price / profit_check / skip_reason
```

修完写一份 `D:\代码\社媒\picks-0910\output\0911-先修6条_结果.md`，并更新收尾 HTML 对应卡片的抽帧/listing。修失败就写 skip_reason，不要用旧废帧充数。

---

## #12 磁力擦窗器 · 必须换源片

- 品名：Double Side Magnetic Window Cleaner
- 现视频（作废，不要再截）：https://www.tiktok.com/@mavigadget/video/7580391923521801527
- 现帧（作废）：`D:\代码\社媒\picks-0910\output\lens_frames\7580391923521801527.jpg`（远楼窗，商品只是玻璃上一个小白三角）
- listing 保留：https://mavigadget.com/products/double-side-magnetic-window-cleaner-brush-tool （$59.95，官方商城，标题对）

怎么修：去 `@mavigadget` 找**同一 SKU** 的另一条视频，必须有擦窗器本体近景（双面磁块、擦头、手拿产品）。优先官方商品页视频/图，或 TikTok 同品近景演示。新视频下载到 `D:\代码\社媒\视频原始\picks-0910-tiktok\`，截 1 张合格帧。找不到近景就 skip，不要保留远楼窗。

## #15 高枝锯 · 先同片换帧，不行再换片

- 品名：Garden Care Stainless Steel High Branch Saw
- 视频：https://www.tiktok.com/@mavigadget/video/7635449089458507021
- mp4：`D:\代码\社媒\视频原始\picks-0910-tiktok\7635449089458507021.mp4`
- 现帧不合格：`D:\代码\社媒\picks-0910\output\lens_frames\7635449089458507021.jpg`（几乎全是树干，锯头在底边）
- 已试过 t=2.0 / 3.7 仍失败，不要重复这两个时间点
- listing 保留：https://mavigadget.com/products/garden-care-stainless-steel-high-branch-saw （$188.95）

怎么修：扫完整支 mp4，截「锯头+加长杆」特写（金属锯片、杆接头要看清）。人可以出画面，树不能当主体。整片都是远景砍树，就换 `@mavigadget` 同款高枝锯近景视频。园艺工具允许做。

## #16 登山杖折叠座 · 同片换帧，去人

- 品名：Hike Seat Combo Telescopic Walking Stick
- 视频：https://www.tiktok.com/@mavigadget/video/7631034671219887374
- mp4：`D:\代码\社媒\视频原始\picks-0910-tiktok\7631034671219887374.mp4`
- 现帧不合格：人占大半，产品只是脚下一个三角
- 已试 t=6.2 / 12.5，人还在，改 crop 或换秒数
- listing 保留：https://mavigadget.com/products/hike-seat-combo-telescopic-stick （$170.95）

怎么修：只要杖+折叠座。展开座、收折、手持杖身特写都可以。裁掉头、半身、站台地面。座椅打开的那一帧优先。

## #20 抱瓶兔 · 同片换清晰帧

- 品名：Sweet Bottle-Hugging Bunny Plush
- 视频：https://www.tiktok.com/@mavigadget/video/7669632997569662222
- mp4：`D:\代码\社媒\视频原始\picks-0910-tiktok\7669632997569662222.mp4`
- 现帧不合格：运动模糊、人坐地上，看不清兔子
- listing 保留：https://mavigadget.com/products/sweet-bottle-hugging-bunny-plush （$44.95）

怎么修：找兔子外形停住、对焦清楚的一帧，兔子 ≥60%。裁掉人脸和身体。这是三条毛绒里定价最好的，帧必须能当封面。

## #24 网球回弹器 · 同片换帧，去人去拍

- 品名：Tennis Self Training Tool
- 视频：https://www.tiktok.com/@mavigadget/video/7582924592411430199
- mp4：`D:\代码\社媒\视频原始\picks-0910-tiktok\7582924592411430199.mp4`
- 现帧不合格：人+球拍，看不出训练器
- 已试 t=1.6 / 4.6，人还在
- listing 保留：https://mavigadget.com/products/tennis-self-training-tool （$23.95；修好后建议售价 $25）

怎么修：只留回弹底座 + 网球 + 弹性绳。地面底座特写优先。裁掉人、球拍、字幕。整片没有底座近景就换同 SKU 近景视频。

## #42 莲花灯 · 抽帧可用，必须换可买新货 listing

- 品名：Lotus Lamp / 荷叶落地灯
- 视频：https://www.tiktok.com/@thefurnituredoctor/video/7237265476122987819
- 合格抽帧（保留，不要重截除非你能更好）：`D:\代码\社媒\picks-0910\output\lens_frames\7237265476122987819.jpg` 以及 `D:\代码\社媒\picks-0910\frames_v2\7237265476122987819.jpg`
- 现 listing 作废：https://www.etsy.com/listing/4323323637/pink-hollywood-regency-1980s-lotus-lamp （中古二手、无主图、无价格）

怎么修：用上面那张合格帧，**本机真实浏览器**打开 Google 镜头网页上传（禁止数据中心爬 Lens，禁止付费 API 当默认）。空了再 Amazon 网页以图搜，再不行才 1688。只留 **1 条**新货商品页：标题必须是 lotus / flower petal / 荷叶/莲花 落地灯或台灯；要有价格、主图、≥3 张详情图。不要 Etsy 中古、不要沙发/窗帘/无关灯。独立站售价 ≥$25。

---

## 不要做

1. 不要动能上架 14 条，不要翻案丢掉的 24+#17/#18/#23/#30/#34/#45。
2. 不要登录任何人的 Instagram。
3. 不要用远景/模糊帧「先交差」。
4. 不要输出 40 条 Lens 噪音链接。
5. #12/#15/#16/#20/#24 不要改官方 mavigadget listing。
6. 不要改去重流水线代码。
