use std::fs;
use std::ptr;

use serde::{Deserialize, Serialize};
use windows_sys::Win32::Foundation::{GetLastError, S_FALSE, S_OK};
use windows_sys::Win32::Storage::FileSystem::GetFullPathNameW;
use windows_sys::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize,
};
use windows_sys::Win32::UI::Shell::{
    FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, SHFILEOPSTRUCTW,
    SHFileOperationW,
};

use crate::error::HelperError;
use crate::util::{read_stdin_bounded, to_wide_null};

#[derive(Deserialize)]
struct TrashMoveInput {
    paths: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct TrashMoveResponse {
    pub ok: bool,
    pub moved: Vec<String>,
}

struct ComStaGuard {
    should_uninit: bool,
}

impl ComStaGuard {
    fn init() -> Self {
        let hr = unsafe { CoInitializeEx(ptr::null_mut(), COINIT_APARTMENTTHREADED as u32) };
        Self {
            should_uninit: hr == S_OK || hr == S_FALSE,
        }
    }
}

impl Drop for ComStaGuard {
    fn drop(&mut self) {
        if self.should_uninit {
            unsafe {
                CoUninitialize();
            }
        }
    }
}

fn is_dangerous_root_path(path: &str) -> bool {
    let trimmed = path.trim().replace('/', "\\");
    if trimmed.is_empty() || trimmed == "\\" {
        return true;
    }
    let bytes = trimmed.as_bytes();
    // Drive root like "C:" or "C:\" or "C:\\\"
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let rest = &trimmed[2..];
        if rest.is_empty() || rest.chars().all(|c| c == '\\') {
            return true;
        }
    }
    // UNC root like "\\server" or "\\server\share" or "\\server\share\"
    if let Some(rest) = trimmed.strip_prefix("\\\\") {
        let parts: Vec<&str> = rest.split('\\').filter(|p| !p.is_empty()).collect();
        if parts.len() <= 2 {
            return true;
        }
    }
    false
}

fn is_local_drive_subpath(path: &str) -> bool {
    let bytes = path.as_bytes();
    // Must start with "<drive>:\" (e.g. "C:\foo"), rejecting UNC ("\\server\share\...") and device paths ("\\.\...")
    bytes.len() > 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\'
}

/// Resolve to a full local-drive Win32 path without following symlinks and without `\\?\` prefix
/// (since `SHFileOperationW` requires fully-qualified non-`\\?\` paths, natively expands `*`/`?`
/// wildcards, and silently permanently deletes UNC paths instead of using the Recycle Bin).
fn resolve_full_path_for_shell(raw: &str) -> Result<String, HelperError> {
    if raw.trim().is_empty() {
        return Err(HelperError::invalid_input("empty path in trash-move"));
    }
    if raw.contains('\0') {
        return Err(HelperError::invalid_input(
            "path in trash-move must not contain NUL characters",
        ));
    }

    let cleaned = if raw.starts_with(r"\\?\UNC\") || raw.starts_with(r"\\?\unc\") {
        return Err(HelperError::invalid_input(
            "UNC paths are not supported for Recycle Bin move",
        ));
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        raw.to_string()
    };

    if cleaned.contains('*') || cleaned.contains('?') {
        return Err(HelperError::invalid_input(
            "path in trash-move must not contain wildcard characters ('*' or '?')",
        ));
    }
    if cleaned.starts_with(r"\\") || cleaned.starts_with("//") {
        return Err(HelperError::invalid_input(
            "UNC and device paths are not supported for Recycle Bin move",
        ));
    }

    let wide = to_wide_null(&cleaned);
    let mut cap: usize = 512;
    loop {
        let mut buf = vec![0u16; cap];
        let written = unsafe {
            GetFullPathNameW(
                wide.as_ptr(),
                buf.len() as u32,
                buf.as_mut_ptr(),
                ptr::null_mut(),
            )
        };
        if written == 0 {
            let err = unsafe { GetLastError() };
            return Err(HelperError::win32("GetFullPathNameW", err));
        }
        if (written as usize) < buf.len() {
            let full = String::from_utf16_lossy(&buf[..written as usize]);
            let normalized = full.trim_end_matches('\\').to_string();
            if normalized.contains('*') || normalized.contains('?') {
                return Err(HelperError::invalid_input(
                    "resolved path in trash-move must not contain wildcard characters",
                ));
            }
            if is_dangerous_root_path(&full) || is_dangerous_root_path(&normalized) {
                return Err(HelperError::invalid_input(
                    "refusing to move root volume or UNC share root to Recycle Bin",
                ));
            }
            if !is_local_drive_subpath(&normalized) {
                return Err(HelperError::invalid_input(
                    "only local drive paths are supported for Recycle Bin move",
                ));
            }
            return Ok(normalized);
        }
        cap = (written as usize) + 1;
        if cap > 32_768 {
            return Err(HelperError::invalid_input("path exceeds maximum length"));
        }
    }
}

