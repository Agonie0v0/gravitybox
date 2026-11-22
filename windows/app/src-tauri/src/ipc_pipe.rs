use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

const MAX_REPLY_BYTES: usize = 4_000_000;

#[derive(Debug, Clone)]
pub struct PipeError {
    pub message: String,
    pub retryable: bool,
}

impl std::fmt::Display for PipeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for PipeError {}

/// Strip Win32 extended-length verbatim prefixes (`\\?\` and `\\?\UNC\`) so external
/// processes (Node.js v22, `explorer.exe`, Win32 helper, Windows Run registry) never receive
/// `\\?\D:\...` paths that break Node's internal `realpathSync`/`lstat`.
pub fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if raw.len() >= 8 && raw[..8].eq_ignore_ascii_case(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{}", &raw[8..]))
    } else if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path.to_path_buf()
    }
}

/// Extract an explicit `--state-dir <path>` or `--state-dir=<path>` CLI override.
pub fn parse_cli_state_dir(args: &[String]) -> Option<PathBuf> {
    let mut iter = args.iter().skip(1);
    while let Some(arg) = iter.next() {
        if let Some(val) = arg.strip_prefix("--state-dir=") {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return Some(strip_verbatim_prefix(Path::new(trimmed)));
            }
        } else if arg == "--state-dir" {
            if let Some(next) = iter.next() {
                let trimmed = next.trim();
                if !trimmed.is_empty() {
                    return Some(strip_verbatim_prefix(Path::new(trimmed)));
                }
            }
        }
    }
    None
}

/// Resolve an explicit state-dir override from CLI `--state-dir` or `GRAVITYBOX_STATE_DIR` env.
pub fn resolve_explicit_state_dir(args: &[String]) -> Option<PathBuf> {
    if let Some(cli) = parse_cli_state_dir(args) {
        return Some(cli);
    }
    if let Ok(override_dir) = std::env::var("GRAVITYBOX_STATE_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return Some(strip_verbatim_prefix(Path::new(trimmed)));
        }
    }
    None
}

/// Default GravityBox state directory on Windows: `%APPDATA%\GravityBox`.
/// Respects `GRAVITYBOX_STATE_DIR` override when set.
pub fn resolve_state_dir() -> PathBuf {
    if let Ok(override_dir) = std::env::var("GRAVITYBOX_STATE_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return strip_verbatim_prefix(Path::new(trimmed));
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        let trimmed = appdata.trim();
        if !trimmed.is_empty() {
            return strip_verbatim_prefix(&PathBuf::from(trimmed).join("GravityBox"));
        }
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        return strip_verbatim_prefix(
            &PathBuf::from(profile)
                .join("AppData")
                .join("Roaming")
                .join("GravityBox"),
        );
    }
    PathBuf::from(".").join("GravityBox")
}

/// Default GravityBox log directory on Windows: `%LOCALAPPDATA%\GravityBox\Logs`.
pub fn resolve_log_dir() -> PathBuf {
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let trimmed = local_app_data.trim();
        if !trimmed.is_empty() {
            return strip_verbatim_prefix(&PathBuf::from(trimmed).join("GravityBox").join("Logs"));
        }
    }
    resolve_state_dir().join("Logs")
}

/// Match Node.js `path.resolve(stateDir).replace(/^\\\\\?\\/, '')` on Windows:
/// - Make absolute against `current_dir` if relative
/// - Normalize `.` and `..` components
/// - Use backslash separators
/// - Strip verbatim `\\?\` prefix
/// - Strip trailing backslash unless drive root (`C:\`)
pub fn normalize_windows_path(path: &Path) -> String {
    let stripped_input = strip_verbatim_prefix(path);
    let abs = if stripped_input.is_absolute() {
        stripped_input
    } else {
        strip_verbatim_prefix(&std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
            .join(stripped_input)
    };

    let mut normalized = PathBuf::new();
    for comp in abs.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }

    let mut raw = strip_verbatim_prefix(&normalized)
        .to_string_lossy()
        .replace('/', "\\");
    // Trim trailing backslash unless it is a drive root like "C:\"
    while raw.ends_with('\\') && raw.len() > 3 {
        raw.pop();
    }
    raw
}

