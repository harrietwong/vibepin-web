# VibePin Create Pins — Draft / Multi-image / Quick Edit UX PRD

## 1\. 本次改动目标

这次不是单独修改某一个卡片样式，而是统一解决 Create Pins 当前几个互相关联的问题：

1. Create Pins 默认进入后展示内容过多，Scheduled / Posted 也铺在首页，让用户产生大量“待处理事项”的心理压力。
2. 当前 `All` 是默认 Tab，不符合 Create Pins 作为内容工作台的使用逻辑。
3. 当前一次选择多张图片，会直接生成多个独立 Draft，无法创建一条包含多张图片的内容。
4. 每一个现有 Draft 都只能拥有一张图片，后续不能继续增加第二张、第三张图片。
5. 当前 Draft 的底层模型需要支持 `media\[]`，为 Instagram carousel / Pinterest 或未来其他平台多媒体内容做准备。
6. 当前鼠标 hover 后自动展开完整 Edit Pin 卡片，动画慢、页面跳动，并且严重影响右上角 `···` 等操作。
7. 展开后的 Edit Pin 内容过于臃肿，给用户“很多东西必须填写”的感觉。
8. AI Generated / Image analyzed / Context used 等系统信息视觉权重过高。
9. Scheduled / Posted / Failed / All 之间的状态和展示逻辑需要统一。
10. Failed Banner 数量和 Failed Tab 数量可能不一致，需要明确失败类型，而不是看起来像数据错误。

核心产品原则：

> Create Pins 默认应该展示“用户现在正在制作的内容”，而不是展示用户所有历史内容。

同时：

> 一个 Draft 是一条未来要发布的内容，而不是一张图片。

因此一个 Draft 必须允许包含一张或多张图片。

\---

# 2\. Create Pins 顶部导航调整

## 2.1 默认 Tab 改为 Drafts

当前：

`All | Unscheduled | Scheduled | Plan | Posted | Failed`

调整为：

`Drafts | Scheduled | Posted | Failed | All`

`Plan` 不属于内容状态，它属于规划视图。

建议将 Plan 从状态 Tabs 中移出，放在 Tabs 右侧或者页面操作区域：

`Open Plan`

或者：

`Plan →`

不要再把 Plan 和 Draft / Scheduled / Posted / Failed 混成同一种 Tab。

\---

## 2.2 Drafts 成为默认页面

用户每次进入 Create Pins：

默认进入：

**Drafts**

而不是：

**All**

Drafts 只显示当前尚未成功 Schedule 的正常编辑内容。

例如：

* 新上传的内容
* AI 生成但尚未排期的内容
* 正在编辑的内容
* 已保存但没有 Schedule 的内容

不要显示：

* Scheduled
* Posted

Failed 作为独立状态存在，不和 Drafts 强行混合。

\---

# 3\. Tab 状态定义

必须使用同一个 Content / Draft 实体生命周期，不要为不同页面复制数据。

推荐生命周期：

`Draft → Scheduled → Posted`

异常状态：

`Draft → Generation Failed`

或者：

`Scheduled → Publishing Failed`

Failed 是异常状态，不是新的 Content 实体。

\---

## Drafts

显示所有尚未 Schedule 的正常内容。

例如：

`status = draft`

Draft 数量就是实际 Draft 内容数量。

\---

## Scheduled

显示已经成功安排发布时间，但还没有真正发布的内容。

例如：

`status = scheduled`

Schedule 成功之后：

从 Drafts 消失。

进入 Scheduled。

同时仍然存在于 All。

\---

## Posted

显示已经成功发布的平台内容。

例如：

`status = posted`

Posted 内容：

不再出现在 Drafts。

不再出现在 Scheduled。

仍然存在于 All。

\---

## Failed

显示真正需要处理的失败内容。

至少区分：

* Generation failed
* Publishing failed

不要把两种失败混在 UI 文案中导致用户误解。

\---

## All

All 是完整内容库。

应该包含：

* Draft
* Scheduled
* Posted
* Failed

All 不再作为默认页面。

Scheduled / Posted 成功以后不要从 All 删除。

All 是过滤视图，不是另外复制一份数据。

\---

# 4\. Failed Banner 调整

当前可能出现：

顶部：

`11 Pins failed to publish`

但是 Tab：

`Failed 16`

这种情况下用户会认为系统数据不一致。

如果真实情况是：

* Publishing failed = 11
* Generation failed = 5

则必须明确。

例如顶部只提示：

`11 publishing issues need attention`

按钮：

`Review`

Failed Tab：

`Failed 16`

进入 Failed 页面以后可以进一步区分：

`Publishing failed 11`

`Generation failed 5`

不要再让 Banner 和 Tab 看起来像在描述同一个数字却不一致。

\---

# 5\. Draft 数据模型升级：支持多张图片

这是本次最重要的底层修改。

当前隐含模型：

`1 Draft = 1 image`

必须改成：

`1 Draft = media\[]`

示例：

```ts
Draft {
  id
  status

  media: \[
    {
      id
      type
      url
      width
      height
      aspectRatio
      order
      source
      processingStatus
    }
  ]

  title
  description
  websiteUrl
  destination
  board
  schedule
  ...
}
```

