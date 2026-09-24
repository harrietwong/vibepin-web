# 给 WorkBuddy：识图截帧纠偏 + 本批先收尾 + 下一轮只跑这份清单

先把**当前这 50 条收尾**（按新截帧规则把能救的救完）。收尾后再用文末「重跑清单」重跑。重跑前清单先给用户看过，不要自行加号、加视频。

---

## 一、这次错在哪（下次禁止再犯）

1. 截的是视频氛围，不是商品。猫、人脸、手、字幕、房间背景、一堆杂物，不能当 Lens 输入。
2. 把 Lens 返回的 10–40 条「长得像」的链接当成已识货。T 恤、雾机、项链、手套、IKEA 桌，全部是噪音。
3. 同一 SKU 跑多遍：折叠门 5 条、茶漏 2 条、Bedlore 床垫罩 2 条几乎同款。
4. 合集/教程视频（cakedfinds 小黄车、Dollar Tree DIY、刷漆翻新）没有拆成「一个视频一个货」。
5. 在数据中心 IP 爬 Google Lens 网页。本机真实浏览器上传才是默认路径，不要逼用户买 API。

---

## 二、截帧硬规则（不满足就重截，禁止拿去搜）

每一条视频只产出 **1–2 张**合格图，不是随机抽帧。

必须同时满足：

1. 画面主体是**正在卖的那一件商品**，商品面积 ≥ 画面的 60%。
2. 能看清外形和材质。允许手拿着演示，但手不能挡住商品关键外形。
3. 裁掉：人脸、宠物、大字幕、黄车按钮、多个不同商品同时入镜。
4. 优先暂停在：商品放桌/床/地、正面或 45 度、动作停住的那一帧（倒出、按下、展开、贴上）。
5. 合集视频：一条视频只截**一个**SKU。要第二个货就另开一行，不要一张图里两件货。
6. 同一 SKU 多条视频：只处理评论最高的那一条，其它标 `duplicate_sku` 跳过。
7. 截完先自检：把图给不看视频的人，他能说出「这是什么东西」。说不出就重截。

不合格示例：猫站在 3D 地垫上却把猫当主体；折叠门视频截到衣服；气泡枪截到圣诞球。

---

## 三、识图怎么跑（免费网页，不要 API）

1. 用**合格截帧**在本机浏览器打开 Google 智能镜头，上传裁好的图（先裁商品再传）。
2. Google 空了或明显跑偏，再 Amazon 网页以图搜。
3. 还没有，才 1688 以图搜。1688 不是第一步。
4. 从结果里只留 **1 个主 listing**（优先 Amazon 或独立站商品页），标题必须和视频品名是同一类东西。
5. 再从这个 listing 抽：英文标题、描述/卖点、≥3 张详情图、标价。
6. 禁止把 20 条 eBay/T 恤/雾机链接写进报告充数。

---

## 四、选品规则（覆盖旧的 $80 上限）

1. 独立站售价：**不低于 $25，不设上限**。床垫罩、抱枕、花洒、折叠门、登山杖、园艺工具、户外廊架都可以进。
2. 利润必须 **>50%**（售价 − 到岸成本）/ 售价。
3. 床上用品允许做。沙发/织物修复套装、磨脚打磨仪、园艺工具可以测。
4. 仍不要：口服补剂、合集小黄车未拆 SKU、纯 DIY 教程（Dollar Tree 材料包）、品牌油漆/木器脱漆剂、低俗整蛊（便便茶漏/马桶杯）。车间木家具打磨不要；磨脚仪要。
5. 要的是标题 + 描述 + 详情图，不要求原购买页。
6. 受众是 Pinterest 女性。问会不会被存进卧室/厨房/花园/宝宝房，不会就丢掉。

---

## 五、每条交付格式（少一条都不算完成）

```
sku_id:
product_name:
video_url:
frame_path:          # 合格截帧本地路径
crop_note:           # 裁了什么
listing_url:         # 只 1 条，且标题对得上
listing_title:
listing_price:
description_en:
detail_images:       # ≥3
proposed_store_price:
profit_check:        # 能否 >50%，未知就写 unknown
skip_reason:         # 若跳过必填
```

不要再输出「Lens 反查商品链接 (40)」这种列表。

---

## 六、当前这波怎么收尾

对已跑的 50 条：不要重爬全网链接。按第二节重截帧，只重跑「截错主体」的条目。截对了再识图，每条只留 1 个 listing。折叠门 5 条只留评论最高那条，其余标重复。

收尾完成后停下，等用户确认下面的重跑清单再开下一轮。

