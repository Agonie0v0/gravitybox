use std::ffi::c_void;
use std::mem::size_of;
use std::ptr;

use serde::Serialize;
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_INSUFFICIENT_BUFFER, ERROR_PATH_NOT_FOUND,
    ERROR_PIPE_BUSY, GetLastError, HANDLE,
};
use windows_sys::Win32::Security::{
    EqualSid, GetTokenInformation, IsValidSid, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
};
use windows_sys::Win32::System::Pipes::{GetNamedPipeServerProcessId, WaitNamedPipeW};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::error::HelperError;
use crate::process::query_process_exe_path;
use crate::util::{OwnedHandle, normalize_win_path, to_wide_null};

const REQUIRED_PIPE_PREFIX: &str = r"\\.\pipe\gravitybox-";
const MAX_PIPE_SUFFIX_LEN: usize = 128;
const MAX_TOKEN_USER_BYTES: usize = 64 * 1024;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VerifyPipeServerResponse {
    pub ok: bool,
    pub verified: bool,
    pub pipe_name: String,
    pub server_pid: Option<u32>,
    pub same_user_sid: bool,
    pub exe_path: String,
    pub reason: Option<String>,
}

/// Strictly validate that `pipe_name` begins with `\\.\pipe\gravitybox-` and has a safe,
/// traversal-free suffix (`[A-Za-z0-9_-]{1,128}`).
pub(crate) fn validate_gravitybox_pipe_name(pipe_name: &str) -> Result<(), HelperError> {
    if pipe_name.contains('\0') {
        return Err(HelperError::invalid_args(
            "pipe name must not contain NUL characters",
        ));
    }
    let Some(suffix) = pipe_name.strip_prefix(REQUIRED_PIPE_PREFIX) else {
        return Err(HelperError::invalid_args(
            r"pipe name must strictly start with \\.\pipe\gravitybox-",
        ));
    };
    if suffix.is_empty() || suffix.len() > MAX_PIPE_SUFFIX_LEN {
        return Err(HelperError::invalid_args(
            "pipe name suffix length is out of allowed bounds (1..=128)",
        ));
    }
    if !suffix
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(HelperError::invalid_args(
            "pipe name suffix contains disallowed characters",
        ));
    }
    Ok(())
}

/// Pointer-aligned owned buffer holding a `TOKEN_USER` structure returned by `GetTokenInformation`.
struct TokenUserBuffer {
    buf: Vec<usize>,
    byte_len: usize,
}

