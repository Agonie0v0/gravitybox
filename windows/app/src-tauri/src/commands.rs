use crate::antigravity::{
    get_antigravity_info, is_antigravity_running, launch_antigravity, quit_antigravity_and_wait,
    safe_relaunch_antigravity, AntigravityInfo, SafeRelaunchResult,
};
use crate::autostart;
use crate::backend::BackendManager;
use crate::config::{load_config, save_config, UiConfig};
use crate::ipc_pipe::strip_verbatim_prefix;
use crate::tray::{hide_tray_window, show_main_window_and_focus, update_tray_menu_language};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub state_dir: String,
    pub pipe_name: String,
    pub os_label: String,
    pub antigravity: AntigravityInfo,
}

#[tauri::command]
pub async fn backend_request(
    backend: State<'_, Arc<BackendManager>>,
    payload: Value,
) -> Result<Value, String> {
    let mgr = Arc::clone(backend.inner());
    tokio::task::spawn_blocking(move || mgr.request(payload))
        .await
        .map_err(|e| format!("后台任务调度失败: {}", e))?
}

#[tauri::command]
pub async fn restart_backend(backend: State<'_, Arc<BackendManager>>) -> Result<(), String> {
    let mgr = Arc::clone(backend.inner());
    tokio::task::spawn_blocking(move || mgr.restart())
        .await
        .map_err(|e| format!("重启后端任务失败: {}", e))?
}

#[tauri::command]
pub async fn get_app_info(backend: State<'_, Arc<BackendManager>>) -> Result<AppInfo, String> {
    let mgr = Arc::clone(backend.inner());
    tokio::task::spawn_blocking(move || {
        let ag = get_antigravity_info(mgr.resource_dir());
        let os_label = format!("Windows {}", std::env::consts::ARCH);
        AppInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            state_dir: mgr.state_dir.to_string_lossy().to_string(),
            pipe_name: mgr.pipe_name.clone(),
            os_label,
            antigravity: ag,
        }
    })
    .await
    .map_err(|e| format!("读取环境信息失败: {}", e))
}

#[tauri::command]
pub async fn launch_antigravity_cmd() -> Result<(), String> {
    tokio::task::spawn_blocking(launch_antigravity)
        .await
        .map_err(|e| format!("启动失败: {}", e))?
}

#[tauri::command]
pub async fn safe_relaunch_antigravity_cmd(
    backend: State<'_, Arc<BackendManager>>,
) -> Result<SafeRelaunchResult, String> {
    let res_dir = backend.resource_dir().map(|p| p.to_path_buf());
    tokio::task::spawn_blocking(move || safe_relaunch_antigravity(res_dir.as_deref()))
        .await
        .map_err(|e| format!("安全重启失败: {}", e))?
}

#[tauri::command]
pub async fn quit_antigravity_and_wait_cmd(
    backend: State<'_, Arc<BackendManager>>,
    timeout_ms: Option<u64>,
) -> Result<bool, String> {
    let res_dir = backend.resource_dir().map(|p| p.to_path_buf());
    let timeout = timeout_ms.unwrap_or(18_000).clamp(1_000, 35_000);
    tokio::task::spawn_blocking(move || quit_antigravity_and_wait(res_dir.as_deref(), timeout))
        .await
        .map_err(|e| format!("等待 Antigravity 退出失败: {}", e))?
}

#[tauri::command]
pub async fn get_antigravity_running(
    backend: State<'_, Arc<BackendManager>>,
) -> Result<bool, String> {
    let res_dir = backend.resource_dir().map(|p| p.to_path_buf());
    tokio::task::spawn_blocking(move || is_antigravity_running(res_dir.as_deref()))
        .await
        .map_err(|e| format!("检测运行状态失败: {}", e))
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("仅允许打开 http:// 或 https:// 链接".to_string());
    }
    if trimmed.contains('\0') || trimmed.contains('\r') || trimmed.contains('\n') {
        return Err("链接格式无效".to_string());
    }
    #[cfg(windows)]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use std::ptr::null;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let verb: Vec<u16> = OsStr::new("open").encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = OsStr::new(trimmed).encode_wide().chain(Some(0)).collect();
        let res = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                target.as_ptr(),
                null(),
                null(),
                SW_SHOWNORMAL,
            )
        };
        if (res as isize) <= 32 {
            return Err("无法打开默认浏览器".to_string());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Unsupported platform".to_string())
    }
}