---

## 七、重跑清单（去重后的 SKU，先给用户，用户点头再跑）

只跑这些视频。不要自行加 `@cakedfinds` 合集、Dollar Tree 教程、刷漆/脱漆。

| # | 账号 | 品名 | 视频 | 备注 |
|---|---|---|---|---|
| 1 | mavigadget | Double Side Magnetic Window Cleaner | https://www.tiktok.com/@mavigadget/video/7580391923521801527 | 优先，截擦窗器本体 |
| 2 | mavigadget | DIY Electric Automatic Hair Braider | https://www.tiktok.com/@mavigadget/video/7582847497572257038 | 截机器，不要只截头发 |
| 3 | mavigadget | Orthopedic Gel Toe Separator Cushion | https://www.tiktok.com/@mavigadget/video/7598803938267188535 | |
| 4 | mavigadget | Modern Nordic Wall Bird Lamp | https://www.tiktok.com/@mavigadget/video/7643251838866689294 | |
| 5 | mavigadget | Lazy Horizontal Prism Reading Glasses | https://www.tiktok.com/@mavigadget/video/7582986735735311629 | |
| 6 | mavigadget | Tennis Self Training Tool | https://www.tiktok.com/@mavigadget/video/7582924592411430199 | 截回弹器和球，不要截人 |
| 7 | mavigadget | Foldable Baby Bath Reclining Chair | https://www.tiktok.com/@mavigadget/video/7588926675509988621 | |
| 8 | mavigadget | Duck-Shaped Non-Slip Baby Bath Rack | https://www.tiktok.com/@mavigadget/video/7587812501560020237 | |
| 9 | mavigadget | Hike Seat Combo Telescopic Walking Stick | https://www.tiktok.com/@mavigadget/video/7631034671219887374 | 截杖+座，不要截衣服 |
| 10 | mavigadget | Sleep Buddy Hugging Body Pillow | https://www.tiktok.com/@mavigadget/video/7594397187195276558 | 床品，允许 |
| 11 | mavigadget | Garden Care Stainless Steel High Branch Saw | https://www.tiktok.com/@mavigadget/video/7635449089458507021 | 售价不设上限 |
| 12 | mavigadget | Nordic Rain Waterfall Shower Set | https://www.tiktok.com/@mavigadget/video/7645898499023752461 | 售价不设上限 |
| 13 | mavigadget | LED Streetlamp Snowfall Effect Decor | https://www.tiktok.com/@mavigadget/video/7633593762605698318 | |
| 14 | mavigadget | Automatic Rocket Bubble Gun with Lights | https://www.tiktok.com/@mavigadget/video/7670094786979843358 | 截枪，不要截气球/吊灯 |
| 15 | mavigadget | LED Digital Tally Counter | https://www.tiktok.com/@mavigadget/video/7634418508675157262 | |
| 16 | mavigadget | Pull My Ears Interactive Rabbit Plush | https://www.tiktok.com/@mavigadget/video/7640680591716863245 | |
| 17 | homevibeswithmia | Bedlore 竹纤维凉感床垫罩 | https://www.tiktok.com/@homevibeswithmia/video/7620655690037677342 | 床品，截床垫罩不是人 |
| 18 | homevibeswithmia | Bedlore 云感加层床垫 | https://www.tiktok.com/@homevibeswithmia/video/7615214285068848415 | 与 17 不同款才保留 |
| 19 | doorslidefold | No-Drill Accordion Folding Sliding Door | https://www.tiktok.com/@doorslidefold/video/7622971443713789214 | 只这一条，另外 4 条同 SKU 跳过 |
| 20 | thefurnituredoctor | Lotus Lamp 中古风台灯 | https://www.tiktok.com/@thefurnituredoctor/video/7237265476122987819 | 截灯，不要截整屋装修 |
| 21 | the_gooch | 书本造型花瓶 | https://www.tiktok.com/@the_gooch/video/7638712577983384846 | 成品花瓶；若仍是纯 DIY 过程则跳过 |
| 22 | the_gooch | 骷髅氛围灯 | https://www.tiktok.com/@the_gooch/video/7530301465299029303 | 必须是可买的灯，不是手工材料 |

明确不跑：cakedfinds 两条合集；the_gooch 其余 Dollar Tree 教程；thefurnituredoctor 油漆/脱漆/漂白/书桌材料（沙发修复套装若是开箱即用成品则可测）；折叠门其余 4 条；茶漏重复第二条；Bedlore 第三条（7659720589728337182，与 17 同款）。园艺工具、高枝锯、廊架类**要跑**。
