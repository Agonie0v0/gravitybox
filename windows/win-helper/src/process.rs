use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::c_void;
use std::mem::{MaybeUninit, size_of};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use windows_sys::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation};
use windows_sys::Win32::Foundation::{
    BOOL, ERROR_INSUFFICIENT_BUFFER, GetLastError, HANDLE, HWND, LPARAM,
};
use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Memory::{
    MEM_COMMIT, MEMORY_BASIC_INFORMATION, PAGE_GUARD, PAGE_NOACCESS, VirtualQueryEx,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PEB, PROCESS_BASIC_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_VM_READ, QueryFullProcessImageNameW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GW_OWNER, GetWindow, GetWindowThreadProcessId, IsWindowVisible, PostMessageW,
    WM_CLOSE,
};

use crate::error::HelperError;
use crate::util::{
    OwnedHandle, from_wide_null, path_matches_prefix, zeroize_bytes, zeroize_u16,
};

/// Upper bound when reading remote process CommandLine (64 KiB).
const MAX_CMDLINE_BYTES: usize = 64 * 1024;

/// Upper bound when reading remote process Environment block (256 KiB).
const MAX_ENV_BYTES: usize = 256 * 1024;

/// Chunk size when streaming remote Environment memory.
const ENV_CHUNK_BYTES: usize = 8192;

/// Offset of `EnvironmentSize` inside 64-bit `RTL_USER_PROCESS_PARAMETERS` (Vista SP1+ / Win10 / Win11).
const RTL_PARAMS_ENV_SIZE_OFFSET: u64 = 0x3F0;

const SERVER_CSRF_ENV_KEY: &str = "ANTIGRAVITY_SERVER_CSRF_TOKEN";
const SIDECAR_CSRF_ENV_KEY: &str = "ANTIGRAVITY_CSRF_TOKEN";
const LS_ADDRESS_ENV_KEY: &str = "ANTIGRAVITY_LS_ADDRESS";

#[derive(Debug, Clone)]
pub struct ProcessSnapshotEntry {
    pub pid: u32,
    pub parent_pid: u32,
    pub exe_name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EnvCsrfScan {
    pub csrf_token: Option<String>,
    pub ls_port: Option<u16>,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct UnicodeString64 {
    length: u16,
    maximum_length: u16,
    _pad: u32,
    buffer: u64,
}

/// Prefix of 64-bit `RTL_USER_PROCESS_PARAMETERS` through `Environment` (offset 0x80).
#[repr(C)]
#[derive(Clone, Copy)]
struct RtlUserProcessParametersHead {
    maximum_length: u32,               // 0x00
    length: u32,                       // 0x04
    flags: u32,                        // 0x08
    debug_flags: u32,                  // 0x0C
    console_handle: u64,               // 0x10
    console_flags: u32,                // 0x18
    _pad0: u32,                        // 0x1C
    standard_input: u64,               // 0x20
    standard_output: u64,              // 0x28
    standard_error: u64,               // 0x30
    current_dir_path: UnicodeString64, // 0x38
    current_dir_handle: u64,           // 0x48
    dll_path: UnicodeString64,         // 0x50
    image_path_name: UnicodeString64,  // 0x60
    command_line: UnicodeString64,     // 0x70
    environment: u64,                  // 0x80
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppProcessInfo {
    pub pid: u32,
    pub exe_path: String,
    pub cmd_line: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppProcessesResponse {
    pub ok: bool,
    pub processes: Vec<AppProcessInfo>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GracefulCloseResponse {
    pub ok: bool,
    pub closed: bool,
    pub remaining_pids: Vec<u32>,
}

/// Enumerate all running processes as `ProcessSnapshotEntry`.
pub fn snapshot_processes() -> Result<Vec<ProcessSnapshotEntry>, HelperError> {
    let snap = OwnedHandle::new(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) })
        .ok_or_else(|| HelperError::win32("CreateToolhelp32Snapshot", unsafe { GetLastError() }))?;

    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;

    let mut result = Vec::new();
    let mut ok = unsafe { Process32FirstW(snap.as_raw(), &mut entry) };
    while ok != 0 {
        result.push(ProcessSnapshotEntry {
            pid: entry.th32ProcessID,
            parent_pid: entry.th32ParentProcessID,
            exe_name: from_wide_null(&entry.szExeFile),
        });
        ok = unsafe { Process32NextW(snap.as_raw(), &mut entry) };
    }
    Ok(result)
}

/// Query full Win32 executable image path from an open process handle.
pub fn query_process_exe_path(handle: HANDLE) -> Option<String> {
    let mut cap: usize = 1024;
    loop {
        let mut buf = vec![0u16; cap];
        let mut len = buf.len() as u32;
        let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len) };
        if ok != 0 {
            return Some(String::from_utf16_lossy(&buf[..len as usize]));
        }
        let err = unsafe { GetLastError() };
        if err == ERROR_INSUFFICIENT_BUFFER && cap < 32_768 {
            cap = (cap * 2).min(32_768);
            continue;
        }
        return None;
    }
}

/// Query full executable path by PID (best-effort; returns `None` if process exited or access denied).
pub fn query_pid_exe_path(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    let handle = OwnedHandle::new(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })?;
    query_process_exe_path(handle.as_raw())
}

