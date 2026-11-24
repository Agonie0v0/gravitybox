use crate::config::load_config;
use crate::ipc_pipe::strip_verbatim_prefix;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
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
    pub needs_background_exit_confirmation: bool,
    pub reason: String,
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
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(_) => return false,
    };
    if meta.file_type().is_symlink() || !meta.file_type().is_file() || meta.len() > 4096 {
        return false;
    }
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

fn has_control_or_whitespace(s: &str) -> bool {
    s.chars()
        .any(|c| c.is_whitespace() || (c as u32) < 0x20 || (c as u32) == 0x7f)
}

fn is_valid_proxy_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 255 || has_control_or_whitespace(host) {
        return false;
    }
    if host.starts_with('[') && host.ends_with(']') {
        let inner = &host[1..host.len() - 1];
        return !inner.is_empty()
            && inner
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.');
    }
    host.bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

/// Strictly validate and normalize an HTTP/HTTPS proxy URL (for both registry and manual config).
/// Rejects control chars (CRLF/NUL), whitespace, non-HTTP(S) schemes (e.g. socks/ftp/file),
/// path/query/fragment suffixes, and missing/out-of-range ports.
pub(crate) fn normalize_and_validate_http_proxy_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 2048 || has_control_or_whitespace(trimmed) {
        return None;
    }

    let (scheme, rest) = if let Some(idx) = trimmed.find("://") {
        let s = trimmed[..idx].to_ascii_lowercase();
        if s != "http" && s != "https" {
            return None;
        }
        (s, &trimmed[idx + 3..])
    } else {
        // Reject bare disallowed schemes like "socks5:...", "file:...", "javascript:..."
        let lower = trimmed.to_ascii_lowercase();
        if [
            "socks:",
            "socks4:",
            "socks4a:",
            "socks5:",
            "ftp:",
            "file:",
            "javascript:",
            "data:",
            "ws:",
            "wss:",
        ]
        .iter()
        .any(|p| lower.starts_with(p))
        {
            return None;
        }
        ("http".to_string(), trimmed)
    };

    let mut remainder = rest;
    if let Some(stripped) = remainder.strip_suffix('/') {
        remainder = stripped;
    }
    if remainder.is_empty()
        || remainder.contains('/')
        || remainder.contains('?')
        || remainder.contains('#')
    {
        return None;
    }

    let (userinfo_prefix, host_port) = if let Some(at_idx) = remainder.rfind('@') {
        let userinfo = &remainder[..at_idx];
        if userinfo.is_empty() || has_control_or_whitespace(userinfo) {
            return None;
        }
        (format!("{}@", userinfo), &remainder[at_idx + 1..])
    } else {
        (String::new(), remainder)
    };

    let (host, port_str) = if host_port.starts_with('[') {
        let close = host_port.find(']')?;
        let h = &host_port[..=close];
        let after = &host_port[close + 1..];
        let port = after.strip_prefix(':')?;
        (h, port)
    } else {
        let colon = host_port.rfind(':')?;
        let h = &host_port[..colon];
        if h.contains(':') {
            return None;
        }
        (h, &host_port[colon + 1..])
    };

    if !is_valid_proxy_host(host) {
        return None;
    }
    if port_str.is_empty() || !port_str.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let port: u16 = port_str.parse().ok()?;
    if port == 0 {
        return None;
    }

    Some(format!(
        "{}://{}{}:{}",
        scheme,
        userinfo_prefix,
        host.to_ascii_lowercase(),
        port
    ))
}

pub(crate) fn sanitize_no_proxy_list(raw_override: &str) -> String {
    let mut no_proxy_entries: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for entry in ["127.0.0.1", "localhost", "::1"]
        .into_iter()
        .chain(raw_override.split(';').map(str::trim))
    {
        if entry.is_empty()
            || entry.eq_ignore_ascii_case("<local>")
            || entry.contains(',')
            || has_control_or_whitespace(entry)
        {
            continue;
        }
        let key = entry.to_ascii_lowercase();
        if seen.insert(key) {
            no_proxy_entries.push(entry.to_string());
        }
    }
    no_proxy_entries.join(",")
}