单图 Draft：

```ts
media.length === 1
```

多图 Draft：

```ts
media.length > 1
```

不要建立：

`image1 / image2 / image3`

这种固定字段。

必须使用数组。

\---

# 6\. Existing Draft migration

当前已有的所有单图片 Draft：

自动迁移成：

```ts
media: \[existingImage]
```

不能影响：

* 已有标题
* Description
* Website URL
* Board
* Destination
* Schedule
* Status
* Existing generated content

现有 Scheduled / Posted 内容也继续保持正常。

这次升级不能导致历史内容重新变成 Draft。

\---

# 7\. 每一个 Draft 都必须可以继续 Add images

这是新增核心能力。

无论 Draft 最初是：

* 单图上传创建
* 多图上传创建
* AI generated
* 已经编辑了一段时间的 Draft

只要当前内容允许编辑，就必须允许用户继续增加图片。

例如：

当前 Draft：

`1 image`

用户点击：

`+ Add images`

一次可以再添加：

`1 张或多张图片`

之后：

`media.length = 4`

它仍然只是一条 Draft。

不能因为新增三张图片，就自动生成另外三条 Draft。

\---

# 8\. Multi-image Draft 编辑结构

一个包含 6 张图片的 Draft：

仍然只显示为 **一个 Draft 卡片**。

不要显示成 6 张独立 Draft。

Collapsed card 上可以：

* 使用第一张图片作为 Cover
* 显示多图标识
* 显示 `6` 或 `1 / 6`

例如图片角落：

`▧ 6`

用户一眼就能知道这是一条多图片内容。

\---

# 9\. Expanded Draft 中增加 Media Manager

用户打开 Draft 编辑状态以后，在编辑区顶部显示媒体区域。

例如：

```text
Media

\[img1] \[img2] \[img3] \[img4] \[ + ]
```

需要支持：

* Add images
* 一次添加多张
* 删除单张图片
* Replace image
* Drag \& drop 调整图片顺序
* 设置 / 更改第一张图片
* 查看当前图片数量

第一张图片默认作为：

* 卡片 Cover
* 多媒体内容中的首图

\---

# 10\. 删除单张图片和删除 Draft 必须分开

Draft 右上角 `···`：

属于整个 Draft。

例如：

* Duplicate
* Delete Draft
* Other draft-level operations

每一张媒体自己的操作：

必须放在自己的 thumbnail 上。

例如：

`···`

或者：

Remove / Replace

不要让“删除图片”和“删除整个 Draft”使用同一个不明确的入口。

\---

# 11\. Multi-image Draft 的字段属于整条 Post

以下字段属于整个 Draft：

* Title
* Description / Caption
* Website URL
* Publish destination
* Pinterest Board
* Social Account
* Schedule time

不要因为 6 张图片就复制 6 套：

* Title
* Description
* URL
* Schedule

6 张图片共同组成一条内容。

Schedule 时也是：

**整条 Draft 一次 Schedule。**

不能对同一 Draft 里的每张图分别 Schedule。

\---

# 12\. 上传多张图片时的行为

当前行为：

选择 6 张图片：

立即创建 6 个 Draft。

这个行为需要修改。

\---

## 单张上传

用户只选择 1 张图片：

直接创建：

`1 Draft / 1 image`

不要弹窗。

\---

## 多张上传

用户一次选择 2 张及以上图片时：

出现一个非常轻量的选择界面。

标题：

**How would you like to use these 6 images?**

两个选项：

### Create 6 separate drafts

说明：

`Create one draft for each image.`

结果：

```text
Draft 1 → media\[1]
Draft 2 → media\[1]
Draft 3 → media\[1]
...
Draft 6 → media\[1]
```

### Add all 6 images to one draft

说明：

`Use all images in a single post.`

结果：

```text
Draft 1 → media\[6]
```

不要根据用户选择多张图片擅自判断意图。

不要永远强制：

`多选 = 多个 Draft`

也不要永远强制：

`多选 = 一个 Draft`

必须给用户选择。

\---

# 13\. 已存在 Draft 中 Add images 不需要再问 Separate Drafts

如果用户已经进入某一条 Draft，并点击：

`Add images`

这里意图已经非常明确：

用户是在给 **当前 Draft 增加媒体**。

因此：

不要再次弹：

`Create separate drafts / One draft`

直接把新图片添加到当前 Draft 的：

`media\[]`

\---

# 14\. Platform capability validation

Draft 本身支持多图片。

但是最终平台是否允许这种媒体组合，是 Publish Destination 的能力限制。

因此：

**不要在 Draft 数据层把一个 Draft 永久限制为单图。**

应该在 Destination / Schedule / Publish 层进行 validation。

例如：

```ts
validateDraftForDestination(draft, destination)
```

检查：

* 当前平台是否支持 multi-image
* 最大媒体数量
* 支持的 media type
* Aspect ratio
* Size
* Resolution
* Video / image combination
* 当前 Account 是否支持

这些限制不要散落 hardcode 在 UI 各个组件中。