/// Open process with `PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ`, falling back to query-only.
pub fn open_process_for_inspect(pid: u32) -> Option<(OwnedHandle, bool)> {
    if pid == 0 {
        return None;
    }
    if let Some(h) = OwnedHandle::new(unsafe {
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid)
    }) {
        return Some((h, true));
    }
    OwnedHandle::new(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })
        .map(|h| (h, false))
}

fn read_remote_bytes(handle: HANDLE, addr: u64, dst: &mut [u8]) -> Option<usize> {
    if addr == 0 || dst.is_empty() {
        return None;
    }
    let mut read_len: usize = 0;
    let ok = unsafe {
        ReadProcessMemory(
            handle,
            addr as *const c_void,
            dst.as_mut_ptr() as *mut c_void,
            dst.len(),
            &mut read_len,
        )
    };
    if ok == 0 || read_len == 0 {
        None
    } else {
        Some(read_len)
    }
}

fn read_remote_struct<T: Copy>(handle: HANDLE, addr: u64) -> Option<T> {
    if addr == 0 {
        return None;
    }
    let mut uninit = MaybeUninit::<T>::uninit();
    let mut read_len: usize = 0;
    let ok = unsafe {
        ReadProcessMemory(
            handle,
            addr as *const c_void,
            uninit.as_mut_ptr() as *mut c_void,
            size_of::<T>(),
            &mut read_len,
        )
    };
    if ok != 0 && read_len == size_of::<T>() {
        Some(unsafe { uninit.assume_init() })
    } else {
        None
    }
}

/// Extract `--csrf_token` from a command line string (`--csrf_token=VAL`, `--csrf_token VAL`, quoted or unquoted).
pub fn extract_csrf_token_from_cmdline(cmd: &str) -> Option<String> {
    let bytes = cmd.as_bytes();
    let needle = b"--csrf_token";
    let mut search_from = 0usize;

    while search_from < bytes.len() {
        let rel = cmd[search_from..].find("--csrf_token")?;
        let idx = search_from + rel;
        search_from = idx + needle.len();

        // Must start at beginning or after whitespace/quote
        if idx > 0 {
            let prev = bytes[idx - 1];
            if !prev.is_ascii_whitespace() && prev != b'"' && prev != b'\'' {
                continue;
            }
        }

        let rest = &cmd[idx + needle.len()..];
        let val_start = if let Some(after_eq) = rest.strip_prefix('=') {
            after_eq
        } else if rest.starts_with(char::is_whitespace) {
            rest.trim_start()
        } else {
            // e.g. `--csrf_token_other` -> not a match
            continue;
        };

        if val_start.is_empty() {
            continue;
        }

        let token = if let Some(after_q) = val_start.strip_prefix('"') {
            let end = after_q.find('"').unwrap_or(after_q.len());
            &after_q[..end]
        } else if let Some(after_q) = val_start.strip_prefix('\'') {
            let end = after_q.find('\'').unwrap_or(after_q.len());
            &after_q[..end]
        } else {
            let end = val_start
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
                .unwrap_or(val_start.len());
            &val_start[..end]
        };

        if !token.is_empty() && !token.starts_with("--") {
            return Some(token.to_string());
        }
    }
    None
}

