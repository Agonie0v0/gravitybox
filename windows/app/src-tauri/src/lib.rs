mod antigravity;
mod autostart;
mod backend;
mod commands;
mod config;
mod ipc_pipe;
mod tray;

use backend::BackendManager;
use config::load_config;
use std::sync::Arc;
use tauri::{Manager, RunEvent, WindowEvent};
use tray::{
    hide_tray_window, mark_tray_hidden_now, setup_tray, show_main_window_and_focus,
    show_tray_popover,
};

#[cfg(windows)]
fn apply_windows_rounded_corners(win: &tauri::WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_ROUND: i32 = 2;
    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            DwmSetWindowAttribute(
                hwnd.0 as _,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &DWMWCP_ROUND as *const i32 as *const _,
                std::mem::size_of::<i32>() as u32,
            );
        }
    }
}

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let start_minimized = args.iter().any(|a| a == "--minimized");
    let start_tray = args.iter().any(|a| a == "--tray");
    let start_page: Option<String> = args
        .iter()
        .find_map(|a| a.strip_prefix("--page=").map(|s| s.to_string()));
    let explicit_state_dir = ipc_pipe::resolve_explicit_state_dir(&args);
    let is_isolated = explicit_state_dir.is_some();
    let effective_state_dir = explicit_state_dir.unwrap_or_else(ipc_pipe::resolve_state_dir);

    // For isolated `--state-dir` / `GRAVITYBOX_STATE_DIR` instances (e.g. multi-profile or verification),
    // isolate WebView2 user data folder so we never contend with an already-running primary instance.
    if is_isolated && std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
        let wv_dir = effective_state_dir.join("webview");
        let _ = std::fs::create_dir_all(&wv_dir);
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &wv_dir);
    }

    let mut builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    if !is_isolated {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if argv.iter().any(|a| a == "--tray") {
                show_tray_popover(app, true);
                return;
            }
            let page = argv.iter().find_map(|a| a.strip_prefix("--page="));
            hide_tray_window(app);
            show_main_window_and_focus(app, page);
        }));
    }

    let app = builder
        .setup(move |app| {
            let resource_dir = app
                .path()
                .resource_dir()
                .ok()
                .map(|p| ipc_pipe::strip_verbatim_prefix(&p));
            let backend = Arc::new(BackendManager::new_with_options(
                effective_state_dir.clone(),
                resource_dir,
                is_isolated,
            ));

            // Determine initial tray menu locale from persisted config
            let initial_cfg = load_config(&backend.state_dir);
            let is_english = initial_cfg
                .app_language
                .as_deref()
                .map(|s| s.eq_ignore_ascii_case("en"))
                .unwrap_or(false);

            // Start Node 22 backend daemon in background so window appears instantaneously
            let backend_boot = Arc::clone(&backend);
            std::thread::spawn(move || {
                let _ = backend_boot.ensure_started();
                backend_boot.spawn_watchdog();
            });

            setup_tray(app.handle(), Arc::clone(&backend), is_english)?;

            app.manage(Arc::clone(&backend));

            if let Some(main_win) = app.get_webview_window("main") {
                if !start_minimized && !start_tray {
                    let _ = main_win.show();
                    let _ = main_win.set_focus();
                    if let Some(ref page) = start_page {
                        let _ = tauri::Emitter::emit(app.handle(), "navigate-page", page.as_str());
                    }
                }
                let handle = app.handle().clone();
                main_win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        // Hide to system tray when clicking the window X button (matching macOS GravityBox)
                        api.prevent_close();
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                });
            }

            if let Some(tray_win) = app.get_webview_window("tray") {
                #[cfg(windows)]
                apply_windows_rounded_corners(&tray_win);

                let handle = app.handle().clone();
                tray_win.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        hide_tray_window(&handle);
                        mark_tray_hidden_now();
                    }
                });

                if start_tray {
                    show_tray_popover(app.handle(), true);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::backend_request,
            commands::restart_backend,
            commands::get_app_info,
            commands::launch_antigravity_cmd,
            commands::safe_relaunch_antigravity_cmd,
            commands::quit_antigravity_and_wait_cmd,
            commands::get_antigravity_running,
            commands::open_external_url,
            commands::open_folder,
            commands::reveal_in_explorer,
            commands::get_autostart,
            commands::set_autostart,
            commands::load_ui_config,
            commands::save_ui_config,
            commands::show_main_window,
            commands::hide_tray_window_cmd,
            commands::sync_tray_language,
            commands::set_window_dark_mode,
            commands::save_json_file,
            commands::quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while building GravityBox Windows desktop app");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(backend) = app_handle.try_state::<Arc<BackendManager>>() {
                backend.graceful_stop();
            }
        }
    });
}
