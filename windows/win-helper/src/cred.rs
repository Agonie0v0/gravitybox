use std::ffi::c_void;
use std::ptr;

use serde::{Deserialize, Serialize};
use windows_sys::Win32::Foundation::{ERROR_NOT_FOUND, FILETIME, GetLastError};
use windows_sys::Win32::Security::Credentials::{
    CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CredDeleteW, CredFree, CredReadW,
    CredWriteW,
};

use crate::error::HelperError;
use crate::util::{read_stdin_bounded, to_wide_null, zeroize_bytes, zeroize_u16};

/// Windows generic credential blob maximum size is 5 * 512 = 2560 bytes (`CRED_MAX_CREDENTIAL_BLOB_SIZE`).
const CRED_MAX_BLOB_BYTES: usize = 5 * 512;

struct CredPtrGuard(*mut CREDENTIALW);

impl Drop for CredPtrGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let cred = &*self.0;
                let blob_len = cred.CredentialBlobSize as usize;
                if blob_len > 0 && !cred.CredentialBlob.is_null() {
                    let blob_slice = std::slice::from_raw_parts_mut(cred.CredentialBlob, blob_len);
                    zeroize_bytes(blob_slice);
                }
                CredFree(self.0 as *const c_void);
            }
        }
    }
}

#[derive(Serialize)]
pub struct CredReadResponse {
    pub ok: bool,
    pub found: bool,
    pub value: Option<String>,
}

#[derive(Deserialize)]
struct CredWriteInput {
    service: String,
    account: String,
    value: String,
}

#[derive(Serialize)]
pub struct CredWriteResponse {
    pub ok: bool,
}

#[derive(Serialize)]
pub struct CredDeleteResponse {
    pub ok: bool,
    pub deleted: bool,
}

fn target_name(service: &str, account: &str) -> Result<String, HelperError> {
    if service.is_empty() || account.is_empty() {
        return Err(HelperError::invalid_args(
            "service and account must be non-empty",
        ));
    }
    if service.contains('\0') || account.contains('\0') {
        return Err(HelperError::invalid_args(
            "service and account must not contain NUL characters",
        ));
    }
    Ok(format!("{service}:{account}"))
}

/// Decode `CredentialBlob` bytes.
///
/// `zalando/go-keyring/keyring_windows.go` (`danieljoos/wincred`) stores passwords verbatim as raw
/// UTF-8 bytes (`[]byte(password)` without NUL terminator). If a credential was written by another
/// Windows tool using UTF-16LE (detectable via NUL bytes or non-UTF-8 encoding with even byte
/// length), fall back cleanly to UTF-16LE decoding.
pub(crate) fn decode_credential_blob(bytes: &[u8]) -> Result<String, HelperError> {
    if bytes.is_empty() {
        return Ok(String::new());
    }

    // Primary path: exact raw UTF-8 without NUL bytes (100% compatible with zalando/go-keyring)
    if !bytes.contains(&0) {
        if let Ok(s) = std::str::from_utf8(bytes) {
            return Ok(s.to_owned());
        }
    }

    // Secondary path: UTF-16LE fallback (e.g. entries written by Windows Credential UI)
    if bytes.len() % 2 == 0 {
        let mut units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        while units.last() == Some(&0) {
            units.pop();
        }
        let decoded = if !units.contains(&0) {
            String::from_utf16(&units).ok()
        } else {
            None
        };
        zeroize_u16(&mut units);
        if let Some(s) = decoded {
            return Ok(s);
        }
    }

    // Final fallback: raw UTF-8 even if containing NUL bytes
    std::str::from_utf8(bytes)
        .map(|s| s.to_owned())
        .map_err(|_| HelperError::new("INVALID_ENCODING", "credential blob is not valid UTF-8 or UTF-16LE"))
}

pub fn cred_read(service: &str, account: &str) -> Result<CredReadResponse, HelperError> {
    let target = target_name(service, account)?;
    let target_w = to_wide_null(&target);
    let mut cred_ptr: *mut CREDENTIALW = ptr::null_mut();

    let ok = unsafe { CredReadW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred_ptr) };
    if ok == 0 {
        let err = unsafe { GetLastError() };
        if err == ERROR_NOT_FOUND {
            return Ok(CredReadResponse {
                ok: true,
                found: false,
                value: None,
            });
        }
        return Err(HelperError::win32("CredReadW", err));
    }

    let _guard = CredPtrGuard(cred_ptr);
    let cred = unsafe { &*cred_ptr };
    let blob_len = cred.CredentialBlobSize as usize;
    let value = if blob_len == 0 || cred.CredentialBlob.is_null() {
        String::new()
    } else {
        let slice = unsafe { std::slice::from_raw_parts(cred.CredentialBlob, blob_len) };
        decode_credential_blob(slice)?
    };

    Ok(CredReadResponse {
        ok: true,
        found: true,
        value: Some(value),
    })
}