fn utf16_key_eq_ascii_ignore_case(slice: &[u16], expected: &str) -> bool {
    slice.len() == expected.len()
        && slice
            .iter()
            .zip(expected.as_bytes().iter())
            .all(|(&w, &b)| w <= 0x7F && (w as u8).eq_ignore_ascii_case(&b))
}

fn parse_port_from_ls_address(raw: &str) -> Option<u16> {
    let trimmed = raw.trim().trim_end_matches('/');
    let (_, port_part) = trimmed.rsplit_once(':')?;
    let port: u16 = port_part.parse().ok()?;
    if port > 0 { Some(port) } else { None }
}

/// Scan a UTF-16LE Windows environment block (`KEY=VAL\0KEY2=VAL2\0\0`) for:
/// - `ANTIGRAVITY_SERVER_CSRF_TOKEN` (highest priority)
/// - `ANTIGRAVITY_CSRF_TOKEN` (Antigravity 2.34+ sidecar/child process env var)
/// - `ANTIGRAVITY_LS_ADDRESS` (optional `host:port` binding check)
pub fn scan_env_utf16_for_csrf(words: &[u16]) -> EnvCsrfScan {
    let mut server_csrf: Option<String> = None;
    let mut sidecar_csrf: Option<String> = None;
    let mut ls_port: Option<u16> = None;

    let mut pos = 0usize;
    while pos < words.len() {
        if words[pos] == 0 {
            // Double-NUL end of environment block
            break;
        }
        let end = words[pos..]
            .iter()
            .position(|&w| w == 0)
            .map(|off| pos + off)
            .unwrap_or(words.len());

        let entry = &words[pos..end];
        if let Some(eq_idx) = entry.iter().position(|&w| w == b'=' as u16) {
            let key = &entry[..eq_idx];
            let val_slice = &entry[eq_idx + 1..];
            if !val_slice.is_empty() {
                if utf16_key_eq_ascii_ignore_case(key, SERVER_CSRF_ENV_KEY) {
                    let val = String::from_utf16_lossy(val_slice).trim().to_string();
                    if !val.is_empty() {
                        server_csrf = Some(val);
                    }
                } else if utf16_key_eq_ascii_ignore_case(key, SIDECAR_CSRF_ENV_KEY) {
                    let val = String::from_utf16_lossy(val_slice).trim().to_string();
                    if !val.is_empty() {
                        sidecar_csrf = Some(val);
                    }
                } else if utf16_key_eq_ascii_ignore_case(key, LS_ADDRESS_ENV_KEY) {
                    let val = String::from_utf16_lossy(val_slice);
                    ls_port = parse_port_from_ls_address(&val);
                }
            }
        }

        if end >= words.len() {
            break;
        }
        pos = end + 1;
    }

    EnvCsrfScan {
        csrf_token: server_csrf.or(sidecar_csrf),
        ls_port,
    }
}

