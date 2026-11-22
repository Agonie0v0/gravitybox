mod cred;
mod error;
mod network;
mod pe;
mod process;
mod trash;
mod util;

use std::env;
use std::io::{self, Write};
use std::process::ExitCode;

use serde::Serialize;

use crate::error::HelperError;

fn emit_json<T: Serialize>(value: &T) {
    let line = serde_json::to_string(value).unwrap_or_else(|_| {
        r#"{"ok":false,"code":"SERIALIZE_ERROR","error":"failed to serialize response"}"#
            .to_string()
    });
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    let _ = handle.write_all(line.as_bytes());
    let _ = handle.write_all(b"\n");
    let _ = handle.flush();
}

fn emit_error(err: &HelperError) {
    let line = err.to_json_line();
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    let _ = handle.write_all(line.as_bytes());
    let _ = handle.write_all(b"\n");
    let _ = handle.flush();
}

/// Split `--flag=value` or take next arg as value for `--flag value`.
fn parse_flag_value(
    flag_name: &str,
    arg: &str,
    args: &mut std::iter::Peekable<std::vec::IntoIter<String>>,
) -> Result<Option<String>, HelperError> {
    if arg == flag_name {
        let val = args
            .next()
            .ok_or_else(|| HelperError::invalid_args(format!("missing value for {flag_name}")))?;
        Ok(Some(val))
    } else if let Some(rest) = arg.strip_prefix(flag_name).and_then(|s| s.strip_prefix('=')) {
        Ok(Some(rest.to_string()))
    } else {
        Ok(None)
    }
}

fn dispatch(mut args: Vec<String>) -> Result<(), HelperError> {
    if args.len() < 2 {
        return Err(HelperError::invalid_args(
            "missing subcommand (expected one of: cred-read, cred-write, cred-delete, ls-inspect, port-owner, app-processes, app-graceful-close, trash-move, pe-version)",
        ));
    }

    let subcommand = args.remove(1);
    let rest: Vec<String> = args.into_iter().skip(1).collect();
    let mut iter = rest.into_iter().peekable();

    match subcommand.as_str() {
        "cred-read" => {
            let mut service: Option<String> = None;
            let mut account: Option<String> = None;
            while let Some(arg) = iter.next() {
                if let Some(v) = parse_flag_value("--service", &arg, &mut iter)? {
                    service = Some(v);
                } else if let Some(v) = parse_flag_value("--account", &arg, &mut iter)? {
                    account = Some(v);
                } else {
                    return Err(HelperError::invalid_args("unknown argument for cred-read"));
                }
            }
            let service = service.ok_or_else(|| HelperError::invalid_args("missing --service"))?;
            let account = account.ok_or_else(|| HelperError::invalid_args("missing --account"))?;
            let resp = cred::cred_read(&service, &account)?;
            emit_json(&resp);
            Ok(())
        }

        "cred-write" => {
            if iter.peek().is_some() {
                return Err(HelperError::invalid_args(
                    "cred-write accepts no CLI arguments; pass JSON via stdin",
                ));
            }
            let resp = cred::cred_write_from_stdin()?;
            emit_json(&resp);
            Ok(())
        }

        "cred-delete" => {
            let mut service: Option<String> = None;
            let mut account: Option<String> = None;
            while let Some(arg) = iter.next() {
                if let Some(v) = parse_flag_value("--service", &arg, &mut iter)? {
                    service = Some(v);
                } else if let Some(v) = parse_flag_value("--account", &arg, &mut iter)? {
                    account = Some(v);
                } else {
                    return Err(HelperError::invalid_args("unknown argument for cred-delete"));
                }
            }
            let service = service.ok_or_else(|| HelperError::invalid_args("missing --service"))?;
            let account = account.ok_or_else(|| HelperError::invalid_args("missing --account"))?;
            let resp = cred::cred_delete(&service, &account)?;
            emit_json(&resp);
            Ok(())
        }

        "ls-inspect" => {
            let mut exe_filter: Option<String> = None;
            while let Some(arg) = iter.next() {
                if let Some(v) = parse_flag_value("--exe-filter", &arg, &mut iter)? {
                    exe_filter = Some(v);
                } else {
                    return Err(HelperError::invalid_args("unknown argument for ls-inspect"));
                }
            }
            let resp = network::ls_inspect(exe_filter.as_deref())?;
            emit_json(&resp);
            Ok(())
        }

        "port-owner" => {
            let mut port_str: Option<String> = None;
            while let Some(arg) = iter.next() {
                if let Some(v) = parse_flag_value("--port", &arg, &mut iter)? {
                    port_str = Some(v);
                } else {
                    return Err(HelperError::invalid_args("unknown argument for port-owner"));
                }
            }
            let port_str = port_str.ok_or_else(|| HelperError::invalid_args("missing --port"))?;
            let port: u16 = port_str
                .parse()
                .map_err(|_| HelperError::invalid_args("invalid --port (expected 1..65535)"))?;
            let resp = network::port_owner(port)?;
            emit_json(&resp);
            Ok(())
        }

        "app-processes" => {
            let mut prefixes: Vec<String> = Vec::new();
            while let Some(arg) = iter.next() {
                if let Some(v) = parse_flag_value("--prefix", &arg, &mut iter)? {
                    if !v.trim().is_empty() {
                        prefixes.push(v);
                    }
                } else {
                    return Err(HelperError::invalid_args(
                        "unknown argument for app-processes",
                    ));
                }
            }
            let resp = process::app_processes(&prefixes)?;
            emit_json(&resp);
            Ok(())
        }

        "app-graceful-close" => {
            let mut prefixes: Vec<String> = Vec::new();
            let mut timeout_ms: u64 = 8000;
            while let Some(arg) = iter.next() {
                if let Some(v) = parse_flag_value("--prefix", &arg, &mut iter)? {
                    prefixes.push(v);
                } else if let Some(v) = parse_flag_value("--timeout-ms", &arg, &mut iter)? {
                    timeout_ms = v.parse().map_err(|_| {
                        HelperError::invalid_args("invalid --timeout-ms (expected integer >= 0)")
                    })?;
                } else {
                    return Err(HelperError::invalid_args(
                        "unknown argument for app-graceful-close",
                    ));
                }
            }
            if prefixes.is_empty() {
                return Err(HelperError::invalid_args("missing --prefix"));
            }
            let resp = process::app_graceful_close(&prefixes, timeout_ms)?;
            emit_json(&resp);
            Ok(())
        }

        "trash-move" => {
            if iter.peek().is_some() {
                return Err(HelperError::invalid_args(
                    "trash-move accepts no CLI arguments; pass JSON via stdin",
                ));
            }
            let resp = trash::trash_move_from_stdin()?;
            emit_json(&resp);
            Ok(())
        }

        "pe-version" => {
            let mut path: Option<String> = None;
            while let Some(arg) = iter.next() {
                if let Some(v) = parse_flag_value("--path", &arg, &mut iter)? {
                    path = Some(v);
                } else {
                    return Err(HelperError::invalid_args("unknown argument for pe-version"));
                }
            }
            let path = path.ok_or_else(|| HelperError::invalid_args("missing --path"))?;
            let resp = pe::pe_version(&path)?;
            emit_json(&resp);
            Ok(())
        }

        _ => Err(HelperError::invalid_args("unknown subcommand")),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    match dispatch(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            emit_error(&err);
            ExitCode::FAILURE
        }
    }
}
