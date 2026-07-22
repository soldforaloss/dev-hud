//! User-defined cards: the HUD runs a small thing the user configured and
//! renders whatever JSON comes back.
//!
//! The card author is the user, so the threat here is not malice but blast
//! radius: a runaway process, a multi-megabyte payload, a card that quietly
//! becomes a network client. So every source is bounded (bytes, time), HTTP is
//! restricted to loopback, and the payload is sanitized on the way in —
//! rendering is text-only, so `<` and `>` never survive.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::types::{CustomCardPayload, CustomCardResult, CustomCardSpec};

/// Hard ceiling on any payload, whatever the card asks for.
const PAYLOAD_CEILING: u64 = 64 * 1024;
const SUPPORTED_SCHEMA: u32 = 1;
const MAX_METRICS: usize = 24;
const MAX_LABEL_CHARS: usize = 60;
const MAX_MESSAGE_CHARS: usize = 200;
const STATUSES: &[&str] = &["ok", "warning", "critical", "unknown"];

pub fn run_blocking(spec: &CustomCardSpec) -> CustomCardResult {
    let started = Instant::now();
    let at_unix = chrono::Utc::now().timestamp();
    let cap = spec.max_bytes.clamp(1, PAYLOAD_CEILING);
    let timeout = Duration::from_millis(spec.timeout_ms.clamp(200, 60_000));

    let raw = match spec.kind.as_str() {
        "command" => read_command(spec, cap, timeout),
        "file" => read_file(&spec.target, cap),
        "http" => read_http(&spec.target, cap, timeout),
        other => Err(format!(
            "unknown card kind {other:?} — expected \"command\", \"file\" or \"http\""
        )),
    };

    let (payload, error) = match raw.and_then(|text| validate_payload(&text, cap)) {
        Ok(p) => (Some(p), None),
        Err(e) => (None, Some(e)),
    };
    CustomCardResult {
        id: spec.id.clone(),
        ok: payload.is_some(),
        payload,
        error,
        duration_ms: started.elapsed().as_millis() as u64,
        at_unix,
    }
}

// ---------- sources ----------

/// Either a file the user pointed at, or a bare program name to be resolved on
/// PATH. Anything in between — a relative path, a traversal — is refused.
fn validate_command_target(target: &str) -> Result<(), String> {
    if target.trim().is_empty() {
        return Err("command target is empty".into());
    }
    if target.contains("..") || target.contains('\0') {
        return Err("command target may not contain '..' or a NUL byte".into());
    }
    if target.contains('/') || target.contains('\\') {
        return if Path::new(target).is_file() {
            Ok(())
        } else {
            Err(format!("{target:?} is not an existing file"))
        };
    }
    if target
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    {
        Ok(())
    } else {
        Err(format!("{target:?} is not a plain program name"))
    }
}

fn read_command(spec: &CustomCardSpec, cap: u64, timeout: Duration) -> Result<String, String> {
    validate_command_target(&spec.target)?;
    let mut cmd = Command::new(&spec.target);
    cmd.args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start {:?}: {e}", spec.target))?;

    // Read one byte past the cap so an oversized payload is detectable rather
    // than silently truncated into invalid JSON.
    let mut stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = stdout.as_mut() {
            let _ = (&mut *pipe).take(cap + 1).read_to_end(&mut buf);
            // Keep draining, or a chatty child blocks forever on a full pipe.
            let _ = std::io::copy(pipe, &mut std::io::sink());
        }
        buf
    });

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait(); // reap, so the card can't leak zombies
                    return Err(format!(
                        "{:?} did not finish within {}ms",
                        spec.target,
                        timeout.as_millis()
                    ));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(format!("waiting on {:?} failed: {e}", spec.target)),
        }
    }
    let bytes = reader.join().unwrap_or_default();
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn read_file(target: &str, cap: u64) -> Result<String, String> {
    if target.contains('\0') {
        return Err("file target contains a NUL byte".into());
    }
    let path = Path::new(target);
    if !path.is_absolute() {
        return Err("file target must be an absolute path".into());
    }
    if path
        .components()
        .any(|c| c == std::path::Component::ParentDir)
    {
        return Err("file target may not contain '..'".into());
    }
    let meta = std::fs::metadata(path).map_err(|e| format!("cannot read {target:?}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{target:?} is not a file"));
    }
    if meta.len() > cap {
        return Err(format!("file is {} bytes, limit is {cap}", meta.len()));
    }
    std::fs::read_to_string(path).map_err(|e| format!("cannot read {target:?}: {e}"))
}

