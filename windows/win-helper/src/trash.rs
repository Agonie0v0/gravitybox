use std::collections::HashSet;
use std::ffi::c_void;
use std::fs;
use std::mem::size_of;
use std::ptr;

use serde::{Deserialize, Serialize};
use windows_sys::core::{GUID, PCWSTR};
use windows_sys::Win32::Foundation::{BOOL, GetLastError, HWND, S_FALSE, S_OK};
use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetFullPathNameW};
use windows_sys::Win32::System::Com::{
    CLSCTX_ALL, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use windows_sys::Win32::System::WindowsProgramming::DRIVE_FIXED;
use windows_sys::Win32::UI::Shell::{
    FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FOFX_RECYCLEONDELETE,
    FileOperation, SHCreateItemFromParsingName, SHQUERYRBINFO, SHQueryRecycleBinW,
};

use crate::error::HelperError;
use crate::util::{
    has_absolute_local_drive_prefix, has_parent_dir_segment, is_verbatim_unc_path,
    read_stdin_bounded, to_wide_null,
};

/// `IID_IFileOperation` (`947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8`) from `ShObjIdl_core.h`.
const IID_IFILE_OPERATION: GUID = GUID::from_u128(0x947aab5f_0a5c_4c13_b4d6_4bf7836fc9f8);

/// `IID_IShellItem` (`43826d1e-e718-42ee-bc55-a1e261c37bfe`) from `ShObjIdl_core.h`.
const IID_ISHELL_ITEM: GUID = GUID::from_u128(0x43826d1e_e718_42ee_bc55_a1e261c37bfe);

/// Minimal `IUnknown` vtable prefix (slots 0..=2) for RAII `Release()`.
#[repr(C)]
struct IUnknownVtbl {
    query_interface:
        unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> i32,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
}

/// Complete `IFileOperation` COM vtable layout (slots 0..=22) verified against Windows SDK `ShObjIdl_core.h`.
#[repr(C)]
struct IFileOperationVtbl {
    // IUnknown (slots 0..=2)
    query_interface:
        unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> i32,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    // IFileOperation (slots 3..=22)
    advise: unsafe extern "system" fn(*mut c_void, *mut c_void, *mut u32) -> i32, // 3
    unadvise: unsafe extern "system" fn(*mut c_void, u32) -> i32,                  // 4
    set_operation_flags: unsafe extern "system" fn(*mut c_void, u32) -> i32,       // 5
    set_progress_message: unsafe extern "system" fn(*mut c_void, PCWSTR) -> i32,   // 6
    set_progress_dialog: unsafe extern "system" fn(*mut c_void, *mut c_void) -> i32, // 7
    set_properties: unsafe extern "system" fn(*mut c_void, *mut c_void) -> i32,    // 8
    set_owner_window: unsafe extern "system" fn(*mut c_void, HWND) -> i32,         // 9
    apply_properties_to_item: unsafe extern "system" fn(*mut c_void, *mut c_void) -> i32, // 10
    apply_properties_to_items: unsafe extern "system" fn(*mut c_void, *mut c_void) -> i32, // 11
    rename_item:
        unsafe extern "system" fn(*mut c_void, *mut c_void, PCWSTR, *mut c_void) -> i32, // 12
    rename_items: unsafe extern "system" fn(*mut c_void, *mut c_void, PCWSTR) -> i32, // 13
    move_item: unsafe extern "system" fn(
        *mut c_void,
        *mut c_void,
        *mut c_void,
        PCWSTR,
        *mut c_void,
    ) -> i32, // 14
    move_items: unsafe extern "system" fn(*mut c_void, *mut c_void, *mut c_void) -> i32, // 15
    copy_item: unsafe extern "system" fn(
        *mut c_void,
        *mut c_void,
        *mut c_void,
        PCWSTR,
        *mut c_void,
    ) -> i32, // 16
    copy_items: unsafe extern "system" fn(*mut c_void, *mut c_void, *mut c_void) -> i32, // 17
    delete_item: unsafe extern "system" fn(*mut c_void, *mut c_void, *mut c_void) -> i32, // 18
    delete_items: unsafe extern "system" fn(*mut c_void, *mut c_void) -> i32,      // 19
    new_item: unsafe extern "system" fn(
        *mut c_void,
        *mut c_void,
        u32,
        PCWSTR,
        PCWSTR,
        *mut c_void,
    ) -> i32, // 20
    perform_operations: unsafe extern "system" fn(*mut c_void) -> i32,             // 21
    get_any_operations_aborted: unsafe extern "system" fn(*mut c_void, *mut BOOL) -> i32, // 22
}

/// RAII wrapper around any COM interface pointer (`IUnknown`-derived) calling `Release()` on Drop.
struct ComObject(*mut c_void);

impl ComObject {
    fn new(ptr: *mut c_void) -> Option<Self> {
        if ptr.is_null() { None } else { Some(Self(ptr)) }
    }

    fn as_ptr(&self) -> *mut c_void {
        self.0
    }
}

impl Drop for ComObject {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let vtbl = *(self.0 as *const *const IUnknownVtbl);
                ((*vtbl).release)(self.0);
            }
        }
    }
}

