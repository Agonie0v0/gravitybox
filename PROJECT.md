# GravityBox 工程架构总览

## 核心定位
GravityBox (`1.2.1`) 是面向 macOS 14+ (Apple Silicon `arm64`) 的轻量级 Google Antigravity 正式版伴侣工具箱，提供**原生 AppKit / Node 后端 / HUD 全链路中英双语界面（跟随系统 / 简体中文 / English）**、零侵入式 IDE 双语热适配、输入框实时会话遥测 HUD（含 `2.34.0+` BTW 侧边提问分栏）、SSH 远程窗口零外部 `ssh` 适配、双周期/多池配额监控、多账号四阶段原子切换与同源 `agy` CLI 凭据同步、本机 + SSH 统一只读 SQLite 用量与时序计费核算、HTTP/HTTPS 网络代理管理及非破坏性缓存维护；并从 `1.2.1` 起通过 `src/platform/` 与 `windows/` 同仓隔离提供社区共建的 Windows x64 支持（`#27`、`#30`、`#32`，致谢 `@Agonie0v0` 贡献实现并完成真机验收，由独立 `package-windows.yml` 产出预构建自包含 `.zip` 与 `-setup.exe`，随 `v1.2.1` 通过 GitHub Releases 同步分发，终端用户无需自行构建）。

## 目录与模块分工
- `native/`：macOS 原生 AppKit 前端（常驻菜单栏浮窗 `MenuFloatingPanel`、5 页主控制台 `Overview / Accounts / Usage / Settings / About`、多主机视图 `SshEnvironment.swift`、代理配置与状态探测 `SystemProxy.swift`、`L10n.swift` 本地化运行时、进程守护与自更新校验）
- `src/`：Node 22 / TypeScript 核心后端（CDP 注入控制、应用级双语引擎 `i18n.ts`、四阶段切号与同源 `agy` CLI 同步、双周期/多池配额聚合、`sqlite-worker` 只读投影、时序计费与重估、SSH 远程适配 `ssh-context.ts` / `ssh-remote-rpc.ts`、多环境账本增量同步 `remote-usage-sync.ts`、代理注入与覆盖检测 `proxy.ts`、`src/hud/` HUD 引擎与 `cortex-status.ts` 枚举真源、`src/platform/` 跨平台底座与 IPC 服务）
- `windows/`：同仓隔离的 Windows x64 社区共建端，包含原生 Rust Win32 助手（`win-helper/`）与 Tauri 2 / React 19 桌面客户端及托盘面板（`app/`），不计入 macOS 发布指纹
- `runtime/`：注入 Isolated World 的零侵入 DOM 观察引擎（`engine.js`）与双语会话遥测 HUD 实例（`hud-manager.js` / `hud-i18n.js` / `hud-instance.js` / `hud-popover.js` / `hud-styles.js`）
- `dict/` & `ui-strings/`：分层词典与基于官方正式版 SHA-256 指纹提取的界面文案基准（覆盖 `2.23.0` ~ `2.34.0`，`2.35.0+` 提供自适应兼容回退）
- `assets/`：图标、应用级双语语言包（`i18n/en.json` / `i18n/zh-Hans.json`）、实机截图、公开模型目录与时序定价基准（`model-catalog.json` / `pricing-feed.json`）
- `tools/`：构建（`clean-dist` / `copy-runtime`）、价格同步（`sync-pricing-feed`）、隐私与文档门禁（`check-privacy` / `check-docs` / `release-integrity`）、全量门禁（`verify`）、macOS DMG 打包（`package-mac`）及独立 Windows 打包脚本（`package-win.mjs` / `gravitybox-win.nsi`）
- `test/`：Node 单元与集成测试、中英双语基础/原生测试（`i18n-foundation` / `native-i18n`）、跨平台隔离测试（`windows-platform`）、无头 Chromium 浏览器回归（`test/browser.mjs`）及原生 Swift AppKit 布局断言（`test/native-ui.swift`）

## 双端架构与发布指纹解耦
- **macOS 原生主线（作者主导并实机验收）**：通过 `native/`（Swift 6 / AppKit）与内置 `arm64` Node 22 通信（Unix Domain Socket IPC），由 `tools/release-integrity.mjs` 的 `sourceDigest` 严格守卫；Windows 端代码（`windows/` 与 `tools/*win*` 等）**不计入** `sourceDigest`。
- **Windows x64 社区共建端（`@Agonie0v0` 贡献并完成真机验收）**：通过 `src/platform/` 统一收口平台路径/文件系统/Named Pipe IPC/Win32 助手调用，结合 `windows/win-helper` 与 `windows/app` 运行；使用独立 `windowsSourceDigest`、非阻塞 `.github/workflows/ci-windows.yml` 及手动 `package-windows.yml`（生成自包含 `.zip` 与用户级 NSIS `-setup.exe`），绝不阻塞 macOS 门禁与发版。