impl TokenUserBuffer {
    fn from_process(process_handle: HANDLE) -> Result<Self, u32> {
        let mut token_raw: HANDLE = ptr::null_mut();
        let ok = unsafe { OpenProcessToken(process_handle, TOKEN_QUERY, &mut token_raw) };
        if ok == 0 {
            return Err(unsafe { GetLastError() });
        }
        let token = OwnedHandle::new(token_raw).ok_or(0u32)?;

        let mut needed: u32 = 0;
        let probe_ok = unsafe {
            GetTokenInformation(token.as_raw(), TokenUser, ptr::null_mut(), 0, &mut needed)
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
                token.as_raw(),
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

fn open_pipe_for_identity_check(pipe_w: &[u16]) -> Result<OwnedHandle, u32> {
    // SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION prevents a squatting server from
    // impersonating this client process. FILE_READ_ATTRIBUTES uses minimal metadata access
    // without claiming a full-duplex data stream.
    let flags = SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION;
    for attempt in 0..2 {
        let raw = unsafe {
            CreateFileW(
                pipe_w.as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                ptr::null(),
                OPEN_EXISTING,
                flags,
                ptr::null_mut(),
            )
        };
        if let Some(handle) = OwnedHandle::new(raw) {
            return Ok(handle);
        }
        let err = unsafe { GetLastError() };
        if err == ERROR_PIPE_BUSY && attempt == 0 {
            unsafe {
                WaitNamedPipeW(pipe_w.as_ptr(), 200);
            }
            continue;
        }
        return Err(err);
    }
    Err(ERROR_PIPE_BUSY)
}

fn exe_matches_filter(exe_path: &str, expected_exe: &str) -> bool {
    let norm_filter = normalize_win_path(expected_exe);
    let norm_exe = normalize_win_path(exe_path);
    if norm_filter.is_empty() || norm_exe.is_empty() {
        return false;
    }
    norm_exe.contains(&norm_filter)
}

/// Open an existing GravityBox Named Pipe with `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`
/// and minimal `FILE_READ_ATTRIBUTES` access, resolve its server PID via
/// `GetNamedPipeServerProcessId`, verify same Windows user SID via `OpenProcessToken` +
/// `GetTokenInformation(TokenUser)` + `EqualSid`, and optionally validate `expected_pid` and
/// `expected_exe`.
pub fn verify_pipe_server(
    pipe_name: &str,
    expected_pid: Option<u32>,
    expected_exe: Option<&str>,
) -> Result<VerifyPipeServerResponse, HelperError> {
    validate_gravitybox_pipe_name(pipe_name)?;

    if let Some(pid) = expected_pid {
        if pid == 0 {
            return Err(HelperError::invalid_args("expected-pid must be > 0"));
        }
    }
    if let Some(exe) = expected_exe {
        if exe.trim().is_empty() || exe.contains('\0') {
            return Err(HelperError::invalid_args(
                "expected-exe must be non-empty and contain no NUL characters",
            ));
        }
    }

    let pipe_w = to_wide_null(pipe_name);
    let pipe_handle = match open_pipe_for_identity_check(&pipe_w) {
        Ok(h) => h,
        Err(err) if err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND => {
            return Ok(VerifyPipeServerResponse {
                ok: true,
                verified: false,
                pipe_name: pipe_name.to_string(),
                server_pid: None,
                same_user_sid: false,
                exe_path: String::new(),
                reason: Some("pipe_not_found".to_string()),
            });
        }
        Err(err) if err == ERROR_ACCESS_DENIED => {
            // Restrictive DACL on an existing pipe indicates a different security principal.
            return Ok(VerifyPipeServerResponse {
                ok: true,
                verified: false,
                pipe_name: pipe_name.to_string(),
                server_pid: None,
                same_user_sid: false,
                exe_path: String::new(),
                reason: Some("sid_mismatch".to_string()),
            });
        }
        Err(err) => {
            return Err(HelperError::win32("CreateFileW", err));
        }
    };

    let mut server_pid: u32 = 0;
    let got_pid = unsafe { GetNamedPipeServerProcessId(pipe_handle.as_raw(), &mut server_pid) };
    if got_pid == 0 || server_pid == 0 {
        let err = unsafe { GetLastError() };
        return Err(HelperError::win32("GetNamedPipeServerProcessId", err));
    }

    // Drop the pipe handle immediately once server PID is resolved.
    drop(pipe_handle);

    let self_user = TokenUserBuffer::from_process(unsafe { GetCurrentProcess() })
        .map_err(|err| HelperError::win32("GetTokenInformation(self)", err))?;
    let self_sid = self_user
        .sid_ptr()
        .ok_or_else(|| HelperError::new("WIN32_ERROR", "failed to resolve current user SID"))?;

    let server_proc = OwnedHandle::new(unsafe {
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, server_pid)
    });

    let (exe_path, same_user_sid) = match server_proc {
        Some(proc_handle) => {
            let exe = query_process_exe_path(proc_handle.as_raw()).unwrap_or_default();
            let same_sid = match TokenUserBuffer::from_process(proc_handle.as_raw()) {
                Ok(server_user) => match server_user.sid_ptr() {
                    Some(server_sid) => unsafe { EqualSid(self_sid, server_sid) != 0 },
                    None => false,
                },
                Err(_) => false,
            };
            (exe, same_sid)
        }
        None => (String::new(), false),
    };

    if !same_user_sid {
        return Ok(VerifyPipeServerResponse {
            ok: true,
            verified: false,
            pipe_name: pipe_name.to_string(),
            server_pid: Some(server_pid),
            same_user_sid: false,
            exe_path,
            reason: Some("sid_mismatch".to_string()),
        });
    }

    if let Some(exp_pid) = expected_pid {
        if server_pid != exp_pid {
            return Ok(VerifyPipeServerResponse {
                ok: true,
                verified: false,
                pipe_name: pipe_name.to_string(),
                server_pid: Some(server_pid),
                same_user_sid: true,
                exe_path,
                reason: Some("pid_mismatch".to_string()),
            });
        }
    }

    if let Some(exp_exe) = expected_exe {
        if !exe_matches_filter(&exe_path, exp_exe) {
            return Ok(VerifyPipeServerResponse {
                ok: true,
                verified: false,
                pipe_name: pipe_name.to_string(),
                server_pid: Some(server_pid),
                same_user_sid: true,
                exe_path,
                reason: Some("exe_mismatch".to_string()),
            });
        }
    }

    Ok(VerifyPipeServerResponse {
        ok: true,
        verified: true,
        pipe_name: pipe_name.to_string(),
        server_pid: Some(server_pid),
        same_user_sid: true,
        exe_path,
        reason: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
    };
    use windows_sys::Win32::System::Pipes::{
        CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
    };

    fn unique_test_pipe_name(tag: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!(r"\\.\pipe\gravitybox-unit-{tag}-{}-{nanos}", std::process::id())
    }

    fn create_test_pipe(pipe_name: &str) -> OwnedHandle {
        let pipe_w = to_wide_null(pipe_name);
        let raw = unsafe {
            CreateNamedPipeW(
                pipe_w.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1,
                4096,
                4096,
                0,
                ptr::null(),
            )
        };
        OwnedHandle::new(raw).expect("CreateNamedPipeW with FILE_FLAG_FIRST_PIPE_INSTANCE")
    }

    #[test]
    fn rejects_disallowed_pipe_prefixes_and_traversal() {
        for bad in [
            r"\\.\pipe\other-app",
            r"\\.\pipe\gravitybox-",
            r"\\?\pipe\gravitybox-abc",
            r"\\.\pipe\gravitybox-..\evil",
            r"\\.\pipe\gravitybox-foo\bar",
            r"\\.\pipe\gravitybox-foo/bar",
            r"\\.\pipe\gravitybox-foo bar",
            "\\\\.\\pipe\\gravitybox-foo\0bar",
        ] {
            let err = verify_pipe_server(bad, None, None).unwrap_err();
            assert_eq!(err.code, "INVALID_ARGS", "expected INVALID_ARGS for {bad}");
        }
    }

    #[test]
    fn verifies_in_process_named_pipe_server_identity() {
        let self_pid = std::process::id();

        // 1. Matching current process PID and exe name
        let pipe_ok = unique_test_pipe_name("self-ok");
        let _server_ok = create_test_pipe(&pipe_ok);
        let ok_res = verify_pipe_server(&pipe_ok, Some(self_pid), Some("gravitybox_win_helper"))
            .expect("verify_pipe_server match");
        assert!(ok_res.ok);
        assert!(ok_res.verified);
        assert!(ok_res.same_user_sid);
        assert_eq!(ok_res.server_pid, Some(self_pid));
        assert_eq!(ok_res.pipe_name, pipe_ok);
        assert!(!ok_res.exe_path.is_empty());
        assert!(ok_res.reason.is_none());

        // 2. Mismatched expected PID
        let pipe_pid = unique_test_pipe_name("self-pid");
        let _server_pid = create_test_pipe(&pipe_pid);
        let wrong_pid = self_pid.saturating_add(1);
        let pid_mismatch = verify_pipe_server(&pipe_pid, Some(wrong_pid), None)
            .expect("verify_pipe_server pid_mismatch");
        assert!(pid_mismatch.ok);
        assert!(!pid_mismatch.verified);
        assert!(pid_mismatch.same_user_sid);
        assert_eq!(pid_mismatch.server_pid, Some(self_pid));
        assert_eq!(pid_mismatch.reason.as_deref(), Some("pid_mismatch"));

        // 3. Mismatched expected exe
        let pipe_exe = unique_test_pipe_name("self-exe");
        let _server_exe = create_test_pipe(&pipe_exe);
        let exe_mismatch =
            verify_pipe_server(&pipe_exe, Some(self_pid), Some("definitely_not_this.exe"))
                .expect("verify_pipe_server exe_mismatch");
        assert!(exe_mismatch.ok);
        assert!(!exe_mismatch.verified);
        assert!(exe_mismatch.same_user_sid);
        assert_eq!(exe_mismatch.reason.as_deref(), Some("exe_mismatch"));
    }

    #[test]
    fn reports_pipe_not_found_when_missing() {
        let missing = unique_test_pipe_name("missing");
        let res = verify_pipe_server(&missing, None, None).expect("verify missing pipe");
        assert!(res.ok);
        assert!(!res.verified);
        assert!(!res.same_user_sid);
        assert!(res.server_pid.is_none());
        assert_eq!(res.reason.as_deref(), Some("pipe_not_found"));
    }
}
