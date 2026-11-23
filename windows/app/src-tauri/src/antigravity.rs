use crate::ipc_pipe::strip_verbatim_prefix;
use serde::Serialize;
use serde_json::Value;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityInfo {
    pub install_dir: String,
    pub exe_path: String,
    pub installed: bool,
    pub version: String,
    pub running: bool,
    pub debug_port_ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeRelaunchResult {
    pub ok: bool,
    pub debug_port_ready: bool,
    pub message: String,
}

pub fn resolve_antigravity_dir() -> PathBuf {
    if let Ok(explicit) = std::env::var("GRAVITYBOX_ANTIGRAVITY_DIR") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return strip_verbatim_prefix(Path::new(trimmed));
        }
    }
    let mut candidates = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        if !local.trim().is_empty() {
            candidates.push(strip_verbatim_prefix(
                &PathBuf::from(local.trim()).join("Programs").join("Antigravity"),
            ));
        }
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        if !pf.trim().is_empty() {
            candidates.push(strip_verbatim_prefix(
                &PathBuf::from(pf.trim()).join("Antigravity"),
            ));
        }
    }
    for c in &candidates {
        if c.join("Antigravity.exe").is_file() {
            return strip_verbatim_prefix(c);
        }
    }
    candidates
        .into_iter()
        .next()
        .map(|p| strip_verbatim_prefix(&p))
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files\Antigravity"))
}

pub fn resolve_antigravity_exe() -> PathBuf {
    strip_verbatim_prefix(&resolve_antigravity_dir().join("Antigravity.exe"))
}

pub fn resolve_devtools_active_port_path() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        if !appdata.trim().is_empty() {
            return strip_verbatim_prefix(
                &PathBuf::from(appdata.trim())
                    .join("Antigravity")
                    .join("DevToolsActivePort"),
            );
        }
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        return strip_verbatim_prefix(
            &PathBuf::from(profile)
                .join("AppData")
                .join("Roaming")
                .join("Antigravity")
                .join("DevToolsActivePort"),
        );
    }
    PathBuf::from("DevToolsActivePort")
}

pub fn resolve_win_helper_exe(resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("GRAVITYBOX_WIN_HELPER_PATH") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            let p = strip_verbatim_prefix(Path::new(trimmed));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(res) = resource_dir {
        let clean_res = strip_verbatim_prefix(res);
        candidates.push(clean_res.join("gravitybox-win-helper.exe"));
        candidates.push(clean_res.join("resources").join("gravitybox-win-helper.exe"));
    }
    if let Ok(exe) = std::env::current_exe() {
        let clean_exe = strip_verbatim_prefix(&exe);
        if let Some(dir) = clean_exe.parent() {
            candidates.push(dir.join("gravitybox-win-helper.exe"));
            candidates.push(dir.join("resources").join("gravitybox-win-helper.exe"));
            // Dev mode: walk ancestors looking for repo `windows/win-helper/target/{release,debug}`
            for anc in dir.ancestors().take(8) {
                candidates.push(
                    anc.join("windows")
                        .join("win-helper")
                        .join("target")
                        .join("release")
                        .join("gravitybox-win-helper.exe"),
                );
                candidates.push(
                    anc.join("windows")
                        .join("win-helper")
                        .join("target")
                        .join("debug")
                        .join("gravitybox-win-helper.exe"),
                );
            }
        }
    }
    #[cfg(debug_assertions)]
    if let Ok(cwd) = std::env::current_dir() {
        let clean_cwd = strip_verbatim_prefix(&cwd);
        for anc in clean_cwd.ancestors().take(6) {
            candidates.push(
                anc.join("windows")
                    .join("win-helper")
                    .join("target")
                    .join("release")
                    .join("gravitybox-win-helper.exe"),
            );
            candidates.push(
                anc.join("windows")
                    .join("win-helper")
                    .join("target")
                    .join("debug")
                    .join("gravitybox-win-helper.exe"),
            );
        }
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| strip_verbatim_prefix(&p))
}

