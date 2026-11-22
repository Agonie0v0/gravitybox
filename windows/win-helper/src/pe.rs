use std::ffi::c_void;
use std::mem::size_of;
use std::path::Path;
use std::ptr;

use serde::Serialize;
use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VS_FIXEDFILEINFO, VerQueryValueW,
};

use crate::error::HelperError;
use crate::util::to_wide_null;

const VS_FFI_SIGNATURE: u32 = 0xFEEF_04BD;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PeVersionResponse {
    pub ok: bool,
    pub file_version: String,
    pub product_version: String,
    pub product_name: String,
    pub company_name: String,
}

/// Safely project a `VerQueryValueW` output pointer onto a validated subslice of `buf`.
fn checked_subslice(buf: &[u8], ptr: *const c_void, byte_len: usize) -> Option<&[u8]> {
    if ptr.is_null() || byte_len == 0 {
        return None;
    }
    let base = buf.as_ptr() as usize;
    let end = base.checked_add(buf.len())?;
    let p = ptr as usize;
    let p_end = p.checked_add(byte_len)?;
    if p >= base && p_end <= end {
        Some(&buf[(p - base)..(p_end - base)])
    } else {
        None
    }
}

fn query_translations(buf: &[u8]) -> Vec<(u16, u16)> {
    let mut pairs = Vec::new();
    let subblock = to_wide_null(r"\VarFileInfo\Translation");
    let mut ptr: *mut c_void = ptr::null_mut();
    let mut byte_len: u32 = 0;

    let ok = unsafe {
        VerQueryValueW(
            buf.as_ptr() as *const c_void,
            subblock.as_ptr(),
            &mut ptr,
            &mut byte_len,
        )
    };
    if ok != 0 {
        if let Some(slice) = checked_subslice(buf, ptr, byte_len as usize) {
            for chunk in slice.chunks_exact(4) {
                let lang = u16::from_le_bytes([chunk[0], chunk[1]]);
                let cp = u16::from_le_bytes([chunk[2], chunk[3]]);
                if !pairs.contains(&(lang, cp)) {
                    pairs.push((lang, cp));
                }
            }
        }
    }

    // Common fallback codepages if Translation table is missing or omits English strings
    for fallback in [(0x0409u16, 0x04B0u16), (0x0409, 0x04E4), (0x0000, 0x04B0)] {
        if !pairs.contains(&fallback) {
            pairs.push(fallback);
        }
    }
    pairs
}

