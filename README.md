<div align="center">
  <a href="https://github.com/Enzoo404/gravitybox">
    <img src="assets/master-1024.png" alt="GravityBox Logo" width="80" height="80" />
  </a>

  <h1>GravityBox</h1>

  <p>
    <strong>面向 Google Antigravity 的跨平台增强伴侣（macOS Apple Silicon 原生主线 · Windows x64 社区共建端）</strong><br />
    零改包双语适配 · 输入框 Telemetry HUD · 双周期配额账单 · 多账号安全切换 · 可撤回缓存瘦身
  </p>

  <p>
    <a href="https://github.com/Agonie0v0/gravitybox/releases/latest"><img src="https://img.shields.io/github/v/release/Agonie0v0/gravitybox?style=flat-square&color=2563EB" alt="Latest Windows Release"></a>
    <a href="https://github.com/Agonie0v0/gravitybox/actions/workflows/ci-windows.yml"><img src="https://img.shields.io/github/actions/workflow/status/Agonie0v0/gravitybox/ci-windows.yml?branch=main&style=flat-square&logo=github&label=Windows%20CI" alt="Windows CI Status"></a>
    <img src="https://img.shields.io/badge/macOS-14%2B%20%C2%B7%20Apple%20Silicon-111827?style=flat-square&logo=apple&logoColor=white" alt="macOS 14+ Apple Silicon">
    <img src="https://img.shields.io/badge/Windows-10%2F11%20%C2%B7%20x64-0078D4?style=flat-square&logo=windows&logoColor=white" alt="Windows 10/11 x64">
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-10B981?style=flat-square" alt="MIT License"></a>
  </p>

  <p>
    <b>简体中文</b> · <a href="./README_EN.md">English</a>
  </p>

  <p>
    <a href="#windows-适配版">Windows 适配版</a> ·
    <a href="#概览">概览</a> ·
    <a href="#平台支持与验收边界">平台支持</a> ·
    <a href="#快速上手">快速上手</a> ·
    <a href="#对话状态栏-hud">对话状态栏 HUD</a> ·
    <a href="#界面与核心机制">界面与机制</a> ·
    <a href="#安装与升级">安装与升级</a> ·
    <a href="#安全与隐私边界">安全边界</a> ·
    <a href="#架构与源码构建">源码构建</a>
  </p>
</div>

