use std::ptr;

use serde::Serialize;
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_PIPE_BUSY, GetLastError,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
};
use windows_sys::Win32::System::Pipes::{GetNamedPipeServerProcessId, WaitNamedPipeW};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

use crate::error::HelperError;
use crate::process::query_process_exe_path;
use crate::util::{
    OwnedHandle, TokenUserBuffer, exe_matches_filter, process_has_compatible_integrity,
    process_has_same_user_sid, to_wide_null,
};

const REQUIRED_PIPE_PREFIX: &str = r"\\.\pipe\gravitybox-";
const MAX_PIPE_SUFFIX_LEN: usize = 128;

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

/// Open an existing GravityBox Named Pipe with `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`
/// and minimal `FILE_READ_ATTRIBUTES` access, resolve its server PID via
/// `GetNamedPipeServerProcessId`, acquire the server process handle BEFORE releasing the pipe
/// handle (eliminating the PID-reuse micro-TOCTOU window), verify same Windows user SID via
/// `OpenProcessToken` + `GetTokenInformation(TokenUser)` + `EqualSid`, and optionally validate
/// `expected_pid` and `expected_exe`.
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

    // Open the server process handle while still holding the live pipe handle to eliminate the
    // micro-TOCTOU window where the server exits and its PID is recycled before OpenProcess.
    let server_proc = OwnedHandle::new(unsafe {
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, server_pid)
    });

    // Release the pipe handle immediately after acquiring the server process handle.
    drop(pipe_handle);

    let self_user = TokenUserBuffer::from_current_process()
        .map_err(|err| HelperError::win32("GetTokenInformation(self)", err))?;
    let self_sid = self_user
        .sid_ptr()
        .ok_or_else(|| HelperError::new("WIN32_ERROR", "failed to resolve current user SID"))?;

    let (exe_path, same_user_sid, compatible_integrity) = match server_proc {
        Some(proc_handle) => {
            let exe = query_process_exe_path(proc_handle.as_raw()).unwrap_or_default();
            let same_sid = process_has_same_user_sid(proc_handle.as_raw(), self_sid);
            let compat_il = if same_sid {
                process_has_compatible_integrity(proc_handle.as_raw())
            } else {
                false
            };
            (exe, same_sid, compat_il)
        }
        None => (String::new(), false, false),
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

    if !compatible_integrity {
        return Ok(VerifyPipeServerResponse {
            ok: true,
            verified: false,
            pipe_name: pipe_name.to_string(),
            server_pid: Some(server_pid),
            same_user_sid: true,
            exe_path,
            reason: Some("integrity_mismatch".to_string()),
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
    fn exe_matches_filter_prevents_directory_name_spoofing() {
        // Exact filename match (case-insensitive)
        assert!(exe_matches_filter(
            r"C:\Program Files\nodejs\node.exe",
            "node.exe"
        ));
        assert!(exe_matches_filter(
            r"C:\Program Files\nodejs\node.exe",
            "NODE.EXE"
        ));
        // Directory-name spoofing MUST be rejected
        assert!(!exe_matches_filter(
            r"C:\evil\node.exe\malware.exe",
            "node.exe"
        ));
        // Substring / partial filename MUST be rejected
        assert!(!exe_matches_filter(
            r"C:\Program Files\nodejs\node.exe",
            "node"
        ));
        assert!(!exe_matches_filter(
            r"C:\Program Files\nodejs\fake-node.exe",
            "node.exe"
        ));
        // Full-path filter requires exact normalized path equality
        assert!(exe_matches_filter(
            r"C:\Program Files\nodejs\node.exe",
            r"C:/Program Files/nodejs/node.exe"
        ));
        assert!(!exe_matches_filter(
            r"C:\evil\Program Files\nodejs\node.exe",
            r"C:\Program Files\nodejs\node.exe"
        ));
        assert!(!exe_matches_filter(
            r"C:\Program Files\nodejs\node.exe",
            r"nodejs\node.exe"
        ));
    }

    #[test]
    fn verifies_in_process_named_pipe_server_identity() {
        let self_pid = std::process::id();
        let current_exe = std::env::current_exe().expect("current_exe");
        let exact_exe_name = current_exe
            .file_name()
            .expect("exe filename")
            .to_string_lossy()
            .to_string();
        let exact_exe_full = current_exe.to_string_lossy().to_string();

        // 1. Matching current process PID and exact executable filename
        let pipe_ok = unique_test_pipe_name("self-ok");
        let _server_ok = create_test_pipe(&pipe_ok);
        let ok_res = verify_pipe_server(&pipe_ok, Some(self_pid), Some(&exact_exe_name))
            .expect("verify_pipe_server match");
        assert!(ok_res.ok);
        assert!(ok_res.verified);
        assert!(ok_res.same_user_sid);
        assert_eq!(ok_res.server_pid, Some(self_pid));
        assert_eq!(ok_res.pipe_name, pipe_ok);
        assert!(!ok_res.exe_path.is_empty());
        assert!(ok_res.reason.is_none());

        // 2. Matching exact full executable path
        let pipe_full = unique_test_pipe_name("self-full");
        let _server_full = create_test_pipe(&pipe_full);
        let full_res = verify_pipe_server(&pipe_full, Some(self_pid), Some(&exact_exe_full))
            .expect("verify_pipe_server full path match");
        assert!(full_res.ok);
        assert!(full_res.verified);
        assert!(full_res.same_user_sid);

        // 3. Mismatched expected PID
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

        // 4. Mismatched expected exe (including non-exact substring)
        let pipe_exe = unique_test_pipe_name("self-exe");
        let _server_exe = create_test_pipe(&pipe_exe);
        let exe_mismatch =
            verify_pipe_server(&pipe_exe, Some(self_pid), Some("gravitybox_win_helper"))
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