应该通过 destination capability validation 统一判断。

\---

# 15\. 不支持 multi-image 时禁止静默处理

假如：

Draft 有 6 张图片。

用户选择了一个只支持当前单图格式的 Publish Destination。

系统绝对不能：

* 偷偷只发布第一张
* 自动丢掉后面 5 张
* 偷偷拆成 6 条 Post

必须明确提示用户。

例如：

**This destination doesn't support this media combination.**

然后提供明确操作：

* Use first image only
* Create separate drafts
* Change destination

用户自己决定。

\---

# 16\. 图片尺寸 / Aspect Ratio 处理

不要要求用户上传之前自己提前知道所有平台尺寸规则。

Draft 可以先正常接收图片。

当用户选择 multi-image compatible destination 后再检查：

* Aspect ratio
* Size
* Resolution
* Other media restrictions

如果几张图片需要统一比例：

显示：

`2 images need adjustment`

提供：

`Review \& crop`

不要直接报错：

`Invalid`

也不要自动做不可逆 crop。

如果平台要求同一 carousel 使用统一展示比例：

可以允许用户统一选择：

`Original / 1:1 / 4:5 / ...`

然后逐张调整 crop。

\---

# 17\. Multi-image + AI 行为定义

因为 Draft 现在可能包含多张图片，所以当前 AI 行为必须重新定义。

\---

## Generate copy

`Generate copy`

属于整个 Draft。

AI 应该参考：

* Draft 中所有图片
* 用户 Context
* Destination
* Existing metadata

生成一套：

* Title
* Description / Caption

不要每张图片生成一套独立 Copy。

\---

## Regenerate image

`Regenerate image`

属于单张媒体操作。

用户必须先明确选中某一张 thumbnail。

然后只针对：

`selected media`

执行 regenerate。

不要点击一次 `Regenerate image` 就把整个 Draft 里的 6 张图片全部重新生成。

推荐把 `Regenerate image` 从 Draft 顶部的大按钮降低为：

Selected media action

或者放进：

`✨ AI`

菜单。

\---

## Image analyzed

如果 Draft 包含多张图片：

不要继续显示模糊的：

`Image analyzed`

可以显示：

`6 images analyzed`

但是它属于系统状态，不属于主要编辑任务。

视觉上必须降级。

\---

# 18\. 删除当前 Hover 自动展开 Edit Pin

当前交互：

鼠标移入图片卡片 →

整张卡开始慢慢展开 →

变成大型 Edit Pin 表单。

这个交互需要删除。

不是只调整动画速度。

原因：

1. 用户只是经过卡片也会触发编辑。
2. 卡片尺寸突然改变导致页面 layout shift。
3. 鼠标目标不断移动。
4. 右上角 `···` 很难点击。
5. Hover 同时承担“浏览”和“编辑”两个职责。
6. Mobile 没有 hover。
7. 动画越慢问题越明显。

\---

# 19\. 新的卡片交互

## Collapsed 状态

Draft 默认保持固定尺寸。

鼠标 hover：

只显示轻量 Quick actions。

例如：

* Edit
* Schedule
* `···`

**绝对不能改变卡片高度或宽度。**

右上角 `···` 必须永远可点击。

不能因为鼠标进入卡片而消失或移动。

\---

## Expanded 状态

用户：

* 点击卡片
* 或点击 `Edit`

之后才真正展开。

保留当前 inline expanded card 的整体方案即可，不要求此次必须改成 Drawer。

但 Trigger 从：

`hover`

改成：

`click`

\---

# 20\. 展开动画

用户点击 Edit 后应该立即给出响应。

避免当前：

慢慢悠悠放大 / 展开。

建议：

`100–150ms`

使用简单 ease-out。

不要使用：

* 500ms+ transition
* spring bounce
* 高度逐步缓慢增长
* 多阶段 animation

目标应该是：

感觉像“打开编辑状态”。

而不是：

“看一张卡片慢慢变形”。

\---

# 21\. 同一时间建议只展开一张 Draft

Desktop 下：

一次只保留一个 expanded Draft。

用户打开第二张 Draft：

第一张自动 collapse。

这样可以避免页面同时出现：

3–4 个大型 Edit form。

也可以进一步保持页面轻量。

\---

# 22\. 展开卡片重新减重

当前 Edit Pin 展开后过于复杂。

用户一眼看到：

* Edit Pin
* AI Generated
* Scheduled
* Generate copy
* Regenerate image
* Image analyzed
* Context used
* Title
* Description
* Website URL
* Pinterest Board
* More details
* Saved
* Schedule information
* Open in Plan

视觉上会产生：

“这里有十几项需要我完成。”

新的 expanded card 必须减少这种感觉。

\---

# 23\. Expanded Card 信息层级

默认展开以后主要显示：

1. Media
2. Title
3. Description
4. Publish destination / Board

其他内容降低层级。

推荐结构：