struct LoopbackUrl {
    host: String,
    port: u16,
    path: String,
}

/// Custom cards stay local-first: loopback only, and the host is re-checked
/// after resolution so a hosts-file entry can't point "localhost" outward.
fn parse_loopback_http(target: &str) -> Result<LoopbackUrl, String> {
    let rest = target
        .strip_prefix("http://")
        .ok_or_else(|| format!("{target:?} is not an http:// URL"))?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if authority.contains('@') {
        return Err("credentials in the URL are not supported".into());
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (
            h,
            p.parse::<u16>()
                .map_err(|_| format!("{p:?} is not a port number"))?,
        ),
        None => (authority, 80u16),
    };
    if !matches!(host, "127.0.0.1" | "localhost") {
        return Err(format!(
            "{host:?} is not a local host — custom cards may only call 127.0.0.1 or localhost"
        ));
    }
    // The path goes into a request line verbatim, so nothing that could break
    // the line (or smuggle a header) is allowed through.
    if !path
        .bytes()
        .all(|b| b.is_ascii_graphic() && b != b'\\' && b != b'"')
    {
        return Err("URL path contains characters that are not allowed".into());
    }
    Ok(LoopbackUrl {
        host: host.to_string(),
        port,
        path: path.to_string(),
    })
}

fn read_http(target: &str, cap: u64, timeout: Duration) -> Result<String, String> {
    if target.starts_with("https://") {
        // Honest refusal beats a fake result: reqwest's blocking feature is
        // not enabled in this crate, so there is no TLS client to call from a
        // blocking context. Loopback http works; https does not.
        return Err(
            "https custom cards are not supported — this runner has no TLS client, use http:// on loopback"
                .into(),
        );
    }
    let url = parse_loopback_http(target)?;

    let addr: SocketAddr = (url.host.as_str(), url.port)
        .to_socket_addrs()
        .map_err(|e| format!("cannot resolve {}: {e}", url.host))?
        .find(|a| a.ip().is_loopback())
        .ok_or_else(|| format!("{} does not resolve to a loopback address", url.host))?;

    let mut stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|e| format!("cannot connect to {addr}: {e}"))?;
    stream.set_read_timeout(Some(timeout)).ok();
    stream.set_write_timeout(Some(timeout)).ok();

    // HTTP/1.0 on purpose: the server answers with a plain body and closes,
    // so there is no chunked framing to decode here.
    let request = format!(
        "GET {} HTTP/1.0\r\nHost: {}:{}\r\nUser-Agent: dev-hud\r\nAccept: application/json\r\n\r\n",
        url.path, url.host, url.port
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("request failed: {e}"))?;

    let mut raw = Vec::new();
    // Headers plus one byte past the payload cap, so oversize is detectable.
    let _ = stream.take(8 * 1024 + cap + 1).read_to_end(&mut raw);
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = text
        .split_once("\r\n\r\n")
        .or_else(|| text.split_once("\n\n"))
        .ok_or_else(|| "response had no header/body separator".to_string())?;
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("");
    if status != "200" {
        return Err(format!("endpoint answered with status {status:?}"));
    }
    Ok(body.to_string())
}

// ---------- payload ----------

/// Strip everything that could escape a text node, then clip. The UI renders
/// these as text; `<` and `>` are removed so that stays true even if a future
/// renderer is careless.
fn sanitize(s: &str, max_chars: usize) -> String {
    s.chars()
        .filter(|c| !c.is_control() && *c != '<' && *c != '>')
        .take(max_chars)
        .collect::<String>()
        .trim()
        .to_string()
}