pub fn cred_write_raw(service: &str, account: &str, value: &str) -> Result<CredWriteResponse, HelperError> {
    let target = target_name(service, account)?;
    let blob = value.as_bytes();
    if blob.len() > CRED_MAX_BLOB_BYTES {
        return Err(HelperError::invalid_input(format!(
            "credential blob size ({} bytes) exceeds Windows Credential Manager limit ({CRED_MAX_BLOB_BYTES} bytes)",
            blob.len()
        )));
    }

    let mut target_w = to_wide_null(&target);
    let mut user_w = to_wide_null(account);

    let cred = CREDENTIALW {
        Flags: 0,
        Type: CRED_TYPE_GENERIC,
        TargetName: target_w.as_mut_ptr(),
        Comment: ptr::null_mut(),
        LastWritten: FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        },
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: if blob.is_empty() {
            ptr::null_mut()
        } else {
            blob.as_ptr() as *mut u8
        },
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: ptr::null_mut(),
        TargetAlias: ptr::null_mut(),
        UserName: user_w.as_mut_ptr(),
    };

    let ok = unsafe { CredWriteW(&cred, 0) };
    if ok == 0 {
        let err = unsafe { GetLastError() };
        return Err(HelperError::win32("CredWriteW", err));
    }

    Ok(CredWriteResponse { ok: true })
}

pub fn cred_write_from_stdin() -> Result<CredWriteResponse, HelperError> {
    let mut raw = read_stdin_bounded()?;
    let parse_res: Result<CredWriteInput, _> = serde_json::from_slice(&raw);
    zeroize_bytes(&mut raw);

    let mut input = parse_res
        .map_err(|_| HelperError::invalid_input("invalid JSON payload for cred-write"))?;
    let res = cred_write_raw(&input.service, &input.account, &input.value);
    let mut secret_bytes = std::mem::take(&mut input.value).into_bytes();
    zeroize_bytes(&mut secret_bytes);
    res
}

pub fn cred_delete(service: &str, account: &str) -> Result<CredDeleteResponse, HelperError> {
    let target = target_name(service, account)?;
    let target_w = to_wide_null(&target);
    let ok = unsafe { CredDeleteW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0) };
    if ok == 0 {
        let err = unsafe { GetLastError() };
        if err == ERROR_NOT_FOUND {
            return Ok(CredDeleteResponse {
                ok: true,
                deleted: false,
            });
        }
        return Err(HelperError::win32("CredDeleteW", err));
    }
    Ok(CredDeleteResponse {
        ok: true,
        deleted: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct CleanupCred<'a>(&'a str, &'a str);
    impl Drop for CleanupCred<'_> {
        fn drop(&mut self) {
            let _ = cred_delete(self.0, self.1);
        }
    }

    #[test]
    fn decode_blob_utf8_and_utf16_fallback() {
        let json = r#"{"token":{"access_token":"demo"},"auth_method":"consumer"}"#;
        assert_eq!(decode_credential_blob(json.as_bytes()).unwrap(), json);

        let b64 = "go-keyring-base64:eyJ0ZXN0IjoxfQ==";
        assert_eq!(decode_credential_blob(b64.as_bytes()).unwrap(), b64);

        let unicode = "测试凭据-🔐-value";
        assert_eq!(decode_credential_blob(unicode.as_bytes()).unwrap(), unicode);

        // UTF-16LE compatibility
        let utf16: Vec<u8> = "hello-utf16\0"
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        assert_eq!(decode_credential_blob(&utf16).unwrap(), "hello-utf16");

        assert_eq!(decode_credential_blob(&[]).unwrap(), "");
    }

    #[test]
    fn credential_manager_roundtrip_unit_entry() {
        let service = "gravitybox-test";
        let account = "unit";
        let _cleanup = CleanupCred(service, account);

        // Ensure clean start
        let _ = cred_delete(service, account);

        // Write UTF-8 JSON payload (go-keyring Windows format)
        let payload1 = r#"{"test":"gravitybox-unit","unicode":"中文"}"#;
        let wr = cred_write_raw(service, account, payload1).unwrap();
        assert!(wr.ok);

        // Read back exact match
        let rd = cred_read(service, account).unwrap();
        assert!(rd.ok);
        assert!(rd.found);
        assert_eq!(rd.value.as_deref(), Some(payload1));

        // Overwrite with go-keyring-base64 format
        let payload2 = "go-keyring-base64:eyJ0ZXN0IjoyfQ==";
        assert!(cred_write_raw(service, account, payload2).unwrap().ok);
        let rd2 = cred_read(service, account).unwrap();
        assert!(rd2.found);
        assert_eq!(rd2.value.as_deref(), Some(payload2));

        // Delete existing
        let del1 = cred_delete(service, account).unwrap();
        assert!(del1.ok);
        assert!(del1.deleted);

        // Delete missing returns deleted=false without error
        let del2 = cred_delete(service, account).unwrap();
        assert!(del2.ok);
        assert!(!del2.deleted);

        // Read missing returns found=false, value=null
        let rd3 = cred_read(service, account).unwrap();
        assert!(rd3.ok);
        assert!(!rd3.found);
        assert!(rd3.value.is_none());
    }
}
