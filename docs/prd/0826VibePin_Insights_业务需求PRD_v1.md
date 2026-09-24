# VibePin Insights 业务需求 PRD v1

## 1. 产品目标

Insights 让用户知道：内容表现如何、在哪个平台更适合、为什么表现好或差，以及下一条内容应怎样调整。

它不是把 Pinterest、Instagram、Facebook 的后台数字简单相加，而是连接 VibePin 的完整闭环：

**Create → Publish → Measure → Diagnose → Improve → Create**

## 2. 目标用户与范围

面向已连接 Pinterest、Instagram 或 Facebook 账号，并已通过 VibePin 发布内容的用户。

V1 包含：

- Overview：账号与跨平台表现总览
- Content：每条 VibePin Content 的表现比较
- Content detail：同一 Content 在各发布目标的独立结果
- Diagnosis：基于历史表现的可解释诊断
- Recommendations：可带回 Create Pin 的下一步建议

V1 不包含：广告 ROI、销售归因、竞品账号的私有分析、逐张 Carousel 图片的效果归因。

## 3. 核心业务概念

- **Content**：一条 VibePin 内容，可含一张或多张媒体。
- **Destination**：该 Content 发布到的一个具体平台和账号，例如 Pinterest 某 Board、Instagram 某账号、Facebook 某 Page。
- **Published result**：一个 Destination 的实际发布结果与外部内容链接；多平台结果彼此独立。
- **Native metric**：平台原生指标，保留平台自己的名称和含义。
- **VibePin rate**：基于原生指标计算的比例指标，必须标为 VibePin 计算值。
- **VibePin performance score**：内容相对该账号历史基线的表现分位，不是跨平台原始播放量排名。

## 4. 信息架构

Insights 顶级导航：

- Overview
- Content
- Audience
- Diagnosis
- Recommendations

用户可从 Content 和 Diagnosis 直接进入原 Content，或以建议为基础创建新 Draft。

## 5. Overview

### 5.1 页面内容

- 日期范围选择与上一周期比较
- 已连接平台的独立表现卡片
- 账号趋势图：按天查看原生关键指标
- 表现最佳 Content、需要关注的 Content
- 数据更新时间与数据可用性说明

### 5.2 展示原则

- 不把 Pinterest Impressions、Instagram Views、Facebook Media Views 合并成一个“总曝光”。
- 每个平台的指标使用原生名称；用户可查看简短定义。
- 平台未连接、暂无权限、尚未更新与数值为 0 必须明确区分。
- Overview 参考 Tailwind 的清晰趋势阅读方式：先看账号趋势，再钻取具体内容；不复制其页面或品牌视觉。

## 6. 指标与比较规则

### 6.1 平台原生指标

| 指标族 | Pinterest | Instagram | Facebook |
| --- | --- | --- | --- |
| 曝光 | Impressions | Views | Media Views |
| 独立受众 | Total Audience（可用时） | Reach | Unique Media Viewers |
| 收藏价值 | Saves | Saves | — |
| 互动 | Engagement、Pin Clicks | Likes、Comments、Shares、Saves | Reactions、Comments、Shares |
| 引流意图 | Outbound Clicks | Profile / Link actions（可用时） | Link / Post Clicks |
| 视频质量 | Video Views、Watch Time、Completion | Watch Time、Skip / Retention（可用时） | Video / Reel watch metrics |

“—”表示该平台没有可比的原生指标，不以 0 补齐。

### 6.2 VibePin 比例指标

在分母数据可用且大于 0 时，VibePin 可以展示：

- Save rate = Saves / Exposure
- Click rate = Outbound 或 Link Clicks / Exposure
- Share rate = Shares / Exposure
- Comment rate = Comments / Exposure
- Engagement rate = 已定义的互动总数 / Exposure
- Video quality = 依据各平台可用的观看时长、完成度或留存指标单独解释

比例指标只用于相同平台内的比较；跨平台页面仅可并列展示，不得暗示相同定义。

### 6.3 跨平台比较规则

同一 Content 可以比较“在哪个平台相对表现更好”，但不能用原始 Views 决定胜负。

VibePin performance score 必须在下列可比 cohort 中计算：

- 同一用户账号
- 同一平台
- 相同或相近内容格式
- 相近发布年龄，例如发布后 1 天、7 天或 30 天
- 同为 Organic 内容