```text
┌─────────────────────────────────────────────┐
│ Media                         ✨ AI     ··· │
│                                             │
│ \[img1] \[img2] \[img3] \[+]                   │
│                                             │
│ Pin title                             ✨    │
│ \[\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_]   │
│                                             │
│ Description                           ✨    │
│ \[\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_]   │
│                                             │
│ Pinterest board                            │
│ \[Home                                  ▾]  │
│                                             │
│ More details ▾                             │
│                                             │
│ ✓ Saved          Schedule / Open in Plan   │
└─────────────────────────────────────────────┘
```

不要把所有系统信息都做成大型模块。

\---

# 24\. AI 操作收拢

当前两个大型按钮：

`Generate copy`

`Regenerate image`

视觉重量太大。

改成一个轻量：

`✨ AI`

点击以后菜单：

* Generate copy
* Regenerate selected image
* Analyze again

Title / Description 右侧仍然可以保留轻量 regenerate icon。

但不要同时出现多个大型 AI CTA。

AI 是辅助能力。

不能让 AI Controls 比用户真正需要填写的内容还显眼。

\---

# 25\. Image analyzed / Context used 降级

当前：

`Image analyzed`

`Context used`

被包在一个很大的独立灰色容器中。

删除这种大型 Container。

可以改成：

`✓ Images analyzed · Context`

或者放入：

`AI / More details`

内部。

它们属于：

系统信息。

不是：

用户任务。

因此视觉权重必须明显低于：

* Title
* Description
* Destination
* Schedule

\---

# 26\. Website URL 移入 More details

默认展开状态不需要同时展示 Website URL。

将：

`Website URL · Optional`

放入：

`More details`

只有用户主动展开以后显示。

这样默认编辑界面只保留真正高频字段。

如果产品数据证明 Website URL 是核心高频字段，可以后续重新评估，但本次优先让界面更轻。

\---

# 27\. Saved 状态降低视觉权重

不要把：

`Saved`

做成一个重要 Footer 模块。

继续自动保存。

保存成功以后：

显示非常轻量：

`✓ Saved`

即可。

用户不应该产生：

“我是不是还需要按一个 Save”

的心理。

\---

# 28\. Scheduled 内容编辑时的信息展示

已经 Scheduled 的内容如果用户主动进入 Scheduled 页面打开：

不要显示大型 Schedule Footer。

显示一行轻量信息：

`Scheduled · Aug 29 · 7:05 AM`

旁边：

`Open in Plan`

即可。

Schedule 信息是状态信息，不应该占据半个 Footer。

\---

# 29\. Collapsed card 信息设计

Collapsed card 必须保持浏览效率。

至少显示：

* Cover image
* Multi-image count
* Status
* Source，例如 AI Generated / Uploaded
* `···`

可根据状态补充：

Draft：

`Draft`

Scheduled：

`Scheduled · Aug 29`

Posted：

`Posted · Aug 24`

Failed：

`Publishing failed`

不要只依赖 badge 颜色表达状态。

\---

# 30\. Multi-image card 视觉

一个 Draft 有多张图片时：

不要在 Grid 中同时铺开所有图片。

仍然只占一个 Card。

显示第一张 Cover。

右下角或其他固定位置显示：

`▧ 6`

或者：

`1 / 6`

可以增加非常轻的 stacked-image 视觉效果。

但不要让一个 6 图 Draft 在列表中占 6 个卡片位置。

这是保持 Create Pins 精简的关键。

\---

# 31\. Drafts 页面 Empty State

如果没有 Draft：

不要显示空白 Grid。

显示：

**No drafts right now.**

辅助信息：

`Your scheduled content is ready to go.`

CTA：

`Upload images`

如果存在 Scheduled 内容，可以轻量显示：

`11 posts scheduled`

目的：

让用户获得“当前事情已经处理完”的感觉。

\---

# 32\. Default Create Pins 页面心理目标

当前页面在告诉用户：

> You have 79 pieces of content.

新的页面应该告诉用户：

> You currently have 4 drafts to work on.

已经 Scheduled 和 Posted 的内容不应该每天重复制造任务压力。

因此：

* Drafts 默认
* Scheduled 主动查看
* Posted 主动查看
* Failed 独立提醒
* All 最后查看历史

\---

# 33\. Upload more 行为

页面顶部现有：

`Upload more`

继续保留。

如果用户从页面顶部一次上传多图：

执行 Section 12 的：

`Separate drafts / One draft`

选择。

如果用户是在具体 Draft 内：

点击：

`+ Add images`

则直接增加到当前 Draft。

两种行为不能混淆。

\---

# 34\. Schedule multi-image Draft

用户 Schedule 一个 multi-image Draft 时：

Schedule 的对象始终是：

`Draft`

不是：

`media`

例如：

```ts
scheduleDraft(draftId)
```

而不是：

```ts
scheduleMedia(mediaId)
```

Schedule 前运行：

```ts
validateDraftForDestination()
```

如果 validation 成功：

`Draft → Scheduled`

整条内容一起进入 Scheduled。

\---

# 35\. Published multi-image Draft

发布成功之后：

整条 Draft：

`Scheduled → Posted`

仍然保持 media\[]。

Posted 页面仍然显示一张 Card。

Card 上显示：

`▧ 6`

不能发布以后又拆成六条历史记录。

\---

# 36\. Failed multi-image Draft