struct ComStaGuard {
    should_uninit: bool,
}

impl ComStaGuard {
    fn init() -> Result<Self, HelperError> {
        let hr = unsafe { CoInitializeEx(ptr::null_mut(), COINIT_APARTMENTTHREADED as u32) };
        if hr == S_OK || hr == S_FALSE {
            Ok(Self {
                should_uninit: true,
            })
        } else {
            Err(HelperError::new(
                "COM_INIT_FAILED",
                format!("CoInitializeEx(STA) failed (HRESULT 0x{:08X})", hr as u32),
            ))
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

#[derive(Deserialize)]
struct TrashMoveInput {
    paths: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct TrashMoveResponse {
    pub ok: bool,
    pub moved: Vec<String>,
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

fn is_fixed_drive_type(drive_type: u32) -> bool {
    drive_type == DRIVE_FIXED
}

fn verify_drive_is_fixed(drive_root: &str) -> Result<(), HelperError> {
    let root_w = to_wide_null(drive_root);
    let drive_type = unsafe { GetDriveTypeW(root_w.as_ptr()) };
    if !is_fixed_drive_type(drive_type) {
        return Err(HelperError::invalid_input(format!(
            "refusing to recycle path on non-fixed drive {drive_root} (driveType={drive_type})"
        )));
    }
    Ok(())
}

fn verify_recycle_bin_available(drive_root: &str) -> Result<(), HelperError> {
    let root_w = to_wide_null(drive_root);
    let mut info: SHQUERYRBINFO = unsafe { std::mem::zeroed() };
    info.cbSize = size_of::<SHQUERYRBINFO>() as u32;
    let hr = unsafe { SHQueryRecycleBinW(root_w.as_ptr(), &mut info) };
    if hr < 0 {
        return Err(HelperError::new(
            "RECYCLE_BIN_UNAVAILABLE",
            format!(
                "Recycle Bin is unavailable on drive {drive_root} (HRESULT 0x{:08X})",
                hr as u32
            ),
        ));
    }
    Ok(())
}

/// Strictly validate and resolve a path for Recycle Bin deletion BEFORE invoking Shell COM APIs:
/// - Rejects empty/whitespace, NUL, case-insensitive `\\?\UNC\`, UNC/device paths, wildcards (`*`/`?`),
///   relative paths, any `..` traversal segment, drive roots, and non-`DRIVE_FIXED` volumes.
/// - Resolves via `GetFullPathNameW` without following leaf symlinks.
fn resolve_full_path_for_shell(raw: &str) -> Result<String, HelperError> {
    if raw.trim().is_empty() {
        return Err(HelperError::invalid_input("empty path in trash-move"));
    }
    if raw.contains('\0') {
        return Err(HelperError::invalid_input(
            "path in trash-move must not contain NUL characters",
        ));
    }
    if is_verbatim_unc_path(raw) {
        return Err(HelperError::invalid_input(
            "UNC paths are not supported for Recycle Bin move",
        ));
    }

    let cleaned = raw.strip_prefix(r"\\?\").unwrap_or(raw);

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
    if !has_absolute_local_drive_prefix(cleaned) {
        return Err(HelperError::invalid_input(
            "path in trash-move must be an absolute local drive path (e.g. C:\\...)",
        ));
    }
    if has_parent_dir_segment(cleaned) {
        return Err(HelperError::invalid_input(
            "path in trash-move must not contain '..' parent directory segments",
        ));
    }
    if is_dangerous_root_path(cleaned) {
        return Err(HelperError::invalid_input(
            "refusing to move root volume to Recycle Bin",
        ));
    }

    let wide = to_wide_null(cleaned);
    let mut cap: usize = 512;
    let normalized = loop {
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
            let norm = full.trim_end_matches('\\').to_string();
            if norm.contains('*') || norm.contains('?') {
                return Err(HelperError::invalid_input(
                    "resolved path in trash-move must not contain wildcard characters",
                ));
            }
            if has_parent_dir_segment(&norm) {
                return Err(HelperError::invalid_input(
                    "resolved path in trash-move must not contain '..' segments",
                ));
            }
            if is_dangerous_root_path(&full) || is_dangerous_root_path(&norm) {
                return Err(HelperError::invalid_input(
                    "refusing to move root volume or UNC share root to Recycle Bin",
                ));
            }
            if !is_local_drive_subpath(&norm) {
                return Err(HelperError::invalid_input(
                    "only local drive paths are supported for Recycle Bin move",
                ));
            }
            break norm;
        }
        cap = (written as usize) + 1;
        if cap > 32_768 {
            return Err(HelperError::invalid_input("path exceeds maximum length"));
        }
    };

    let drive_root = format!(r"{}:\", normalized.as_bytes()[0].to_ascii_uppercase() as char);
    verify_drive_is_fixed(&drive_root)?;
    Ok(normalized)
}

fn move_paths_via_ifile_operation(resolved: &[(String, String)]) -> Result<Vec<String>, HelperError> {
    let _com = ComStaGuard::init()?;

    let mut op_raw: *mut c_void = ptr::null_mut();
    let hr_create = unsafe {
        CoCreateInstance(
            &FileOperation,
            ptr::null_mut(),
            CLSCTX_ALL,
            &IID_IFILE_OPERATION,
            &mut op_raw,
        )
    };
    if hr_create < 0 {
        return Err(HelperError::new(
            "TRASH_FAILED",
            format!(
                "CoCreateInstance(FileOperation) failed (HRESULT 0x{:08X})",
                hr_create as u32
            ),
        ));
    }
    let op = ComObject::new(op_raw).ok_or_else(|| {
        HelperError::new("TRASH_FAILED", "CoCreateInstance(FileOperation) returned null")
    })?;
    let vtbl = unsafe { &**(op.as_ptr() as *const *const IFileOperationVtbl) };

    // FOFX_RECYCLEONDELETE enforces fail-closed Recycle Bin deletion on Windows 8+
    // (returns an error HRESULT instead of silently permanently deleting when Recycle Bin is unavailable).
    let flags: u32 =
        FOFX_RECYCLEONDELETE | FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI;
    let hr_flags = unsafe { (vtbl.set_operation_flags)(op.as_ptr(), flags) };
    if hr_flags < 0 {
        return Err(HelperError::new(
            "TRASH_FAILED",
            format!(
                "IFileOperation::SetOperationFlags failed (HRESULT 0x{:08X})",
                hr_flags as u32
            ),
        ));
    }

    for (_orig, full) in resolved {
        let full_w = to_wide_null(full);
        let mut item_raw: *mut c_void = ptr::null_mut();
        let hr_item = unsafe {
            SHCreateItemFromParsingName(
                full_w.as_ptr(),
                ptr::null_mut(),
                &IID_ISHELL_ITEM,
                &mut item_raw,
            )
        };
        if hr_item < 0 {
            return Err(HelperError::new(
                "TRASH_FAILED",
                format!(
                    "SHCreateItemFromParsingName failed (HRESULT 0x{:08X})",
                    hr_item as u32
                ),
            ));
        }
        let item = ComObject::new(item_raw).ok_or_else(|| {
            HelperError::new("TRASH_FAILED", "SHCreateItemFromParsingName returned null")
        })?;

        let hr_del = unsafe { (vtbl.delete_item)(op.as_ptr(), item.as_ptr(), ptr::null_mut()) };
        if hr_del < 0 {
            return Err(HelperError::new(
                "TRASH_FAILED",
                format!(
                    "IFileOperation::DeleteItem failed (HRESULT 0x{:08X})",
                    hr_del as u32
                ),
            ));
        }
    }

    let hr_perf = unsafe { (vtbl.perform_operations)(op.as_ptr()) };
    let mut aborted: BOOL = 0;
    let hr_aborted = unsafe { (vtbl.get_any_operations_aborted)(op.as_ptr(), &mut aborted) };

    if hr_perf < 0 {
        return Err(HelperError::new(
            "TRASH_FAILED",
            format!(
                "IFileOperation::PerformOperations failed (HRESULT 0x{:08X}, aborted={})",
                hr_perf as u32,
                aborted != 0
            ),
        ));
    }
    if hr_aborted < 0 || aborted != 0 {
        return Err(HelperError::new(
            "TRASH_FAILED",
            format!(
                "IFileOperation reported aborted operation (aborted={}, hr=0x{:08X})",
                aborted != 0,
                hr_aborted as u32
            ),
        ));
    }

    Ok(resolved.iter().map(|(orig, _)| orig.clone()).collect())
}

pub fn trash_move_paths(paths: &[String]) -> Result<TrashMoveResponse, HelperError> {
    if paths.is_empty() {
        return Ok(TrashMoveResponse {
            ok: true,
            moved: Vec::new(),
        });
    }

    // Validate all paths, fixed-drive status, existence, and Recycle Bin availability up front.
    let mut resolved = Vec::with_capacity(paths.len());
    let mut checked_drives: HashSet<char> = HashSet::new();
    for raw in paths {
        let full = resolve_full_path_for_shell(raw)?;
        if fs::symlink_metadata(&full).is_err() {
            return Err(HelperError::not_found(format!("path does not exist: {raw}")));
        }
        let drive_letter = full.as_bytes()[0].to_ascii_uppercase() as char;
        if checked_drives.insert(drive_letter) {
            let drive_root = format!(r"{drive_letter}:\");
            verify_recycle_bin_available(&drive_root)?;
        }
        resolved.push((raw.clone(), full));
    }

    let moved = move_paths_via_ifile_operation(&resolved)?;
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
    use std::mem::offset_of;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn ifile_operation_vtable_slots_match_sdk_abi() {
        let ptr_sz = size_of::<usize>();
        assert_eq!(offset_of!(IFileOperationVtbl, release), 2 * ptr_sz);
        assert_eq!(offset_of!(IFileOperationVtbl, set_operation_flags), 5 * ptr_sz);
        assert_eq!(offset_of!(IFileOperationVtbl, delete_item), 18 * ptr_sz);
        assert_eq!(offset_of!(IFileOperationVtbl, perform_operations), 21 * ptr_sz);
        assert_eq!(
            offset_of!(IFileOperationVtbl, get_any_operations_aborted),
            22 * ptr_sz
        );
        assert_eq!(size_of::<IFileOperationVtbl>(), 23 * ptr_sz);
    }

    #[test]
    fn rejects_relative_traversal_wildcards_root_and_mixed_case_unc_paths() {
        assert!(is_dangerous_root_path(r"C:\"));
        assert!(is_dangerous_root_path(r"C:"));
        assert!(is_dangerous_root_path(r"\\server\share"));
        assert!(!is_dangerous_root_path(r"C:\temp\file.txt"));
        assert!(is_local_drive_subpath(r"C:\temp\file.txt"));
        assert!(!is_local_drive_subpath(r"\\server\share\file.txt"));
        assert!(!is_local_drive_subpath(r"\\.\PhysicalDrive0"));

        for bad in [
            "",
            "   ",
            "C:\\bad\0path",
            r"C:\",
            r"C:/",
            "relative.txt",
            r".\relative.txt",
            r"..\escape.txt",
            r"C:drive-relative.txt",
            r"\rooted-no-drive\file.txt",
            r"C:\temp\..\Windows\system.ini",
            r"C:\temp\a\..\b.txt",
            r"C:\temp\..",
            r"C:\temp\*.tmp",
            r"C:\temp\file?.tmp",
            r"\\server\share\folder\file.txt",
            r"\\?\UNC\server\share\folder\file.txt",
            r"\\?\uNc\server\share\folder\file.txt",
            r"\\?\unc\server\share\folder\file.txt",
            r"\\.\PhysicalDrive0",
        ] {
            let err = trash_move_paths(&[bad.to_string()]).unwrap_err();
            assert_eq!(err.code, "INVALID_INPUT", "expected INVALID_INPUT for {bad}");
        }
    }

    #[test]
    fn verifies_drive_fixed_guard() {
        assert!(is_fixed_drive_type(DRIVE_FIXED));
        assert!(!is_fixed_drive_type(0)); // DRIVE_UNKNOWN
        assert!(!is_fixed_drive_type(1)); // DRIVE_NO_ROOT_DIR
        assert!(!is_fixed_drive_type(2)); // DRIVE_REMOVABLE
        assert!(!is_fixed_drive_type(4)); // DRIVE_REMOTE
        assert!(!is_fixed_drive_type(5)); // DRIVE_CDROM
        assert!(!is_fixed_drive_type(6)); // DRIVE_RAMDISK

        // Local system drive (usually C:\) is DRIVE_FIXED
        let sys_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
        let root = format!(r"{sys_drive}\");
        assert!(verify_drive_is_fixed(&root).is_ok());

        // Find an unmapped drive letter (if any) and confirm it is rejected as non-fixed
        for letter in ('Q'..='Z').rev() {
            let candidate = format!(r"{letter}:\");
            let w = to_wide_null(&candidate);
            let dt = unsafe { GetDriveTypeW(w.as_ptr()) };
            if dt != DRIVE_FIXED {
                let err = verify_drive_is_fixed(&candidate).unwrap_err();
                assert_eq!(err.code, "INVALID_INPUT");
                break;
            }
        }
    }

    #[test]
    fn moves_temp_file_to_recycle_bin_via_ifile_operation() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_path = std::env::temp_dir().join(format!("gravitybox-trash-unit-{nanos}.tmp"));
        fs::write(&temp_path, b"gravitybox IFileOperation recycle bin unit test").unwrap();
        assert!(temp_path.exists());

        let path_str = temp_path.to_string_lossy().to_string();
        let res = trash_move_paths(&[path_str.clone()]).expect("trash_move_paths");
        assert!(res.ok);
        assert_eq!(res.moved, vec![path_str]);
        assert!(!temp_path.exists());
    }
}
