use crate::antigravity::{launch_antigravity, safe_relaunch_antigravity};
use crate::backend::BackendManager;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-icon.png");
pub const TRAY_ID: &str = "gravitybox-tray";

static LAST_TRAY_HIDE_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn mark_tray_hidden_now() {
    LAST_TRAY_HIDE_MS.store(now_ms(), Ordering::SeqCst);
}

pub fn show_main_window_and_focus(app: &AppHandle, page: Option<&str>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        if let Some(p) = page {
            let _ = app.emit("navigate-page", p);
        }
    }
}

pub fn hide_tray_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("tray") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
            mark_tray_hidden_now();
        }
    }
}

#[cfg(windows)]
fn compute_tray_popup_position(popup_w: i32, popup_h: i32, anchor_corner: bool) -> (i32, i32) {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut pt = POINT { x: 0, y: 0 };
    let has_cursor = !anchor_corner && unsafe { GetCursorPos(&mut pt) } != 0;
    let monitor = unsafe { MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST) };
    let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
    info.cbSize = size_of::<MONITORINFO>() as u32;
    let has_mon = !monitor.is_null() && unsafe { GetMonitorInfoW(monitor, &mut info) } != 0;

    if !has_mon {
        return (100, 100);
    }

    let work = info.rcWork;
    let mon = info.rcMonitor;
    let margin = 10;

    if !has_cursor {
        let x = (work.right - popup_w - margin).max(work.left + margin);
        let y = (work.bottom - popup_h - margin).max(work.top + margin);
        return (x, y);
    }

    // Center horizontally on cursor, then clamp inside monitor work area
    let mut x = pt.x - popup_w / 2;
    x = x.clamp(work.left + margin, (work.right - popup_w - margin).max(work.left + margin));

    // Determine taskbar edge relative to monitor vs work area
    let taskbar_top = work.top > mon.top;
    let taskbar_left = work.left > mon.left;
    let taskbar_right = work.right < mon.right;

    let mut y = if taskbar_top {
        work.top + margin
    } else if taskbar_left || taskbar_right {
        pt.y - popup_h / 2
    } else {
        // Default Windows 11 bottom taskbar: pop directly above work area bottom
        work.bottom - popup_h - margin
    };

    y = y.clamp(work.top + margin, (work.bottom - popup_h - margin).max(work.top + margin));
    (x, y)
}

#[cfg(not(windows))]
fn compute_tray_popup_position(_popup_w: i32, _popup_h: i32, _anchor_corner: bool) -> (i32, i32) {
    (100, 100)
}

pub fn show_tray_popover(app: &AppHandle, anchor_corner: bool) {
    let Some(win) = app.get_webview_window("tray") else {
        return;
    };
    let scale = win.scale_factor().unwrap_or(1.0);
    let phys_w = (424.0 * scale).round() as i32;
    let phys_h = (535.0 * scale).round() as i32;
    let (x, y) = compute_tray_popup_position(phys_w, phys_h, anchor_corner);

    let _ = win.set_position(PhysicalPosition::new(x, y));
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit("tray-opened", ());
}

pub fn toggle_tray_popover(app: &AppHandle) {
    let Some(win) = app.get_webview_window("tray") else {
        return;
    };

    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        mark_tray_hidden_now();
        return;
    }

    // Debounce: if tray was just hidden by blur from clicking the tray icon itself (< 220ms ago), keep hidden
    let elapsed = now_ms().saturating_sub(LAST_TRAY_HIDE_MS.load(Ordering::SeqCst));
    if elapsed < 220 {
        return;
    }

    show_tray_popover(app, false);
}

pub fn build_tray_menu(app: &AppHandle, is_english: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let open_main = MenuItem::with_id(
        app,
        "open_main",
        if is_english { "Open GravityBox" } else { "打开主界面" },
        true,
        None::<&str>,
    )?;
    let toggle_loc = MenuItem::with_id(
        app,
        "toggle_localization",
        if is_english { "Toggle Localization" } else { "切换汉化" },
        true,
        None::<&str>,
    )?;
    let open_ag = MenuItem::with_id(
        app,
        "open_antigravity",
        if is_english { "Open Antigravity" } else { "打开 Antigravity" },
        true,
        None::<&str>,
    )?;
    let safe_relaunch = MenuItem::with_id(
        app,
        "safe_relaunch",
        if is_english {
            "Safely Relaunch Antigravity"
        } else {
            "安全重启 Antigravity"
        },
        true,
        None::<&str>,
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        if is_english { "Quit GravityBox" } else { "退出 GravityBox" },
        true,
        None::<&str>,
    )?;

    Menu::with_items(
        app,
        &[
            &open_main,
            &sep1,
            &toggle_loc,
            &open_ag,
            &safe_relaunch,
            &sep2,
            &quit,
        ],
    )
}

pub fn update_tray_menu_language(app: &AppHandle, is_english: bool) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_tray_menu(app, is_english) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

pub fn setup_tray(app: &AppHandle, backend: Arc<BackendManager>, is_english: bool) -> tauri::Result<()> {
    let icon = Image::from_bytes(TRAY_ICON_BYTES)?;
    let menu = build_tray_menu(app, is_english)?;

    let backend_for_menu = Arc::clone(&backend);

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("GravityBox")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_tray_popover(tray.app_handle());
            }
        })
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open_main" => {
                hide_tray_window(app);
                show_main_window_and_focus(app, None);
            }
            "toggle_localization" => {
                let mgr = Arc::clone(&backend_for_menu);
                let handle = app.clone();
                std::thread::spawn(move || {
                    let status = mgr.request(json!({ "command": "status", "includeAccounts": false, "includeTasks": false }));
                    let currently_enabled = status
                        .ok()
                        .and_then(|v| v.get("status").and_then(|s| s.get("translationEnabled")).and_then(|b| b.as_bool()))
                        .unwrap_or(true);
                    let cmd = if currently_enabled { "pause" } else { "resume" };
                    let _ = mgr.request(json!({ "command": cmd }));
                    let _ = handle.emit("backend-data-changed", "localization");
                });
            }
            "open_antigravity" => {
                hide_tray_window(app);
                std::thread::spawn(|| {
                    let _ = launch_antigravity();
                });
            }
            "safe_relaunch" => {
                hide_tray_window(app);
                let res_dir = backend_for_menu.resource_dir().map(|p| p.to_path_buf());
                let handle = app.clone();
                std::thread::spawn(move || {
                    let outcome = safe_relaunch_antigravity(res_dir.as_deref());
                    match outcome {
                        Ok(res) => {
                            let _ = handle.emit("toast-message", json!({ "message": res.message, "error": false }));
                        }
                        Err(err) => {
                            let _ = handle.emit("toast-message", json!({ "message": err, "error": true }));
                        }
                    }
                    let _ = handle.emit("backend-data-changed", "relaunch");
                });
            }
            "quit" => {
                backend_for_menu.graceful_stop();
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