如果一个 6 图 Draft 发布失败：

生成的是：

**1 条 Publishing failed Content**

而不是：

6 条 Failed cards。

因为用户发布的是：

1 个 Post。

如果 API 返回具体某一张媒体失败的信息：

可以在打开 Failed Draft 后指出：

`Image 4 could not be processed.`

但 Draft 本身仍然是一条内容实体。

\---

# 37\. Desktop / Mobile interaction

不能依赖 hover 才能操作。

Desktop：

* hover = reveal quick actions only
* click = edit

Mobile：

* tap card = edit
* `···` 保持可点击
* Add images 使用相同逻辑

Mobile 不需要模拟 hover 行为。

\---

# 38\. 本次不要做的事情

为了避免 Claude 在这次修改中过度扩散范围，本次不要求：

* 重做整个 Create Pins 视觉系统
* 重做 Plan 页面
* 重做完整 Social Accounts
* 为每个平台建立完全独立的 Draft 系统
* 给 Pinterest / Instagram 建两套 Draft database
* 自动把所有 multi-image Draft 转换成平台格式
* 根据平台自动静默拆 Post
* 重做完整发布 API

本次重点是：

**Draft content model + multi-image UX + Create Pins default view + compact editor interaction。**

\---

# 39\. Implementation principles

必须遵守：

### Principle 1

一个 Draft 是一条内容，不是一张图片。

### Principle 2

Draft 可以拥有：

`1...N media`

### Principle 3

平台限制发生在：

Destination validation

而不是 Draft 基础数据层。

### Principle 4

用户多选上传图片时不能猜测用户意图。

### Principle 5

向已经存在的 Draft 添加图片时，不创建新 Draft。

### Principle 6

Scheduled / Posted 仍然属于同一个 Content lifecycle。

### Principle 7

All 永远只是全部内容的聚合视图。

### Principle 8

Create Pins 默认进入 Drafts。

### Principle 9

编辑必须由 click 触发，而不是 hover。

### Principle 10

Hover 不能导致 layout shift。

\---

# 40\. Acceptance Criteria

完成后必须满足以下行为。

## Navigation

* \[ ] Create Pins 默认打开 `Drafts`
* \[ ] `All` 不再是默认 Tab
* \[ ] Drafts 不显示 Scheduled
* \[ ] Drafts 不显示 Posted
* \[ ] Scheduled 仍然显示在 All
* \[ ] Posted 仍然显示在 All
* \[ ] Failed 有独立 Tab
* \[ ] Plan 不再作为普通内容状态处理

## Multi-image model

* \[ ] Draft 使用 `media\[]`
* \[ ] Existing single-image Draft 可以兼容
* \[ ] 一个 Draft 可以拥有多张图片
* \[ ] Existing Draft 可以继续 Add images
* \[ ] Add images 可以一次选择多张
* \[ ] 给现有 Draft Add images 不创建新 Draft
* \[ ] 图片可以 reorder
* \[ ] 图片可以单独 remove
* \[ ] 图片可以 replace
* \[ ] 第一张媒体作为默认 Cover

## Multi-upload

* \[ ] 单张上传直接创建一个 Draft
* \[ ] 多张上传询问 separate drafts / one draft
* \[ ] Separate drafts 正确生成 N 个 Draft
* \[ ] One draft 正确生成 1 个 Draft + N media
* \[ ] 系统不能未经用户允许自动拆分 multi-image Draft

## Card

* \[ ] Hover 不再展开 Edit Pin
* \[ ] Hover 不改变 card dimensions
* \[ ] `···` 在 collapsed / expanded 状态都可点击
* \[ ] 点击 Edit / card 才展开
* \[ ] 展开反馈快速，没有慢速动画
* \[ ] 建议一次只展开一张
* \[ ] Multi-image Draft collapsed 状态显示媒体数量

## Editor

* \[ ] Expanded editor 顶部存在 media thumbnails
* \[ ] 存在 `+ Add images`
* \[ ] 默认主要字段只保留 Title / Description / Destination
* \[ ] Website URL 移入 More details
* \[ ] AI 操作降低视觉权重
* \[ ] Image analyzed / Context used 不再占大型模块
* \[ ] Saved 显示为轻量状态

## Publishing

* \[ ] Schedule 操作针对整个 Draft
* \[ ] Multi-image compatibility 在 destination 层验证
* \[ ] 不支持时不能 silently discard media
* \[ ] 不支持时不能 silently split Draft
* \[ ] Scheduled 后从 Drafts 消失
* \[ ] Scheduled 后进入 Scheduled
* \[ ] Scheduled 后仍存在于 All
* \[ ] Posted 后进入 Posted
* \[ ] Posted 后仍存在于 All

## Failed

* \[ ] Generation failed 和 Publishing failed 可以区分
* \[ ] Failed banner 的数字语义清楚
* \[ ] Failed Tab 总数与分类能够解释
* \[ ] Multi-image Post 发布失败仍然只生成一条 Failed Content

\---

# 41\. 最终 UI 建议

最终顶部更接近：