fn read_remote_env_csrf(
    handle: HANDLE,
    env_addr: u64,
    hint_env_size: Option<usize>,
) -> EnvCsrfScan {
    if env_addr == 0 {
        return EnvCsrfScan::default();
    }

    let mut mbi: MEMORY_BASIC_INFORMATION = unsafe { std::mem::zeroed() };
    let queried = unsafe {
        VirtualQueryEx(
            handle,
            env_addr as *const c_void,
            &mut mbi,
            size_of::<MEMORY_BASIC_INFORMATION>(),
        )
    };
    if queried == 0 {
        return EnvCsrfScan::default();
    }
    if mbi.State != MEM_COMMIT || (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD)) != 0 {
        return EnvCsrfScan::default();
    }

    let region_end = (mbi.BaseAddress as usize).saturating_add(mbi.RegionSize);
    let avail = region_end.saturating_sub(env_addr as usize);
    let mut max_bytes = avail.min(MAX_ENV_BYTES);
    if let Some(sz) = hint_env_size {
        if sz > 0 && sz < max_bytes {
            max_bytes = sz;
        }
    }
    // UTF-16 alignment: round down to even number of bytes
    max_bytes &= !1;
    if max_bytes < 2 {
        return EnvCsrfScan::default();
    }

    let mut words: Vec<u16> = Vec::with_capacity((max_bytes / 2).min(16_384));
    let mut chunk = vec![0u8; ENV_CHUNK_BYTES];
    let mut offset: usize = 0;
    let mut prev_was_zero = false;
    let mut hit_double_nul = false;

    while offset < max_bytes && !hit_double_nul {
        let to_read = (max_bytes - offset).min(chunk.len()) & !1;
        if to_read < 2 {
            break;
        }
        let Some(n) = read_remote_bytes(
            handle,
            env_addr.saturating_add(offset as u64),
            &mut chunk[..to_read],
        ) else {
            break;
        };
        let even_n = n & !1;
        if even_n == 0 {
            break;
        }
        for pair in chunk[..even_n].chunks_exact(2) {
            let w = u16::from_le_bytes([pair[0], pair[1]]);
            words.push(w);
            if w == 0 {
                if words.len() == 1 || prev_was_zero {
                    hit_double_nul = true;
                    break;
                }
                prev_was_zero = true;
            } else {
                prev_was_zero = false;
            }
        }
        offset = offset.saturating_add(even_n);
        if n < to_read {
            break;
        }
    }

    let scan = scan_env_utf16_for_csrf(&words);
    zeroize_bytes(&mut chunk);
    zeroize_u16(&mut words);
    scan
}

fn read_peb_process_params(handle: HANDLE) -> Option<(u64, RtlUserProcessParametersHead)> {
    let mut pbi: PROCESS_BASIC_INFORMATION = unsafe { std::mem::zeroed() };
    let mut ret_len: u32 = 0;
    let status = unsafe {
        NtQueryInformationProcess(
            handle,
            ProcessBasicInformation,
            &mut pbi as *mut _ as *mut c_void,
            size_of::<PROCESS_BASIC_INFORMATION>() as u32,
            &mut ret_len,
        )
    };
    if status < 0 || pbi.PebBaseAddress.is_null() {
        return None;
    }

    let peb = read_remote_struct::<PEB>(handle, pbi.PebBaseAddress as u64)?;
    let params_addr = peb.ProcessParameters as u64;
    if params_addr == 0 {
        return None;
    }
    let head = read_remote_struct::<RtlUserProcessParametersHead>(handle, params_addr)?;
    Some((params_addr, head))
}

fn read_hint_env_size(
    handle: HANDLE,
    params_addr: u64,
    head: &RtlUserProcessParametersHead,
) -> Option<usize> {
    if (head.length as u64) >= RTL_PARAMS_ENV_SIZE_OFFSET + 8 {
        read_remote_struct::<u64>(
            handle,
            params_addr.saturating_add(RTL_PARAMS_ENV_SIZE_OFFSET),
        )
        .and_then(|v| usize::try_from(v).ok())
    } else {
        None
    }
}

