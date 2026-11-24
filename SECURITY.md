# 安全策略与漏洞通报 (Security Policy)

GravityBox 高度重视用户的数据安全与隐私保护。作为一款涉及本地账号凭据管理与系统级辅助功能的工具箱，我们采取了多层次的安全与隐私隔离设计。

---

## 1. 受支持的版本 (Supported Versions)

我们仅针对最新稳定主版本提供安全更新与补丁支持：

| 版本 | 是否支持安全更新 |
| :--- | :--- |
| `1.2.x` | :white_check_mark: 当前维护版本 |
| `1.1.x` | :warning: 建议升级至 `1.2.x` |
| `1.0.x` | :warning: 建议升级至 `1.2.x` |
| `< 1.0.0` | :x: 已终止支持（请升级至最新版本） |

---

## 2. 漏洞提报渠道 (Reporting a Vulnerability)

**请切勿通过公开的 GitHub Issue 提报安全漏洞！**

如果你在 GravityBox 中发现了安全漏洞或潜在的凭据泄漏隐患，请通过以下安全渠道联系维护者：

1. **GitHub Private Vulnerability Reporting**（首选）：
   前往仓库的 **Security** -> **Advisories** -> **Report a vulnerability** 页面，在线提交加密漏洞报告。
2. **私密邮件沟通**：
   发送详细报告至项目维护者邮箱：[enzoo404@users.noreply.github.com](mailto:enzoo404@users.noreply.github.com)

### 提报内容建议包含：
- 漏洞类型与详细描述（如凭据隔离失效、IPC 未授权执行、未脱敏日志泄露等）；
- 复现步骤、概念验证代码（PoC）或环境上下文；
- 影响评估与潜在的利用场景；
- 建议的修复方案（若有）。

---

## 3. 漏洞响应与披露流程 (Response Process)

1. **初步确认**：在收到报告后的 **48 小时** 内，我们将确认收到报告并展开初步技术验证。
2. **漏洞修复**：经确认的安全漏洞将由核心维护者在私有安全分支中开发并经过回归验证。
3. **安全发版与致谢**：修复完成后，我们将发布包含安全补丁的正式版本，并在安全公告（Security Advisory）中向报告者公开致谢（经报告者同意）。

---

## 4. 核心安全架构说明 (Security Principles)

GravityBox 在架构层遵循以下核心安全保障机制：

- **零外部遥测与外联声明**：应用绝不在后台发起未经许可的第三方遥测、分析或数据收集请求；自动更新与模型价格同步默认关闭，仅在用户明确启用或手动点击检查时请求 GitHub Releases 及公开价格源（GitHub Raw 与 `cdn.jsdelivr.net` 回退域名）。
- **本机凭据存储与访问限制**：
  - **macOS 主线**：账号库位于 `~/Library/Application Support/GravityBox`。账号文件 `accounts/<id>.json` 包含未加密的 OAuth 凭据（包括 Access Token、Refresh Token）；应用以 `0600` 权限创建账号文件及相关原子写入文件，限制为当前用户可读写。macOS Keychain 用于读取或写入 Antigravity 登录态，并非账号库凭据的唯一存储位置。文件权限不等同于加密，也不能阻止以当前用户身份运行且具有文件访问权限的程序或管理员读取凭据。
  - **Windows x64 社区端**：持久数据位于 `%APPDATA%\GravityBox`（缓存位于 `%LOCALAPPDATA%\GravityBox\Cache`，日志位于 `%LOCALAPPDATA%\GravityBox\Logs`）；OAuth 凭据通过 Windows Credential Manager（受 `2560` 字节容量边界校验与缓冲区清零约束）及 `gravitybox-win-helper.exe` 严格按当前用户上下文读写；回收站清理经 COM `IFileOperation` 移入回收站并拦截盘符根目录、系统目录、通配符与 UNC 路径；进程优雅退出遵循 UIPI 与同用户 SID 边界，默认不强杀官方进程。
- **IPC 深度脱敏与桌面外壳安全边界**：前端进程（macOS Native / Windows Tauri）与后端 Node 控制器之间严格进行敏感字段清洗与权限校验；macOS 走本地 Unix Domain Socket，Windows 使用每启动随机名称的 Named Pipe、256-bit `authToken` 及服务端同用户 SID / 完整性级别校验；`windows/app` Tauri 外壳遵循最小权限 `capabilities`、严格 CSP、`withGlobalTauri: false`、禁止向 `state_dir` 写入用户导出文件，并将外部链接限制在 `https://` 与官方白名单域名（`github.com`、`raw.githubusercontent.com`、`cdn.jsdelivr.net`、`accounts.google.com`）。
- **恢复记录与归档脱敏**：当前切号恢复记录可能保留恢复所需的登录凭据；历史切号归档对 OAuth 令牌、钥匙串内容和账号文件等敏感字段作脱敏处理。用户数据目录及含凭据备份不得加入公开源码、安装包或公开问题附件；备份、同步或分享这些文件时应按敏感凭据处理。
