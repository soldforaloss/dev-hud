//! Explicit MCP handshake: spawn a configured server, speak JSON-RPC 2.0 over
//! stdio, and report what it says about itself. Never polled — this starts a
//! real child process, so it only runs when the user asks for it.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::types::McpHealth;

/// Everything below bounds what an unknown third-party process can do to us.
const MAX_READ_BYTES: u64 = 512 * 1024;
const MAX_TOOLS: usize = 200;
const MAX_TOOL_NAME: usize = 80;
const MAX_ERROR_CHARS: usize = 200;

const INITIALIZE: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"ai-hud","version":"0.1.0"}}}"#;
const INITIALIZED: &str = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
const TOOLS_LIST: &str = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#;

const INIT_ID: u64 = 1;
const TOOLS_ID: u64 = 2;

fn configure(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

fn failed(error: String) -> McpHealth {
    McpHealth {
        ok: false,
        error: Some(error.chars().take(MAX_ERROR_CHARS).collect()),
        ..Default::default()
    }
}

/// Handshake with the server at `command`/`args`. `name` is left empty — the
/// caller labels the result, since only it knows which config entry this was.
pub fn check(command: &str, args: &[String], timeout: Duration) -> McpHealth {
    let deadline = Instant::now() + timeout;
    let mut cmd = Command::new(command);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // stderr is where MCP servers put their logging; it is not protocol.
        .stderr(Stdio::null());
    configure(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return failed(format!("spawn failed: {e}")),
    };
    let result = session(&mut child, deadline);
    // Always kill and reap, on every path: this child is a live server that
    // would otherwise outlive the check.
    let _ = child.kill();
    let _ = child.wait();
    match result {
        Ok(health) => health,
        Err(e) => failed(e),
    }
}

fn session(child: &mut Child, deadline: Instant) -> Result<McpHealth, String> {
    let stdout = child.stdout.take().ok_or("no stdout pipe")?;
    let lines = spawn_reader(stdout);
    let mut stdin = child.stdin.take().ok_or("no stdin pipe")?;

    let started = Instant::now();
    send(&mut stdin, INITIALIZE)?;
    let init = read_response(&lines, INIT_ID, deadline)?;
    // Latency is the round trip to a working initialize — the one number that
    // says "this server actually starts".
    let latency_ms = started.elapsed().as_millis() as u64;
    if let Some(err) = init.get("error") {
        return Err(rpc_error(err));
    }
    let mut health = McpHealth {
        ok: true,
        latency_ms: Some(latency_ms),
        server_name: string_at(&init, "/result/serverInfo/name"),
        server_version: string_at(&init, "/result/serverInfo/version"),
        protocol_version: string_at(&init, "/result/protocolVersion"),
        ..Default::default()
    };

    send(&mut stdin, INITIALIZED)?;
    send(&mut stdin, TOOLS_LIST)?;
    // A server that completes initialize is healthy even if it exposes no
    // tools endpoint — record why the list is empty instead of failing it.
    match read_response(&lines, TOOLS_ID, deadline) {
        Ok(v) => match v.get("error") {
            Some(err) => health.error = Some(rpc_error(err)),
            None => health.tools = tool_names(&v),
        },
        Err(e) => health.error = Some(e),
    }
    Ok(health)
}

/// Read stdout on its own thread so the deadline can be enforced without
/// platform-specific non-blocking IO. `take` caps total bytes at the source,
/// so a single unterminated line can't balloon memory either.
fn spawn_reader(stdout: ChildStdout) -> Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout.take(MAX_READ_BYTES));
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });
    rx
}

fn read_response(lines: &Receiver<String>, id: u64, deadline: Instant) -> Result<Value, String> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!("timed out waiting for response {id}"));
        }
        match lines.recv_timeout(remaining) {
            Ok(line) => {
                if let Some(v) = response_for(&line, id) {
                    return Ok(v);
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                return Err(format!("timed out waiting for response {id}"))
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err("server closed stdout before responding".into())
            }
        }
    }
}

/// The JSON-RPC response carrying `id`, or None for anything else on the wire:
/// notifications, log noise, and replies to other requests.
fn response_for(line: &str, id: u64) -> Option<Value> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("jsonrpc")?.as_str()? != "2.0" {
        return None;
    }
    if v.get("id")?.as_u64()? != id {
        return None;
    }
    Some(v)
}

fn send(stdin: &mut ChildStdin, msg: &str) -> Result<(), String> {
    stdin
        .write_all(msg.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("write failed: {e}"))
}

fn string_at(v: &Value, pointer: &str) -> Option<String> {
    v.pointer(pointer)
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(MAX_ERROR_CHARS).collect())
}

fn tool_names(v: &Value) -> Vec<String> {
    v.pointer("/result/tools")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.get("name").and_then(|n| n.as_str()))
                .take(MAX_TOOLS)
                .map(truncate)
                .collect()
        })
        .unwrap_or_default()
}

/// Clamp by chars, not bytes — a server is free to name a tool in any script.
fn truncate(s: &str) -> String {
    s.chars().take(MAX_TOOL_NAME).collect()
}

fn rpc_error(err: &Value) -> String {
    let msg = err
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("server returned an error");
    msg.chars().take(MAX_ERROR_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_only_the_response_with_the_asked_for_id() {
        let line = r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}"#;
        let v = response_for(line, 1).expect("id 1 should match");
        assert_eq!(string_at(&v, "/result/protocolVersion").as_deref(), Some("2024-11-05"));
        assert!(response_for(line, 2).is_none());
    }

    #[test]
    fn ignores_notifications_noise_and_bad_frames() {
        // No id at all — a notification, not our response.
        assert!(response_for(r#"{"jsonrpc":"2.0","method":"notifications/message"}"#, 1).is_none());
        // Plain log output on stdout.
        assert!(response_for("server listening on stdio", 1).is_none());
        assert!(response_for("", 1).is_none());
        // Valid JSON, wrong protocol.
        assert!(response_for(r#"{"id":1,"result":{}}"#, 1).is_none());
        // Trailing newline from read_line must not break parsing.
        assert!(response_for("{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}\n", 2).is_some());
    }

    #[test]
    fn error_responses_are_returned_so_the_caller_can_report_them() {
        let line = r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"nope"}}"#;
        let v = response_for(line, 1).expect("error responses still match by id");
        assert_eq!(rpc_error(v.get("error").unwrap()), "nope");
    }

    #[test]
    fn tool_names_are_capped_in_count_and_length() {
        let many: Vec<Value> = (0..250)
            .map(|i| serde_json::json!({ "name": format!("tool{i}") }))
            .collect();
        let v = serde_json::json!({ "result": { "tools": many } });
        assert_eq!(tool_names(&v).len(), MAX_TOOLS);

        let long = "é".repeat(200);
        let v = serde_json::json!({ "result": { "tools": [{ "name": long }] } });
        assert_eq!(tool_names(&v)[0].chars().count(), MAX_TOOL_NAME);

        // Absent or malformed tool lists yield an empty list, never a panic.
        assert!(tool_names(&serde_json::json!({ "result": {} })).is_empty());
        assert!(tool_names(&serde_json::json!({ "result": { "tools": [{}] } })).is_empty());
    }

    #[test]
    fn spawn_failure_is_reported_not_panicked() {
        let health = check(
            "definitely-not-a-real-binary-ai-hud",
            &[],
            Duration::from_millis(500),
        );
        assert!(!health.ok);
        assert!(health.error.is_some());
        assert!(health.tools.is_empty() && health.latency_ms.is_none());
    }
}
