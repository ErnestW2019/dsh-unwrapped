# 发布清单（npm）

维护者文档，不进 npm 包。

## 0. 现状（2026-10-30 实测）

| 项 | 状态 |
| --- | --- |
| 外网 | 通（`registry.npmjs.org` 可达） |
| npm 登录 | **没有**（`npm whoami` → `ENEEDAUTH`）→ 所以 agent 没能发布 |
| 包名 | 已定为 `dsh-unwrapped`（可用，见下） |
| 产物 | `npm pack` → 15 文件 / 57 KB；装进临时 prefix、用自带命令往干净 `$DSH_HOME` 安装、真实启动 harness，`/unwrapped` → 200 且是交互版 |

改名过程（2026-10-30 实测 npm registry + GitHub）：

| 名字 | 状态 | 说明 |
| --- | --- | --- |
| `dsh-plugin-rewind` | 占用 | `xueelf`，v0.0.0 / 3 文件 / 305 B / 无描述，像是占名 |
| `dsh-rewind` | 占用 | `l-dot` v0.11.12，「Claude Code 式 /rewind + git 还原」= 回滚，不是报告 |
| `dsh-wrapped` | 占用 | v0.0.1，描述写着 "name reserved" |
| `dsh-recap` / `dsh-retro` / `dsh-mirror` / `dsh-plugin-recap` | 占用 | 前两个是别人的真插件，后两个同样是 "name reserved" |
| **`dsh-unwrapped`** | **可用** | npm + GitHub 都空 → 最终采用 |

`unwrapped` 的双关正好合适：既是 "Wrapped"（年度报告）的变体，也是「拆开给你看」。

## 1. 查名字 / 查同类（脚本，不依赖登录）

```bash
node scripts/market-check.mjs                                  # 默认候选名 + 同类插件
node scripts/market-check.mjs --name dsh-unwrapped --name foo
```

它做两件事：`GET /<name>` 判断名字是否 FREE，以及按 `rewind / wrapped / 年度报告 / 回顾 / usage stats`
在 registry 搜索里筛出 `dsh`/`deepseek` 相关包，按月下载量排序。

## 2. 发布前（2 分钟）

```bash
npm login                                  # 浏览器或 OTP
npm view dsh-unwrapped version        # 应返回 404（= 名字仍是你的）
npm pack --dry-run                         # 看清单：15 个文件，约 57 KB
node --test --test-isolation=none "test/*.test.js"   # 105 个用例（prepublishOnly 也会跑）
```

元数据已填好（`repository` / `homepage` / `bugs` / `author` 指向
`github.com/ErnestW2019/dsh-unwrapped`）。如果仓库放到别处，记得同步改 `package.json`。

## 3. 发布

```bash
npm publish          # publishConfig.access=public 已设好，不需要 --access
npm view dsh-unwrapped version dist.tarball
```

升级：`npm version patch|minor|major` 会改版本号并打 git tag，然后 `npm publish`。

## 4. 发布后自检

```bash
npx dsh-unwrapped --help
npx dsh-unwrapped status
```

## 5. 用户怎么用

```bash
# A. 一行装进当前 profile（推荐）
npx dsh-unwrapped install

# B. 指定 profile / 换语言 / 换按钮文案
npx dsh-unwrapped install --profile tui --language en --label "Wrapped"

# C. 全局安装
npm i -g dsh-unwrapped && dsh-unwrapped install

# D. 只要文件，不要 harness
npx dsh-unwrapped install --dry-run            # 只打印会做什么
npx dsh-unwrapped-report --period year --embed 13 --out unwrapped.html
```

装完重启一次 `dsh web`（改代码必须重启，改 config 才热加载），刷新 GUI 点右下角悬浮按钮，
或直接开 `http://127.0.0.1:8080/rewind`。

卸载：`npx dsh-unwrapped uninstall`（`--keep-files` 只摘 patch 行，保留插件目录）。

## 6. 发布后值得跟进的动作

- **上目录**：`dsh-plugin-catalog`（7700+ 条目，`awesome-dsh-plugin.com`）和 `dshmarket`
  这两个市场是 DSH 用户真正逛的地方；被收录才有自然流量。关键词用 `wrapped` / `年度报告` /
  `conversation analytics`。
- **README 首图**：npm 页面只认包内相对路径 —— `docs/preview-year.png` 已加进 `files`，
  所以首图能显示；`docs/preview-*.html` 不在包里，链接要写成仓库链接。
- **和占名包的关系**：`dsh-plugin-rewind@0.0.0` 如果有内容，别去撞名；必要时在 README 里写一句
  「本插件不是 /rewind 回滚工具」防止误解。
