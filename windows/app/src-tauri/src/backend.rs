use crate::antigravity::resolve_win_helper_exe;
use crate::config::load_config;
use crate::ipc_pipe::{
    resolve_ipc_pipe_name, resolve_log_dir, send_ndjson_request,
    strip_verbatim_prefix, PipeError,
};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimeTarget {
    pub(crate) node_exe: PathBuf,
    pub(crate) main_js: PathBuf,
    pub(crate) working_dir: PathBuf,
}

pub struct BackendManager {
    pub state_dir: PathBuf,
    pub pipe_name: String,
    resource_dir: Option<PathBuf>,
    isolated_logs: bool,
    child: Arc<Mutex<Option<Child>>>,
    is_booting: Arc<AtomicBool>,
    shutting_down: Arc<AtomicBool>,
    owns_process: Arc<AtomicBool>,
}

impl BackendManager {
    pub fn new_with_options(
        state_dir: PathBuf,
        resource_dir: Option<PathBuf>,
        isolated_logs: bool,
    ) -> Self {
        let state_dir = strip_verbatim_prefix(&state_dir);
        let resource_dir = resource_dir.map(|p| strip_verbatim_prefix(&p));
        let pipe_name = resolve_ipc_pipe_name(&state_dir);
        Self {
            state_dir,
            pipe_name,
            resource_dir,
            isolated_logs,
            child: Arc::new(Mutex::new(None)),
            is_booting: Arc::new(AtomicBool::new(false)),
            shutting_down: Arc::new(AtomicBool::new(false)),
            owns_process: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn resource_dir(&self) -> Option<&Path> {
        self.resource_dir.as_deref()
    }

    pub(crate) fn resolve_runtime_target(&self) -> Option<RuntimeTarget> {
        // 1. Check production bundled runtime (Tauri resource_dir or executable directory).
        // Always strip Win32 `\\?\` verbatim prefixes so Node.js v22 never receives `\\?\D:\...`
        // (which triggers `EISDIR: illegal operation on a directory, lstat 'D:'`).
        let mut bundle_roots: Vec<PathBuf> = Vec::new();
        if let Some(res) = &self.resource_dir {
            let clean_res = strip_verbatim_prefix(res);
            bundle_roots.push(clean_res.clone());
            bundle_roots.push(clean_res.join("resources"));
        }
        if let Ok(exe) = std::env::current_exe() {
            let clean_exe = strip_verbatim_prefix(&exe);
            if let Some(dir) = clean_exe.parent() {
                bundle_roots.push(dir.to_path_buf());
                bundle_roots.push(dir.join("resources"));
            }
        }
        for root in &bundle_roots {
            let bundled_node = strip_verbatim_prefix(&root.join("runtime").join("node.exe"));
            let bundled_main = strip_verbatim_prefix(&root.join("core").join("dist").join("main.js"));
            if bundled_node.is_file() && bundled_main.is_file() {
                return Some(RuntimeTarget {
                    node_exe: bundled_node,
                    main_js: bundled_main,
                    working_dir: strip_verbatim_prefix(&root.join("core")),
                });
            }
            let alt_main = strip_verbatim_prefix(&root.join("dist").join("main.js"));
            if bundled_node.is_file() && alt_main.is_file() {
                return Some(RuntimeTarget {
                    node_exe: bundled_node,
                    main_js: alt_main,
                    working_dir: strip_verbatim_prefix(root),
                });
            }
        }

        // 2. Development mode: locate repo root containing `dist/main.js` and `package.json`
        let mut search_starts: Vec<PathBuf> = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            let clean_exe = strip_verbatim_prefix(&exe);
            if let Some(dir) = clean_exe.parent() {
                search_starts.push(dir.to_path_buf());
            }
        }
        #[cfg(debug_assertions)]
        if let Ok(cwd) = std::env::current_dir() {
            search_starts.push(strip_verbatim_prefix(&cwd));
        }
        for start in search_starts {
            for anc in start.ancestors().take(8) {
                let candidate_main = strip_verbatim_prefix(&anc.join("dist").join("main.js"));
                let candidate_pkg = anc.join("package.json");
                if candidate_main.is_file() && candidate_pkg.is_file() {
                    let node_exe = std::env::var("GRAVITYBOX_NODE_PATH")
                        .ok()
                        .filter(|s| !s.trim().is_empty())
                        .map(|s| strip_verbatim_prefix(Path::new(s.trim())))
                        .unwrap_or_else(|| PathBuf::from("node"));
                    return Some(RuntimeTarget {
                        node_exe,
                        main_js: candidate_main,
                        working_dir: strip_verbatim_prefix(anc),
                    });
                }
            }
        }

        None
    }

    fn open_rotated_log_file(&self) -> Option<std::fs::File> {
        let log_dir = if self.isolated_logs {
            self.state_dir.join("logs")
        } else {
            resolve_log_dir()
        };
        fs::create_dir_all(&log_dir).ok()?;
        let log_path = log_dir.join("backend.log");
        if let Ok(meta) = fs::metadata(&log_path) {
            if meta.len() > 1_048_576 {
                let archive_dir = log_dir.join("archive");
                let _ = fs::create_dir_all(&archive_dir);
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let archive_path = archive_dir.join(format!("backend-{}.log", ts));
                let _ = fs::rename(&log_path, &archive_path);
            }
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .ok()
    }

    pub fn ping(&self) -> bool {
        send_ndjson_request(
            &self.pipe_name,
            &json!({ "command": "ping" }),
            Duration::from_millis(350),
        )
        .is_ok()
    }

    /// Ensure the Node 22 GravityBox backend daemon is running.
    /// If an external backend is already listening on the Named Pipe (e.g., `npm run dev:backend`),
    /// attaches to it without spawning a duplicate.
    pub fn ensure_started(&self) -> Result<(), String> {
        if self.shutting_down.load(Ordering::SeqCst) {
            return Ok(());
        }
        if self.ping() {
            return Ok(());
        }

        // Check if our owned child is already running
        {
            let mut guard = self.child.lock().unwrap();
            if let Some(ref mut c) = *guard {
                if let Ok(None) = c.try_wait() {
                    return Ok(());
                }
                *guard = None;
            }
        }

        let target = self.resolve_runtime_target().ok_or_else(|| {
            "未找到 GravityBox Node 后端 (dist/main.js)。请先运行根目录 `npm run build` 或重新安装完整包。".to_string()
        })?;

        fs::create_dir_all(&self.state_dir)
            .map_err(|e| format!("无法创建 GravityBox 数据目录: {}", e))?;

        let cfg = load_config(&self.state_dir);

        let clean_state_dir = strip_verbatim_prefix(&self.state_dir);
        let mut cmd = Command::new(&target.node_exe);
        cmd.current_dir(&target.working_dir)
            .arg("--max-old-space-size=256")
            .arg(&target.main_js)
            .arg("--state-dir")
            .arg(&clean_state_dir);

        if let Some(lang) = cfg.app_language.as_deref() {
            let trimmed = lang.trim();
            if !trimmed.is_empty() {
                cmd.arg("--locale").arg(trimmed);
            }
        }

        if let Some(helper) = resolve_win_helper_exe(self.resource_dir.as_deref()) {
            cmd.env("GRAVITYBOX_WIN_HELPER_PATH", strip_verbatim_prefix(&helper));
        }

        cmd.stdin(Stdio::null()).stdout(Stdio::null());
        if let Some(log_file) = self.open_rotated_log_file() {
            cmd.stderr(Stdio::from(log_file));
        } else {
            cmd.stderr(Stdio::null());
        }

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        self.is_booting.store(true, Ordering::SeqCst);
        let child_proc = cmd.spawn().map_err(|e| {
            self.is_booting.store(false, Ordering::SeqCst);
            format!("无法启动 GravityBox Node 后端 ({}): {}", target.node_exe.display(), e)
        })?;

        {
            let mut guard = self.child.lock().unwrap();
            *guard = Some(child_proc);
        }
        self.owns_process.store(true, Ordering::SeqCst);

        // Wait briefly for the Named Pipe to become reachable (non-fatal if still warming up)
        let wait_deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < wait_deadline {
            if self.ping() {
                break;
            }
            std::thread::sleep(Duration::from_millis(80));
        }
        self.is_booting.store(false, Ordering::SeqCst);

        Ok(())
    }

    /// Background supervisor that detects unexpected backend crashes and restarts automatically.
    pub fn spawn_watchdog(self: &Arc<Self>) {
        let mgr = Arc::clone(self);
        std::thread::spawn(move || {
            let mut restart_window_start = Instant::now();
            let mut restarts_in_window: u32 = 0;

            loop {
                std::thread::sleep(Duration::from_millis(1500));
                if mgr.shutting_down.load(Ordering::SeqCst) {
                    break;
                }
                if !mgr.owns_process.load(Ordering::SeqCst) {
                    continue;
                }

                let exited = {
                    let mut guard = mgr.child.lock().unwrap();
                    if let Some(ref mut c) = *guard {
                        match c.try_wait() {
                            Ok(Some(_status)) => {
                                *guard = None;
                                true
                            }
                            Ok(None) => false,
                            Err(_) => false,
                        }
                    } else {
                        false
                    }
                };

                if exited && !mgr.shutting_down.load(Ordering::SeqCst) {
                    if restart_window_start.elapsed() > Duration::from_secs(60) {
                        restart_window_start = Instant::now();
                        restarts_in_window = 0;
                    }
                    if restarts_in_window >= 5 {
                        // Prevent hot restart loop; user can manually reconnect
                        std::thread::sleep(Duration::from_secs(10));
                        continue;
                    }
                    restarts_in_window += 1;
                    let backoff_ms = 600u64 * (1u64 << (restarts_in_window - 1).min(4));
                    std::thread::sleep(Duration::from_millis(backoff_ms));
                    if !mgr.shutting_down.load(Ordering::SeqCst) {
                        let _ = mgr.ensure_started();
                    }
                }
            }
        });
    }

    /// Send an NDJSON command over the Windows Named Pipe with retry/backoff matching `native/Backend.swift`.
    pub fn request(&self, payload: Value) -> Result<Value, String> {
        let command = payload
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let timeout = match command {
            "stop" => Duration::from_secs(30),
            "account_switch" => Duration::from_secs(65),
            "status" | "ping" | "task_list" => Duration::from_secs(8),
            _ => Duration::from_secs(45),
        };

        let booting = self.is_booting.load(Ordering::SeqCst) || self.owns_process.load(Ordering::SeqCst);
        let max_attempts: usize = if booting { 10 } else { 3 };
        let delays_ms: [u64; 9] = [25, 40, 60, 90, 130, 180, 240, 320, 420];
        let mut last_err: Option<PipeError> = None;

        for attempt in 0..max_attempts {
            match send_ndjson_request(&self.pipe_name, &payload, timeout) {
                Ok(val) => return Ok(val),
                Err(err) => {
                    let retryable = err.retryable;
                    last_err = Some(err);
                    if !retryable || attempt + 1 >= max_attempts {
                        break;
                    }
                    // On first connection failure, try ensuring backend is started if not shutting down
                    if attempt == 1 && !self.shutting_down.load(Ordering::SeqCst) && command != "stop" {
                        let _ = self.ensure_started();
                    }
                    let delay = delays_ms[attempt.min(delays_ms.len() - 1)];
                    std::thread::sleep(Duration::from_millis(delay));
                }
            }
        }

        Err(last_err
            .map(|e| e.message)
            .unwrap_or_else(|| "后台尚未连接。请稍候，或点击重新连接。".to_string()))
    }

    pub fn restart(&self) -> Result<(), String> {
        self.stop_owned_child();
        self.shutting_down.store(false, Ordering::SeqCst);
        self.ensure_started()
    }

    fn stop_owned_child(&self) {
        let owns = self.owns_process.swap(false, Ordering::SeqCst);
        if owns {
            let _ = send_ndjson_request(
                &self.pipe_name,
                &json!({ "command": "stop" }),
                Duration::from_millis(1500),
            );
            let deadline = Instant::now() + Duration::from_millis(1800);
            loop {
                let still_running = {
                    let mut guard = self.child.lock().unwrap();
                    if let Some(ref mut c) = *guard {
                        match c.try_wait() {
                            Ok(Some(_)) => {
                                *guard = None;
                                false
                            }
                            Ok(None) => true,
                            Err(_) => {
                                *guard = None;
                                false
                            }
                        }
                    } else {
                        false
                    }
                };
                if !still_running || Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            let mut guard = self.child.lock().unwrap();
            if let Some(mut c) = guard.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }

    pub fn graceful_stop(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.stop_owned_child();
    }
}

impl Drop for BackendManager {
    fn drop(&mut self) {
        self.graceful_stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_runtime_target_and_win_helper_strip_verbatim_prefix() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let base = strip_verbatim_prefix(&std::env::temp_dir())
            .join(format!("gb-verbatim-test-{}-{}", std::process::id(), stamp));
        let resources = base.join("resources");
        let runtime_dir = resources.join("runtime");
        let core_dist = resources.join("core").join("dist");
        fs::create_dir_all(&runtime_dir).unwrap();
        fs::create_dir_all(&core_dist).unwrap();
        fs::write(runtime_dir.join("node.exe"), b"stub").unwrap();
        fs::write(core_dist.join("main.js"), b"// stub").unwrap();
        fs::write(resources.join("gravitybox-win-helper.exe"), b"stub").unwrap();

        // Simulate Tauri 2 on Windows returning a `\\?\` verbatim path from `app.path().resource_dir()`
        let verbatim_resource_dir = PathBuf::from(format!(r"\\?\{}", base.display()));
        let verbatim_state_dir = PathBuf::from(format!(r"\\?\{}", base.join("state").display()));

        let mgr = BackendManager::new_with_options(
            verbatim_state_dir,
            Some(verbatim_resource_dir.clone()),
            true,
        );
        assert!(
            !mgr.state_dir.to_string_lossy().starts_with(r"\\?\"),
            "state_dir must not contain verbatim prefix: {:?}",
            mgr.state_dir
        );
        let target = mgr
            .resolve_runtime_target()
            .expect("should resolve portable runtime target");
        assert!(
            !target.node_exe.to_string_lossy().starts_with(r"\\?\"),
            "node_exe must not contain verbatim prefix: {:?}",
            target.node_exe
        );
        assert!(
            !target.main_js.to_string_lossy().starts_with(r"\\?\"),
            "main_js must not contain verbatim prefix: {:?}",
            target.main_js
        );
        assert!(
            !target.working_dir.to_string_lossy().starts_with(r"\\?\"),
            "working_dir must not contain verbatim prefix: {:?}",
            target.working_dir
        );
        assert_eq!(target.node_exe, runtime_dir.join("node.exe"));
        assert_eq!(target.main_js, core_dist.join("main.js"));
        assert_eq!(target.working_dir, resources.join("core"));

        // Verify resolve_win_helper_exe also strips `\\?\` when passed a verbatim resource_dir
        let helper = resolve_win_helper_exe(Some(&verbatim_resource_dir))
            .expect("should resolve portable win-helper");
        assert!(
            !helper.to_string_lossy().starts_with(r"\\?\"),
            "win-helper path must not contain verbatim prefix: {:?}",
            helper
        );
        assert_eq!(helper, resources.join("gravitybox-win-helper.exe"));

        let _ = fs::remove_dir_all(&base);
    }
}