pub fn trash_move_paths(paths: &[String]) -> Result<TrashMoveResponse, HelperError> {
    if paths.is_empty() {
        return Ok(TrashMoveResponse {
            ok: true,
            moved: Vec::new(),
        });
    }

    // Validate all paths up front before moving anything
    let mut resolved = Vec::with_capacity(paths.len());
    for raw in paths {
        let full = resolve_full_path_for_shell(raw)?;
        if fs::symlink_metadata(&full).is_err() {
            return Err(HelperError::not_found(format!("path does not exist: {raw}")));
        }
        resolved.push((raw.clone(), full));
    }

    let _com = ComStaGuard::init();
    let flags = (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI) as u16;
    let mut moved = Vec::with_capacity(resolved.len());

    for (orig, full) in resolved {
        // SHFileOperationW requires a double-NUL terminated UTF-16 string in pFrom
        let mut from_w = to_wide_null(&full);
        from_w.push(0);

        let mut op = SHFILEOPSTRUCTW {
            hwnd: ptr::null_mut(),
            wFunc: FO_DELETE,
            pFrom: from_w.as_ptr(),
            pTo: ptr::null(),
            fFlags: flags,
            fAnyOperationsAborted: 0,
            hNameMappings: ptr::null_mut(),
            lpszProgressTitle: ptr::null(),
        };

        let ret = unsafe { SHFileOperationW(&mut op) };
        if ret != 0 || op.fAnyOperationsAborted != 0 {
            return Err(HelperError::new(
                "TRASH_FAILED",
                format!(
                    "SHFileOperationW failed for path (code {ret}, aborted={})",
                    op.fAnyOperationsAborted != 0
                ),
            ));
        }
        moved.push(orig);
    }

    Ok(TrashMoveResponse { ok: true, moved })
}

pub fn trash_move_from_stdin() -> Result<TrashMoveResponse, HelperError> {
    let raw = read_stdin_bounded()?;
    let input: TrashMoveInput = serde_json::from_slice(&raw)
        .map_err(|_| HelperError::invalid_input("invalid JSON payload for trash-move"))?;
    trash_move_paths(&input.paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn rejects_root_nul_wildcards_and_unc_paths() {
        assert!(is_dangerous_root_path(r"C:\"));
        assert!(is_dangerous_root_path(r"C:"));
        assert!(is_dangerous_root_path(r"\\server\share"));
        assert!(!is_dangerous_root_path(r"C:\temp\file.txt"));
        assert!(is_local_drive_subpath(r"C:\temp\file.txt"));
        assert!(!is_local_drive_subpath(r"\\server\share\file.txt"));
        assert!(!is_local_drive_subpath(r"\\.\PhysicalDrive0"));

        for bad in [
            "C:\\bad\0path",
            r"C:\",
            r"C:\temp\*.tmp",
            r"C:\temp\file?.tmp",
            r"\\server\share\folder\file.txt",
            r"\\?\UNC\server\share\folder\file.txt",
            r"\\.\PhysicalDrive0",
        ] {
            let err = trash_move_paths(&[bad.to_string()]).unwrap_err();
            assert_eq!(err.code, "INVALID_INPUT", "expected INVALID_INPUT for {bad}");
        }
    }

    #[test]
    fn moves_temp_file_to_recycle_bin() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_path = std::env::temp_dir().join(format!("gravitybox-trash-unit-{nanos}.tmp"));
        fs::write(&temp_path, b"gravitybox recycle bin unit test").unwrap();
        assert!(temp_path.exists());

        let path_str = temp_path.to_string_lossy().to_string();
        let res = trash_move_paths(&[path_str.clone()]).expect("trash_move_paths");
        assert!(res.ok);
        assert_eq!(res.moved, vec![path_str]);
        assert!(!temp_path.exists());
    }
}
