use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

const MAX_REPLY_BYTES: usize = 4_000_000;
const IPC_SESSION_FILENAME: &str = "ipc-session.json";
const MAX_SESSION_FILE_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone)]
pub struct PipeError {
    pub message: String,
    pub retryable: bool,
}

impl fmt::Display for PipeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for PipeError {}

/// Per-startup Windows IPC session written by GravityBox Node backend to `<stateDir>/ipc-session.json`.
/// `Debug` intentionally redacts `auth_token` so it can never leak into logs or error reports.
#[derive(Clone, PartialEq, Eq)]
pub struct WindowsIpcSession {
    pub schema: u32,
    pub pipe_name: String,
    pub auth_token: String,
    pub pid: u32,
    pub created_at: String,
}

impl fmt::Debug for WindowsIpcSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WindowsIpcSession")
            .field("schema", &self.schema)
            .field("pipe_name", &self.pipe_name)
            .field("auth_token", &"[REDACTED]")
            .field("pid", &self.pid)
            .field("created_at", &self.created_at)
            .finish()
    }
}

fn zeroize_bytes(buf: &mut [u8]) {
    for b in buf.iter_mut() {
        unsafe {
            std::ptr::write_volatile(b, 0);
        }
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}

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

fn sha256_hex_state_dir(state_dir: &Path) -> String {
    let resolved = normalize_windows_path(state_dir);
    let lower = resolved.to_lowercase();
    let mut hasher = Sha256::new();
    hasher.update(lower.as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 16-char state hash matching `src/platform/ipc.ts` `computeWindowsStateHash16(stateDir)`.
pub fn compute_windows_state_hash16(state_dir: &Path) -> String {
    sha256_hex_state_dir(state_dir)[..16].to_string()
}

/// Deterministic fallback pipe name matching `src/platform/ipc.ts` `resolveIpcEndpoint`.
#[cfg(test)]
pub fn resolve_ipc_pipe_name(state_dir: &Path) -> String {
    let hex_full = sha256_hex_state_dir(state_dir);
    format!(r"\\.\pipe\gravitybox-{}", &hex_full[..24])
}

fn is_ascii_hex_lower_or_upper(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Strictly validate `authToken` matches `/^[0-9a-f]{64}$/` (`src/platform/ipc.ts`).
pub fn is_valid_auth_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Strictly validate `pipeName` matches `\\.\pipe\gravitybox-<stateHash16>-<random16>` bound to `state_dir`.
pub fn is_valid_session_pipe_name(pipe_name: &str, state_dir: &Path) -> bool {
    if pipe_name.contains('\0') {
        return false;
    }
    let expected_prefix = format!(
        r"\\.\pipe\gravitybox-{}-",
        compute_windows_state_hash16(state_dir)
    );
    if pipe_name.len() != expected_prefix.len() + 16 {
        return false;
    }
    let prefix_part = &pipe_name[..expected_prefix.len()];
    let random_part = &pipe_name[expected_prefix.len()..];
    prefix_part.eq_ignore_ascii_case(&expected_prefix) && is_ascii_hex_lower_or_upper(random_part)
}

/// Read and strictly validate `<stateDir>/ipc-session.json` against `state_dir`.
/// - Returns `Ok(None)` when the session file is absent or transiently incomplete during startup.
/// - Returns `Err(non-retryable)` if the session path is a symlink or non-regular file.
pub fn read_ipc_session(state_dir: &Path) -> Result<Option<WindowsIpcSession>, PipeError> {
    let session_path = state_dir.join(IPC_SESSION_FILENAME);
    let meta = match fs::symlink_metadata(&session_path) {
        Ok(m) => m,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(PipeError {
                message: "无法读取本机服务会话文件".to_string(),
                retryable: true,
            });
        }
    };
    if meta.file_type().is_symlink() || !meta.file_type().is_file() {
        return Err(PipeError {
            message: "本机服务会话文件异常，已拒绝连接".to_string(),
            retryable: false,
        });
    }
    if meta.len() > MAX_SESSION_FILE_BYTES {
        return Err(PipeError {
            message: "本机服务会话文件超出大小限制，已拒绝连接".to_string(),
            retryable: false,
        });
    }

    let raw = match fs::read_to_string(&session_path) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let Some(obj) = parsed.as_object() else {
        return Ok(None);
    };

    let schema = obj.get("schema").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    if schema != 1 {
        return Ok(None);
    }

    let pipe_name = obj
        .get("pipeName")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    if !is_valid_session_pipe_name(pipe_name, state_dir) {
        return Ok(None);
    }

    let auth_token = obj.get("authToken").and_then(|v| v.as_str()).unwrap_or("");
    if !is_valid_auth_token(auth_token) {
        return Ok(None);
    }

    let pid_u64 = obj.get("pid").and_then(|v| v.as_u64()).unwrap_or(0);
    let Ok(pid) = u32::try_from(pid_u64) else {
        return Ok(None);
    };
    if pid == 0 {
        return Ok(None);
    }

    let created_at = obj
        .get("createdAt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(Some(WindowsIpcSession {
        schema,
        pipe_name: pipe_name.to_string(),
        auth_token: auth_token.to_string(),
        pid,
        created_at,
    }))
}

#[cfg(windows)]
mod win_impl {
    use super::*;
    use std::ffi::{c_void, OsStr};
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND,
        ERROR_INSUFFICIENT_BUFFER, ERROR_IO_PENDING, ERROR_MORE_DATA, ERROR_PATH_NOT_FOUND,
        ERROR_PIPE_BUSY, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
        WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Security::{
        EqualSid, GetTokenInformation, IsValidSid, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
        SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
    };
    use windows_sys::Win32::System::Pipes::{GetNamedPipeServerProcessId, WaitNamedPipeW};
    use windows_sys::Win32::System::Threading::{
        CreateEventW, GetCurrentProcess, OpenProcess, OpenProcessToken, WaitForSingleObject,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::System::IO::{CancelIo, GetOverlappedResult, OVERLAPPED};

    const MAX_TOKEN_USER_BYTES: usize = 64 * 1024;

    pub(super) struct OwnedHandle(pub(super) HANDLE);

    impl OwnedHandle {
        pub(super) fn new(raw: HANDLE) -> Option<Self> {
            if raw.is_null() || raw == INVALID_HANDLE_VALUE {
                None
            } else {
                Some(Self(raw))
            }
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    struct TokenUserBuffer {
        buf: Vec<usize>,
        byte_len: usize,
    }

    impl TokenUserBuffer {
        fn from_process(process_handle: HANDLE) -> Result<Self, u32> {
            let mut token_raw: HANDLE = null_mut();
            let ok = unsafe { OpenProcessToken(process_handle, TOKEN_QUERY, &mut token_raw) };
            if ok == 0 {
                return Err(unsafe { GetLastError() });
            }
            let token = OwnedHandle::new(token_raw).ok_or(0u32)?;

            let mut needed: u32 = 0;
            let probe_ok = unsafe {
                GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut needed)
            };
            if probe_ok != 0 {
                return Err(0);
            }
            let err = unsafe { GetLastError() };
            if err != ERROR_INSUFFICIENT_BUFFER {
                return Err(err);
            }
            let needed_usize = needed as usize;
            if needed_usize < size_of::<TOKEN_USER>() || needed_usize > MAX_TOKEN_USER_BYTES {
                return Err(ERROR_INSUFFICIENT_BUFFER);
            }

            let words = needed_usize.div_ceil(size_of::<usize>());
            let mut buf = vec![0usize; words];
            let alloc_bytes = buf.len() * size_of::<usize>();
            let mut actual: u32 = 0;
            let read_ok = unsafe {
                GetTokenInformation(
                    token.0,
                    TokenUser,
                    buf.as_mut_ptr() as *mut c_void,
                    alloc_bytes as u32,
                    &mut actual,
                )
            };
            if read_ok == 0 {
                return Err(unsafe { GetLastError() });
            }
            let actual_usize = actual as usize;
            if actual_usize < size_of::<TOKEN_USER>() || actual_usize > alloc_bytes {
                return Err(ERROR_INSUFFICIENT_BUFFER);
            }
            Ok(Self {
                buf,
                byte_len: actual_usize,
            })
        }

        fn sid_ptr(&self) -> Option<*mut c_void> {
            if self.byte_len < size_of::<TOKEN_USER>() {
                return None;
            }
            let tu = unsafe { &*(self.buf.as_ptr() as *const TOKEN_USER) };
            let sid = tu.User.Sid;
            if sid.is_null() {
                return None;
            }
            let base = self.buf.as_ptr() as usize;
            let end = base.checked_add(self.byte_len)?;
            let p = sid as usize;
            if p < base || p >= end {
                return None;
            }
            if unsafe { IsValidSid(sid) } == 0 {
                return None;
            }
            Some(sid)
        }
    }

    fn verify_same_user_sid(server_pid: u32) -> Result<bool, u32> {
        let self_user = TokenUserBuffer::from_process(unsafe { GetCurrentProcess() })?;
        let Some(self_sid) = self_user.sid_ptr() else {
            return Ok(false);
        };
        let Some(server_proc) = OwnedHandle::new(unsafe {
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, server_pid)
        }) else {
            return Ok(false);
        };
        let server_user = match TokenUserBuffer::from_process(server_proc.0) {
            Ok(u) => u,
            Err(_) => return Ok(false),
        };
        let Some(server_sid) = server_user.sid_ptr() else {
            return Ok(false);
        };
        Ok(unsafe { EqualSid(self_sid, server_sid) != 0 })
    }

    pub(super) fn to_wide_null(s: &str) -> Vec<u16> {
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

    /// Connect to the Named Pipe with `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION` and
    /// immediately verify BOTH `GetNamedPipeServerProcessId == session.pid` AND same Windows user
    /// SID (`EqualSid`) BEFORE sending any bytes (including `authToken`).
    fn open_pipe_verified(
        session: &WindowsIpcSession,
        deadline: Instant,
    ) -> Result<OwnedHandle, PipeError> {
        let wide = to_wide_null(&session.pipe_name);
        let flags = FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION;
        let pipe = loop {
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    null(),
                    OPEN_EXISTING,
                    flags,
                    null_mut(),
                )
            };
            if let Some(owned) = OwnedHandle::new(handle) {
                break owned;
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
            if err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND {
                return Err(PipeError {
                    message: "后台尚未连接。请稍候，或点击重新连接。".to_string(),
                    retryable: true,
                });
            }
            if err == ERROR_ACCESS_DENIED {
                return Err(PipeError {
                    message: "本机管道服务端权限校验失败，已拒绝连接".to_string(),
                    retryable: false,
                });
            }
            return Err(PipeError {
                message: format!("无法建立本机管道连接 (Win32 error {})", err),
                retryable: true,
            });
        };

        // Mandatory peer identity verification before writing any payload or authToken.
        let mut server_pid: u32 = 0;
        let got_pid = unsafe { GetNamedPipeServerProcessId(pipe.0, &mut server_pid) };
        if got_pid == 0 || server_pid == 0 {
            drop(pipe);
            return Err(PipeError {
                message: "无法验证本机管道服务端进程身份，已拒绝连接".to_string(),
                retryable: false,
            });
        }
        if server_pid != session.pid {
            drop(pipe);
            return Err(PipeError {
                message: "本机管道服务端进程与会话记录不匹配，已拒绝连接".to_string(),
                retryable: false,
            });
        }
        match verify_same_user_sid(server_pid) {
            Ok(true) => Ok(pipe),
            _ => {
                drop(pipe);
                Err(PipeError {
                    message: "本机管道服务端用户身份不匹配，已拒绝连接".to_string(),
                    retryable: false,
                })
            }
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

    pub fn send_authenticated_request(
        session: &WindowsIpcSession,
        payload: &Value,
        timeout: Duration,
    ) -> Result<Value, PipeError> {
        let deadline = Instant::now() + timeout;
        let pipe = open_pipe_verified(session, deadline)?;

        let event_handle = unsafe { CreateEventW(null_mut(), 1, 0, null_mut()) };
        let Some(event) = OwnedHandle::new(event_handle) else {
            return Err(PipeError {
                message: "无法创建异步 IPC 事件句柄".to_string(),
                retryable: false,
            });
        };

        // Inject session `authToken` ONLY after peer PID and SID verification succeeded.
        let mut authed = payload.clone();
        let Some(map) = authed.as_object_mut() else {
            return Err(PipeError {
                message: "IPC 请求体必须为 JSON 对象".to_string(),
                retryable: false,
            });
        };
        map.insert(
            "authToken".to_string(),
            Value::String(session.auth_token.clone()),
        );

        let mut encoded = serde_json::to_vec(&authed).map_err(|_| PipeError {
            message: "请求序列化失败".to_string(),
            retryable: false,
        })?;
        encoded.push(b'\n');

        let write_result = write_all_overlapped(&pipe, &event, &encoded, deadline);
        // Zeroize serialized request containing `authToken` immediately after writing.
        zeroize_bytes(&mut encoded);
        write_result?;

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

/// Read `<stateDir>/ipc-session.json`, verify the pipe server's PID & same-user SID,
/// inject `authToken`, and send a single NDJSON request over the verified Windows Named Pipe.
#[cfg(windows)]
pub fn send_session_ndjson_request(
    state_dir: &Path,
    payload: &Value,
    timeout: Duration,
) -> Result<Value, PipeError> {
    let Some(session) = read_ipc_session(state_dir)? else {
        return Err(PipeError {
            message: "后台尚未连接。请稍候，或点击重新连接。".to_string(),
            retryable: true,
        });
    };
    win_impl::send_authenticated_request(&session, payload, timeout)
}

#[cfg(not(windows))]
pub fn send_session_ndjson_request(
    _state_dir: &Path,
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
    use serde_json::json;

    #[test]
    fn pipe_name_and_state_hash16_match_node_algorithm() {
        let p = Path::new(r"C:\Users\demo\AppData\Roaming\GravityBox");
        let pipe = resolve_ipc_pipe_name(p);
        assert_eq!(pipe, r"\\.\pipe\gravitybox-3aef367f2e1750c7f96781fd");
        assert_eq!(compute_windows_state_hash16(p), "3aef367f2e1750c7");
        // Same path with trailing slash or different casing produces identical hash
        let p2 = Path::new(r"c:\users\demo\appdata\roaming\gravitybox\");
        assert_eq!(pipe, resolve_ipc_pipe_name(p2));
        assert_eq!(compute_windows_state_hash16(p2), "3aef367f2e1750c7");
        // Verbatim prefix is stripped before hashing
        let p3 = Path::new(r"\\?\C:\Users\demo\AppData\Roaming\GravityBox");
        assert_eq!(pipe, resolve_ipc_pipe_name(p3));
        assert_eq!(compute_windows_state_hash16(p3), "3aef367f2e1750c7");
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
        assert_eq!(
            parse_cli_state_dir(&args1),
            Some(PathBuf::from(r"C:\Temp\gb-state"))
        );

        let args2 = vec![
            "GravityBox.exe".to_string(),
            r"--state-dir=\\?\C:\Temp\gb-state-2".to_string(),
        ];
        assert_eq!(
            parse_cli_state_dir(&args2),
            Some(PathBuf::from(r"C:\Temp\gb-state-2"))
        );
    }

    #[test]
    fn ipc_session_parsing_validates_fields_and_redacts_debug() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = strip_verbatim_prefix(&std::env::temp_dir())
            .join(format!("gb-session-parse-{}-{}", std::process::id(), stamp));
        fs::create_dir_all(&dir).unwrap();

        let hash16 = compute_windows_state_hash16(&dir);
        let good_pipe = format!(r"\\.\pipe\gravitybox-{}-0123456789abcdef", hash16);
        let good_token = "a".repeat(64);

        // 1. Valid session parses cleanly and redacts auth_token in Debug output
        fs::write(
            dir.join(IPC_SESSION_FILENAME),
            serde_json::to_string(&json!({
                "schema": 1,
                "pipeName": good_pipe,
                "authToken": good_token,
                "pid": std::process::id(),
                "createdAt": "2026-11-23T00:00:00.000Z"
            }))
            .unwrap(),
        )
        .unwrap();
        let parsed = read_ipc_session(&dir).unwrap().expect("valid session");
        assert_eq!(parsed.pipe_name, good_pipe);
        assert_eq!(parsed.pid, std::process::id());
        let dbg = format!("{:?}", parsed);
        assert!(dbg.contains("[REDACTED]"));
        assert!(!dbg.contains(&good_token));

        // 2. Mismatched stateHash16 in pipeName is rejected
        fs::write(
            dir.join(IPC_SESSION_FILENAME),
            serde_json::to_string(&json!({
                "schema": 1,
                "pipeName": r"\\.\pipe\gravitybox-0000000000000000-0123456789abcdef",
                "authToken": good_token,
                "pid": std::process::id()
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(read_ipc_session(&dir).unwrap().is_none());

        // 3. Invalid authToken (wrong length or uppercase) is rejected
        fs::write(
            dir.join(IPC_SESSION_FILENAME),
            serde_json::to_string(&json!({
                "schema": 1,
                "pipeName": good_pipe,
                "authToken": "A".repeat(64),
                "pid": std::process::id()
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(read_ipc_session(&dir).unwrap().is_none());

        // 4. pid == 0 or wrong schema is rejected
        fs::write(
            dir.join(IPC_SESSION_FILENAME),
            serde_json::to_string(&json!({
                "schema": 1,
                "pipeName": good_pipe,
                "authToken": good_token,
                "pid": 0
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(read_ipc_session(&dir).unwrap().is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn verified_pipe_passes_same_user_and_rejects_pid_mismatch_before_sending_token() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use windows_sys::Win32::Foundation::{GetLastError, ERROR_PIPE_CONNECTED};
        use windows_sys::Win32::Storage::FileSystem::{
            FlushFileBuffers, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_ACCESS_DUPLEX,
        };
        use windows_sys::Win32::System::Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
            PIPE_TYPE_BYTE, PIPE_WAIT,
        };

        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = strip_verbatim_prefix(&std::env::temp_dir())
            .join(format!("gb-pipe-auth-{}-{}", std::process::id(), stamp));
        fs::create_dir_all(&dir).unwrap();

        let hash16 = compute_windows_state_hash16(&dir);
        let self_pid = std::process::id();
        let token = format!("{:064x}", stamp);

        // Case 1: Matching server PID & same user SID succeeds and receives injected authToken
        let ok_rand = format!("{:016x}", (stamp & 0xffff_ffff_ffff_ffff) as u64);
        let ok_pipe_name = format!(r"\\.\pipe\gravitybox-{}-{}", hash16, ok_rand);
        let ok_pipe_w = win_impl::to_wide_null(&ok_pipe_name);
        let raw_ok_srv = unsafe {
            CreateNamedPipeW(
                ok_pipe_w.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1,
                4096,
                4096,
                0,
                std::ptr::null(),
            )
        };
        let ok_srv = win_impl::OwnedHandle::new(raw_ok_srv).expect("create ok test pipe");
        let ok_srv_raw = ok_srv.0 as usize;
        let expected_token = token.clone();
        let srv_thread = std::thread::spawn(move || {
            let h = ok_srv_raw as windows_sys::Win32::Foundation::HANDLE;
            let connected = unsafe { ConnectNamedPipe(h, std::ptr::null_mut()) };
            assert!(connected != 0 || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED);
            let mut buf = [0u8; 2048];
            let mut n: u32 = 0;
            assert!(unsafe { ReadFile(h, buf.as_mut_ptr(), buf.len() as u32, &mut n, std::ptr::null_mut()) } != 0);
            let req: Value = serde_json::from_slice(&buf[..n as usize]).unwrap();
            assert_eq!(req.get("command").and_then(|v| v.as_str()), Some("ping"));
            assert_eq!(
                req.get("authToken").and_then(|v| v.as_str()),
                Some(expected_token.as_str())
            );
            let reply = b"{\"ok\":true,\"verified\":true}\n";
            let mut wn: u32 = 0;
            unsafe {
                WriteFile(h, reply.as_ptr(), reply.len() as u32, &mut wn, std::ptr::null_mut());
                FlushFileBuffers(h);
                DisconnectNamedPipe(h);
            }
        });

        fs::write(
            dir.join(IPC_SESSION_FILENAME),
            serde_json::to_string(&json!({
                "schema": 1,
                "pipeName": ok_pipe_name,
                "authToken": token,
                "pid": self_pid,
                "createdAt": "2026-11-23T00:00:00.000Z"
            }))
            .unwrap(),
        )
        .unwrap();

        let resp = send_session_ndjson_request(
            &dir,
            &json!({ "command": "ping" }),
            Duration::from_secs(3),
        )
        .expect("verified same-user pipe request must succeed");
        assert_eq!(resp.get("verified").and_then(|v| v.as_bool()), Some(true));
        srv_thread.join().unwrap();
        drop(ok_srv);

        // Case 2: Mismatched session PID must reject immediately BEFORE writing any bytes (zero token leak)
        let bad_rand = format!("{:016x}", ((stamp ^ 0x55aa_55aa_55aa_55aa) & 0xffff_ffff_ffff_ffff) as u64);
        let bad_pipe_name = format!(r"\\.\pipe\gravitybox-{}-{}", hash16, bad_rand);
        let bad_pipe_w = win_impl::to_wide_null(&bad_pipe_name);
        let raw_bad_srv = unsafe {
            CreateNamedPipeW(
                bad_pipe_w.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1,
                4096,
                4096,
                0,
                std::ptr::null(),
            )
        };
        let bad_srv = win_impl::OwnedHandle::new(raw_bad_srv).expect("create bad test pipe");
        let bad_srv_raw = bad_srv.0 as usize;
        let received_any_bytes = Arc::new(AtomicBool::new(false));
        let received_flag = Arc::clone(&received_any_bytes);
        let bad_thread = std::thread::spawn(move || {
            let h = bad_srv_raw as windows_sys::Win32::Foundation::HANDLE;
            let connected = unsafe { ConnectNamedPipe(h, std::ptr::null_mut()) };
            if connected != 0 || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED {
                let mut buf = [0u8; 256];
                let mut n: u32 = 0;
                let ok = unsafe { ReadFile(h, buf.as_mut_ptr(), buf.len() as u32, &mut n, std::ptr::null_mut()) };
                if ok != 0 && n > 0 {
                    received_flag.store(true, Ordering::SeqCst);
                }
                unsafe {
                    DisconnectNamedPipe(h);
                }
            }
        });

        fs::write(
            dir.join(IPC_SESSION_FILENAME),
            serde_json::to_string(&json!({
                "schema": 1,
                "pipeName": bad_pipe_name,
                "authToken": token,
                "pid": self_pid.saturating_add(1),
                "createdAt": "2026-11-23T00:00:00.000Z"
            }))
            .unwrap(),
        )
        .unwrap();

        let err = send_session_ndjson_request(
            &dir,
            &json!({ "command": "ping" }),
            Duration::from_secs(3),
        )
        .expect_err("mismatched PID must be rejected");
        assert!(!err.retryable);
        assert!(!err.message.contains(&token));
        bad_thread.join().unwrap();
        assert!(
            !received_any_bytes.load(Ordering::SeqCst),
            "client must NEVER write authToken or any byte when server PID mismatches"
        );
        drop(bad_srv);

        let _ = fs::remove_dir_all(&dir);
    }
}
