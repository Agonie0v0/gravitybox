use std::ffi::{OsStr, c_void};
use std::io::{self, Read};
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::ptr;

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, FILETIME, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::{
    EqualSid, GetLengthSid, GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation,
    IsValidSid, TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TOKEN_USER, TokenIntegrityLevel, TokenUser,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes, OpenProcessToken};

use crate::error::HelperError;

/// Maximum bytes accepted on stdin (1 MiB) to guard against unbounded allocation.
pub const MAX_STDIN_BYTES: usize = 1024 * 1024;

/// Maximum bytes allocated for a `TOKEN_USER` query (64 KiB).
const MAX_TOKEN_USER_BYTES: usize = 64 * 1024;

/// Pointer-aligned owned buffer holding a `TOKEN_USER` structure returned by `GetTokenInformation`.
pub struct TokenUserBuffer {
    buf: Vec<usize>,
    byte_len: usize,
}

impl TokenUserBuffer {
    pub fn from_process(process_handle: HANDLE) -> Result<Self, u32> {
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

    pub fn from_current_process() -> Result<Self, u32> {
        // `GetCurrentProcess()` returns a pseudo-handle that must not be closed.
        Self::from_process(unsafe { GetCurrentProcess() })
    }

    pub fn sid_ptr(&self) -> Option<*mut c_void> {
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
        if p < base || p.checked_add(8)? > end {
            return None;
        }
        if unsafe { IsValidSid(sid) } == 0 {
            return None;
        }
        let sid_len = unsafe { GetLengthSid(sid) } as usize;
        if sid_len < 8 || p.checked_add(sid_len)? > end {
            return None;
        }
        Some(sid)
    }
}

/// Query the integrity-level RID of a process token (fails closed with `None`).
pub fn process_integrity_rid(process_handle: HANDLE) -> Option<u32> {
    let mut token_raw: HANDLE = ptr::null_mut();
    let ok = unsafe { OpenProcessToken(process_handle, TOKEN_QUERY, &mut token_raw) };
    if ok == 0 {
        return None;
    }
    let token = OwnedHandle::new(token_raw)?;

    let mut needed: u32 = 0;
    let probe_ok = unsafe {
        GetTokenInformation(
            token.as_raw(),
            TokenIntegrityLevel,
            ptr::null_mut(),
            0,
            &mut needed,
        )
    };
    if probe_ok != 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
        return None;
    }
    let needed_usize = needed as usize;
    if needed_usize < size_of::<TOKEN_MANDATORY_LABEL>() || needed_usize > MAX_TOKEN_USER_BYTES {
        return None;
    }

    let words = needed_usize.div_ceil(size_of::<usize>());
    let mut buf = vec![0usize; words];
    let alloc_bytes = buf.len() * size_of::<usize>();
    let mut actual: u32 = 0;
    let read_ok = unsafe {
        GetTokenInformation(
            token.as_raw(),
            TokenIntegrityLevel,
            buf.as_mut_ptr() as *mut c_void,
            alloc_bytes as u32,
            &mut actual,
        )
    };
    if read_ok == 0 {
        return None;
    }
    let actual_usize = actual as usize;
    if actual_usize < size_of::<TOKEN_MANDATORY_LABEL>() || actual_usize > alloc_bytes {
        return None;
    }
    let tml = unsafe { &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL) };
    let sid = tml.Label.Sid;
    if sid.is_null() {
        return None;
    }
    let base = buf.as_ptr() as usize;
    let end = base.checked_add(actual_usize)?;
    let p = sid as usize;
    if p < base || p.checked_add(8)? > end || unsafe { IsValidSid(sid) } == 0 {
        return None;
    }
    let sid_len = unsafe { GetLengthSid(sid) } as usize;
    if sid_len < 8 || p.checked_add(sid_len)? > end {
        return None;
    }
    let count_ptr = unsafe { GetSidSubAuthorityCount(sid) };
    if count_ptr.is_null() {
        return None;
    }
    let count = unsafe { *count_ptr } as u32;
    if count == 0 {
        return None;
    }
    let rid_ptr = unsafe { GetSidSubAuthority(sid, count - 1) };
    if rid_ptr.is_null() {
        return None;
    }
    Some(unsafe { *rid_ptr })
}