> [!NOTE]
> **个人增强分叉版（`Agonie0v0/gravitybox`，`v1.2.2-win`）** — 已同步上游 [Enzoo404/gravitybox](https://github.com/Enzoo404/gravitybox) `v1.2.2` 全量更新（双端统一账号信息隐私遮挡、删号静默清理恢复快照、Windows 关闭确认与 `EXDEV` 跨卷重试加固），并额外保留以下个人增强能力：
> - **被动周配额客户端归因**：零新增网络请求，仅基于本地用量账本与既有配额快照被动估算「本端（含同账号 SSH） vs. 其他客户端」在每周配额池中的消耗占比，并隐藏等效 USD 金额展示。
> - **用量统计增强**：新增回复流式输出速率（近 10 次回复中位数 `tok/s` 与明细单条速率）、模型 × 思考强度分档拆解（`Minimal` / `Extra Low` / `Low` / `Medium` / `High` / `XHigh` / `Max` / `Thinking`）以及自定义日期范围查询与导出。
>
> - **Windows 下载安装**：前往 [GitHub Releases](https://github.com/Agonie0v0/gravitybox/releases/latest) 下载用户级免 UAC 安装包（`GravityBox-<version>-win-x64-setup.exe`）或自包含便携压缩包（`GravityBox-<version>-win-x64.zip`）及对应 `.sha256` 校验文件。
> - **Windows 本地热重载开发**：
>   - `npm run dev:win` — 全栈 Windows 开发模式（Vite 前端 HMR + Tauri Rust 自动重编译重启 + 后端 `tsc --watch`）。
>   - `npm run dev:backend` — 后端热重载模式（`tsc --watch` + `runtime/` 监听 + `node --watch dist/main.js` 自动重启）。
>   - `npm run verify` / `npm run package:win` / `npm run package:win:installer` — 全量门禁校验与自包含便携包 / NSIS 安装包构建。
>
> <a id="windows-适配版"></a>

<br />

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/hero-dark.png" />
    <img src="assets/screenshots/hero.png" alt="GravityBox 主控制台与常驻菜单栏浮窗" width="100%" />
  </picture>
  <sub><em>macOS 原生主控制台与菜单栏浮窗（Swift 6 / AppKit，跟随深浅色模式）— Windows x64 端提供功能对等的 Tauri 2 / React 控制台与系统托盘浮窗</em></sub>
</div>

---

## 概览

**GravityBox**（`GravityBox v1.2.2`）是一款专为 **Google Antigravity** 官方正式版打造的轻量级、零侵入、重隐私伴侣工具箱，覆盖 **macOS**（Apple Silicon 原生预构建主线，同时支持 Intel `x86_64` 本机源码构建）与 **Windows x64**（社区共建端，提供免编译安装与便携包）。各端共享同一套内置 Node 22 核心引擎，全程通过本机回环 CDP 与只读 SQLite 事务工作，绝不解包、篡改或重签名官方应用包。

| 核心能力 | 解决什么问题 |
| :--- | :--- |
| **零改包双语适配** | 运行时动态切换简体中文与英文界面（词典指纹已覆盖 `2.23.0`–`2.34.0`，`2.35.0+` 自动进入自适应兼容模式），同时严格保护对话内容、代码块、Diff、CSV 视口、LSP 引用与 Notebook 代码/输出区不被改动。 |
| **对话状态栏 (HUD)** | 在每个聊天输入框正下方嵌入三联遥测条，实时展示轮次用时、输出速度、Token 消耗、缓存命中率、压缩次数与上下文水位。 |
| **双周期配额与账单** | 将 **5 小时** 滚动限额、**每周** 限额与独立高阶池（如 `Gemini 4 Argon`）拆开展示；汇总页自动合并同一模型的各思考档位变体（`-low` 至 `-max`），并按时序官方单价核算等效 API 费用。 |
| **SSH 远程窗口与统一账本** | 无需调用外部 `ssh` 进程即可适配 Antigravity `2.33.0+` SSH 远程窗口（双语界面、实时 HUD、按主机只读配额），并将本机与 SSH 会话用量统一合账且支持「环境 × 账号」正交筛选。 |
| **免 TUN HTTP(S) 代理** | 支持 **关闭**、**自动跟随系统代理**（macOS / Windows 系统设置）或 **手动指定** `http://` / `https://` 代理地址，无需开启 TUN 模式即可为 Antigravity 注入代理环境变量、让 GravityBox 后台外联复用同一代理，并检测 Shell 覆盖冲突。 |
| **多账号、隐私遮挡与 CLI 同步** | 支持保存当前会话、JSON 批量导入与确认后备份导出（macOS 锁定 `0600`）、一键账号隐私遮挡（`⇧⌘M` / `Ctrl+Shift+M`）、删号静默清理切号恢复快照、低配额智能推荐、同源 `agy` CLI 凭据非侵入同步，以及四阶段原子安全切换与异常自动回滚。 |
| **可撤回缓存瘦身** | 仅清理无状态运行缓存与可选超期后台日志（清理前归档账单），统一移入 macOS 废纸篓或 Windows 回收站（`IFileOperation`）并支持一键原位还原，登录凭据与聊天正文受白名单隔离保护。 |

---

## 平台支持与验收边界

| 目标平台 | 前端与系统助手 | IPC 与凭据机制 | 分发产物与验收状态 |
| :--- | :--- | :--- | :--- |
| **macOS 14+ (Apple Silicon `arm64`)** | 原生 **Swift 6 / AppKit** 五页主控制台与 `MenuFloatingPanel`（`native/`） | Unix Domain Socket IPC · macOS 钥匙串与 `0600` 本地文件 | **原生主线（作者已实机验收）**：通过 [GitHub Releases](https://github.com/Enzoo404/gravitybox/releases/latest) 直接下载预构建 `GravityBox-<version>-arm64.dmg` |
| **macOS 14+ (Intel `x86_64`)** | 同源原生 **Swift 6 / AppKit** 五页主控制台与 `MenuFloatingPanel`（`native/`） | Unix Domain Socket IPC · macOS 钥匙串与 `0600` 本地文件 | **本机源码构建支持**：按宿主架构构建校验并提供防跨架构误装保护，源码目录运行 `npm ci && npm run package:mac` 即可生成本机 `.app` 与 `.dmg` |
| **Windows 10/11 (x64)** | **Tauri 2 / React 19** 五页控制台与系统托盘面板（`windows/app/`）+ 静态链接 Rust Win32 助手（`windows/win-helper/`） | 每启动随机 Named Pipe（256-bit `authToken`、同用户 SID 与完整性校验）· Windows Credential Manager（2560 字节容量边界与内存清零） | **社区共建端（已实机验收）**：通过 [GitHub Releases](https://github.com/Enzoo404/gravitybox/releases/latest) 提供预构建自包含 `-setup.exe` 与便携 `.zip`（免编译开箱即用） |

---

## 快速上手

> GitHub Releases 的 macOS 预构建包目前仅面向 Apple Silicon（`arm64`）。Intel（`x86_64`）用户可[从源码在本机验证并打包](#架构与源码构建)。

### macOS（原生主线 · Apple Silicon / Intel 源码构建）

1. **下载与安装**：Apple Silicon 用户前往 [GitHub Releases](https://github.com/Enzoo404/gravitybox/releases/latest) 获取最新 `GravityBox-<version>-arm64.dmg`（Intel 用户见下方[源码构建](#架构与源码构建)），将 **GravityBox.app** 拖入 **Applications**。因开源版本未经过 Apple 付费公证，首次运行前在终端执行一次放行命令即可（也可在「系统设置 → 隐私与安全性」点击仍要打开）：
   ```bash
   xattr -cr /Applications/GravityBox.app
   ```
2. **启动并连接**：打开 **GravityBox**，通过侧栏或菜单栏点击 **「打开 Antigravity」**，或在 **设置 → 启动时自动打开 Antigravity** 开启后，打开 GravityBox 自动驻留菜单栏并拉起带调试端口的 Antigravity。若 `2.33.0+` 客户端是从外部直接启动且未开启调试端口，面板会弹出「未开启调试端口」横幅，点击 **「安全重启以连接」** 即可直接优雅重启并挂载（不在后台强杀进程）。
3. **日常协作**：写代码时直接看输入框下方 **HUD**；查额度/快速切号直接唤起 **菜单栏浮窗**（支持 `⌘1/2/3` 快捷键与全屏跨空间展示）；深度分析与整理打开 **主控制台**（总览 · 账号 · 用量 · 设置 · 关于）。

### Windows x64（社区共建端）

1. **直接下载（无需自行打包构建）**：前往 [GitHub Releases](https://github.com/Enzoo404/gravitybox/releases/latest) 直接下载开箱即用的自包含产物——`GravityBox-<version>-win-x64-setup.exe`（用户级安装程序，默认安装到 `%LOCALAPPDATA%\Programs\GravityBox`，无需管理员权限）或 `GravityBox-<version>-win-x64.zip`（便携包，解压即用），已内置 Node 22 与 Win32 助手，**普通用户无需自己运行编译或打包命令**。
2. **启动并连接**：运行 `GravityBox.exe`（需 Windows 10/11 x64 及系统 WebView2 运行时）。通过侧栏或系统托盘菜单点击 **「打开 Antigravity」**，或开启 **设置 → 启动时自动打开 Antigravity**。若外部启动的 Antigravity 未开启调试端口，点击横幅 **「安全重启以连接」** 即可优雅重启（严格遵守 Windows UIPI 与同用户 SID 边界，绝不静默调用 `TerminateProcess` 强杀官方编辑器）。
3. **日常协作**：在 Antigravity 内直接查看 **HUD**；点击 **系统托盘浮窗** 快速浏览额度、用量与切换账号；打开 **主控制台**（总览 · 账号 · 用量 · 设置 · 关于）进行多账号与账单管理。

---

## 对话状态栏 (HUD)

HUD 挂载于每个 Antigravity 对话输入框下方（含 `2.34.0+` 的 BTW 侧边提问独立分栏，且自动去重克隆前缀用量），支持分栏独立状态且不抢占输入焦点。

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/hud-dark.png" />
    <img src="assets/screenshots/hud.png" alt="IDE 对话状态栏与向上展开卡片" width="94%" />
  </picture>
</div>

<br />

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/hud-capsules-dark.png" />
    <img src="assets/screenshots/hud-capsules.png" alt="IDE 输入框下方三枚常驻 HUD 胶囊特写" width="82%" />
  </picture>
</div>

| 位置 | 示例读数 | 说明 |
| :--- | :--- | :--- |
| **1. 对话与速度** | 灰 / 实心蓝 / 呼吸蓝圆点 + `3 轮 · 本轮 18s · 90 tok/s · 2` | 状态灯指示当前前台活动（**灰** 空闲或仅后台子智能体运行，**实心蓝** 模型思考/输出，**呼吸蓝** 工具调用）；右侧依次为轮次、当前轮用时、平均吐字速度及并行子智能体数量。 |
| **2. Token 与缓存** | `58.6M tok · 缓存命中 97%` | 本会话（含关联子智能体）累计消耗总 Token 及输入缓存复用比例。 |
| **3. 上下文水位** | 压缩徽章 (`1` / `2` / `3+`) + 模型短标 + 进度条 (`66%`) | 发生自动压缩后才显现对应颜色角标；多模型或编排场景显示当前模型简称；未返回精确容量时带 `~` 按参考上限估算。 |

### 向上展开详情卡片

悬停或点击任意胶囊可弹出明细卡片（`Esc` 或点击空白处收起）：

<table>
  <tr>
    <td width="33.3%" align="center">
      <b>对话统计</b><br /><br />
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/hud-card-session-dark.png" />
        <img src="assets/screenshots/hud-card-session.png" alt="对话统计明细卡片" width="100%" />
      </picture>
    </td>
    <td width="33.3%" align="center">
      <b>Token 用量</b><br /><br />
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/hud-card-tokens-dark.png" />
        <img src="assets/screenshots/hud-card-tokens.png" alt="Token 用量明细卡片" width="100%" />
      </picture>
    </td>
    <td width="33.3%" align="center">
      <b>当前上下文</b><br /><br />
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/hud-card-context-dark.png" />
        <img src="assets/screenshots/hud-card-context.png" alt="当前上下文与曾用模型上下文卡片" width="100%" />
      </picture>
    </td>
  </tr>
</table>

<details>
<summary>卡片指标补充与编排器上下文追踪</summary>

- **对话统计**：拆分模型与工具累计耗时（自动合并并行工具重叠时间），展示全局平均与最近一步的 TTFT / TPS，以及子智能体运行步数。
- **Token 用量**：细分为未缓存输入、缓存读取、缓存写入与输出（模型支持时自动拆分 `思维链 / 回复`），并按当时生效费率折算等效 API 费用与缓存节省金额（含未公开定价模型时显示 `≥ $X`）。
- **当前上下文**：单行标题融合当前模型名与角色徽章（`规划` / `执行`），配合双色进度条（缓存复用 vs. 本步新增输入）、本步输出与模型历史峰值，并以统一磨砂中性灰胶囊在 **曾用模型上下文** 列表展示切换过的模型水位与压缩次数（通过 `executor_metadata` 增量扫描在对话回退/截断场景下保留历史编排器角色）。

</details>

---

## 界面与核心机制

> *以下截图摄于已实机验收的 macOS 原生端（Swift 6 / AppKit）。Windows x64 端（Tauri 2 / React）已同步实现功能对等的五页主控制台（总览 · 账号 · 用量 · 设置 · 关于）与系统托盘面板（已由社区完成真机验收，Windows 实机截图后续补充）。*

<table>
  <tr>
    <td width="50%" align="center">
      <b>总览</b><br /><br />
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/dark-overview.png" />
        <img src="assets/screenshots/overview.png" alt="GravityBox 总览看板" width="100%" />
      </picture>
    </td>
    <td width="50%" align="center">
      <b>账号</b><br /><br />
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/dark-accounts.png" />
        <img src="assets/screenshots/accounts.png" alt="GravityBox 账号管理" width="100%" />
      </picture>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <b>用量与费用</b><br /><br />
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/dark-usage.png" />
        <img src="assets/screenshots/usage.png" alt="GravityBox 用量明细" width="100%" />
      </picture>
    </td>
    <td width="50%" align="center">
      <b>设置</b><br /><br />
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/dark-settings.png" />
        <img src="assets/screenshots/settings.png" alt="GravityBox 偏好设置" width="100%" />
      </picture>
    </td>
  </tr>
</table>

<details>
<summary>展开更多截图：常驻菜单栏浮窗、存储与维护、关于页面</summary>
<br />
<table>
  <tr>
    <td width="33.3%" align="center">
      <b>菜单栏 · 用量</b><br /><br />
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/dark-menubar.png" />
        <img src="assets/screenshots/menubar.png" alt="菜单栏用量浮窗" width="100%" />
      </picture>
    </td>
    <td width="33.3%" align="center">
      <b>菜单栏 · 配额</b><br /><br />
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/dark-menubar-quota.png" />
        <img src="assets/screenshots/menubar-quota.png" alt="菜单栏配额浮窗" width="100%" />
      </picture>
    </td>
    <td width="33.3%" align="center">
      <b>菜单栏 · 账号</b><br /><br />
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/dark-menubar-accounts.png" />
        <img src="assets/screenshots/menubar-accounts.png" alt="菜单栏账号浮窗" width="100%" />
      </picture>
    </td>
  </tr>
  <tr>
    <td colspan="2" align="center">
      <b>存储与维护（废纸篓清理与原位还原）</b><br /><br />
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/dark-maintenance.png" />
        <img src="assets/screenshots/maintenance.png" alt="存储与维护弹窗" width="90%" />
      </picture>
    </td>
    <td align="center">
      <b>关于与更新</b><br /><br />
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/dark-about.png" />
        <img src="assets/screenshots/about.png" alt="关于与更新" width="100%" />
      </picture>
    </td>
  </tr>
</table>
</details>

### v1.2.2 核心机制说明

- **账号信息隐私遮挡与删号快照静默清理**：在 **总览**、**账号** 与菜单栏 / 托盘浮窗旁提供纯图标小眼睛一键切换与眨眼/淡入动效（遵守系统减少动态效果设置），支持全局快捷键（macOS `⇧⌘M` 与「显示」菜单项，Windows `Ctrl+Shift+M`）；同步脱敏昵称（`首字 + •••`）与邮箱，覆盖账号卡片、推荐横幅、SSH 伴随行、用量筛选下拉框、请求明细、切号/删号确认弹窗、辅助功能标签、弹窗内联报错及全局 Toast 提示（总览页右键仍可复制完整原邮箱，重命名输入框保留原昵称）。删除账号时后台自动清空 `account-switch-journal-stable.json` 中命中该账号的切号凭据与文件快照（含 `go-keyring-base64:` 与双层 Base64 Protobuf `userStatus`，中断待恢复事务跳过保护），停止写入 `accounts-removed/` 并清理对应历史留档。
- **macOS Intel (`x86_64`) 本地源码构建与更新架构保护**：按宿主架构统一解析 Swift 编译目标，支持 `lipo` 单架构一致性校验（主程序与内置 Node）、按架构下载无头测试浏览器及关于页右键复制环境架构标签；应用内更新仅接受当前编译架构安装包防止跨架构误装（GitHub Releases 仅自动分发 `arm64` 成品，Intel 端由本机源码验证打包）。
- **启动自动连接、进程隔离与无强杀安全重启**：开启 **设置 → 启动时自动打开 Antigravity** 后，打开 GravityBox 自动静默驻留菜单栏 / 系统托盘并拉起带 `--remote-debugging-port=0` 的 Antigravity；外部直接启动未开调试端口时通过 **「安全重启以连接」** 优雅退出重连（Windows 端严格遵循 UIPI / 同用户 SID 边界，不后台强杀），并在切号、回滚与维护期间隔离 `chrome_crashpad_handler` 及已脱离主进程树的后台守护进程（`language_server` / `sidecar`）。
- **SSH 远程窗口零外部 `ssh` 适配与本机 + SSH 统一账本**：经本机 CDP 通道直接适配 Antigravity `2.33.0+` SSH 远程窗口（不拉起外部 `ssh` 进程），提供双语热适配、实时 HUD、与本机隔离的 `本机 / SSH: <host>` 只读配额查看及活跃 SSH 保护提醒；增量同步远端会话至本地只读 SQLite 账本（按轨迹 ID 去重、按时间线归属账号），提供合并总览、`本机 % · SSH %` 占比条与「环境 × 账号」正交筛选。
- **BTW 侧边提问分栏、`2.34.0` 目录与视图防误译保护**：独立观测 `2.34.0+` BTW 侧边提问分栏 HUD 并在用量核算中自动去重克隆前缀生成记录，完整覆盖 `2.34.0` 词典与 `gemini-2.5-pro` `>200K` 阶梯定价（`2.35.0+` 自适应兼容），同时对代码查看、Diff、CSV 视口、LSP 引用与 Notebook 代码/输出区提供防误译保护。
- **免 TUN HTTP / HTTPS 网络代理**：在 **设置** 中选择 **关闭**、**跟随系统代理** 或 **手动配置** `http://` / `https://` 代理（不支持 PAC 与 SOCKS5），无需开启 TUN 模式即可在启动 Antigravity 时自动注入 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`、让受控外联复用同一代理，并实时检测代理不匹配或 Shell 覆盖冲突。
- **JSON 批量管理、`agy` CLI 同步与 `2.34.0+` 备用账号配额追踪**：集成保存当前账号、JSON 批量导入（按邮箱去重）与确认后备份导出（macOS 锁定 `0600`），切号与回滚时非侵入同步同源 `antigravity-oauth-token` 与 `jetski-standalone-oauth-token`（不干扰 `@google/gemini-cli`）。针对 `2.34.0+` 单一活跃会话限制，当前账号保持免密实时刷新；未激活备用账号在过期前自动补刷、过期后静默跳过并按重置时间标示 **「预计已重置」** 供智能推荐参考，切回时自动同步最新余额。
- **思考档位折叠、价格表热同步与独立双语/HUD 开关**：汇总视图自动合并同一基座模型的 `-low`～`-max` / `-tiered` 变体（请求明细保留原始标识）；支持通过 GitHub Raw / jsDelivr 在线热同步公开定价表（带 `ETag` 与 SHA-256 校验）；在设置或浮窗随时热切换 **跟随系统 / 简体中文 / English**，切回官方英文时仍可独立保持英文 HUD。

---

## 安装与升级

- **macOS（原生主线）**：macOS 14 (Sonoma) 或更高版本、官方正式版 `/Applications/Antigravity.app`（不支持也不干扰 Insiders 预览版），内置运行环境、零外部依赖。
  - SHA-256 校验（可选）：`shasum -a 256 -c GravityBox-<version>-arm64.dmg.sha256`
  - 无损升级：退出旧版 GravityBox 后将新版拖入 `/Applications` 替换，或在 **关于** 页检查更新（默认关闭后台检查）。
  - GitHub Releases 提供 Apple Silicon（`arm64`）DMG；Intel（`x86_64`）用户在源码目录运行 `npm ci && npm run verify && npm run package:mac`，再安装本地产出的 DMG（升级时拉取新版源码重新构建）。
- **Windows x64（社区共建端）**：Windows 10/11 x64（需系统 WebView2 运行时）及官方正式版 Antigravity；通过 [GitHub Releases](https://github.com/Enzoo404/gravitybox/releases/latest) 直接提供开箱即用的自包含安装版（`GravityBox-<version>-win-x64-setup.exe`）与便携版（`GravityBox-<version>-win-x64.zip`，均附 `.sha256` 校验文件），**普通用户无需自行编译打包**。
  - PowerShell 校验（可选）：`Get-FileHash GravityBox-<version>-win-x64.zip -Algorithm SHA256`
- **本地数据与缓存路径**：
  - macOS：状态库 `~/Library/Application Support/GravityBox`（缓存位于 `~/Library/Caches/GravityBox`）
  - Windows：状态库 `%APPDATA%\GravityBox`（缓存位于 `%LOCALAPPDATA%\GravityBox\Cache`，日志位于 `%LOCALAPPDATA%\GravityBox\Logs`）

<details>
<summary>进阶可选：为过期备用账号配置后台云端刷新凭据</summary>

日常使用（多账号切号、当前账号实时配额、HUD 状态栏、用量账单与汉化）无需此配置。仅当需要未激活备用账号在过期后继续自动拉取云端配额时，才需在 `~/Library/Application Support/GravityBox/.env`（macOS）或 `%APPDATA%\GravityBox\.env`（Windows）中写入兼容的 OAuth 客户端凭据：

```bash
GRAVITYBOX_GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
GRAVITYBOX_GOOGLE_CLIENT_SECRET="your-client-secret"
```

</details>

---

## 安全与隐私边界

| 安全原则 | 工程实现 |
| :--- | :--- |
| **零遥测零上报** | 无第三方统计或崩溃上报 SDK，无后台静默外联请求；更新检查与价格同步默认均关闭。 |
| **不改动官方包** | 仅通过本机回环（`127.0.0.1`）CDP 隔离世界运行，不解包、不改写、不重签名官方 Antigravity 安装包或可执行文件。 |
| **用户内容隔离** | 输入框草稿、对话正文、代码块、Diff、CSV 视口、LSP 引用、Notebook 代码/输出区、终端输出、文件名与项目名由 DOM 选择器与白名单严格隔离。 |
| **本机隔离存储与 IPC 鉴权** | **macOS**：`~/Library/Application Support/GravityBox`（`0700`/`0600`）、Keychain 与 Unix Domain Socket IPC。<br/>**Windows**：`%APPDATA%\GravityBox`、Windows Credential Manager（2560 字节守卫与内存清零）、带 256-bit `authToken` 及同用户 SID/完整性校验的随机 Named Pipe、最小权限 Tauri CSP/URL 白名单、`IFileOperation` 回收站路径守卫及 UIPI 优雅退出边界。 |
| **隐私遮挡与删号清理** | 支持一键脱敏界面昵称、邮箱、确认框、报错/Toast 与辅助功能标签；删除账号时自动清理关联切号恢复凭据/快照及历史 `accounts-removed/` 留档，且不再写入新留档副本。 |

---

## 架构与源码构建

```mermaid
flowchart LR
  UI["桌面前端<br/>macOS: Swift 6 / AppKit · Win: Tauri 2 / React"] <-->|"macOS: UDS · Win: SID 鉴权 Named Pipe"| Core["核心引擎 (Node 22 / TypeScript)<br/>四阶段切号 · 只读 SQLite 账本 · 配额融合"]
  Core -->|"本机回环 CDP (零改包)"| IDE["官方正式版 Antigravity<br/>界面热汉化 · 对话状态栏 HUD"]
  Core -->|"只读快照 + 废纸篓 / 回收站还原"| Local["本机数据与凭据<br/>macOS App Support / Keychain · Win %APPDATA% / 凭据管理器"]
```

- **macOS 构建依赖**：Xcode Command Line Tools 与匹配构建架构（`arm64` 或 `x64`）的 Node.js `>=22.15.0 <23`。运行 `node tools/setup-test-browser.mjs` 准备固定版本的无头浏览器，也可指定 `CHROME_BIN`。
- **Windows 构建依赖**：Windows 10/11 x64、Node.js `>=22.15.0 <23`、Rust（`cargo` / `rustc`）、MSVC 与 WebView2 构建工具（构建 `.exe` 安装包另需 NSIS）。维护者与 CI 亦可通过手动运行 `Package Windows (Artifact Only)` 工作流直接产出预构建 Windows 测试包。

```bash
git clone https://github.com/Enzoo404/gravitybox.git
cd gravitybox
npm ci

npm test                # 编译 TS、校验价格资产并运行单元/集成测试
npm run check:swift     # Swift 6 AppKit 编译与布局检查（macOS）
npm run verify          # 全量发布门禁（TS + 单测 + 无头浏览器 E2E + Swift -O + 词典门禁）
npm run package:mac     # 按本机 macOS 架构（arm64 / x86_64）构建 .app 与 .dmg
npm run test:win        # 运行后端快测 + Win32 助手与 Tauri Rust 测试（Windows）
npm run package:win     # 构建 Windows 自包含 .zip（附加 --installer 生成 NSIS .exe）
```

<details>
<summary>仓库目录结构</summary>

```text
gravitybox/
├── native/       # Swift 6 / AppKit 主控制台、MenuFloatingPanel、双语运行时与更新器（macOS）
├── src/          # TypeScript 核心引擎（IPC、双语控制、四阶段切号、配额融合、SQLite 账本、HUD、platform/）
├── windows/      # 同仓隔离的 Windows x64 客户端（win-helper Rust Win32 助手 + Tauri 2 / React 桌面端）
├── runtime/      # CDP 注入脚本（DOM 增量翻译、保护守卫与双语 Telemetry HUD）
├── dict/         # 分层词典与本地覆盖配置
├── ui-strings/   # 各受支持正式版官方界面文案快照（2.23.0 – 2.34.0）
├── assets/       # 图标、i18n 语言包、模型目录、时序价格表与 macOS Retina 实机截图
├── test/         # 单元/集成、无头 Chromium 浏览器回归、跨平台隔离及原生 Swift UI 测试套件
└── tools/        # 发布完整性校验、隐私扫描、文档检查、截图生成、DMG 与 Windows 打包脚本
```

</details>

---

## 常见问题

<details>
<summary><b>为什么切号前需要先退出 Antigravity？</b></summary>

Antigravity 运行时会持续持有本地 SQLite（`state.vscdb`）与认证文件锁，后台强杀或覆写运行中的数据库文件存在损库与草稿丢失风险。GravityBox 先确认安全退出（仅使用优雅关闭），再执行四阶段快照切换并在异常时原位回滚，切号动作始终由你确认。

</details>

<details>
<summary><b>只想开启输入框 HUD，不汉化 Antigravity 可以吗？</b></summary>

可以。在 **设置 → 显示语言** 中选择 **English**，同时保持 **对话状态栏** 开关开启，Antigravity 将保持原生英文界面并在输入框下方展示英文 HUD。

</details>

<details>
<summary><b>如何卸载 GravityBox？</b></summary>

退出 GravityBox（官方 Antigravity 从未被修改过，无需额外还原）：
- **macOS**：将 `/Applications/GravityBox.app` 移入废纸篓即可；如无需保留历史账单与账号配置，再删除 `~/Library/Application Support/GravityBox`。
- **Windows**：运行卸载程序（或删除便携目录），如无需保留历史账单与账号配置，再删除 `%APPDATA%\GravityBox` 与 `%LOCALAPPDATA%\GravityBox`。

</details>

---

## 参与贡献、致谢与开源协议

提交代码或反馈请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)、[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)、[SECURITY.md](./SECURITY.md) 与 [CHANGELOG.md](./CHANGELOG.md)，欢迎在 [GitHub Issues](https://github.com/Enzoo404/gravitybox/issues) 提交讨论。

**致谢**：
- **贡献者**：`@Agonie0v0`、`@lvyandev`
- **交流社区**：感谢 [LINUX DO](https://linux.do/) 社区提供技术交流与开源分享平台。

<div align="center">
  <a href="https://star-history.com/#Enzoo404/gravitybox&Date">
    <img src="https://api.star-history.com/svg?repos=Enzoo404/gravitybox&type=Date" alt="Star History Chart" width="680" />
  </a>
</div>

<p align="center">
  <sub>基于 <a href="./LICENSE">MIT License</a> 开源 · 第三方许可见 <a href="./THIRD_PARTY_NOTICES.md">THIRD_PARTY_NOTICES.md</a> · 与 Google、Apple 或 Microsoft 官方无从属或背书关系。</sub>
</p>