pub(crate) fn parse_windows_proxy_server_value(
    raw_server: &str,
    raw_override: &str,
) -> Option<(String, String, String)> {
    let trimmed = raw_server.trim();
    if trimmed.is_empty() || has_control_or_whitespace(trimmed) {
        return None;
    }
    let mut http_url: Option<String> = None;
    let mut https_url: Option<String> = None;
    if trimmed.contains('=') {
        for part in trimmed.split(';') {
            if let Some((proto, target)) = part.split_once('=') {
                let p = proto.trim().to_ascii_lowercase();
                if p == "http" {
                    http_url = normalize_and_validate_http_proxy_url(target);
                } else if p == "https" {
                    https_url = normalize_and_validate_http_proxy_url(target);
                }
            }
        }
    } else if let Some(ep) = normalize_and_validate_http_proxy_url(trimmed) {
        http_url = Some(ep.clone());
        https_url = Some(ep);
    }

    let final_http = http_url.clone().or_else(|| https_url.clone())?;
    let final_https = https_url.or_else(|| http_url)?;
    Some((final_http, final_https, sanitize_no_proxy_list(raw_override)))
}

#[cfg(windows)]
fn read_windows_system_proxy_env() -> Option<(String, String, String)> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE,
        REG_DWORD, REG_SZ,
    };

    struct RegGuard(HKEY);
    impl Drop for RegGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    RegCloseKey(self.0);
                }
            }
        }
    }

    let subkey: Vec<u16> = OsStr::new(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut hkey: HKEY = null_mut();
    let open_res = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            KEY_QUERY_VALUE,
            &mut hkey,
        )
    };
    if open_res != ERROR_SUCCESS || hkey.is_null() {
        return None;
    }
    let guard = RegGuard(hkey);

    let read_dword = |name: &str| -> Option<u32> {
        let wn: Vec<u16> = OsStr::new(name).encode_wide().chain(Some(0)).collect();
        let mut reg_type: u32 = 0;
        let mut val: u32 = 0;
        let mut len: u32 = std::mem::size_of::<u32>() as u32;
        let res = unsafe {
            RegQueryValueExW(
                guard.0,
                wn.as_ptr(),
                null_mut(),
                &mut reg_type,
                &mut val as *mut u32 as *mut u8,
                &mut len,
            )
        };
        if res == ERROR_SUCCESS && reg_type == REG_DWORD {
            Some(val)
        } else {
            None
        }
    };

    let read_sz = |name: &str| -> Option<String> {
        let wn: Vec<u16> = OsStr::new(name).encode_wide().chain(Some(0)).collect();
        let mut reg_type: u32 = 0;
        let mut len: u32 = 0;
        let probe = unsafe {
            RegQueryValueExW(
                guard.0,
                wn.as_ptr(),
                null_mut(),
                &mut reg_type,
                null_mut(),
                &mut len,
            )
        };
        if probe != ERROR_SUCCESS || reg_type != REG_SZ || len < 2 || len > 32_768 {
            return None;
        }
        let mut buf = vec![0u16; (len as usize).div_ceil(2)];
        let mut actual_len: u32 = (buf.len() * 2) as u32;
        let res = unsafe {
            RegQueryValueExW(
                guard.0,
                wn.as_ptr(),
                null_mut(),
                &mut reg_type,
                buf.as_mut_ptr() as *mut u8,
                &mut actual_len,
            )
        };
        if res != ERROR_SUCCESS || reg_type != REG_SZ {
            return None;
        }
        let valid_u16s = ((actual_len as usize) / 2).min(buf.len());
        let slice = &buf[..valid_u16s];
        let end = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
        Some(String::from_utf16_lossy(&slice[..end]).trim().to_string())
    };

    if read_dword("ProxyEnable").unwrap_or(0) != 1 {
        return None;
    }
    let raw_server = read_sz("ProxyServer").unwrap_or_default();
    let raw_override = read_sz("ProxyOverride").unwrap_or_default();
    parse_windows_proxy_server_value(&raw_server, &raw_override)
}

#[cfg(not(windows))]
fn read_windows_system_proxy_env() -> Option<(String, String, String)> {
    None
}

fn resolve_launch_proxy_env(state_dir: Option<&Path>) -> Vec<(&'static str, String)> {
    let Some(dir) = state_dir else {
        return Vec::new();
    };
    let cfg = load_config(dir);
    let resolved = match cfg.antigravity_proxy_mode.as_str() {
        "manual" => normalize_and_validate_http_proxy_url(&cfg.antigravity_proxy_manual_url).map(
            |normalized| {
                (
                    normalized.clone(),
                    normalized,
                    "127.0.0.1,localhost,::1".to_string(),
                )
            },
        ),
        "system" => read_windows_system_proxy_env(),
        _ => None,
    };

    let Some((http_url, https_url, no_proxy)) = resolved else {
        return Vec::new();
    };
    vec![
        ("HTTP_PROXY", http_url.clone()),
        ("http_proxy", http_url),
        ("HTTPS_PROXY", https_url.clone()),
        ("https_proxy", https_url),
        ("NO_PROXY", no_proxy.clone()),
        ("no_proxy", no_proxy),
        ("NODE_USE_ENV_PROXY", "1".to_string()),
    ]
}

