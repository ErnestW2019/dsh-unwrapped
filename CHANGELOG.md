# Changelog

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.0] - 2026-10-31

首个公开版本。此前仓库名为 `dsh-plugin-wrapped`（从未发布到 npm）。

### 新增

- Cordis 宿主插件：月度 / 季度 / 年度三种周期，人类 vs AI 双视角报告。
- 报告页为单文件 HTML（inline CSS + inline SVG + 原生 JS），无框架、无构建、无外部请求。
- 三种分享卡（1080×1350 PNG，canvas 现画）：主卡 / 反差卡 / 口头禅卡，右下角带水印与安装命令。
- 句子层：第一次、最近一次、最晚的一条、最长连续对话、最高频词、每段首句话时间线。
- 高光对话 Top 6：标题、轮次、Token、时长，以及子代理会话标签。
- 离线 CLI：`node bin/unwrapped.js`，不需要 harness，支持 `--embed <n>` 把最近 N 期烘进同一个文件。
- HTTP API：`GET /unwrapped`、`GET /api/unwrapped`，支持 `?partial=1` 片段返回。
- 跨平台安装器 `npx dsh-unwrapped install|uninstall|status`（`--profile` / `--dry-run`）。
- 多帧 zstd 读取：按 RFC 8878 逐帧解码 `session.vN.jsonl.zstd`，尾部残帧自动丢弃。
- 中文 / 英文文案包（`language: zh | en`）。

### 测试与文档

- 105 个单元 / 集成测试（`node --test`，零依赖）。
- 17 项真浏览器交互检查（`scripts/browser-check.mjs`）。
- `docs/` 下全部预览由确定性的合成数据生成，可用 `scripts/make-demo.mjs` 复现。
- GitHub Actions：Linux + Windows × Node 22 / 24 测试矩阵，外加演示管线冒烟检查。

[Unreleased]: https://github.com/ErnestW2019/dsh-unwrapped/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ErnestW2019/dsh-unwrapped/releases/tag/v0.2.0