```text
Create Pins

\[ Upload more ]                             \[ Open Plan ]

Drafts 4    Scheduled 11    Posted 48    Failed 16    All 79
────────────────
```

默认只看到 4 个 Draft。

不是一进入系统就看到 79 张内容。

Draft 打开以后：

```text
Media
\[img1] \[img2] \[img3] \[+ Add]

Title
\[................................]

Description
\[................................]

Pinterest board / Destination
\[................................]

More details ▾

✓ Saved
```

而不是默认展示一个包含十几个视觉模块的大型表单。

\---

# 42\. 本次改动最重要的最终结果

完成后，Create Pins 的内容结构应该变成：

```text
Content / Draft
   ├── media\[]
   ├── copy
   ├── destination
   ├── schedule
   └── status
```

用户体验应该变成：

```text
Upload
   ↓
Draft
   ↓
Add / remove / reorder media
   ↓
Edit copy
   ↓
Choose destination
   ↓
Validate destination compatibility
   ↓
Schedule
   ↓
Scheduled
   ↓
Posted
```

而不是：

```text
Upload six images
   ↓
Automatically create six unrelated drafts
```

也不是：

```text
Hover over card
   ↓
Card unexpectedly becomes a huge form
```

最终目标：

> Create Pins 看起来更轻，但底层内容能力更强。

用户默认只看到真正还在制作中的 Draft；已经 Scheduled / Posted 的内容退到对应视图。

与此同时，每一个 Draft 从现在开始都应该天然支持一张或多张图片，为 Pinterest、Instagram carousel 以及未来其他 multi-media destination 使用同一套 Content model。



\# Create Pins PRD — Final UI Amendments



> This amendment reflects the final approved Draft editor UI.

>

> If any requirement below conflicts with previous PRD sections, this amendment takes priority.



\---



\# 1. Final Drafts Page Layout



The final Drafts page must use a:



\*\*multi-column vertical Pin editor grid\*\*



not a collapsed card grid and not a horizontal editor.



Desktop target:



```text

\[ Draft editor ]\[ Draft editor ]\[ Draft editor ]\[ Draft editor ]

\[ Draft editor ]\[ Draft editor ]\[ Draft editor ]\[ Draft editor ]

```



Each Draft is permanently displayed in editable form.



There is no separate:



\* collapsed state

\* expanded state

\* hover-to-expand state

\* click-to-expand state



Opening `Create Pins → Drafts` should immediately show editable Draft cards.



\---



\# 2. Desktop Grid Density



The target desktop experience should prioritize seeing multiple Drafts at the same time.



Recommended:



\### Large desktop



4 Draft editors per row.



\### Medium desktop



3 Draft editors per row.



\### Tablet



2 per row.



\### Mobile



1 per row.



Recommended Draft width:



approximately:



`280–330px`



Do not allow cards to stretch into large horizontal editors.



Even on a very wide monitor, cards should preserve a narrow vertical Pin-editor shape.



\---



\# 3. Main Pin Preview Must Use Pinterest 2:3 Ratio



The primary image preview should follow Pinterest's vertical Pin presentation.



Use:



`aspect-ratio: 2 / 3`



Reference creative size:



`1000 × 1500`



Example:



```css

.pin-media-preview {

&#x20; width: 100%;

&#x20; aspect-ratio: 2 / 3;

&#x20; object-fit: cover;

}

```



Important:



`2:3` is the preview container ratio.



Do not destructively resize or overwrite the original uploaded image.



If the original image has another aspect ratio:



show a crop preview.



Original source media must remain intact.



\---



\# 4. Final Draft Card Structure



The approved Draft card structure is:



```text

┌──────────────────────────────┐

│ AI Generated   Draft     ··· │

│                              │

│                              │

│        MAIN IMAGE 2:3        │

│                              │

│                        1 / 6 │

│                              │

├──────────────────────────────┤

│ Media (6)                    │

│ \[1]\[2]\[3]\[4]\[5]\[+2]          │

│                              │

│ Pin title                    │

│ \[\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_] │

│                              │

│ Description                  │

│ \[\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_] │

│                              │

│ Publish destination          │

│ \[Pinterest · account · board]│

│                              │

│ More details ▾               │

│                              │

│ Not scheduled      Schedule  │

│                              │

│ ✓ Saved                  ··· │

└──────────────────────────────┘

```



The image should remain the strongest visual element.



The form should visually feel secondary.



\---



\# 5. Remove Large Save Button



Previous concepts containing:



`Save changes`



should be removed.



Drafts use autosave.



Normal states:



```text

✓ Saved

```



or:



```text

Saving...

```



Error state:



```text

Couldn't save · Retry

```



Do not show a persistent large primary Save button on every card.



Reason:



Four large Save buttons per row make the page visually heavy and make every Draft feel unfinished.



\---



\# 6. Top Status Area



The top of each Draft should only show information that helps identify the content.



Recommended:



```text

AI Generated    Draft

```



or:



```text

Uploaded        Draft

```



These represent two separate concepts:



\### Source



\* AI Generated

\* Uploaded



\### Lifecycle status



\* Draft

\* Scheduled

\* Posted

\* Failed



On the Drafts page the lifecycle status is always:



`Draft`



Do not show all of these at the top:



\* Image analyzed

\* Not scheduled

\* Saved

\* Pinterest

\* Board

\* AI context



Those belong elsewhere.



\---



\# 7. Draft-Level Menu



The top-right:



`···`



must always remain visible.



No hover interaction may move or hide it.



Draft-level menu may contain:



\* Duplicate Draft

\* Delete Draft



Do not place media-specific Remove / Replace actions here.



\---



\# 8. Multi-image Presentation



Every Draft supports:



```ts

media\[]

```



The large 2:3 image shows the current cover:



```ts

media\[0]

```



For a multi-image Draft, show an image counter over the main image.



Example:



```text

▧ 1 / 6

```



This communicates:



\* this is one Draft

\* this Draft contains six media items



Do not create six separate cards.



\---



\# 9. Media Strip



Immediately below the main image, show:



```text

Media (6)



\[img1]\[img2]\[img3]\[img4]\[img5]\[+2]

```



For a single-image Draft:



```text

Media (1)



\[img1]\[ + ]

```



The `+` action means:



`Add images`



Clicking it allows one or multiple new images to be uploaded directly into the current Draft.



Result:



```ts

draft.media.push(...)

```



It must NOT create new Drafts.



\---



\# 10. Media Strip Overflow



Because Draft cards are narrow, do not attempt to display every thumbnail when there are many images.



Example:



If the Draft contains 8 images:



```text

\[1]\[2]\[3]\[4]\[5]\[+3]

```



Clicking:



`+3`



opens the media manager / full media view.



This prevents the card width from expanding.



\---



\# 11. Media Reorder Behavior



Users must be able to change media order.



The first item:



```ts

media\[0]

```



is always the default Cover.



After reordering:



```text

Image 4 → position 1

```



that image becomes the new large main preview automatically.



Reordering should not create a new Draft.



\---



\# 12. Pin Title



Keep `Pin title` visible by default.



Use a compact input / textarea height.



Do not make the Title section visually oversized.



Character count may remain subtle on the lower/right edge.



Example:



```text

72 / 100

```



If AI assistance is available:



use a small AI icon.



Do not add a large `Generate copy` button above the card.



\---



\# 13. Description



Keep Description visible by default.



The default textarea should remain compact.



Do not display a very tall empty textarea.



It may grow as the user types.



Example default:



approximately 2–3 text lines.



The goal is to preserve vertical density.



\---



\# 14. Publish Destination — Final UI



The final UI must use \*\*one compact Publish destination field\*\*.



Example:



```text

Publish destination



\[Pinterest · @vibepin · 家居       ▾]

```



Do NOT permanently display:



```text

Pinterest

Instagram

Facebook

```



as three separate rows inside every Draft.



That would make every card unnecessarily long.



\---



\# 15. Destination Selector Behavior



Clicking Publish destination opens a selector.



Example:



```text

Publish to



Pinterest

&#x20; @vibepin

&#x20;   家居

&#x20;   Fashion

&#x20;   Products



Instagram

&#x20; @vibepin\_official



Facebook

&#x20; VibePin

```



The user selects the platform/account/destination inside this popover.



The selected value is then represented by one compact field inside the card.



\---



\# 16. Supported Platforms



The Publish destination architecture must support:



\* Pinterest

\* Instagram

\* Facebook



Do not build the Draft data model as Pinterest-only.



Avoid using:



```ts

pinterestBoard

```



as the primary publishing destination field.



Prefer:



```ts

publishDestination

```



Example:



```ts

publishDestination = {

&#x20; platform: "pinterest",

&#x20; accountId: "...",

&#x20; boardId: "..."

}

```



Instagram:



```ts

publishDestination = {

&#x20; platform: "instagram",

&#x20; accountId: "..."

}

```



Facebook:



```ts

publishDestination = {

&#x20; platform: "facebook",

&#x20; accountId: "...",

&#x20; pageId: "..."

}

```



\---



\# 17. Platform-specific Destination Display



The compact selector should adapt to the selected platform.



Pinterest:



```text

Pinterest · @vibepin · 家居

```



Instagram:



```text

Instagram · @vibepin\_official

```



Facebook:



```text

Facebook · VibePin

```



Do not show:



`Pinterest Board`



when the selected destination is Instagram or Facebook.



\---



\# 18. Platform-specific Fields



Destination-specific settings should appear conditionally.



\### Pinterest



May require:



\* Pinterest account

\* Board



\### Instagram



May require:



\* Instagram account

\* post format where relevant



\### Facebook



May require:



\* Facebook account/page



These settings should not all remain visible simultaneously.



Only show settings relevant to the selected destination.



\---



\# 19. Current Destination Selection Model



For this implementation:



use one selected Publish destination per Draft unless the existing publishing backend already safely supports multi-destination publishing.



Current UX:



```text

1 Draft

&#x20;   ↓

1 selected Publish destination

```



The selector can choose between:



Pinterest / Instagram / Facebook.



Do not automatically cross-post to all three simply because the user has connected all three platforms.



Architecture may remain extensible for future:



```ts

destinations\[]

```