pub fn launch_antigravity(state_dir: Option<&Path>) -> Result<(), String> {
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
    for (k, v) in resolve_launch_proxy_env(state_dir) {
        cmd.env(k, v);
    }
    cmd.spawn()
        .map_err(|e| format!("无法启动 Antigravity：{}", e))?;
    Ok(())
}

const SAFE_CLOSE_TIMEOUT_MS: u64 = 18_000;
const SAFE_CLOSE_GRACE_MS: u64 = 2_500;
const POST_CLOSE_SETTLE_MS: u64 = 400;
const DEVTOOLS_READY_TIMEOUT_SECS: u64 = 15;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GracefulCloseOutcome {
    pub closed: bool,
    pub reason: String,
}

/// Build CLI arguments for `gravitybox-win-helper.exe app-graceful-close`.
/// Default (`confirm_background_exit = false`) NEVER passes `--confirm-background-exit`
/// or `--terminate-background` — strictly pure graceful WM_CLOSE only.
fn build_graceful_close_args(
    prefix: &str,
    timeout_ms: u64,
    grace_ms: u64,
    confirm_background_exit: bool,
) -> Vec<String> {
    let mut args = vec![
        "app-graceful-close".to_string(),
        "--prefix".to_string(),
        prefix.to_string(),
        "--timeout-ms".to_string(),
        timeout_ms.to_string(),
        "--grace-ms".to_string(),
        grace_ms.to_string(),
    ];
    if confirm_background_exit {
        args.push("--confirm-background-exit".to_string());
    }
    args
}

