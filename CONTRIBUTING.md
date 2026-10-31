# Contributing

先说清楚一件事：这个插件的价值在于**口径可信**——每一个数字都能从会话日志重新算出来。
所以改动时最容易被接受的顺序是：先改进测试，再改实现。

## 环境

- Node ≥ 22.15（用到 `zlib.zstdDecompressSync`）
- 零运行时依赖，不需要 `npm install` 就能跑测试

```bash
node --test --test-isolation=none "test/*.test.js"   # 105 个用例
node scripts/browser-check.mjs --file docs/preview-year.html   # 真浏览器交互 17 项
```

`node --test test/` 在受限沙箱里会因管道被拦截而 `EPERM`，所以命令里带 `--test-isolation=none`。

## 改动的形状

| 你想改 | 应该动哪 |
| --- | --- |
| 指标口径（怎么数、怎么算） | `lib/extract.js` → `lib/aggregate.js`，**必须**配 `test/extract.test.js` 或 `test/aggregate.test.js` |
| 页面长什么样 | `lib/report.js`（自包含 HTML，CSS / SVG / JS 都在里面） |
| 文案 | `lib/labels.js`，中英两份都要改 |
| 路由 / 注入 | `lib/http.js` |
| 安装器行为 | `bin/plugin.js` + `test/profilePatch.test.js` |
| 离线读取日志 | `lib/archive.js`（多帧 zstd 必须逐帧解，别退回 `zstdDecompressSync`） |

几条硬约束：

- **不引入运行时依赖。** 需要 YAML 就手写解析（见 `lib/profilePatch.js`），需要图表就手写 SVG。
- **纯函数优先。** `extract` / `aggregate` / `periods` 不读文件、不看时钟，时间从参数进。
  这样测试才能固定住输出。
- **不改别人的 patch 行。** 安装器对 `cordis.patch.yml` 只动自己的 `insert` 条目。
- **不提交真实会话内容。** `docs/` 下的预览必须由 `scripts/make-demo.mjs` 生成。
  提交截图前跑一遍 `node scripts/make-demo.mjs`，别手改生成物。

## 提 PR

1. 开一个 issue 说清动机（尤其是口径变更，先说清「为什么旧口径不对」）。
2. 分支从 `main` 切，提交信息用 `feat:` / `fix:` / `docs:` / `test:` / `refactor:` 前缀。
3. 测试必须过，且**新增行为要有对应测试**。CI 会在 Linux 和 Windows、Node 22 和 24 上跑。
4. 改了用户可见行为，顺手更新 `CHANGELOG.md` 的 `[Unreleased]` 段。
5. 改了预览相关的实现，重跑 `node scripts/make-demo.mjs` 并提交 `docs/` 的差异。

## 复现预览

```bash
node scripts/make-demo.mjs                                     # 重建合成语料 + 三份预览
node scripts/shot.mjs --file docs/preview-year.html --out docs/preview-year.png
node scripts/shot-cards.mjs                                    # 三张分享卡
node scripts/make-gif.mjs                                      # 首图 GIF（需要 ffmpeg）
```

生成物带当前时间戳，所以每次重建都会产生 diff —— 这是预期的，只提交内容层面的变化。

## 安全

见 [SECURITY.md](SECURITY.md)。隐私相关的改动（读哪些文件、暴露哪些字段）请在 PR 描述里单列一段。
