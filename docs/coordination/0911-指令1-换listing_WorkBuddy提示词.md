# 给 WorkBuddy：指令1 换 listing（先看懂视频，再带关键词找品）

不要重采两个号，不要再交「22 条已匹配」。只修当前这 25 条里**配错的 listing**。最终报告：[指令1-画廊.html](file:///D:/%E4%BB%A3%E7%A0%81/%E7%A4%BE%E5%AA%92/picks-0911/output/%E6%8C%87%E4%BB%A41-%E7%94%BB%E5%BB%8A.html)。复核原文在主会话：配错的不能当已识货。

源视频：`D:\代码\社媒\picks-0911\ig_videos\`  
抽帧：`D:\代码\社媒\picks-0911\ig_frames\`（每条有 `_f1` `_f2` `_f3`，**三张都要看**，不要只用 f2）  
bio：anya https://bio.site/anyabumag ；simpletech https://linktr.ee/simpletechfinds

修完写：

`D:\代码\社媒\picks-0911\output\指令1-换listing结果.md`  
`D:\代码\社媒\picks-0911\output\指令1-换listing结果.jsonl`

并更新画廊 HTML 对应卡片。失败就 `skip_reason`，禁止用旧错 listing 充数。

---

## 这次为什么找错（下次禁止）

1. 没看完视频就拿一张氛围帧去 Lens。投影布被认成书签，除毛球器被认成马克笔，掏耳勺被认成零食夹。
2. 以图搜只看「长得有点像」。塑料杯对上玻璃梅森杯，海绵擦鞋对上电动套装。
3. 品名先入为主。画面是假耳朵还写 Snack Bag Clip。
4. 材质、用途对不上仍提交。玻璃 vs 塑料、书签 vs 投影、笔 vs 剃毛器，一律算错。

## 找品新流程（每条必须按这个顺序，不许跳）

**第 0 步 · 先理解视频（还不许搜）**

1. 打开 Reel 或本地 mp4，从头看到尾。至少看完 `_f1` `_f2` `_f3`。
2. 写下四行，搜之前写进结果：
   - `seen_object`：画面里正在卖的那一件（材质 + 外形）
   - `how_used`：人怎么用它（投到墙上 / 剃毛球 / 装咖啡粉 / 擦鞋底…）
   - `not_this`：明确排除（不是书签、不是马克笔、不是玻璃桶…）
   - `search_keywords`：3–8 个英文检索词，从上面三行来，不要从旧错误品名来
3. 三张帧里选 **商品本体 ≥60%** 的那张当 `frame_path`。人、孩子、整屋、字幕、意面锅、车内仪表盘不能当搜图。

**第 1 步 · 用关键词找，不要先盲 Lens**

1. 先看这条 Reel 的商品标签、字幕、简介、comment LINK、bio/linktree。对得上就用这条。
2. 再用 `search_keywords` 做 **Amazon 文字搜索**（可加 material / use：`plastic tumbler lid straw`、`fabric shaver`、`book projector screen`）。
3. 文字搜到候选后，才把合格抽帧丢进本机 Google 镜头做**核对**，不是当发现引擎。
4. Google 空了再 Amazon 以图搜。还没有才 1688。禁止数据中心爬 Lens。

**第 2 步 · listing 准入（少一条就不许交）**

标题必须同时满足：

1. 和 `seen_object` 是同一类东西（用途相同）。
2. 材质对得上（塑料就不要交玻璃；硅胶书签不要交投影布）。
3. 主图和合格抽帧是同一件货，不是「都是杯子所以算对」。
4. 只留 1 条。独立站售价建议 ≥$25；listing 原价低于 $25 可以交，但 `proposed_store_price` 写 ≥$25。
5. 要有英文标题、描述、≥3 张详情图。

对不上就换关键词再搜。搜三次仍不对就 `skip_reason`，不要交一个差不多的。

---

## 不要动（已对上）

这些 listing 保留，只许把画廊封面换成更干净的帧（蒜器、量勺必须改用 f1，不要用煮意面 / 搅咖啡那张）：

| 账号 | Reel | 品名 | listing |
|---|---|---|---|
| anya | https://www.instagram.com/reel/DdCYvCiOueR/ | 漱口水机，机身 zofgenow | https://www.amazon.com/dp/B0BZSCPF9X |
| anya | https://www.instagram.com/reel/Dcy40hoODr0/ | Savepod 胶囊机 | https://www.amazon.com/dp/B0GJF188H7 |
| anya | https://www.instagram.com/reel/Dcg3iO6Ohb6/ | 便携乒乓套装 | https://www.amazon.com/dp/B0FN1673Y9 |
| anya | https://www.instagram.com/reel/DcjbOn8uE5P/ | 红色汉堡冷冻压盒 | https://www.amazon.com/dp/B00XHI1AGA |
| anya | https://www.instagram.com/reel/DcmBHCFpzos/ | 花朵量勺花盆套（用 f1） | https://www.amazon.com/dp/B0BTX9KGZQ |
| anya | https://www.instagram.com/reel/DceVmA0ufHg/ | 蒜片器（用 f1，不要 f2 意面） | https://www.amazon.com/dp/B01ENK40QM |
| anya | https://www.instagram.com/reel/DcwSJQKOCYl/ | 竹砧板+折叠滤篮 | https://www.amazon.com/dp/B0BD63H2JD |
| simpletech | https://www.instagram.com/reel/Dc16LPVOL_4/ | 3-in-1 蒸汽拖把 | https://www.amazon.com/dp/B0DBR82BMX |

两条合集继续丢弃，不要硬拆：

- https://www.instagram.com/reel/Dct0rviOxbF/ Mini Purse Finds
- https://www.instagram.com/reel/Dc1fRDVOB2n/ 多个厨房小物

---

## 必须换 listing（视频实际是什么 + 关键词）

旧 Amazon/Avoxer 链接全部作废。从视频重新命名，再用关键词搜。

### 1. 书签配错 → 其实是投影

- https://www.instagram.com/reel/Dc4jQwfO9zk/
- 帧：`D:\代码\社媒\picks-0911\ig_frames\simpletechfinds__Dc4jQwfO9zk_f1.jpg`（白布）和 `_f2.jpg`（浴缸里把书页投到墙上）
- 旧错：https://www.amazon.com/dp/B0D9GG45X8 硅胶自动书签 $5.96
- 视频实际：便携投影布 / 把电子书或画面投到墙上的 book projector / projection screen，不是书签
- 关键词：`portable projector screen book` `book projector wall` `mini projector screen cloth` `bookgirlie projector`
- 禁止再搜：bookmark、page clip、silicone bookmark

### 2. 闪光笔配错 → 其实是除毛球器

- https://www.instagram.com/reel/DdCB_xVObci/
- 帧：`...simpletechfinds__DdCB_xVObci_f1.jpg`（气球上剃毛，粉盒 Dual Head Shaver）
- 旧错：https://www.amazon.com/dp/B0FMD7HTZN 48 色闪光笔
- 视频实际：电动除毛球器 / fabric shaver / lint remover
- 关键词：`fabric shaver` `lint remover rechargeable` `dual head sweater shaver` `pill remover`
- 禁止再搜：glitter marker、sparkle pen、brush tip marker

### 3. 玻璃饮料桶配错 → 其实是粉色塑料杯

- https://www.instagram.com/reel/Dc6R0-RO_3a/
- 帧：`...simpletechfinds__Dc6R0-RO_3a_f1.jpg` `_f2.jpg`
- 旧错：https://www.amazon.com/dp/B08V9HCLDM 1.5 加仑玻璃龙头桶
- 视频实际：粉色可重复使用塑料杯 + 盖，不是玻璃饮料桶
- 关键词：`pink plastic tumbler with lid` `reusable plastic party cups stackable` `colored plastic cups lids`
- 禁止再搜：glass beverage dispenser、spigot、mason jar glass

### 4. 麦秸杯配错 → 其实是深色塑料奶茶杯

- https://www.instagram.com/reel/Dc33hyfudaw/
- 帧：`...simpletechfinds__Dc33hyfudaw_f2.jpg` 深色半透明塑料杯、黑盖、吸管
- 旧错：https://www.amazon.com/dp/B0FR447LX4 玻璃梅森杯
- 视频实际：可重复使用塑料奶茶/外卖杯（dark plastic tumbler lid straw）
- 关键词：`reusable plastic tumbler lid straw black` `boba cup plastic reusable` `dark plastic drink cups with lids`
- 禁止再搜：glass mason、wheat straw（除非视频里真写了麦秸）

### 5. 零食夹配错 → 其实是掏耳勺

- https://www.instagram.com/reel/DdGq6o0oD7F/
- 帧：`...simpletechfinds__DdGq6o0oD7F_f1.jpg` 假耳朵 + 金属勺；字幕 Stop Using Cotton Swabs、sesame seeds represent earwax
- 旧错品名：Snack Bag Sealing Clip（画面都认错了）
- 视频实际：耳勺 / ear pick / earwax cleaner（演示用假耳）
- 关键词：`ear pick stainless` `earwax removal tool` `ear cleaner spoon`
- 禁止再搜：chip clip、snack bag sealer。若判定为个护小工具且售价能 ≥$25 再交；像整蛊/低俗就 skip。

### 6. 电动擦鞋套装配错 → 其实是海绵擦鞋底

- https://www.instagram.com/reel/Dc84TM5uJ8F/
- 帧：`...simpletechfinds__Dc84TM5uJ8F_f2.jpg` 黄海绵擦 AJ 鞋底
- 旧错：https://www.amazon.com/dp/B0FMYRW8BL Crep Protect 电动套装
- 视频实际：sneaker sole cleaning sponge / magic eraser sponge for shoes
- 关键词：`sneaker sole cleaner sponge` `shoe midsole cleaning sponge` `magic eraser shoes`
- 禁止再搜：Crep Protect、electric shoe cleaner、rechargeable brush kit

### 7. 白鞋清洁剂对不上

- https://www.instagram.com/reel/DdEAN1_I9hB/
- 帧：给小孩黑鞋擦底，孩子占画面
- 旧错：https://www.amazon.com/dp/B0GGGQYTJP White Shoe Cleaner $9.98
- 先看完视频：到底是白鞋清洁剂、去氧化中底、还是通用擦鞋湿巾。看清瓶子/包装再搜。
- 关键词从实物来，例如 `sneaker sole restorer` `midsole cleaner` `shoe wipe kit`。商品必须 ≥60%，裁掉小孩。看不清就 skip。

---

## 半对，要核材质/品牌（可换可留，但必须过第 2 步）

1. https://www.instagram.com/reel/DXzlJuhudJ3/ 青花瓷滤茶网，像花形/荷叶，不一定是 umbrella。关键词：`blue white porcelain tea strainer` `ceramic tea filter lid tassel`。旧链 https://www.amazon.com/dp/B0F13QDQ5Z 仅当主图真是同一件才留。
2. https://www.instagram.com/reel/Dc_uQIruohc/ 墙插电动牙刷充电座。关键词：`wall mount electric toothbrush charger` `outlet toothbrush charging base`。不要交整支牙刷 listing，除非视频在卖整机。旧链 https://www.amazon.com/dp/B0FFNHVCY6 只是配件。
3. https://www.instagram.com/reel/DdE8a07Oaub/ 机身 CAFEMA。关键词：`CAFEMA portafilter knock box` `espresso puck cleaner CAFEMA`。不要交无关 $249 通用机，除非就是同一台。旧链 https://www.amazon.com/dp/B0FL1TW347 先作废再核。
4. https://www.instagram.com/reel/DdHchyLOTXD/ 马桶盖内侧 UV。确认是智能马桶整机还是盖板 UV 附件。关键词：`toilet lid UV sanitizer` `UV-C toilet light`。整机和附件不要混。
5. https://www.instagram.com/reel/Dc_cBUlOedC/ 免打孔张力杆。换商品近景帧。关键词：`tension rod no drill` `adjustable spring curtain rod`。
6. https://www.instagram.com/reel/Dc7RvJQOEyc/ 吹叶机。换机身近景，不要院子全身照。关键词：`cordless leaf blower` 颜色/外形对上再交。
7. https://www.instagram.com/reel/DdISKHdOjVJ/ 墙上挂 T 恤的挂钩。换产品近景。关键词：`wall t-shirt display hanger no drill` `adhesive shirt hanger`。https://www.avoxer.com/products/smart-hanger-pro 无价格则换有价 listing。
8. https://www.instagram.com/reel/DdEuL-sO80a/ 车窗去油膜。必须截到瓶子/工具本体。关键词：`windshield oil film remover` `car glass oil film cleaner`。只有车内夜景、看不见货就 skip。

---

## 每条交付（少一字段不算完成）

```
handle
reel_url
seen_object          # 看视频后写，搜之前写
how_used
not_this
search_keywords      # 实际用来搜的词
frame_path           # 合格近景，写明 f1/f2/f3
listing_url          # 只 1 条；换掉的旧链不要再出现
listing_title
listing_price
proposed_store_price # ≥$25
description_en
detail_image_urls    # ≥3
source_method        # bio / amazon_keyword / google_lens_verify / 1688
match_check          # 一句话：材质+用途为什么和 seen_object 一致
skip_reason
```

## 不要做

1. 不要重跑 50 条、不要加号。
2. 不要登录任何人的 Instagram。
3. 不要先 Lens 再猜品名。
4. 不要交玻璃当塑料、书签当投影、马克笔当剃毛器、零食夹当掏耳勺。
5. 不要输出 20 条噪音链接。
6. 不要改去重流水线。
7. 已对上的 8 条不要换 listing。