/// Check that `process_handle` runs at an integrity level >= the current process (blocks Low-IL / AppContainer pipe squatters).
pub fn process_has_compatible_integrity(process_handle: HANDLE) -> bool {
    let Some(self_rid) = process_integrity_rid(unsafe { GetCurrentProcess() }) else {
        return false;
    };
    let Some(proc_rid) = process_integrity_rid(process_handle) else {
        return false;
    };
    proc_rid >= self_rid
}

/// Query a process's Win32 creation timestamp (`FILETIME` packed as `u64`) to guard against PID-reuse races.
pub fn query_process_creation_time(process_handle: HANDLE) -> Option<u64> {
    let mut creation = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let mut exit = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let mut kernel = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let mut user = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let ok = unsafe {
        GetProcessTimes(
            process_handle,
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    };
    if ok == 0 {
        return None;
    }
    Some(((creation.dwHighDateTime as u64) << 32) | (creation.dwLowDateTime as u64))
}

/// Check whether `process_handle` belongs to the same Windows user SID as `expected_sid`.
/// Fails closed (`false`) if the process token cannot be queried (e.g. `ERROR_ACCESS_DENIED`).
pub fn process_has_same_user_sid(process_handle: HANDLE, expected_sid: *mut c_void) -> bool {
    if expected_sid.is_null() {
        return false;
    }
    match TokenUserBuffer::from_process(process_handle) {
        Ok(user) => match user.sid_ptr() {
            Some(proc_sid) => unsafe { EqualSid(expected_sid, proc_sid) != 0 },
            None => false,
        },
        Err(_) => false,
    }
}

/// Case-insensitively check whether `raw` starts with the Win32 verbatim UNC prefix `\\?\UNC\`.
pub fn is_verbatim_unc_path(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    bytes.len() >= 8
        && &bytes[0..4] == br"\\?\"
        && bytes[4..7].eq_ignore_ascii_case(b"UNC")
        && bytes[7] == b'\\'
}

/// Check whether any path segment (split on `\` or `/`) is a parent-directory traversal (`..`).
pub fn has_parent_dir_segment(path: &str) -> bool {
    path.split(['\\', '/']).any(|seg| seg == "..")
}

/// Check whether `path` begins with an absolute local drive prefix (`^[A-Za-z]:[\\/]`).
pub fn has_absolute_local_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

/// RAII wrapper for a Win32 `HANDLE` that closes itself on drop.
pub struct OwnedHandle(HANDLE);

impl OwnedHandle {
    pub fn new(handle: HANDLE) -> Option<Self> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            None
        } else {
            Some(Self(handle))
        }
    }

    pub fn as_raw(&self) -> HANDLE {
        self.0
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

/// Convert a Rust `&str` into a NUL-terminated UTF-16 `Vec<u16>`.
pub fn to_wide_null(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

/// Convert a NUL-terminated (or fixed-size) UTF-16 slice into a `String`.
pub fn from_wide_null(slice: &[u16]) -> String {
    let end = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
    String::from_utf16_lossy(&slice[..end])
}

/// Overwrite a byte slice using volatile writes to reduce sensitive data retention in memory.
pub fn zeroize_bytes(buf: &mut [u8]) {
    for b in buf.iter_mut() {
        unsafe {
            ptr::write_volatile(b, 0);
        }
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}

/// Overwrite a UTF-16 slice using volatile writes.
pub fn zeroize_u16(buf: &mut [u16]) {
    for w in buf.iter_mut() {
        unsafe {
            ptr::write_volatile(w, 0);
        }
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}

/// Read stdin into a bounded, non-reallocating buffer (up to `MAX_STDIN_BYTES`), zeroizing on error or overflow.
pub fn read_stdin_bounded() -> Result<Vec<u8>, HelperError> {
    let mut stdin = io::stdin().lock();
    let mut buf = vec![0u8; MAX_STDIN_BYTES + 1];
    let mut total = 0usize;
    while total < buf.len() {
        match stdin.read(&mut buf[total..]) {
            Ok(0) => break,
            Ok(n) => total += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => {
                zeroize_bytes(&mut buf);
                return Err(HelperError::invalid_input(format!("failed to read stdin: {e}")));
            }
        }
    }
    if total > MAX_STDIN_BYTES {
        zeroize_bytes(&mut buf);
        return Err(HelperError::invalid_input("stdin payload exceeds 1 MiB limit"));
    }
    zeroize_bytes(&mut buf[total..]);
    buf.truncate(total);
    Ok(buf)
}

/// Normalize a Windows filesystem path for case-insensitive comparison.
/// - Replaces `/` with `\`
/// - Strips optional `\\?\` extended-length prefix (converting `\\?\UNC\` to `\\`)
/// - Collapses repeated `\` (preserving leading `\\` for UNC paths)
/// - Trims trailing `\` except for root paths like `c:\`
/// - Lowercases for Windows case-insensitive comparison
pub fn normalize_win_path(raw: &str) -> String {
    let mut s = raw.trim().replace('/', "\\");
    if is_verbatim_unc_path(&s) {
        s = format!("\\\\{}", &s[8..]);
    } else if let Some(rest) = s.strip_prefix("\\\\?\\") {
        s = rest.to_string();
    }

    let is_unc = s.starts_with("\\\\");
    let mut collapsed = String::with_capacity(s.len());
    let mut prev_sep = false;
    for (idx, ch) in s.chars().enumerate() {
        if ch == '\\' {
            if is_unc && idx < 2 {
                collapsed.push('\\');
                prev_sep = true;
            } else if !prev_sep {
                collapsed.push('\\');
                prev_sep = true;
            }
        } else {
            collapsed.push(ch);
            prev_sep = false;
        }
    }

    // Trim trailing backslashes except root like "C:\"
    while collapsed.ends_with('\\') {
        if collapsed.len() == 3 && collapsed.as_bytes()[1] == b':' {
            break;
        }
        if is_unc && collapsed.len() <= 2 {
            break;
        }
        collapsed.pop();
    }

    collapsed.to_lowercase()
}

/// Check whether `exe_path` is equal to or strictly inside directory `prefix` (case-insensitive, path-boundary safe).
pub fn path_matches_prefix(exe_path: &str, prefix: &str) -> bool {
    let norm_exe = normalize_win_path(exe_path);
    let norm_prefix = normalize_win_path(prefix);
    if norm_prefix.is_empty() || norm_exe.is_empty() {
        return false;
    }
    if norm_exe == norm_prefix {
        return true;
    }
    if norm_prefix.ends_with('\\') {
        norm_exe.starts_with(&norm_prefix)
    } else {
        norm_exe.starts_with(&norm_prefix)
            && norm_exe.as_bytes().get(norm_prefix.len()) == Some(&b'\\')
    }
}

/// Extract the lowercase filename component of a Windows path.
pub fn path_file_name_lower(path: &str) -> String {
    let norm = normalize_win_path(path);
    match norm.rfind('\\') {
        Some(idx) => norm[idx + 1..].to_string(),
        None => norm,
    }
}

/// Strictly match `exe_path` against `expected_exe`:
/// - When `expected_exe` contains a path separator (`\` or `/`), require exact normalized full-path equality.
/// - Otherwise, require exact case-insensitive executable filename equality.
pub fn exe_matches_filter(exe_path: &str, expected_exe: &str) -> bool {
    let trimmed = expected_exe.trim();
    if trimmed.is_empty() || exe_path.trim().is_empty() {
        return false;
    }
    if trimmed.contains('\\') || trimmed.contains('/') {
        normalize_win_path(exe_path) == normalize_win_path(trimmed)
    } else {
        path_file_name_lower(exe_path) == trimmed.to_ascii_lowercase()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_and_prefix_matching() {
        assert_eq!(
            normalize_win_path(r"C:/Users/demo/AppData/Local/Programs/Antigravity/"),
            r"c:\users\demo\appdata\local\programs\antigravity"
        );
        assert_eq!(
            normalize_win_path(r"\\?\C:\Program Files\Antigravity\"),
            r"c:\program files\antigravity"
        );
        assert!(path_matches_prefix(
            r"C:\Users\demo\AppData\Local\Programs\Antigravity\Antigravity.exe",
            r"C:/Users/demo/AppData/Local/Programs/Antigravity"
        ));
        assert!(path_matches_prefix(
            r"C:\Users\demo\AppData\Local\Programs\Antigravity\resources\bin\language_server.exe",
            r"c:\users\demo\appdata\local\programs\antigravity\"
        ));
        // Boundary safety: must NOT match sibling directory with shared string prefix
        assert!(!path_matches_prefix(
            r"C:\Program Files\Antigravity-Old\Antigravity.exe",
            r"C:\Program Files\Antigravity"
        ));
        // Exact exe match also allowed
        assert!(path_matches_prefix(
            r"C:\Program Files\Antigravity\Antigravity.exe",
            r"c:\program files\antigravity\antigravity.exe"
        ));
    }
}
