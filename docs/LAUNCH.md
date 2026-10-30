# 宣传手册（Launch Kit）

这份文件只服务一个目标：**让人点进来、看完、装上、再转出去。**
所有文案都可以直接复制，`{{}}` 是需要按你的真实数字替换的占位。

---

## 0. 先认清传播结构

这个项目的传播不是靠"功能多"，是靠**社交货币**：

```
别人的真实日志 → 生成一张卡片（带 2026、你的原话、你的占比）
      ↑                                  ↓
  安装（npx 一行）  ←── 卡片右下角就是安装命令 ──→ 发到群里/小红书/X
```

所以素材的优先级是：
1. **分享卡片**（1080×1350，已内置三种模板）—— 最轻的传播单位；
2. **首屏截图**（`docs/preview-year.png`）—— 决定"要不要点 star"；
3. **15 秒 GIF** —— 决定"要不要装"。

功能列表排在最后。没有人因为"支持季度聚合"而转发。

---

## 1. 一句话定位（挑一个用，别三个一起用）

| 场景 | 文案 |
| --- | --- |
| 技术人 | **给你的 AI 对话做一份网易云年度报告。** 自动读本地会话日志，零上传、零 token。 |
| 情绪人 | **你说 4,731 字，它回了 3.3 万字。** 消息里你只占 22%，但每句话都是你先开的口。 |
| 反差钩 | **我和 AI 聊了一年，近八成的消息都是它在说。** |

英文版（X / HN）：

> **Wrapped, but for your AI conversations.** DeepSeek Harness 插件：月度/季度/年度回顾，人类 vs AI 双视角，读本地日志，不上传、不调模型。`npx dsh-plugin-wrapped install`

**反面教材**（不要这么写）："一个功能完整的对话统计分析插件，支持多维度聚合与可视化。" —— 没有一个字让人想点。

---

## 2. 渠道清单（按"性价比"排序）

| # | 渠道 | 谁在看 | 动作 | 成本 |
| --- | --- | --- | --- | --- |
| 1 | **dshmarket**（可视化插件市场） | 真在用 DSH 的人，月下载 78 万 | 提交收录 | 低 |
| 2 | **dsh-plugin-catalog / awesome-dsh-plugin.com** | 逛目录的人，7723 条 | 提 PR / 提 issue | 低 |
| 3 | **npm** | 搜 `dsh-plugin` 的人 | 关键词 + README 首图 | 发布即得 |
| 4 | **小红书** | 非技术但爱年度报告的人 | 卡片九宫格 + 一句话 | 中 |
| 5 | **即刻 / V2EX / 知乎** | 中文开发者 | 长一点的"我这一年"叙事 | 中 |
| 6 | **X / Twitter** | 海外 + AI 圈 | 英文 thread + GIF | 中 |
| 7 | **B站 / 抖音** | 泛人群 | 15 秒录屏 | 高 |
| 8 | **相关插件联动** | 已有流量池 | 和桌宠/主题类插件互相 @ | 低 |

### 提交到两个目录（发布当天做）

```bash
# 目录是 npm 上的包，收录走各自仓库的 PR / issue
npx dsh-plugin-catalog --help 2>/dev/null || npm view dsh-plugin-catalog version
# 打开 https://awesome-dsh-plugin.com 找 "Submit" / 仓库 README 的收录说明
```

提交时用的元信息（照抄）：

```yaml
name: dsh-plugin-wrapped
one-liner: 网易云年度报告风格的 AI 对话回顾 · 人类 vs AI 双视角
keywords: wrapped, year-in-review, conversation-analytics, report
category: insights / stats
install: npx dsh-plugin-wrapped install
```

---

## 3. 现成文案（复制即发）

### 3.1 小红书（3:4 卡片，配 1080×1350 分享卡）

> 标题：**我给我的 AI 对话做了一份年度报告，有点上头**
>
> 正文：
> 用了一年 AI 写代码，好奇到底谁在说话，就做了个插件把本地日志变成网易云那种年度报告。
>
> 结果有点扎心：
> · 我写了 {{4,731}} 字，它回了 {{3.3万}} 字 —— 消息里我只占 **{{22%}}**
> · 最晚一次是 {{01:15}}，最后一句是「文档里这段是什么意思，我没看懂 migration 那行」
> · 我说得最多的词是「{{能不能}}」，{{26}} 次
> · 一年里我问了 {{5}} 个问题，说了 {{16}} 次谢谢（AI 不在乎，但我有点）
>
> 报告最后一句是它写给自己的：**「它不会记得这些。日志会。」**
>
> 数据全在本地，不上传、不联网，装一个就能看自己的：`npx dsh-plugin-wrapped install`

### 3.2 X / Twitter thread（英文）

> 1/ I built Wrapped for my AI coding sessions.
> Not screenshots. Not a SaaS. It reads your local session logs and renders
> a shareable report — monthly, quarterly, yearly.
>
> 2/ The number that got me: I wrote {{4,731}} characters this year. The model
> wrote {{33,000}}. I'm {{22%}} of my own conversations.
>
> 3/ But 100% of the openings were mine. The report has a "things you said"
> section — first line, latest line, the {{01:15}} you were still debugging,
> the phrase you kept repeating.
>
> 4/ No upload, no database, no model calls. It's a host plugin on the
> harness's own web server: `npx dsh-plugin-wrapped install`
>
> 5/ Repo: github.com/ErnestW2019/dsh-plugin-wrapped
> MIT. Zero deps. 105 tests. PRs welcome.
> Here's my card ⬇️