but do not introduce unnecessary multi-publish complexity in this UI now.



\---



\# 20. More Details



Keep:



`More details ▾`



between Publish destination and Schedule.



Default:



collapsed.



Move lower-frequency fields into this section.



Examples:



\* Website URL

\* advanced destination options

\* optional metadata

\* other non-essential settings



The Draft card must not show all advanced fields by default.



\---



\# 21. Schedule



Keep Schedule compact.



Default Draft state:



```text

Not scheduled                 Schedule

```



The Schedule button should be secondary/outlined rather than the strongest primary CTA on the entire card.



Once scheduling succeeds:



```text

Draft → Scheduled

```



The item disappears from Drafts.



It appears under:



`Scheduled`



and remains in:



`All`.



Therefore Draft cards do not need to permanently display large scheduled-status controls.



\---



\# 22. Autosave Footer



The footer should be extremely lightweight.



Example:



```text

✓ Saved just now                ···

```



or:



```text

✓ Saved 2h ago                  ···

```



No persistent primary action is required.



\---



\# 23. No Hover Expansion



Completely remove any previous logic resembling:



```text

hover card

→ open editor

```



Cards are already editors.



Hover may only:



\* subtly strengthen border

\* reveal thumbnail media controls

\* highlight action buttons



Hover must never:



\* change card width

\* change card height significantly

\* trigger the editor

\* rearrange the grid

\* hide the three-dot menu



\---



\# 24. Draft Card Height



Do not enforce one giant fixed card height.



Cards may have natural height.



However, default content should remain compact enough that a row still feels visually aligned.



Use:



\* compact title

\* compact description

\* one-line destination

\* collapsed More details

\* compact Schedule

\* autosave footer



to control overall height.



\---



\# 25. Create Pins Top Navigation



Final primary tabs:



```text

Drafts    Scheduled    Posted    Failed    All

```



Default selected Tab:



`Drafts`



Plan remains a separate action:



```text

Open in Plan

```



Do not return `All` to the first/default position.



\---



\# 26. Drafts Default Experience



Example:



```text

Drafts 4    Scheduled 11    Posted 48    Failed 16    All 79



\[ Draft ]\[ Draft ]\[ Draft ]\[ Draft ]

```



The user should immediately see only content that is still being prepared.



Already Scheduled / Posted content should not fill the default workspace.



\---



\# 27. Final Visual Priority



Visual priority should be:



\### Level 1



Pin image



\### Level 2



Title + Description



\### Level 3



Destination + Schedule



\### Level 4



Source/status/system metadata



Do not let badges, AI controls, save controls, or system metadata compete visually with the content itself.



\---



\# 28. Final Acceptance Criteria Additions



\## Grid



\* \[ ] Drafts display as vertical editable cards by default

\* \[ ] Large desktop supports approximately 4 Draft editors per row

\* \[ ] Cards do not become horizontal editors

\* \[ ] Cards do not require click-to-expand

\* \[ ] Cards do not expand on hover



\## Media



\* \[ ] Main media preview uses a 2:3 Pinterest-style container

\* \[ ] Main image is not stretched

\* \[ ] Multi-image count displays on the cover

\* \[ ] Media thumbnails appear below the main image

\* \[ ] Existing Draft can add multiple images

\* \[ ] Additional images remain inside the same Draft

\* \[ ] Media order can be changed

\* \[ ] `media\[0]` controls the Cover



\## Destination



\* \[ ] One compact Publish destination field appears in each Draft

\* \[ ] Selector supports Pinterest

\* \[ ] Selector supports Instagram

\* \[ ] Selector supports Facebook

\* \[ ] Pinterest can select account + Board

\* \[ ] Instagram does not display Pinterest Board

\* \[ ] Facebook does not display Pinterest Board

\* \[ ] All three platforms are not permanently expanded inside every card



\## Editor



\* \[ ] Title visible by default

\* \[ ] Description visible by default

\* \[ ] Description starts compact

\* \[ ] More details collapsed by default

\* \[ ] Website URL is not a primary always-visible field

\* \[ ] No large Generate Copy button

\* \[ ] No large Regenerate Image button



\## Saving



\* \[ ] Drafts autosave

\* \[ ] Large Save Changes button is removed

\* \[ ] Saved state is lightweight

\* \[ ] Save error supports Retry



\## Schedule



\* \[ ] Draft shows lightweight `Not scheduled`

\* \[ ] Schedule button remains compact

\* \[ ] Successful scheduling removes item from Drafts

\* \[ ] Scheduled item appears in Scheduled

\* \[ ] Scheduled item remains in All



\---



\# 29. Final Approved UI Reference



The latest approved UI mockup should be treated as the visual reference for implementation.



Key characteristics to preserve:



\* four-column vertical Draft editor layout on large desktop

\* Pinterest-style tall media

\* editable cards always open

\* compact media thumbnails

\* compact Publish destination

\* compact Schedule

\* autosave instead of Save Changes

\* minimal badges

\* large image as the visual focus



The implementation does not need to pixel-match the mockup exactly, but should preserve its information density, card proportions, interaction hierarchy, and lightweight feel.



