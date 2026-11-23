use std::ffi::OsStr;
use std::io::{self, Read};
use std::os::windows::ffi::OsStrExt;
use std::ptr;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};

use crate::error::HelperError;

/// Maximum bytes accepted on stdin (1 MiB) to guard against unbounded allocation.
pub const MAX_STDIN_BYTES: usize = 1024 * 1024;

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

/// Read stdin into a bounded UTF-8 buffer (up to `MAX_STDIN_BYTES`).
pub fn read_stdin_bounded() -> Result<Vec<u8>, HelperError> {
    let mut stdin = io::stdin().take((MAX_STDIN_BYTES + 1) as u64);
    let mut buf = Vec::new();
    stdin
        .read_to_end(&mut buf)
        .map_err(|e| HelperError::invalid_input(format!("failed to read stdin: {e}")))?;
    if buf.len() > MAX_STDIN_BYTES {
        zeroize_bytes(&mut buf);
        return Err(HelperError::invalid_input("stdin payload exceeds 1 MiB limit"));
    }
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
    if let Some(rest) = s.strip_prefix("\\\\?\\UNC\\") {
        s = format!("\\\\{rest}");
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