### 3.3 即刻 / 朋友圈（一行 + 图）

> 给自己的 AI 对话做了一份年度报告，最后一句话是「它不会记得这些。日志会。」
> 数据全本地，装一个能看自己的：`npx dsh-plugin-wrapped install`

### 3.4 V2EX / 知乎（技术向，别标题党）

> 标题：**把本地 AI 会话日志做成网易云式年度报告（开源，零上传）**
>
> 我用 DeepSeek Harness 的会话日志写了个回顾插件，几个实现上的取舍可能对
> 同类工具有参考：
> · **不引入存储**：直接读 harness 已经写好的 `session.vN.jsonl.zstd`，内存里按
>   周期现算，60s TTL。多帧 zstd 要自己走 RFC 8878 帧头，`zstdDecompressSync`
>   只解第一帧。
> · **不进模型上下文**：只挂 HTTP 路由，零 token。
> · **人类 vs AI 的口径**：把「AI 发言」和「AI 步数（含工具调用）」分开，否则
>   工具调用会把比例算成 1:13，看着像自己没说过话。
> · **离线也要能切周期**：导出的 HTML 把最近 13 期烘焙成惰性 `<template>`，
>   双击打开也能翻页（`file://` 下没有服务器）。
>
> 仓库：…  MIT，105 个单测，零依赖。

---

## 4. 素材清单（要准备的图）

| 素材 | 规格 | 从哪来 |
| --- | --- | --- |
| GitHub social preview | 1280×640 | 用 `docs/preview-year.png` 裁首屏 + 大标题 |
| npm/GitHub 首图 | 1180×自动 | `docs/preview-year.png`（已随包发布） |
| 分享卡 · 主卡 | 1080×1350 | 页面上点「分享卡片」下载 |
| 分享卡 · 反差卡 | 1080×1350 | 点「反差卡」：大号 `你只占了 X%` |
| 分享卡 · 口头禅卡 | 1080×1350 | 点「口头禅卡」 |
| 九宫格 | 1080×1080 ×9 | 卡片 + 页面切片 + 一句文案 |
| 15 秒 GIF | 1200×800 | 见下面的录制脚本 |

**15 秒 GIF 脚本**（一镜到底，别剪辑炫技）：

```
0-2s   终端：npx dsh-plugin-wrapped install && 看到 "patch -> ... (live)"
2-5s   浏览器刷新，右下角出现悬浮按钮，点进去
5-8s   首屏：巨大的 2026 + "你说 4,731 字，它说了 3.3 万字" + 占比条生长
8-11s  滚动：图表长出来 → 「最晚的一次 01:15」→ 引号里的原话
11-13s 滚到底：「它不会记得这些。日志会。」
13-15s 点「分享卡片」，卡片落进下载目录（画面停在卡片上）
```

录屏用 `scripts/shot.mjs` 的同款 headless 方案（`Page.startScreencast`）或直接
OBS；GIF 控制在 3 MB 内（X 和微信都能直传）。

---

## 5. 发布节奏

| 时间 | 做什么 |
| --- | --- |
| T-1 天 | 提交两个目录收录；准备好 3 张卡片 + GIF + 首图 |
| T 0（上午） | `npm publish`；发 GitHub release；小红书 + 即刻首发（图文） |
| T 0（晚上） | X thread（英文）+ V2EX / 知乎长文；回评论区 |
| T+1 | 发第二波：只发**一张你同事/朋友的报告卡片**（真实感 > 广告感） |
| T+3 | 把收到的反馈做成一条"更新日志"再发一次（二期传播） |
| T+7 | 统计 star / 安装量，写一篇"发布一周复盘"（这类内容二次传播很好） |
| 年底 12 月 | **Wrapped 心智最强的时候**，把"年度报告"重新置顶一次 |

时机判断：DSH 插件生态现在（2026-10）正热（`dshmarket` 月下载 78 万、
`dsh-plugin-catalog` 7700+ 条目），早发早占位；真正的爆发窗口在 12 月。

---

## 6. 诚实红线（别越，越了会被反噬）

- **不买量、不刷 star、不互刷下载** —— npm 下载量异常会被社区扒，且目录站会下架。
- **不编造百分位**："只有 3% 的人是夜猫子"这种话必须有数据支撑；目前插件只做
  「和你上一期比」，这是它唯一能诚实说出的对比。
- **不夸大隐私承诺**：确实零上传、零模型调用，但要说清"读的是你自己机器上的日志"。
- **图片必须真**：截图用真实渲染（本项目 `docs/` 下全部来自确定性合成数据，
  可复现），不要 PS。
- **不要用别人的聊天内容做宣传**：卡片默认只含你自己的数据，转发别人的卡片前先问。

---

## 7. 代码层还能加的增长钩子（按 ROI 排序）

1. ~~分享卡片右下角带水印 + 安装命令~~ ✅ 已做（每张卡片都是广告位）
2. ~~三种卡片模板~~ ✅ 已做（主卡 / 反差卡 / 口头禅卡）
3. ~~首屏巨大年份幽灵字 + 反差句~~ ✅ 已做（截图更像 Wrapped 封面）
4. **"和上一年比"的一句话**：`比 2025 年多说了 3 倍` —— 年度报告的情绪全靠纵向对比。
5. **卡片二维码**：把仓库地址画进卡片右下角（手机扫一下就进 GitHub），
   纯 canvas 实现，零依赖。
6. **「生成我的报告」落地页**：一个静态页 + 用户上传（本地解析）—— 但要有
   上传就有隐私争议，慎做；更安全的是"给了地址就自己跑命令"。
