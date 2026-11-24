use std::collections::{BTreeSet, HashMap};
use std::ffi::c_void;
use std::mem::{offset_of, size_of};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::ptr;

use serde::Serialize;
use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP_STATE_LISTEN, MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID,
    MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
};
use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};

use crate::error::HelperError;
use crate::process::{
    open_process_for_inspect, query_pid_exe_path, query_process_exe_path,
    read_peb_cmdline_and_csrf, resolve_descendant_csrf_token, snapshot_processes,
};
use crate::util::{
    TokenUserBuffer, exe_matches_filter, path_file_name_lower, process_has_same_user_sid,
};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerProcess {
    pub pid: u32,
    pub exe_path: String,
    pub cmd_line: String,
    pub ports: Vec<u16>,
    pub csrf_token: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LsInspectResponse {
    pub ok: bool,
    pub processes: Vec<LanguageServerProcess>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct PortOwnerEntry {
    pub pid: u32,
    pub exe_path: String,
    pub local_address: String,
    pub port: u16,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PortOwnerResponse {
    pub ok: bool,
    pub owners: Vec<PortOwnerEntry>,
}

#[derive(Debug, Clone)]
struct TcpListenRow {
    pid: u32,
    local_address: String,
    is_loopback: bool,
    port: u16,
}

/// Maximum buffer allocation for `GetExtendedTcpTable` (32 MiB) to guard against unbounded allocation.
const MAX_TCP_TABLE_BYTES: usize = 32 * 1024 * 1024;

fn query_extended_tcp_table_raw(af: u32) -> Result<(Vec<u32>, usize), HelperError> {
    let mut size: u32 = 0;
    let first = unsafe {
        GetExtendedTcpTable(
            ptr::null_mut(),
            &mut size,
            0,
            af,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if first != ERROR_INSUFFICIENT_BUFFER && first != NO_ERROR {
        return Err(HelperError::win32("GetExtendedTcpTable(size)", first));
    }
    if size == 0 {
        return Ok((Vec::new(), 0));
    }
    if (size as usize) > MAX_TCP_TABLE_BYTES {
        return Err(HelperError::new(
            "WIN32_ERROR",
            "GetExtendedTcpTable required size exceeds 32 MiB limit",
        ));
    }

    for _attempt in 0..4 {
        let alloc_bytes = (size as usize).saturating_add(1024);
        if alloc_bytes > MAX_TCP_TABLE_BYTES {
            return Err(HelperError::new(
                "WIN32_ERROR",
                "GetExtendedTcpTable allocation exceeds 32 MiB limit",
            ));
        }
        let words = alloc_bytes.div_ceil(4);
        let mut buf = vec![0u32; words];
        let mut buf_size = (buf.len() * 4) as u32;
        let ret = unsafe {
            GetExtendedTcpTable(
                buf.as_mut_ptr() as *mut c_void,
                &mut buf_size,
                0,
                af,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if ret == NO_ERROR {
            let clamped = (buf_size as usize).min(buf.len() * 4);
            return Ok((buf, clamped));
        }
        if ret == ERROR_INSUFFICIENT_BUFFER {
            let next = buf_size.max(size.saturating_mul(2));
            if (next as usize) > MAX_TCP_TABLE_BYTES {
                return Err(HelperError::new(
                    "WIN32_ERROR",
                    "GetExtendedTcpTable required size exceeds 32 MiB limit",
                ));
            }
            size = next;
            continue;
        }
        return Err(HelperError::win32("GetExtendedTcpTable", ret));
    }

    Err(HelperError::new(
        "WIN32_ERROR",
        "GetExtendedTcpTable repeatedly returned ERROR_INSUFFICIENT_BUFFER",
    ))
}

fn query_ipv4_listeners() -> Result<Vec<TcpListenRow>, HelperError> {
    let (buf, raw_byte_len) = query_extended_tcp_table_raw(AF_INET as u32)?;
    let byte_len = raw_byte_len.min(buf.len() * 4);
    let table_offset = offset_of!(MIB_TCPTABLE_OWNER_PID, table);
    if byte_len < table_offset || buf.is_empty() {
        return Ok(Vec::new());
    }

    let num_entries = buf[0] as usize;
    let base_ptr = buf.as_ptr() as *const u8;
    let max_rows = (byte_len - table_offset) / size_of::<MIB_TCPROW_OWNER_PID>();
    let count = num_entries.min(max_rows);

    let mut rows = Vec::with_capacity(count);
    for i in 0..count {
        let row_ptr = unsafe {
            base_ptr.add(table_offset + i * size_of::<MIB_TCPROW_OWNER_PID>())
                as *const MIB_TCPROW_OWNER_PID
        };
        let row = unsafe { ptr::read_unaligned(row_ptr) };
        if row.dwState != MIB_TCP_STATE_LISTEN as u32 {
            continue;
        }
        let addr = Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes());
        let port = u16::from_be((row.dwLocalPort & 0xFFFF) as u16);
        if port == 0 {
            continue;
        }
        rows.push(TcpListenRow {
            pid: row.dwOwningPid,
            local_address: addr.to_string(),
            is_loopback: addr == Ipv4Addr::LOCALHOST,
            port,
        });
    }
    Ok(rows)
}

fn query_ipv6_listeners() -> Result<Vec<TcpListenRow>, HelperError> {
    let (buf, raw_byte_len) = query_extended_tcp_table_raw(AF_INET6 as u32)?;
    let byte_len = raw_byte_len.min(buf.len() * 4);
    let table_offset = offset_of!(MIB_TCP6TABLE_OWNER_PID, table);
    if byte_len < table_offset || buf.is_empty() {
        return Ok(Vec::new());
    }

    let num_entries = buf[0] as usize;
    let base_ptr = buf.as_ptr() as *const u8;
    let max_rows = (byte_len - table_offset) / size_of::<MIB_TCP6ROW_OWNER_PID>();
    let count = num_entries.min(max_rows);

    let mut rows = Vec::with_capacity(count);
    for i in 0..count {
        let row_ptr = unsafe {
            base_ptr.add(table_offset + i * size_of::<MIB_TCP6ROW_OWNER_PID>())
                as *const MIB_TCP6ROW_OWNER_PID
        };
        let row = unsafe { ptr::read_unaligned(row_ptr) };
        if row.dwState != MIB_TCP_STATE_LISTEN as u32 {
            continue;
        }
        let addr = Ipv6Addr::from(row.ucLocalAddr);
        let port = u16::from_be((row.dwLocalPort & 0xFFFF) as u16);
        if port == 0 {
            continue;
        }
        rows.push(TcpListenRow {
            pid: row.dwOwningPid,
            local_address: addr.to_string(),
            is_loopback: addr == Ipv6Addr::LOCALHOST,
            port,
        });
    }
    Ok(rows)
}

pub fn ls_inspect(exe_filter: Option<&str>) -> Result<LsInspectResponse, HelperError> {
    let filter_trimmed = exe_filter.map(str::trim).filter(|s| !s.is_empty());

    let self_user = TokenUserBuffer::from_current_process()
        .map_err(|err| HelperError::win32("GetTokenInformation(self)", err))?;
    let self_sid = self_user
        .sid_ptr()
        .ok_or_else(|| HelperError::new("WIN32_ERROR", "failed to resolve current user SID"))?;

    let mut tcp_rows = query_ipv4_listeners()?;
    if let Ok(v6_rows) = query_ipv6_listeners() {
        tcp_rows.extend(v6_rows);
    }
    let mut loopback_ports_by_pid: HashMap<u32, Vec<u16>> = HashMap::new();
    for row in tcp_rows {
        if row.is_loopback {
            loopback_ports_by_pid.entry(row.pid).or_default().push(row.port);
        }
    }
    for ports in loopback_ports_by_pid.values_mut() {
        ports.sort_unstable();
        ports.dedup();
    }

    let entries = snapshot_processes()?;
    let mut processes = Vec::new();

    for entry in &entries {
        let pid = entry.pid;
        if pid == 0 {
            continue;
        }
        // Fast pre-filter when using default `language_server.exe` mode
        if filter_trimmed.is_none() && !entry.exe_name.eq_ignore_ascii_case("language_server.exe") {
            continue;
        }

        let Some((handle, has_vm_read)) = open_process_for_inspect(pid) else {
            continue;
        };
        if !process_has_same_user_sid(handle.as_raw(), self_sid) {
            continue;
        }
        let Some(exe_path) = query_process_exe_path(handle.as_raw()) else {
            continue;
        };

        let matched = match filter_trimmed {
            None => path_file_name_lower(&exe_path) == "language_server.exe",
            Some(filter) => exe_matches_filter(&exe_path, filter),
        };
        if !matched {
            continue;
        }

        let ports = loopback_ports_by_pid.remove(&pid).unwrap_or_default();
        let (cmd_line, mut csrf_token) = if has_vm_read {
            read_peb_cmdline_and_csrf(handle.as_raw(), true)
        } else {
            (String::new(), None)
        };
        if csrf_token.is_none() {
            csrf_token = resolve_descendant_csrf_token(pid, &ports, &entries);
        }

        processes.push(LanguageServerProcess {
            pid,
            exe_path,
            cmd_line,
            ports,
            csrf_token,
        });
    }

    processes.sort_by_key(|p| p.pid);
    Ok(LsInspectResponse {
        ok: true,
        processes,
    })
}

pub fn port_owner(port: u16) -> Result<PortOwnerResponse, HelperError> {
    if port == 0 {
        return Err(HelperError::invalid_args("port must be between 1 and 65535"));
    }

    let mut rows = query_ipv4_listeners()?;
    // IPv6 table is best-effort if IPv6 stack is disabled on a machine
    if let Ok(v6) = query_ipv6_listeners() {
        rows.extend(v6);
    }

    let mut snap_names: Option<HashMap<u32, String>> = None;
    let mut exe_cache: HashMap<u32, String> = HashMap::new();
    let mut dedup: BTreeSet<PortOwnerEntry> = BTreeSet::new();

    for row in rows {
        if row.port != port {
            continue;
        }
        let exe_path = exe_cache
            .entry(row.pid)
            .or_insert_with(|| {
                if let Some(p) = query_pid_exe_path(row.pid) {
                    p
                } else {
                    let map = snap_names.get_or_insert_with(|| {
                        snapshot_processes()
                            .unwrap_or_default()
                            .into_iter()
                            .map(|e| (e.pid, e.exe_name))
                            .collect()
                    });
                    map.get(&row.pid).cloned().unwrap_or_default()
                }
            })
            .clone();

        dedup.insert(PortOwnerEntry {
            pid: row.pid,
            exe_path,
            local_address: row.local_address,
            port: row.port,
        });
    }

    Ok(PortOwnerResponse {
        ok: true,
        owners: dedup.into_iter().collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn tcp_table_num_entries_is_at_offset_zero() {
        assert_eq!(offset_of!(MIB_TCPTABLE_OWNER_PID, dwNumEntries), 0);
        assert_eq!(offset_of!(MIB_TCP6TABLE_OWNER_PID, dwNumEntries), 0);
    }

    #[test]
    fn port_owner_detects_local_ephemeral_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().unwrap().port();
        let res = port_owner(port).expect("port_owner");
        assert!(res.ok);
        let self_pid = std::process::id();
        assert!(
            res.owners
                .iter()
                .any(|o| o.pid == self_pid && o.port == port && o.local_address == "127.0.0.1"),
            "expected current test pid {self_pid} owning 127.0.0.1:{port}, got {:?}",
            res.owners
        );
        drop(listener);
    }

    #[test]
    fn ls_inspect_runs_safely_and_verifies_running_language_server_without_printing_secrets() {
        // NEVER print csrf_token or cmd_line to stdout/stderr!
        let res = ls_inspect(None).expect("ls_inspect");
        assert!(res.ok);
        for proc_info in &res.processes {
            assert!(proc_info.pid > 0);
            assert!(
                proc_info
                    .exe_path
                    .to_ascii_lowercase()
                    .ends_with("language_server.exe")
            );
            // If Antigravity language_server.exe is active on this machine, verify ports & non-empty csrfToken boolean
            if !proc_info.ports.is_empty() {
                assert!(
                    proc_info.csrf_token.as_deref().is_some_and(|t| !t.is_empty()),
                    "expected non-empty csrfToken for active language_server pid {}",
                    proc_info.pid
                );
            }
        }
    }
}