pub fn validate_payload(raw: &str, max_bytes: u64) -> Result<CustomCardPayload, String> {
    let cap = max_bytes.clamp(1, PAYLOAD_CEILING);
    if raw.len() as u64 > cap {
        return Err(format!("payload is {} bytes, limit is {cap}", raw.len()));
    }
    let value: serde_json::Value =
        serde_json::from_str(raw.trim()).map_err(|e| format!("payload is not valid JSON: {e}"))?;

    match value.get("schemaVersion").and_then(|v| v.as_u64()) {
        Some(v) if v == SUPPORTED_SCHEMA as u64 => {}
        Some(other) => {
            return Err(format!(
                "schemaVersion {other} is not supported — this HUD reads schemaVersion {SUPPORTED_SCHEMA}"
            ))
        }
        None => {
            return Err(format!(
                "payload has no numeric schemaVersion — this HUD reads schemaVersion {SUPPORTED_SCHEMA}"
            ))
        }
    }

    let mut payload: CustomCardPayload = serde_json::from_value(value)
        .map_err(|e| format!("payload does not match the card contract: {e}"))?;

    if !STATUSES.contains(&payload.status.as_str()) {
        return Err(format!(
            "status {:?} is not one of ok/warning/critical/unknown",
            payload.status
        ));
    }
    payload.title = sanitize(&payload.title, MAX_LABEL_CHARS);
    payload.message = payload
        .message
        .as_deref()
        .map(|m| sanitize(m, MAX_MESSAGE_CHARS));

    payload.metrics.truncate(MAX_METRICS);
    for metric in &mut payload.metrics {
        // Scalars only: an object or array has no text rendering, and
        // flattening one would invent data the card never reported.
        if !matches!(
            metric.value,
            serde_json::Value::String(_)
                | serde_json::Value::Number(_)
                | serde_json::Value::Bool(_)
        ) {
            return Err(format!(
                "metric {:?} must be a string, number or bool",
                metric.label
            ));
        }
        metric.label = sanitize(&metric.label, MAX_LABEL_CHARS);
        metric.unit = metric.unit.as_deref().map(|u| sanitize(u, MAX_LABEL_CHARS));
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(metrics: &str) -> String {
        format!(
            r#"{{"schemaVersion":1,"status":"ok","title":"Build","metrics":[{metrics}]}}"#
        )
    }

    #[test]
    fn round_trips_a_valid_payload() {
        let raw = r#"{"schemaVersion":1,"status":"warning","title":"Queue",
            "metrics":[{"label":"depth","value":12,"unit":"jobs"},
                       {"label":"oldest","value":"3m"}],
            "message":"backlog growing"}"#;
        let p = validate_payload(raw, 4096).unwrap();
        assert_eq!(p.status, "warning");
        assert_eq!(p.title, "Queue");
        assert_eq!(p.metrics.len(), 2);
        assert_eq!(p.metrics[0].label, "depth");
        assert_eq!(p.metrics[0].unit.as_deref(), Some("jobs"));
        assert_eq!(p.message.as_deref(), Some("backlog growing"));
    }

    #[test]
    fn rejects_oversized_payload() {
        let raw = body(&format!(r#"{{"label":"x","value":"{}"}}"#, "a".repeat(500)));
        let err = validate_payload(&raw, 100).unwrap_err();
        assert!(err.contains("limit is 100"), "{err}");
    }

    #[test]
    fn max_bytes_is_clamped_to_the_ceiling() {
        let raw = format!(
            r#"{{"schemaVersion":1,"status":"ok","title":"x","metrics":[{{"label":"y","value":"{}"}}]}}"#,
            "a".repeat(100_000)
        );
        // The card asked for 1 MB; the ceiling still applies.
        let err = validate_payload(&raw, 1_000_000).unwrap_err();
        assert!(err.contains(&PAYLOAD_CEILING.to_string()), "{err}");
    }

    #[test]
    fn rejects_wrong_schema_version() {
        let raw = r#"{"schemaVersion":2,"status":"ok","title":"x","metrics":[]}"#;
        let err = validate_payload(raw, 4096).unwrap_err();
        assert!(err.contains("schemaVersion 2"), "{err}");
        assert!(err.contains("schemaVersion 1"), "{err}");

        let missing = r#"{"status":"ok","title":"x","metrics":[]}"#;
        assert!(validate_payload(missing, 4096)
            .unwrap_err()
            .contains("no numeric schemaVersion"));
    }

    #[test]
    fn rejects_unknown_status() {
        let raw = r#"{"schemaVersion":1,"status":"on fire","title":"x","metrics":[]}"#;
        let err = validate_payload(raw, 4096).unwrap_err();
        assert!(err.contains("ok/warning/critical/unknown"), "{err}");
    }

    #[test]
    fn strips_markup_and_control_characters() {
        let raw = r#"{"schemaVersion":1,"status":"ok","title":"<script>alert(1)</script>",
            "metrics":[{"label":"a\u0007<b>","value":1}],"message":"<img src=x>"}"#;
        let p = validate_payload(raw, 4096).unwrap();
        assert_eq!(p.title, "scriptalert(1)/script");
        assert_eq!(p.metrics[0].label, "ab");
        assert_eq!(p.message.as_deref(), Some("img src=x"));
    }

    #[test]
    fn truncates_long_title_and_message() {
        let raw = format!(
            r#"{{"schemaVersion":1,"status":"ok","title":"{}","metrics":[],"message":"{}"}}"#,
            "t".repeat(200),
            "m".repeat(500)
        );
        let p = validate_payload(&raw, PAYLOAD_CEILING).unwrap();
        assert_eq!(p.title.chars().count(), MAX_LABEL_CHARS);
        assert_eq!(p.message.unwrap().chars().count(), MAX_MESSAGE_CHARS);
    }

    #[test]
    fn caps_metric_count() {
        let metrics: Vec<String> = (0..100)
            .map(|i| format!(r#"{{"label":"m{i}","value":{i}}}"#))
            .collect();
        let p = validate_payload(&body(&metrics.join(",")), PAYLOAD_CEILING).unwrap();
        assert_eq!(p.metrics.len(), MAX_METRICS);
        assert_eq!(p.metrics[0].label, "m0");
    }

    #[test]
    fn rejects_non_scalar_metric_values() {
        for value in ["{\"a\":1}", "[1,2]", "null"] {
            let raw = body(&format!(r#"{{"label":"x","value":{value}}}"#));
            let err = validate_payload(&raw, PAYLOAD_CEILING).unwrap_err();
            assert!(err.contains("string, number or bool"), "{value}: {err}");
        }
        // Scalars all pass.
        for value in ["1.5", "true", "\"text\""] {
            let raw = body(&format!(r#"{{"label":"x","value":{value}}}"#));
            assert!(validate_payload(&raw, PAYLOAD_CEILING).is_ok(), "{value}");
        }
    }

    #[test]
    fn command_target_rejects_paths_and_traversal() {
        assert!(validate_command_target("node").is_ok());
        assert!(validate_command_target("my-tool.exe").is_ok());
        for bad in [
            "",
            "..",
            "../evil.exe",
            "C:\\nope\\missing.exe",
            "sub/dir/tool",
            "tool; calc",
            "tool arg",
            "a\u{0}b",
        ] {
            assert!(validate_command_target(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn http_targets_are_loopback_only() {
        let url = parse_loopback_http("http://127.0.0.1:8787/health").unwrap();
        assert_eq!((url.host.as_str(), url.port, url.path.as_str()), ("127.0.0.1", 8787, "/health"));
        let bare = parse_loopback_http("http://localhost").unwrap();
        assert_eq!((bare.port, bare.path.as_str()), (80, "/"));
        for bad in [
            "http://example.com/health",
            "http://10.0.0.5:80/x",
            "http://user:pw@localhost/x",
            "ftp://localhost/x",
            "http://localhost:notaport/x",
            "http://localhost/a b",
            "http://localhost/a\r\nHost: evil",
        ] {
            assert!(parse_loopback_http(bad).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn https_is_refused_with_a_reason() {
        let err = read_http("https://localhost/health", 1024, Duration::from_millis(200))
            .unwrap_err();
        assert!(err.contains("no TLS client"), "{err}");
    }
}