/// Read `(cmd_line, csrf_token)` from a 64-bit target process's PEB -> `RTL_USER_PROCESS_PARAMETERS`.
pub fn read_peb_cmdline_and_csrf(handle: HANDLE, scan_env_for_csrf: bool) -> (String, Option<String>) {
    let Some((params_addr, head)) = read_peb_process_params(handle) else {
        return (String::new(), None);
    };

    let cmd_line = {
        let len_bytes = head.command_line.length as usize;
        if len_bytes > 0
            && len_bytes % 2 == 0
            && len_bytes <= MAX_CMDLINE_BYTES
            && head.command_line.buffer != 0
        {
            let mut raw = vec![0u8; len_bytes];
            if let Some(read_n) = read_remote_bytes(handle, head.command_line.buffer, &mut raw) {
                let mut units: Vec<u16> = raw[..(read_n & !1)]
                    .chunks_exact(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .collect();
                let end = units.iter().position(|&w| w == 0).unwrap_or(units.len());
                let text = String::from_utf16_lossy(&units[..end]);
                zeroize_u16(&mut units);
                zeroize_bytes(&mut raw);
                text
            } else {
                zeroize_bytes(&mut raw);
                String::new()
            }
        } else {
            String::new()
        }
    };

    let mut csrf = extract_csrf_token_from_cmdline(&cmd_line);
    if csrf.is_none() && scan_env_for_csrf && head.environment != 0 {
        let hint_env_size = read_hint_env_size(handle, params_addr, &head);
        csrf = read_remote_env_csrf(handle, head.environment, hint_env_size).csrf_token;
    }

    (cmd_line, csrf)
}

/// On Windows Antigravity >= 2.34, `language_server.exe` unsets `ANTIGRAVITY_SERVER_CSRF_TOKEN`
/// from its own mutable PEB environment after startup, while passing `ANTIGRAVITY_CSRF_TOKEN` and
/// `ANTIGRAVITY_LS_ADDRESS` to its descendant sidecar processes. Walk up to 4 hops of descendants
/// strictly rooted at `ls_pid` to recover the CSRF token safely.
pub fn resolve_descendant_csrf_token(
    ls_pid: u32,
    ls_ports: &[u16],
    snapshot: &[ProcessSnapshotEntry],
) -> Option<String> {
    let mut children_map: HashMap<u32, Vec<u32>> = HashMap::new();
    for entry in snapshot {
        if entry.pid != 0 && entry.parent_pid != 0 && entry.pid != entry.parent_pid {
            children_map.entry(entry.parent_pid).or_default().push(entry.pid);
        }
    }

    let mut visited: HashSet<u32> = HashSet::new();
    visited.insert(ls_pid);
    let mut queue: VecDeque<(u32, u8)> = VecDeque::new();
    if let Some(children) = children_map.get(&ls_pid) {
        for &child in children {
            if visited.insert(child) {
                queue.push_back((child, 1));
            }
        }
    }

    let mut inspected: usize = 0;
    const MAX_DESCENDANTS: usize = 64;
    const MAX_DEPTH: u8 = 4;

    while let Some((pid, depth)) = queue.pop_front() {
        if inspected >= MAX_DESCENDANTS {
            break;
        }
        inspected += 1;

        if let Some((handle, true)) = open_process_for_inspect(pid) {
            if let Some((params_addr, head)) = read_peb_process_params(handle.as_raw()) {
                if head.environment != 0 {
                    let hint = read_hint_env_size(handle.as_raw(), params_addr, &head);
                    let scan = read_remote_env_csrf(handle.as_raw(), head.environment, hint);
                    if let Some(token) = scan.csrf_token {
                        let port_ok = match (scan.ls_port, ls_ports.is_empty()) {
                            (Some(p), false) => ls_ports.contains(&p),
                            _ => true,
                        };
                        if port_ok {
                            return Some(token);
                        }
                    }
                }
            }
        }

        if depth < MAX_DEPTH {
            if let Some(children) = children_map.get(&pid) {
                for &child in children {
                    if visited.insert(child) {
                        queue.push_back((child, depth + 1));
                    }
                }
            }
        }
    }

    None
}

pub fn app_processes(prefixes: &[String]) -> Result<AppProcessesResponse, HelperError> {
    let entries = snapshot_processes()?;
    let mut processes = Vec::new();

    for entry in entries {
        let pid = entry.pid;
        if pid == 0 {
            continue;
        }
        let Some((handle, has_vm_read)) = open_process_for_inspect(pid) else {
            continue;
        };
        let Some(exe_path) = query_process_exe_path(handle.as_raw()) else {
            continue;
        };
        if !prefixes.is_empty() && !prefixes.iter().any(|p| path_matches_prefix(&exe_path, p)) {
            continue;
        }
        let cmd_line = if has_vm_read {
            read_peb_cmdline_and_csrf(handle.as_raw(), false).0
        } else {
            String::new()
        };
        processes.push(AppProcessInfo {
            pid,
            exe_path,
            cmd_line,
        });
    }

    processes.sort_by_key(|p| p.pid);
    Ok(AppProcessesResponse {
        ok: true,
        processes,
    })
}

fn find_matching_pids(prefixes: &[String]) -> Result<Vec<u32>, HelperError> {
    let self_pid = std::process::id();
    let entries = snapshot_processes()?;
    let mut pids = Vec::new();

    for entry in entries {
        let pid = entry.pid;
        if pid == 0 || pid == self_pid {
            continue;
        }
        let Some(exe_path) = query_pid_exe_path(pid) else {
            continue;
        };
        if prefixes.iter().any(|p| path_matches_prefix(&exe_path, p)) {
            pids.push(pid);
        }
    }

    pids.sort_unstable();
    pids.dedup();
    Ok(pids)
}

struct EnumWindowsState {
    target_pids: HashSet<u32>,
    windows: Vec<(HWND, bool, bool)>, // (hwnd, is_visible, has_owner)
}

unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let state = unsafe { &mut *(lparam as *mut EnumWindowsState) };
    let mut win_pid: u32 = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, &mut win_pid);
    }
    if state.target_pids.contains(&win_pid) {
        let is_visible = unsafe { IsWindowVisible(hwnd) } != 0;
        let has_owner = !unsafe { GetWindow(hwnd, GW_OWNER) }.is_null();
        state.windows.push((hwnd, is_visible, has_owner));
    }
    1
}