fn validate_dir_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains('\0') || trimmed.starts_with('/') {
        return Err("无效的目录路径".to_string());
    }
    let p = strip_verbatim_prefix(std::path::Path::new(trimmed));
    if !p.is_dir() {
        return Err(format!("目标不是有效目录: {}", p.display()));
    }
    Ok(p)
}

fn validate_json_save_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains('\0') || trimmed.starts_with('/') {
        return Err("保存路径无效".to_string());
    }
    let p = strip_verbatim_prefix(std::path::Path::new(trimmed));
    let is_json = p
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("json"))
        .unwrap_or(false);
    if !is_json {
        return Err("仅允许保存为 .json 文件".to_string());
    }
    if let Ok(meta) = std::fs::symlink_metadata(&p) {
        if meta.file_type().is_symlink() || meta.is_dir() {
            return Err("目标路径不允许覆盖目录或符号链接".to_string());
        }
    }
    Ok(p)
}

#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    let p = validate_dir_path(&path)?;
    #[cfg(windows)]
    {
        Command::new("explorer.exe")
            .arg(&p)
            .spawn()
            .map_err(|e| format!("无法打开资源管理器: {}", e))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = p;
        Err("Unsupported platform".to_string())
    }
}

#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.contains('\0') || trimmed.starts_with('/') {
        return Err("无效的文件或目录路径".to_string());
    }
    let p = strip_verbatim_prefix(std::path::Path::new(trimmed));
    if !p.exists() {
        if let Some(parent) = p.parent() {
            if parent.is_dir() {
                return open_folder(parent.to_string_lossy().to_string());
            }
        }
        return Err(format!("路径不存在: {}", p.display()));
    }
    #[cfg(windows)]
    {
        if p.is_file() {
            let select_arg = format!("/select,{}", p.to_string_lossy());
            Command::new("explorer.exe")
                .arg(select_arg)
                .spawn()
                .map_err(|e| format!("无法在资源管理器中定位文件: {}", e))?;
            Ok(())
        } else if p.is_dir() {
            Command::new("explorer.exe")
                .arg(&p)
                .spawn()
                .map_err(|e| format!("无法打开目录: {}", e))?;
            Ok(())
        } else {
            Err(format!("路径不是有效文件或目录: {}", p.display()))
        }
    }
    #[cfg(not(windows))]
    {
        Err("Unsupported platform".to_string())
    }
}

#[tauri::command]
pub fn get_autostart() -> Result<bool, String> {
    autostart::get_autostart()
}

#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    autostart::set_autostart(enabled)
}

#[tauri::command]
pub fn load_ui_config(backend: State<'_, Arc<BackendManager>>) -> UiConfig {
    load_config(&backend.state_dir)
}

#[tauri::command]
pub fn save_ui_config(
    app: AppHandle,
    backend: State<'_, Arc<BackendManager>>,
    config: UiConfig,
) -> Result<(), String> {
    save_config(&backend.state_dir, &config)?;
    let _ = app.emit("ui-config-changed", &config);
    Ok(())
}

#[tauri::command]
pub fn show_main_window(app: AppHandle, page: Option<String>) {
    hide_tray_window(&app);
    show_main_window_and_focus(&app, page.as_deref());
}

#[tauri::command]
pub fn hide_tray_window_cmd(app: AppHandle) {
    hide_tray_window(&app);
}

#[tauri::command]
pub fn sync_tray_language(app: AppHandle, is_english: bool) {
    update_tray_menu_language(&app, is_english);
}