fn query_string_field(buf: &[u8], translations: &[(u16, u16)], field: &str) -> Option<String> {
    for &(lang, cp) in translations {
        let subblock = to_wide_null(&format!(r"\StringFileInfo\{lang:04X}{cp:04X}\{field}"));
        let mut ptr: *mut c_void = ptr::null_mut();
        let mut char_len: u32 = 0;

        let ok = unsafe {
            VerQueryValueW(
                buf.as_ptr() as *const c_void,
                subblock.as_ptr(),
                &mut ptr,
                &mut char_len,
            )
        };
        if ok != 0 && char_len > 0 {
            let byte_len = (char_len as usize).saturating_mul(2);
            if let Some(slice) = checked_subslice(buf, ptr, byte_len) {
                let units: Vec<u16> = slice
                    .chunks_exact(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .collect();
                let end = units.iter().position(|&c| c == 0).unwrap_or(units.len());
                let text = String::from_utf16_lossy(&units[..end]).trim().to_string();
                if !text.is_empty() {
                    return Some(text);
                }
            }
        }
    }
    None
}

fn format_fixed_version(ms: u32, ls: u32) -> String {
    let major = (ms >> 16) & 0xFFFF;
    let minor = ms & 0xFFFF;
    let patch = (ls >> 16) & 0xFFFF;
    let build = ls & 0xFFFF;
    format!("{major}.{minor}.{patch}.{build}")
}

fn query_fixed_versions(buf: &[u8]) -> Option<(String, String)> {
    let subblock = to_wide_null(r"\");
    let mut ptr: *mut c_void = ptr::null_mut();
    let mut byte_len: u32 = 0;

    let ok = unsafe {
        VerQueryValueW(
            buf.as_ptr() as *const c_void,
            subblock.as_ptr(),
            &mut ptr,
            &mut byte_len,
        )
    };
    if ok == 0 || (byte_len as usize) < size_of::<VS_FIXEDFILEINFO>() {
        return None;
    }

    let slice = checked_subslice(buf, ptr, size_of::<VS_FIXEDFILEINFO>())?;
    let ffi: VS_FIXEDFILEINFO = unsafe { ptr::read_unaligned(slice.as_ptr() as *const VS_FIXEDFILEINFO) };
    if ffi.dwSignature != VS_FFI_SIGNATURE {
        return None;
    }

    let fv = format_fixed_version(ffi.dwFileVersionMS, ffi.dwFileVersionLS);
    let pv = format_fixed_version(ffi.dwProductVersionMS, ffi.dwProductVersionLS);
    Some((fv, pv))
}

pub fn pe_version(path: &str) -> Result<PeVersionResponse, HelperError> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err(HelperError::invalid_args("invalid PE path"));
    }
    if !Path::new(path).exists() {
        return Err(HelperError::not_found(format!("file not found: {path}")));
    }

    let path_w = to_wide_null(path);
    let mut handle: u32 = 0;
    let size = unsafe { GetFileVersionInfoSizeW(path_w.as_ptr(), &mut handle) };
    if size == 0 {
        let err = unsafe { GetLastError() };
        return Err(HelperError::new(
            "NO_VERSION_INFO",
            format!("GetFileVersionInfoSizeW failed (error {err})"),
        ));
    }

    let mut buf = vec![0u8; size as usize];
    let ok = unsafe {
        GetFileVersionInfoW(
            path_w.as_ptr(),
            0,
            size,
            buf.as_mut_ptr() as *mut c_void,
        )
    };
    if ok == 0 {
        let err = unsafe { GetLastError() };
        return Err(HelperError::win32("GetFileVersionInfoW", err));
    }

    let translations = query_translations(&buf);
    let fixed = query_fixed_versions(&buf);

    let file_version = query_string_field(&buf, &translations, "FileVersion")
        .or_else(|| fixed.as_ref().map(|(fv, _)| fv.clone()))
        .unwrap_or_default();
    let product_version = query_string_field(&buf, &translations, "ProductVersion")
        .or_else(|| fixed.as_ref().map(|(_, pv)| pv.clone()))
        .unwrap_or_default();
    let product_name = query_string_field(&buf, &translations, "ProductName").unwrap_or_default();
    let company_name = query_string_field(&buf, &translations, "CompanyName").unwrap_or_default();

    Ok(PeVersionResponse {
        ok: true,
        file_version,
        product_version,
        product_name,
        company_name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pe_version_reads_local_antigravity_or_kernel32() {
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let candidate = format!(r"{local_app_data}\Programs\Antigravity\Antigravity.exe");
        if Path::new(&candidate).exists() {
            let info = pe_version(&candidate).expect("pe_version for Antigravity.exe");
            assert!(info.ok);
            assert!(!info.file_version.is_empty());
            assert!(!info.product_version.is_empty());
            assert_eq!(info.product_name, "Antigravity");
            assert_eq!(info.company_name, "Google");
        } else {
            // Fallback verification against Windows system DLL
            let sys = r"C:\Windows\System32\kernel32.dll";
            let info = pe_version(sys).expect("pe_version for kernel32.dll");
            assert!(info.ok);
            assert!(!info.file_version.is_empty());
        }
    }

    #[test]
    fn pe_version_missing_file_returns_not_found() {
        let err = pe_version(r"C:\__gravitybox_nonexistent_pe__.exe").unwrap_err();
        assert_eq!(err.code, "NOT_FOUND");
    }
}
