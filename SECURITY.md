# Security Policy

## 支持范围

只有最新发布版本接收安全修复。

| 版本 | 支持 |
| --- | --- |
| 0.2.x | ✅ |
| < 0.2 | ❌ |

## 报告漏洞

请**不要**开公开 issue。用 GitHub 的私密报告入口：

<https://github.com/ErnestW2019/dsh-unwrapped/security/advisories/new>

或在仓库 Security 标签页点 "Report a vulnerability"。

请包含：受影响版本、复现步骤、影响判断（能否读到本机日志之外的数据 / 能否被远程触发）。
通常 3 个工作日内回复。

## 威胁模型

这个插件的设计前提是「数据不出本机」，所以威胁模型很窄，说明清楚比笼统承诺更有用：

**在范围内**

- 读取了预期之外的会话数据（例如越出 `$DSH_HOME/sessions`、读到别的用户目录）。
- 报告页或 JSON API 可被非回环地址访问，导致局域网内其他人看到你的会话标题与提问预览。
- 安装器（`bin/plugin.js`）越权改写 `cordis.patch.yml` 中不属于本插件的行，或写入预期之外的路径。
- 报告 HTML 里的 XSS：会话标题 / 用户提问被原样拼进 HTML 或 `<script>` 元数据块。
- 离线 CLI 处理恶意构造的 zstd / JSONL 文件时的崩溃或任意写。

**不在范围内**

- 你主动把导出的 HTML 或分享卡发到网上——那就是公开了。
- harness 自身（`ctx.sessionQuery`、`ctx.webServer`）的漏洞，请报给上游。
- 本机已被攻陷（同权限下的攻击者本来就能直接读日志）。
- 依赖问题——本包零运行时依赖，`devDependencies` 也未使用。

## 已知的隐私边界

- 插件不发起任何外部网络请求，不调用模型，不建数据库。
- JSON API 会返回会话标题、工作区路径和最多 3 条人类提问预览（每条 170 字）。
  默认路由只挂在 harness 的回环监听上；如果 harness 被配置成对外监听，这些内容也会对外可见。
  可用 `path` / `apiPath` 换成未公开路径，或 `launcher: false` 只用离线 CLI。
