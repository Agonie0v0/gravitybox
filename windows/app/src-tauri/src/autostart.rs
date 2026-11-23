use crate::ipc_pipe::strip_verbatim_prefix;
use std::path::Path;

/// Strip Win32 extended-length (`\\?\` / `\\?\UNC\`) prefix so the Run registry value stays clean.
pub fn normalize_run_exe_path(path: &Path) -> String {
    strip_verbatim_prefix(path).to_string_lossy().into_owned()
}

#[cfg(windows)]
mod win_autostart {
    use super::normalize_run_exe_path;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
        HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_SZ,
    };

    const RUN_KEY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE_NAME: &str = "GravityBox";

    struct RegKeyGuard(HKEY);

    impl Drop for RegKeyGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    RegCloseKey(self.0);
                }
            }
        }
    }

    fn to_wide_null(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    pub fn is_enabled() -> Result<bool, String> {
        let subkey = to_wide_null(RUN_KEY_PATH);
        let value_name = to_wide_null(VALUE_NAME);
        let mut hkey: HKEY = null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                KEY_QUERY_VALUE,
                &mut hkey,
            )
        };
        if status != ERROR_SUCCESS {
            return Ok(false);
        }
        let guard = RegKeyGuard(hkey);
        let mut reg_type: u32 = 0;
        let mut data_len: u32 = 0;
        let query = unsafe {
            RegQueryValueExW(
                guard.0,
                value_name.as_ptr(),
                null_mut(),
                &mut reg_type,
                null_mut(),
                &mut data_len,
            )
        };
        Ok(query == ERROR_SUCCESS && reg_type == REG_SZ && data_len > 2)
    }

    pub fn set_enabled(enabled: bool) -> Result<(), String> {
        let subkey = to_wide_null(RUN_KEY_PATH);
        let value_name = to_wide_null(VALUE_NAME);
        let mut hkey: HKEY = null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                KEY_SET_VALUE,
                &mut hkey,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!("无法打开 Windows 启动项注册表键 (error {})", status));
        }
        let guard = RegKeyGuard(hkey);
        if enabled {
            let exe = std::env::current_exe()
                .map_err(|e| format!("无法获取当前可执行文件路径: {}", e))?;
            let clean_exe = normalize_run_exe_path(&exe);
            let command = format!("\"{}\" --minimized", clean_exe);
            let wide_cmd = to_wide_null(&command);
            let byte_len = (wide_cmd.len() * std::mem::size_of::<u16>()) as u32;
            let set_status = unsafe {
                RegSetValueExW(
                    guard.0,
                    value_name.as_ptr(),
                    0,
                    REG_SZ,
                    wide_cmd.as_ptr() as *const u8,
                    byte_len,
                )
            };
            if set_status == ERROR_SUCCESS {
                Ok(())
            } else {
                Err(format!("写入开机自启项失败 (error {})", set_status))
            }
        } else {
            let del_status = unsafe { RegDeleteValueW(guard.0, value_name.as_ptr()) };
            if del_status == ERROR_SUCCESS || del_status == ERROR_FILE_NOT_FOUND {
                Ok(())
            } else {
                Err(format!("移除开机自启项失败 (error {})", del_status))
            }
        }
    }
}

pub fn get_autostart() -> Result<bool, String> {
    #[cfg(windows)]
    {
        win_autostart::is_enabled()
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

pub fn set_autostart(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        win_autostart::set_enabled(enabled)
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_verbatim_prefix_from_run_exe_path() {
        assert_eq!(
            normalize_run_exe_path(Path::new(r"\\?\C:\Program Files\GravityBox\GravityBox.exe")),
            r"C:\Program Files\GravityBox\GravityBox.exe"
        );
        assert_eq!(
            normalize_run_exe_path(Path::new(r"\\?\UNC\server\share\GravityBox.exe")),
            r"\\server\share\GravityBox.exe"
        );
        assert_eq!(
            normalize_run_exe_path(Path::new(r"C:\Tools\GravityBox.exe")),
            r"C:\Tools\GravityBox.exe"
        );
    }
}