#[tauri::command]
pub fn set_window_dark_mode(app: AppHandle, is_dark: bool) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
        const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
        let value: i32 = if is_dark { 1 } else { 0 };
        for label in ["main", "tray"] {
            if let Some(win) = app.get_webview_window(label) {
                if let Ok(hwnd) = win.hwnd() {
                    unsafe {
                        DwmSetWindowAttribute(
                            hwnd.0 as _,
                            DWMWA_USE_IMMERSIVE_DARK_MODE,
                            &value as *const i32 as *const _,
                            std::mem::size_of::<i32>() as u32,
                        );
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, is_dark);
    }
}

#[tauri::command]
pub fn save_json_file(path: String, content: Value) -> Result<(), String> {
    use std::io::Write;
    let target = validate_json_save_path(&path)?;
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "保存路径缺少有效父目录".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("无法创建目标目录: {}", e))?;

    let mut pretty = serde_json::to_string_pretty(&content)
        .map_err(|e| format!("JSON 序列化失败: {}", e))?;
    pretty.push('\n');

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("export.json");
    let tmp = parent.join(format!(".{}.tmp.{}.{}", file_name, std::process::id(), stamp));

    let write_res = (|| -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp)?;
        f.write_all(pretty.as_bytes())?;
        f.sync_all()?;
        Ok(())
    })();
    if let Err(err) = write_res {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("文件写入失败: {}", err));
    }

    let mut last_err = None;
    for attempt in 0..5u64 {
        match std::fs::rename(&tmp, &target) {
            Ok(()) => return Ok(()),
            Err(err) => {
                if std::fs::symlink_metadata(&target)
                    .map(|m| m.file_type().is_file())
                    .unwrap_or(false)
                {
                    let _ = std::fs::remove_file(&target);
                    if std::fs::rename(&tmp, &target).is_ok() {
                        return Ok(());
                    }
                }
                last_err = Some(err);
                std::thread::sleep(std::time::Duration::from_millis(25 * (attempt + 1)));
            }
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Err(format!(
        "文件保存失败: {}",
        last_err.map(|e| e.to_string()).unwrap_or_default()
    ))
}

#[tauri::command]
pub fn quit_app(app: AppHandle, backend: State<'_, Arc<BackendManager>>) {
    backend.graceful_stop();
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_and_json_path_validation_enforces_security_boundaries() {
        let tmp_dir = std::env::temp_dir().join(format!("gb-cmd-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let fake_exe = tmp_dir.join("calc.exe");
        std::fs::write(&fake_exe, b"stub").unwrap();

        // open_folder validator accepts directories and rejects files, leading '/', and NUL
        assert!(validate_dir_path(&tmp_dir.to_string_lossy()).is_ok());
        assert!(validate_dir_path(&fake_exe.to_string_lossy()).is_err());
        assert!(validate_dir_path("/select,C:\\Windows").is_err());
        assert!(validate_dir_path("C:\\Temp\0evil").is_err());

        // save_json_file validator accepts .json/.JSON and rejects executables/non-json/NUL
        let ok_json = tmp_dir.join("backup.JSON");
        assert!(validate_json_save_path(&ok_json.to_string_lossy()).is_ok());
        assert!(validate_json_save_path(&fake_exe.to_string_lossy()).is_err());
        assert!(validate_json_save_path(&tmp_dir.join("run.bat").to_string_lossy()).is_err());
        assert!(validate_json_save_path("C:\\Temp\\bad\0.json").is_err());
        assert!(validate_json_save_path("/weird.json").is_err());

        // Atomic JSON save roundtrip
        let out_file = tmp_dir.join("accounts-export.json");
        save_json_file(
            out_file.to_string_lossy().to_string(),
            serde_json::json!({ "version": 1, "accounts": [] }),
        )
        .unwrap();
        let saved = std::fs::read_to_string(&out_file).unwrap();
        assert!(saved.contains("\"version\": 1"));

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
}