/// Deterministic Windows Named Pipe matching `src/platform/ipc.ts`:
/// `\\.\pipe\gravitybox-${sha256(resolve(stateDir).toLowerCase()).slice(0, 24)}`
pub fn resolve_ipc_pipe_name(state_dir: &Path) -> String {
    let resolved = normalize_windows_path(state_dir);
    let lower = resolved.to_lowercase();
    let mut hasher = Sha256::new();
    hasher.update(lower.as_bytes());
    let digest = hasher.finalize();
    let hex_full: String = digest.iter().map(|b| format!("{:02x}", b)).collect();
    format!(r"\\.\pipe\gravitybox-{}", &hex_full[..24])
}

#[cfg(windows)]
mod win_impl {
    use super::*;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_FILE_NOT_FOUND, ERROR_IO_PENDING, ERROR_MORE_DATA,
        ERROR_PIPE_BUSY, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
        WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Pipes::WaitNamedPipeW;
    use windows_sys::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
    use windows_sys::Win32::System::IO::{CancelIo, GetOverlappedResult, OVERLAPPED};

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    fn to_wide_null(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    fn remaining_ms(deadline: Instant) -> u32 {
        let now = Instant::now();
        if now >= deadline {
            0
        } else {
            deadline
                .saturating_duration_since(now)
                .as_millis()
                .min(u32::MAX as u128) as u32
        }
    }

    fn open_pipe(pipe_name: &str, deadline: Instant) -> Result<OwnedHandle, PipeError> {
        let wide = to_wide_null(pipe_name);
        loop {
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    null_mut(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED,
                    null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE && !handle.is_null() {
                return Ok(OwnedHandle(handle));
            }
            let err = unsafe { GetLastError() };
            if err == ERROR_PIPE_BUSY {
                let rem = remaining_ms(deadline);
                if rem == 0 {
                    return Err(PipeError {
                        message: "后台响应超时，请稍后重试".to_string(),
                        retryable: true,
                    });
                }
                let wait_ms = rem.min(1500);
                unsafe {
                    WaitNamedPipeW(wide.as_ptr(), wait_ms);
                }
                continue;
            }
            if err == ERROR_FILE_NOT_FOUND {
                return Err(PipeError {
                    message: "后台尚未连接。请稍候，或点击重新连接。".to_string(),
                    retryable: true,
                });
            }
            return Err(PipeError {
                message: format!("无法建立本机管道连接 (Win32 error {})", err),
                retryable: true,
            });
        }
    }

    fn cancel_and_drain_overlapped(pipe: &OwnedHandle, ov: &OVERLAPPED) {
        let mut dummy: u32 = 0;
        unsafe {
            CancelIo(pipe.0);
            // Synchronously wait for the kernel to finalize the cancelled IRP before `ov`
            // and the associated I/O buffer leave scope, preventing stack/heap use-after-free.
            GetOverlappedResult(pipe.0, ov, &mut dummy, 1);
        }
    }

    fn write_all_overlapped(
        pipe: &OwnedHandle,
        event: &OwnedHandle,
        data: &[u8],
        deadline: Instant,
    ) -> Result<(), PipeError> {
        let mut offset = 0usize;
        while offset < data.len() {
            let rem = remaining_ms(deadline);
            if rem == 0 {
                return Err(PipeError {
                    message: "本机请求发送超时".to_string(),
                    retryable: false,
                });
            }
            let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
            ov.hEvent = event.0;
            let mut written: u32 = 0;
            let chunk = &data[offset..];
            let to_write = chunk.len().min(u32::MAX as usize) as u32;
            let ok = unsafe {
                WriteFile(
                    pipe.0,
                    chunk.as_ptr(),
                    to_write,
                    &mut written,
                    &mut ov,
                )
            };
            if ok != 0 {
                offset += written as usize;
                continue;
            }
            let err = unsafe { GetLastError() };
            if err == ERROR_IO_PENDING {
                let wait = unsafe { WaitForSingleObject(event.0, rem) };
                if wait == WAIT_TIMEOUT {
                    cancel_and_drain_overlapped(pipe, &ov);
                    return Err(PipeError {
                        message: "本机请求发送超时".to_string(),
                        retryable: false,
                    });
                }
                if wait != WAIT_OBJECT_0 {
                    cancel_and_drain_overlapped(pipe, &ov);
                    return Err(PipeError {
                        message: "本机请求未能完整发送".to_string(),
                        retryable: false,
                    });
                }
                let res = unsafe { GetOverlappedResult(pipe.0, &ov, &mut written, 0) };
                if res == 0 || written == 0 {
                    return Err(PipeError {
                        message: "本机请求未能完整发送".to_string(),
                        retryable: false,
                    });
                }
                offset += written as usize;
                continue;
            }
            return Err(PipeError {
                message: format!("本机请求写入失败 (Win32 error {})", err),
                retryable: false,
            });
        }
        Ok(())
    }

    fn read_line_overlapped(
        pipe: &OwnedHandle,
        event: &OwnedHandle,
        deadline: Instant,
    ) -> Result<Vec<u8>, PipeError> {
        let mut reply = Vec::with_capacity(4096);
        let mut buf = vec![0u8; 65_536];
        loop {
            let rem = remaining_ms(deadline);
            if rem == 0 {
                return Err(PipeError {
                    message: "后台响应超时，请稍后重试".to_string(),
                    retryable: false,
                });
            }
            let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
            ov.hEvent = event.0;
            let mut read_bytes: u32 = 0;
            let ok = unsafe {
                ReadFile(
                    pipe.0,
                    buf.as_mut_ptr(),
                    buf.len() as u32,
                    &mut read_bytes,
                    &mut ov,
                )
            };
            if ok != 0 {
                if read_bytes == 0 {
                    break;
                }
                reply.extend_from_slice(&buf[..read_bytes as usize]);
                if reply.len() > MAX_REPLY_BYTES {
                    return Err(PipeError {
                        message: "后台响应超出大小限制".to_string(),
                        retryable: false,
                    });
                }
                if reply.contains(&b'\n') {
                    break;
                }
                continue;
            }
            let err = unsafe { GetLastError() };
            if err == ERROR_MORE_DATA {
                if read_bytes > 0 {
                    reply.extend_from_slice(&buf[..read_bytes as usize]);
                }
                if reply.len() > MAX_REPLY_BYTES {
                    return Err(PipeError {
                        message: "后台响应超出大小限制".to_string(),
                        retryable: false,
                    });
                }
                if reply.contains(&b'\n') {
                    break;
                }
                continue;
            }
            if err == ERROR_IO_PENDING {
                let wait = unsafe { WaitForSingleObject(event.0, rem) };
                if wait == WAIT_TIMEOUT {
                    cancel_and_drain_overlapped(pipe, &ov);
                    return Err(PipeError {
                        message: "后台响应超时，请稍后重试".to_string(),
                        retryable: false,
                    });
                }
                if wait != WAIT_OBJECT_0 {
                    cancel_and_drain_overlapped(pipe, &ov);
                    return Err(PipeError {
                        message: "后台响应无效或连接已中断".to_string(),
                        retryable: false,
                    });
                }
                let res = unsafe { GetOverlappedResult(pipe.0, &ov, &mut read_bytes, 0) };
                if res == 0 {
                    let ov_err = unsafe { GetLastError() };
                    if ov_err == ERROR_MORE_DATA && read_bytes > 0 {
                        reply.extend_from_slice(&buf[..read_bytes as usize]);
                        if reply.contains(&b'\n') {
                            break;
                        }
                        continue;
                    }
                    if !reply.is_empty() && reply.contains(&b'\n') {
                        break;
                    }
                    return Err(PipeError {
                        message: "后台响应无效或连接已中断".to_string(),
                        retryable: false,
                    });
                }
                if read_bytes == 0 {
                    break;
                }
                reply.extend_from_slice(&buf[..read_bytes as usize]);
                if reply.len() > MAX_REPLY_BYTES {
                    return Err(PipeError {
                        message: "后台响应超出大小限制".to_string(),
                        retryable: false,
                    });
                }
                if reply.contains(&b'\n') {
                    break;
                }
                continue;
            }
            // Peer closed after writing full line
            if !reply.is_empty() {
                break;
            }
            return Err(PipeError {
                message: "后台响应无效或连接已中断".to_string(),
                retryable: false,
            });
        }
        Ok(reply)
    }

    pub fn send_ndjson_request(
        pipe_name: &str,
        payload: &Value,
        timeout: Duration,
    ) -> Result<Value, PipeError> {
        let deadline = Instant::now() + timeout;
        let pipe = open_pipe(pipe_name, deadline)?;

        let event_handle = unsafe { CreateEventW(null_mut(), 1, 0, null_mut()) };
        if event_handle.is_null() {
            return Err(PipeError {
                message: "无法创建异步 IPC 事件句柄".to_string(),
                retryable: false,
            });
        }
        let event = OwnedHandle(event_handle);

        let mut encoded = serde_json::to_vec(payload).map_err(|e| PipeError {
            message: format!("请求序列化失败: {}", e),
            retryable: false,
        })?;
        encoded.push(b'\n');

        write_all_overlapped(&pipe, &event, &encoded, deadline)?;
        let raw = read_line_overlapped(&pipe, &event, deadline)?;

        let line = match raw.iter().position(|&b| b == b'\n') {
            Some(pos) => &raw[..pos],
            None => raw.as_slice(),
        };
        let value: Value = serde_json::from_slice(line).map_err(|_| PipeError {
            message: "后台响应无效或连接已中断".to_string(),
            retryable: false,
        })?;

        if value.get("ok").and_then(|v| v.as_bool()) == Some(false) {
            let msg = value
                .get("error")
                .and_then(|v| v.as_str())
                .or_else(|| value.get("message").and_then(|v| v.as_str()))
                .unwrap_or("操作未完成")
                .to_string();
            return Err(PipeError {
                message: msg,
                retryable: false,
            });
        }

        Ok(value)
    }
}

#[cfg(windows)]
pub fn send_ndjson_request(
    pipe_name: &str,
    payload: &Value,
    timeout: Duration,
) -> Result<Value, PipeError> {
    win_impl::send_ndjson_request(pipe_name, payload, timeout)
}

#[cfg(not(windows))]
pub fn send_ndjson_request(
    _pipe_name: &str,
    _payload: &Value,
    _timeout: Duration,
) -> Result<Value, PipeError> {
    Err(PipeError {
        message: "Windows Named Pipe IPC is only supported on Windows".to_string(),
        retryable: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_name_matches_node_algorithm() {
        let p = Path::new(r"C:\Users\demo\AppData\Roaming\GravityBox");
        let pipe = resolve_ipc_pipe_name(p);
        assert_eq!(pipe, r"\\.\pipe\gravitybox-3aef367f2e1750c7f96781fd");
        // Same path with trailing slash or different casing produces identical pipe name
        let p2 = Path::new(r"c:\users\demo\appdata\roaming\gravitybox\");
        assert_eq!(pipe, resolve_ipc_pipe_name(p2));
        // Verbatim prefix is stripped before hashing
        let p3 = Path::new(r"\\?\C:\Users\demo\AppData\Roaming\GravityBox");
        assert_eq!(pipe, resolve_ipc_pipe_name(p3));
    }

    #[test]
    fn strip_verbatim_and_cli_state_dir_work() {
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"\\?\D:\AI\GravityBox")),
            PathBuf::from(r"D:\AI\GravityBox")
        );
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"\\?\UNC\fileserver\share\GravityBox")),
            PathBuf::from(r"\\fileserver\share\GravityBox")
        );
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"\\?\unc\fileserver\share\GravityBox")),
            PathBuf::from(r"\\fileserver\share\GravityBox")
        );
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"D:\AI\GravityBox")),
            PathBuf::from(r"D:\AI\GravityBox")
        );

        let args1 = vec![
            "GravityBox.exe".to_string(),
            "--state-dir".to_string(),
            r"\\?\C:\Temp\gb-state".to_string(),
        ];
        assert_eq!(parse_cli_state_dir(&args1), Some(PathBuf::from(r"C:\Temp\gb-state")));

        let args2 = vec![
            "GravityBox.exe".to_string(),
            r"--state-dir=\\?\C:\Temp\gb-state-2".to_string(),
        ];
        assert_eq!(parse_cli_state_dir(&args2), Some(PathBuf::from(r"C:\Temp\gb-state-2")));
    }
}