fn format_close_failure_message(reason: &str, timeout_ms: u64) -> String {
    if reason == "visible_window_open" {
        "检测到 Antigravity 仍有未关闭的可见窗口（例如未保存更改确认框），已停止关闭且未强制终止。请先在 Antigravity 中完成保存或确认关闭，再重试安全重启。".to_string()
    } else if reason == "background_resident" {
        "Antigravity 的可见窗口已全部关闭，但仍有无界面后台/托盘进程驻留。是否确认结束这些无界面后台进程并带调试端口重启？（也可点「取消」自行从系统托盘退出）".to_string()
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
    confirm_background_exit: bool,
) -> Result<GracefulCloseOutcome, String> {
    let install_dir = resolve_antigravity_dir();
    let prefix = install_dir.to_string_lossy().to_string();
    let helper = resolve_win_helper_exe(resource_dir)
        .ok_or_else(|| "未找到 gravitybox-win-helper.exe，无法安全关闭 Antigravity".to_string())?;
    let owned_args =
        build_graceful_close_args(&prefix, timeout_ms, SAFE_CLOSE_GRACE_MS, confirm_background_exit);
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

/// Safe relaunch strictly enforcing zero silent background force-kill:
/// 1. When `confirm_background_exit == false` (default), calls `app-graceful-close` WITHOUT
///    `--confirm-background-exit`. If only windowless background/tray processes remain
///    (`reason == "background_resident"`), returns `needs_background_exit_confirmation: true`
///    so the UI asks for explicit user confirmation first.
/// 2. If any visible window remains open (`reason == "visible_window_open"`), NEVER offers
///    force-kill and returns an actionable error telling the user to save/close open windows.
/// 3. Once all processes exit, waits 400ms, removes stale regular-file `DevToolsActivePort`,
///    relaunches `Antigravity.exe --remote-debugging-port=0` (injecting configured proxy env if enabled),
///    and polls for up to 15s until the debugging port is ready.
pub fn safe_relaunch_antigravity(
    resource_dir: Option<&Path>,
    state_dir: Option<&Path>,
    confirm_background_exit: bool,
) -> Result<SafeRelaunchResult, String> {
    if is_antigravity_running(resource_dir) {
        let outcome =
            quit_antigravity_detailed(resource_dir, SAFE_CLOSE_TIMEOUT_MS, confirm_background_exit)?;
        if !outcome.closed {
            if outcome.reason == "background_resident" && !confirm_background_exit {
                return Ok(SafeRelaunchResult {
                    ok: false,
                    debug_port_ready: false,
                    needs_background_exit_confirmation: true,
                    reason: "background_resident".to_string(),
                    message: format_close_failure_message("background_resident", SAFE_CLOSE_TIMEOUT_MS),
                });
            }
            return Err(format_close_failure_message(
                &outcome.reason,
                SAFE_CLOSE_TIMEOUT_MS,
            ));
        }
    }

    // All Antigravity processes are confirmed exited; clear stale DevToolsActivePort before relaunching
    remove_stale_devtools_active_port(&resolve_devtools_active_port_path());

    let mut last_err: Option<String> = None;
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(450));
        }
        if let Err(e) = launch_antigravity(state_dir) {
            last_err = Some(e);
            continue;
        }
        let deadline = Instant::now() + Duration::from_secs(DEVTOOLS_READY_TIMEOUT_SECS);
        while Instant::now() < deadline {
            if has_live_devtools_port() {
                return Ok(SafeRelaunchResult {
                    ok: true,
                    debug_port_ready: true,
                    needs_background_exit_confirmation: false,
                    reason: "ready".to_string(),
                    message: "Antigravity 已带调试端口重启并就绪".to_string(),
                });
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        if is_antigravity_running(resource_dir) {
            return Ok(SafeRelaunchResult {
                ok: true,
                debug_port_ready: has_live_devtools_port(),
                needs_background_exit_confirmation: false,
                reason: "launched".to_string(),
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
    fn graceful_close_args_never_force_kill_by_default_and_require_explicit_confirm() {
        let default_args = build_graceful_close_args(
            r"C:\Program Files\Antigravity",
            SAFE_CLOSE_TIMEOUT_MS,
            SAFE_CLOSE_GRACE_MS,
            false,
        );
        assert_eq!(
            default_args,
            vec![
                "app-graceful-close",
                "--prefix",
                r"C:\Program Files\Antigravity",
                "--timeout-ms",
                "18000",
                "--grace-ms",
                "2500",
            ]
        );
        assert!(!default_args.iter().any(|a| a.contains("confirm-background-exit") || a.contains("terminate-background")));

        let confirmed_args = build_graceful_close_args(
            r"C:\Program Files\Antigravity",
            SAFE_CLOSE_TIMEOUT_MS,
            SAFE_CLOSE_GRACE_MS,
            true,
        );
        assert!(confirmed_args.contains(&"--confirm-background-exit".to_string()));
        assert!(!confirmed_args.contains(&"--terminate-background".to_string()));

        let visible_msg = format_close_failure_message("visible_window_open", SAFE_CLOSE_TIMEOUT_MS);
        assert!(visible_msg.contains("可见窗口") && visible_msg.contains("保存"));

        let resident_msg = format_close_failure_message("background_resident", SAFE_CLOSE_TIMEOUT_MS);
        assert!(resident_msg.contains("后台") && resident_msg.contains("确认"));

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

    #[test]
    fn proxy_url_and_override_validation_rejects_injection_and_non_http_schemes() {
        assert_eq!(
            normalize_and_validate_http_proxy_url("127.0.0.1:7890").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            normalize_and_validate_http_proxy_url("HTTPS://Proxy.Local:8443/").as_deref(),
            Some("https://proxy.local:8443")
        );
        assert_eq!(
            normalize_and_validate_http_proxy_url("http://[::1]:7890").as_deref(),
            Some("http://[::1]:7890")
        );
        // Reject CRLF, NUL, whitespace, non-HTTP schemes, missing/invalid port, path/query
        assert!(normalize_and_validate_http_proxy_url("http://127.0.0.1:7890\r\nEVIL=1").is_none());
        assert!(normalize_and_validate_http_proxy_url("http://127.0.0.1:7890\0").is_none());
        assert!(normalize_and_validate_http_proxy_url("http://127.0.0.1:7890 extra").is_none());
        assert!(normalize_and_validate_http_proxy_url("socks5://127.0.0.1:7891").is_none());
        assert!(normalize_and_validate_http_proxy_url("ftp://127.0.0.1:21").is_none());
        assert!(normalize_and_validate_http_proxy_url("http://127.0.0.1:0").is_none());
        assert!(normalize_and_validate_http_proxy_url("http://127.0.0.1:70000").is_none());
        assert!(normalize_and_validate_http_proxy_url("http://127.0.0.1/path").is_none());

        // Windows ProxyServer parsing & NO_PROXY sanitization
        let (h, hs, np) = parse_windows_proxy_server_value(
            "http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892",
            "*.corp.local;<local>;bad\r\nline;a,b;10.*",
        )
        .expect("valid windows proxy server string");
        assert_eq!(h, "http://127.0.0.1:7890");
        assert_eq!(hs, "http://127.0.0.1:7891");
        assert_eq!(np, "127.0.0.1,localhost,::1,*.corp.local,10.*");

        assert!(parse_windows_proxy_server_value("socks=127.0.0.1:7892", "").is_none());
        assert!(parse_windows_proxy_server_value("127.0.0.1:7890\nINJECT=1", "").is_none());
    }
}