pub fn app_graceful_close(
    prefixes: &[String],
    timeout_ms: u64,
) -> Result<GracefulCloseResponse, HelperError> {
    if prefixes.is_empty() || prefixes.iter().any(|p| p.trim().is_empty()) {
        return Err(HelperError::invalid_args(
            "app-graceful-close requires at least one non-empty --prefix",
        ));
    }

    let initial_pids = find_matching_pids(prefixes)?;
    if initial_pids.is_empty() {
        return Ok(GracefulCloseResponse {
            ok: true,
            closed: true,
            remaining_pids: Vec::new(),
        });
    }

    let mut state = EnumWindowsState {
        target_pids: initial_pids.iter().copied().collect(),
        windows: Vec::new(),
    };
    unsafe {
        EnumWindows(
            Some(enum_windows_proc),
            &mut state as *mut EnumWindowsState as LPARAM,
        );
    }

    // Prefer visible top-level unowned windows, then visible windows, then unowned top-level windows
    let mut targets: Vec<HWND> = state
        .windows
        .iter()
        .filter(|&&(_, vis, owned)| vis && !owned)
        .map(|&(h, _, _)| h)
        .collect();
    if targets.is_empty() {
        targets = state
            .windows
            .iter()
            .filter(|&&(_, vis, _)| vis)
            .map(|&(h, _, _)| h)
            .collect();
    }
    if targets.is_empty() {
        targets = state
            .windows
            .iter()
            .filter(|&&(_, _, owned)| !owned)
            .map(|&(h, _, _)| h)
            .collect();
    }

    for hwnd in targets {
        unsafe {
            PostMessageW(hwnd, WM_CLOSE, 0, 0);
        }
    }

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let remaining = find_matching_pids(prefixes)?;
        if remaining.is_empty() {
            return Ok(GracefulCloseResponse {
                ok: true,
                closed: true,
                remaining_pids: Vec::new(),
            });
        }
        let now = Instant::now();
        if now >= deadline {
            return Ok(GracefulCloseResponse {
                ok: true,
                closed: false,
                remaining_pids: remaining,
            });
        }
        let sleep_for = Duration::from_millis(100).min(deadline - now);
        thread::sleep(sleep_for);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::offset_of;

    #[test]
    fn x64_peb_and_rtl_params_offsets_match_windows_abi() {
        #[cfg(target_arch = "x86_64")]
        {
            assert_eq!(offset_of!(PEB, ProcessParameters), 0x20);
            assert_eq!(offset_of!(RtlUserProcessParametersHead, command_line), 0x70);
            assert_eq!(offset_of!(RtlUserProcessParametersHead, environment), 0x80);
            assert_eq!(size_of::<RtlUserProcessParametersHead>(), 0x88);
        }
    }

    #[test]
    fn parses_csrf_token_from_cmdline() {
        assert_eq!(
            extract_csrf_token_from_cmdline(r#""C:\app\ls.exe" --csrf_token=tok_123 --port 8080"#),
            Some("tok_123".to_string())
        );
        assert_eq!(
            extract_csrf_token_from_cmdline(r#"ls.exe --csrf_token tok_456 --other"#),
            Some("tok_456".to_string())
        );
        assert_eq!(
            extract_csrf_token_from_cmdline(r#"ls.exe --csrf_token="tok_789""#),
            Some("tok_789".to_string())
        );
        assert_eq!(
            extract_csrf_token_from_cmdline(r#"ls.exe --csrf_token_other=bad --foo bar"#),
            None
        );
        assert_eq!(
            extract_csrf_token_from_cmdline(r#"ls.exe --csrf_token --next-flag"#),
            None
        );
    }

    #[test]
    fn parses_csrf_token_from_utf16_env_block() {
        let mut block: Vec<u16> = Vec::new();
        for entry in [
            "PATH=C:\\Windows\\System32",
            "ANTIGRAVITY_SERVER_CSRF_TOKEN=unit-csrf-sample-value",
            "ANTIGRAVITY_CSRF_TOKEN=fallback-value",
            "ANTIGRAVITY_LS_ADDRESS=localhost:54398",
            "TEMP=C:\\Temp",
        ] {
            block.extend(entry.encode_utf16());
            block.push(0);
        }
        block.push(0);

        let scan = scan_env_utf16_for_csrf(&block);
        assert_eq!(scan.csrf_token.as_deref(), Some("unit-csrf-sample-value"));
        assert_eq!(scan.ls_port, Some(54398));

        // Sidecar fallback when ANTIGRAVITY_SERVER_CSRF_TOKEN is absent
        let mut sidecar_block: Vec<u16> = Vec::new();
        for entry in [
            "ANTIGRAVITY_CSRF_TOKEN=sidecar-unit-token",
            "ANTIGRAVITY_LS_ADDRESS=127.0.0.1:50409",
        ] {
            sidecar_block.extend(entry.encode_utf16());
            sidecar_block.push(0);
        }
        sidecar_block.push(0);
        let sidecar_scan = scan_env_utf16_for_csrf(&sidecar_block);
        assert_eq!(sidecar_scan.csrf_token.as_deref(), Some("sidecar-unit-token"));
        assert_eq!(sidecar_scan.ls_port, Some(50409));

        let empty: Vec<u16> = vec![0, 0];
        assert_eq!(scan_env_utf16_for_csrf(&empty), EnvCsrfScan::default());
    }

    #[test]
    fn app_processes_finds_current_test_process() {
        let exe = std::env::current_exe().expect("current_exe");
        let dir = exe.parent().expect("parent").to_string_lossy().to_string();
        let res = app_processes(&[dir]).expect("app_processes");
        assert!(res.ok);
        let self_pid = std::process::id();
        assert!(res.processes.iter().any(|p| p.pid == self_pid));
    }

    #[test]
    fn app_graceful_close_returns_closed_when_no_matching_process() {
        let res = app_graceful_close(
            &[r"C:\__gravitybox_nonexistent_app_dir__".to_string()],
            200,
        )
        .expect("app_graceful_close");
        assert!(res.ok);
        assert!(res.closed);
        assert!(res.remaining_pids.is_empty());
    }
}