fn run_win_helper(helper_path: &Path, args: &[&str]) -> Result<Value, String> {
    let clean_helper = strip_verbatim_prefix(helper_path);
    let mut cmd = Command::new(&clean_helper);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .output()
        .map_err(|e| format!("无法执行 win-helper: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let first_line = stdout.lines().next().unwrap_or("").trim();
    if first_line.is_empty() {
        return Err("win-helper 未返回有效响应".to_string());
    }
    let val: Value = serde_json::from_str(first_line)
        .map_err(|e| format!("win-helper JSON 解析失败: {}", e))?;
    if val.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let err = val
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("win-helper 执行失败");
        return Err(err.to_string());
    }
    Ok(val)
}

pub fn parse_devtools_active_port(contents: &str) -> Option<u16> {
    let first = contents.lines().next()?.trim();
    let port: u16 = first.parse().ok()?;
    if port > 0 {
        Some(port)
    } else {
        None
    }
}

pub fn is_local_tcp_port_listening(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

pub fn has_live_devtools_port() -> bool {
    let path = resolve_devtools_active_port_path();
    let contents = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return false,
    };
    match parse_devtools_active_port(&contents) {
        Some(port) => is_local_tcp_port_listening(port),
        None => false,
    }
}

pub fn is_antigravity_running(resource_dir: Option<&Path>) -> bool {
    let install_dir = resolve_antigravity_dir();
    let prefix = install_dir.to_string_lossy().to_string();
    if let Some(helper) = resolve_win_helper_exe(resource_dir) {
        if let Ok(val) = run_win_helper(&helper, &["app-processes", "--prefix", &prefix]) {
            if let Some(arr) = val.get("processes").and_then(|v| v.as_array()) {
                return !arr.is_empty();
            }
        }
    }
    false
}

pub fn read_antigravity_version(resource_dir: Option<&Path>) -> String {
    let exe = resolve_antigravity_exe();
    if !exe.is_file() {
        return String::new();
    }
    if let Some(helper) = resolve_win_helper_exe(resource_dir) {
        let exe_str = exe.to_string_lossy().to_string();
        if let Ok(val) = run_win_helper(&helper, &["pe-version", "--path", &exe_str]) {
            if let Some(ver) = val
                .get("fileVersion")
                .and_then(|v| v.as_str())
                .or_else(|| val.get("productVersion").and_then(|v| v.as_str()))
            {
                let trimmed = ver.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
        }
    }
    String::new()
}

pub fn get_antigravity_info(resource_dir: Option<&Path>) -> AntigravityInfo {
    let install_dir = resolve_antigravity_dir();
    let exe_path = install_dir.join("Antigravity.exe");
    let installed = exe_path.is_file();
    let version = if installed {
        read_antigravity_version(resource_dir)
    } else {
        String::new()
    };
    let running = is_antigravity_running(resource_dir);
    let debug_port_ready = running && has_live_devtools_port();
    AntigravityInfo {
        install_dir: install_dir.to_string_lossy().to_string(),
        exe_path: exe_path.to_string_lossy().to_string(),
        installed,
        version,
        running,
        debug_port_ready,
    }
}

pub fn launch_antigravity() -> Result<(), String> {
    let exe = resolve_antigravity_exe();
    if !exe.is_file() {
        return Err(format!(
            "未找到 Antigravity 可执行文件：{}",
            exe.to_string_lossy()
        ));
    }
    let mut cmd = Command::new(&exe);
    cmd.arg("--remote-debugging-port=0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn()
        .map_err(|e| format!("无法启动 Antigravity：{}", e))?;
    Ok(())
}

const SAFE_CLOSE_TIMEOUT_MS: u64 = 18_000;
const SAFE_CLOSE_GRACE_MS: u64 = 2_500;
const POST_CLOSE_SETTLE_MS: u64 = 400;
const DEVTOOLS_READY_TIMEOUT_SECS: u64 = 15;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GracefulCloseOutcome {
    pub closed: bool,
    pub reason: String,
}

fn build_graceful_close_args(prefix: &str, timeout_ms: u64, grace_ms: u64) -> Vec<String> {
    vec![
        "app-graceful-close".to_string(),
        "--prefix".to_string(),
        prefix.to_string(),
        "--timeout-ms".to_string(),
        timeout_ms.to_string(),
        "--terminate-background".to_string(),
        "--grace-ms".to_string(),
        grace_ms.to_string(),
    ]
}

fn format_close_failure_message(reason: &str, timeout_ms: u64) -> String {
    if reason == "visible_window_open" {
        "检测到 Antigravity 仍有未关闭的可见窗口（例如未保存更改确认框），已停止关闭且未强制终止。请先在 Antigravity 中完成保存或确认关闭，再重试安全重启。".to_string()
    } else {
        let secs = (timeout_ms / 1000).max(1);
        format!(
            "Antigravity 在 {} 秒内未能完全退出，未强制终止可见工作窗口。请先保存工作并手动退出 Antigravity，再通过「打开 Antigravity」重新启动。",
            secs
        )
    }
}

/// Remove a stale `DevToolsActivePort` regular file once all Antigravity processes have exited,
/// preventing relaunch readiness checks from reading an obsolete port. Never follows symlinks.
fn remove_stale_devtools_active_port(path: &Path) {
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if meta.file_type().is_file() {
            let _ = std::fs::remove_file(path);
        }
    }
}

pub fn quit_antigravity_detailed(
    resource_dir: Option<&Path>,
    timeout_ms: u64,
) -> Result<GracefulCloseOutcome, String> {
    let install_dir = resolve_antigravity_dir();
    let prefix = install_dir.to_string_lossy().to_string();
    let helper = resolve_win_helper_exe(resource_dir)
        .ok_or_else(|| "未找到 gravitybox-win-helper.exe，无法安全关闭 Antigravity".to_string())?;
    let owned_args = build_graceful_close_args(&prefix, timeout_ms, SAFE_CLOSE_GRACE_MS);
    let arg_refs: Vec<&str> = owned_args.iter().map(String::as_str).collect();
    let val = run_win_helper(&helper, &arg_refs)?;
    let closed = val.get("closed").and_then(|v| v.as_bool()).unwrap_or(false);
    let reason = val
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if closed {
        std::thread::sleep(Duration::from_millis(POST_CLOSE_SETTLE_MS));
    }
    Ok(GracefulCloseOutcome { closed, reason })
}

pub fn quit_antigravity_and_wait(resource_dir: Option<&Path>, timeout_ms: u64) -> Result<bool, String> {
    Ok(quit_antigravity_detailed(resource_dir, timeout_ms)?.closed)
}

/// Safe relaunch matching macOS `AssistantProcessLifecycle.swift`:
/// 1. Gracefully close running Antigravity via `gravitybox-win-helper.exe app-graceful-close --terminate-background --grace-ms 2500`
///    (never force-kills while any visible window remains open!)
/// 2. Wait 400ms after all processes exit and remove any stale `%APPDATA%\Antigravity\DevToolsActivePort`
/// 3. Relaunch `Antigravity.exe --remote-debugging-port=0`
/// 4. Poll `%APPDATA%\Antigravity\DevToolsActivePort` and probe TCP loopback for up to 15s until ready
pub fn safe_relaunch_antigravity(resource_dir: Option<&Path>) -> Result<SafeRelaunchResult, String> {
    if is_antigravity_running(resource_dir) {
        let outcome = quit_antigravity_detailed(resource_dir, SAFE_CLOSE_TIMEOUT_MS)?;
        if !outcome.closed {
            return Err(format_close_failure_message(&outcome.reason, SAFE_CLOSE_TIMEOUT_MS));
        }
    }

    // All Antigravity processes are confirmed exited; clear stale DevToolsActivePort before relaunching
    remove_stale_devtools_active_port(&resolve_devtools_active_port_path());

    let mut last_err: Option<String> = None;
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(450));
        }
        if let Err(e) = launch_antigravity() {
            last_err = Some(e);
            continue;
        }
        let deadline = Instant::now() + Duration::from_secs(DEVTOOLS_READY_TIMEOUT_SECS);
        while Instant::now() < deadline {
            if has_live_devtools_port() {
                return Ok(SafeRelaunchResult {
                    ok: true,
                    debug_port_ready: true,
                    message: "Antigravity 已带调试端口重启并就绪".to_string(),
                });
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        if is_antigravity_running(resource_dir) {
            return Ok(SafeRelaunchResult {
                ok: true,
                debug_port_ready: has_live_devtools_port(),
                message: "Antigravity 已重新启动，等待调试连接就绪".to_string(),
            });
        }
    }

    Err(last_err.unwrap_or_else(|| "未能自动重新打开 Antigravity，请手动打开".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graceful_close_args_and_messages_match_contract() {
        let args = build_graceful_close_args(
            r"C:\Program Files\Antigravity",
            SAFE_CLOSE_TIMEOUT_MS,
            SAFE_CLOSE_GRACE_MS,
        );
        assert_eq!(
            args,
            vec![
                "app-graceful-close",
                "--prefix",
                r"C:\Program Files\Antigravity",
                "--timeout-ms",
                "18000",
                "--terminate-background",
                "--grace-ms",
                "2500",
            ]
        );

        let visible_msg = format_close_failure_message("visible_window_open", SAFE_CLOSE_TIMEOUT_MS);
        assert!(visible_msg.contains("可见窗口") && visible_msg.contains("保存"));

        let timeout_msg = format_close_failure_message("timeout", SAFE_CLOSE_TIMEOUT_MS);
        assert!(timeout_msg.contains("18 秒"));
    }

    #[test]
    fn remove_stale_devtools_port_removes_regular_file_only() {
        let tmp = strip_verbatim_prefix(&std::env::temp_dir())
            .join(format!("gb-dtp-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let port_file = tmp.join("DevToolsActivePort");
        std::fs::write(&port_file, "9222\n/devtools/browser/abc\n").unwrap();
        assert!(port_file.is_file());

        remove_stale_devtools_active_port(&port_file);
        assert!(!port_file.exists());

        // Calling again on missing file or directory must not fail or remove directory
        remove_stale_devtools_active_port(&port_file);
        remove_stale_devtools_active_port(&tmp);
        assert!(tmp.is_dir());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
