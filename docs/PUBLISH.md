# 发布清单（npm）

维护者文档，不进 npm 包。

## 0. 现状（2026-10-31 实测）

| 项 | 状态 |
| --- | --- |
| 外网 | 通（`registry.npmjs.org` 可达；`www.npmjs.com` 在本机 403） |
| npm 登录 | ✅ `ernestw2019`，用 Granular Access Token |
| 已发布 | ✅ `dsh-unwrapped@0.2.0`（`latest`），21 文件 / 1.5 MB |
| 包名 | `dsh-unwrapped`（可用，见下） |
| 产物 | `npm pack` → 21 文件 / 1.5 MB；`npx dsh-unwrapped --help` 已验证可跑 |

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
npm view dsh-unwrapped version             # 已有版本号 = 名字是你的
npm pack --dry-run                         # 看清单：21 个文件，约 1.5 MB
npm test                                   # 105 个用例（prepublishOnly 也会跑）
```

> **认证用 Granular Access Token 最省事**（`www.npmjs.com` 打不开时尤其如此）。token 必须
> 勾选 **Bypass 2FA**，否则 `npm publish` 会 403：
>
> ```
> 403 Two-factor authentication or granular access token with bypass 2fa enabled is required
> ```
>
> 校验当前 token：`npm whoami`；查 token 自身的权限：`GET /-/npm/v1/tokens`。
>
> **WSL 里 `npm login` 也会崩**：`ERR_INVALID_ARG_TYPE` / `The "file" argument must be of type
> string`。原因是没有 `xdg-open`，npm 拿 `undefined` 去 spawn 浏览器。绕法（任选其一）：
>
> ```bash
> npm login --browser=false                    # 只打印 URL，自己在别处打开
> npm login --browser=explorer.exe             # 或让 WSL 调 Windows 的 explorer.exe
> ```
>
> 但 `--auth-type=legacy` 这条路走不通：npm 已关闭 legacy **注册**，只会返回
> `{"ok":false,"error":"username or password was invalid"}`。用 token。
>
> **Node 版本**：WSL 里常是 Node 20，而 `--test-isolation=none` 是 Node 24 才有的拼写
> （22 只认 `--experimental-test-isolation`，20 两个都不认）。所以 `npm test` 不带路径、
> 也不带 isolation flag，由 runner 自己发现用例。Node 20 缺 zstd，相关用例会自动跳过
> （96 项而不是 105 项）——这不影响 `npm publish`，但**发布前建议在 Node ≥ 22.15 上再跑一次**
> 以覆盖 zstd 路径。

元数据已填好（`repository` / `homepage` / `bugs` / `author` 指向
`github.com/ErnestW2019/dsh-unwrapped`）。如果仓库放到别处，记得同步改 `package.json`。

## 3. 发布

```bash
npm publish          # publishConfig.access=public 已设好，不需要 --access
npm view dsh-unwrapped version dist.tarball
```

升级：`npm version patch|minor|major` 会改版本号并打 git tag，然后 `npm publish`。

> **staged publish 的坑**：如果 token 的 bypass 2FA 被回收，`npm publish` 不会报错，而是把
> 包**暂存**起来，并先上线一个 `0.0.0-stage` 占位版（描述是 "Temporary package placeholder
> for staged publishing"）。此时 `npm view dsh-unwrapped version` 会返回 `0.0.0-stage`，
> 而真实版本已存在于 `versions` 里但不在 `dist-tags` 中。
> 用 `npm stage list` / `npm stage approve <stage-id>` 处理（需要 npm CLI ≥ 11.15 且有 2FA）；
> 或者换一个勾了 Bypass 2FA 的 token 重新 `npm publish`。
> 2026-10-31 这次首发就撞上了：发生一次后 `latest` 已回到 `0.2.0`，占位版留下但不影响安装。

## 4. 发布后自检

```bash
npx dsh-unwrapped --help
npx dsh-unwrapped status
```

## 5. 用户怎么用

已发布，最快的装机方式是一行：

```bash
npx dsh-unwrapped install
```

也可以克隆仓库自己跑（离线环境和审计场景）：

```bash
git clone https://github.com/ErnestW2019/dsh-unwrapped.git
cd dsh-unwrapped
node bin/plugin.js install
```

其他形态：

```bash
# 指定 profile / 换语言 / 换按钮文案
npx dsh-unwrapped install --profile tui --language en --label "Wrapped"

# 全局安装
npm i -g dsh-unwrapped && dsh-unwrapped install

# 只要文件，不要 harness
npx dsh-unwrapped install --dry-run            # 只打印会做什么
npx dsh-unwrapped-report --period year --embed 13 --out unwrapped.html
```

装完重启一次 `dsh web`（改代码必须重启，改 config 才热加载），刷新 GUI 点右下角悬浮按钮，
或直接开 `http://127.0.0.1:8080/unwrapped`。

卸载：`npx dsh-unwrapped uninstall`（`--keep-files` 只摘 patch 行，保留插件目录）。

> **注意**：`dsh plugin add` 这条路走不通——它内部调 pnpm，没装 pnpm 的机器会直接失败
> （`dsh: pnpm failed in profile directory ...`）。本插件不需要 pnpm，安装器只做文件拷贝
> 和 patch 行维护。

## 6. 发布后值得跟进的动作

- **上目录**：`dsh-plugin-catalog`（7700+ 条目，`awesome-dsh-plugin.com`）和 `dshmarket`
  这两个市场是 DSH 用户真正逛的地方；被收录才有自然流量。关键词用 `wrapped` / `年度报告` /
  `conversation analytics`。
- **README 首图**：npm 页面只认包内相对路径 —— `docs/preview-year.png` 已加进 `files`，
  所以首图能显示；`docs/preview-*.html` 不在包里，链接要写成仓库链接。
- **和占名包的关系**：`dsh-plugin-rewind@0.0.0` 如果有内容，别去撞名；必要时在 README 里写一句
  「本插件不是 /rewind 回滚工具」防止误解。