结果使用分位表达，例如“Pinterest Save Rate 超过你同类 Pin 的 88%”。

样本不足时仍展示原始数据，但不显示胜负结论、排名或 AI 归因。默认最低条件为同一 cohort 有 10 条可比较内容；具体门槛可在后续运营校准。

## 7. Content 与内容详情

### 7.1 Content 列表

每行代表一条 VibePin Content，而不是一个平台帖子。展示：

- Cover、标题、格式、发布时间
- 已发布平台与账号
- 各平台的关键原生指标摘要
- VibePin performance score
- 最新诊断状态

支持按平台、账号、内容格式、主题、发布时间和表现区间筛选。

### 7.2 内容详情

同一 Content 下按 Destination 分别展示 Pinterest、Instagram、Facebook 的发布结果、外部链接、原生指标和趋势。

业务规则：

- 多平台部分成功时，成功结果永久保留；失败的平台独立显示失败，不覆盖其他平台事实。
- 内容编辑后再次 Publish 属于新的发布结果；历史发布结果不可被后续编辑改写。
- 多图内容按整体 Content / Destination 计算表现；没有平台证据时，不声称某一张 Carousel 图片贡献了具体效果。

## 8. Audience

Audience 以平台为单位展示，不强制伪造跨平台统一画像。

- Pinterest：人口属性、地区、设备、兴趣与 Affinity。
- Instagram：可用的人口属性、地区与关注者活动。
- Facebook：当前可用的 Page 受众信号。

业务规则：兴趣与 Affinity 是 Pinterest 的专属优势；Instagram 或 Facebook 没有等价数据时显示“该平台不提供此类洞察”，不显示空白或错误的 0。

## 9. Diagnosis 与 Recommendations

### 9.1 Diagnosis

Diagnosis 回答“可能发生了什么”，而非声称平台数据证明因果关系。

每条诊断必须同时显示：

- 结论，例如“收藏意图强、引流意图弱”
- 对比基线，例如“高于你同类 Pinterest Pin 的 Save Rate，但 Click Rate 低于中位数”
- 证据指标与比较范围
- 数据是否足够的提示

允许的诊断示例：

- Pinterest：Save Rate 强、Outbound Click Rate 弱，建议保留主题但测试更明确的标题或 CTA。
- Instagram：Reach 正常、观看质量弱，建议测试首帧或更早展示核心收益。
- 跨平台：同一创意在 Pinterest 表现领先、Instagram 表现落后，建议将其归为更偏搜索与收藏的内容，不应默认大量跨发。

禁止：

- 用不足样本给出强结论。
- 将相关性写成因果。
- 因为某平台没有指标就推断内容失败。

### 9.2 Recommendations

每条建议使用明确结构：

- **Keep**：已验证应保留的主题、格式或视觉方向。
- **Change**：下一条应改变的一个变量，例如标题 hook、CTA、首图或发布时间。
- **Test**：建议进行的受控比较，例如单图 vs 三图 Carousel。

用户可选择“Generate based on this insight”，系统以建议和原 Content 为上下文创建新的 Draft；不会改写原 Content 或历史发布结果。

## 10. 数据可用性与历史规则

- Insights 只分析用户已授权连接的账号及其可访问内容。
- 所有指标标示最近更新时间；不同平台更新节奏不同，不承诺实时。
- 连接后开始积累 VibePin 历史；连接前能否展示历史由各平台当时允许的范围决定。
- 短窗口数据、受众洞察与趋势信号应显示实际覆盖期间，不得暗示拥有完整历史。
- 用户断开连接后，停止新增采集；已在 VibePin 中形成的历史展示遵循账号的数据保留与删除规则。
- 付费、广告与 Organic 数据必须分开呈现；V1 默认只分析 Organic。

## 11. V1 验收标准

1. 用户能在一条 Content 下看到每个平台独立、真实的发布结果与数据状态。
2. 用户能选择周期并查看平台内趋势及与上一周期的变化。
3. 任一跨平台结论均以相对历史基线表达，不能以不同定义的原始 Views 直接排名。
4. 缺失、不支持、未连接、未更新和 0 值在界面上可区分。
5. Diagnosis 可追溯到具体指标、比较对象和样本充分性。
6. Recommendations 可直接转化为新的 Draft，且不修改任何历史发布结果。
