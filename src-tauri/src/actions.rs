//! Validated operator actions and the audit trail behind them.
//!
//! Two invariants hold in every line of this file. Commands are argv arrays —
//! no string is ever handed to a shell, so a metacharacter in a name can never
//! become execution. And nothing reaches the UI before it has been through
//! `mask_secrets` and clipped: command output is the most common place a token
//! leaks into a screenshot.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::cli::{is_not_found, run_silent_timeout};
use crate::types::{ActionResult, AuditEntry};

/// A card shows an excerpt, never a log file.
const DETAIL_MAX: usize = 4000;
const AUDIT_MAX: usize = 500;
const REDACTED: &str = "\u{ab}redacted\u{bb}";

// ---------- validation ----------

/// PID 0 is the idle process and PID 4 is System; neither is ever a target the
/// operator meant to pick, and both are the classic "kill everything" typo.
pub fn validate_pid(pid: u32) -> Result<u32, String> {
    match pid {
        0 => Err("pid 0 is the idle process".into()),
        4 => Err("pid 4 is the System process".into()),
        _ => Ok(pid),
    }
}

pub fn validate_port(port: u32) -> Result<u16, String> {
    if port == 0 || port > 65535 {
        Err(format!("port {port} is outside 1..=65535"))
    } else {
        Ok(port as u16)
    }
}

/// Docker's own name/id grammar: `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`. Nothing
/// outside it can be a real container, so anything else is a typo or an attack.
pub fn validate_container_ref(s: &str) -> Result<String, String> {
    if s.len() > 128 {
        return Err("container name is longer than 128 characters".into());
    }
    let mut chars = s.chars();
    let Some(first) = chars.next() else {
        return Err("container name is empty".into());
    };
    if !first.is_ascii_alphanumeric() {
        return Err("container name must start with a letter or digit".into());
    }
    for c in chars {
        if !(c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')) {
            return Err(format!("illegal character {c:?} in container name"));
        }
    }
    Ok(s.to_string())
}

/// `[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}`. The leading-character rule is what stops
/// `-d`-style argument smuggling: a name beginning with `-` would be read by
/// wsl.exe as a flag rather than a distro. The charset itself excludes quotes,
/// `;|&$`, newlines and every control character.
pub fn validate_distro_name(s: &str) -> Result<String, String> {
    if s.len() > 64 {
        return Err("distro name is longer than 64 characters".into());
    }
    if s.contains("..") {
        return Err("distro name may not contain '..'".into());
    }
    let mut chars = s.chars();
    let Some(first) = chars.next() else {
        return Err("distro name is empty".into());
    };
    if !first.is_ascii_alphanumeric() {
        return Err("distro name must start with a letter or digit".into());
    }
    for c in chars {
        if !(c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-')) {
            return Err(format!("illegal character {c:?} in distro name"));
        }
    }
    Ok(s.to_string())
}

/// Must already exist, be a directory, be absolute, and contain no `..`
/// component — canonicalizing afterwards would hide a traversal that already
/// escaped, so the rejection happens on the text the caller supplied.
pub fn validate_existing_dir(s: &str) -> Result<PathBuf, String> {
    if s.trim().is_empty() {
        return Err("path is empty".into());
    }
    if s.contains('\0') {
        return Err("path contains a NUL byte".into());
    }
    let raw = Path::new(s);
    if !raw.is_absolute() {
        return Err("path must be absolute".into());
    }
    if raw.components().any(|c| c == Component::ParentDir) {
        return Err("path may not contain '..'".into());
    }
    let canonical = raw
        .canonicalize()
        .map_err(|e| format!("path is not reachable: {e}"))?;
    if !canonical.is_dir() {
        return Err("path is not a directory".into());
    }
    Ok(strip_verbatim(canonical))
}

/// Windows canonicalization yields `\\?\C:\…`; explorer, wt and git all choke
/// on the verbatim prefix, so drop it for plain drive paths (UNC keeps it).
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy().into_owned();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p,
    }
}

// ---------- secret masking ----------

const SECRET_FLAGS: &[&str] = &["--token", "--api-key", "--password", "--secret"];
const SENSITIVE_KEY_PARTS: &[&str] = &[
    "TOKEN",
    "SECRET",
    "KEY",
    "PASSWORD",
    "PASSWD",
    "CREDENTIAL",
    "AUTH",
];

/// Redact credentials out of anything on its way to the UI. Hand-written
/// rather than regex-driven: the crate isn't a dependency here, and a scanner
/// that walks whitespace-separated tokens matches how argv actually looks.
pub fn mask_secrets(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    // Set when the *previous* token announced that this one is the secret
    // (`--token abc`, `Bearer abc`).
    let mut value_is_secret = false;

    for piece in split_keep_whitespace(s) {
        if piece.starts_with(char::is_whitespace) {
            out.push_str(piece);
            continue;
        }
        if value_is_secret {
            value_is_secret = false;
            out.push_str(REDACTED);
            continue;
        }
        let lower = piece.to_ascii_lowercase();
        if SECRET_FLAGS.contains(&lower.as_str()) || lower == "bearer" {
            value_is_secret = true;
            out.push_str(piece);
            continue;
        }
        if let Some(flag) = SECRET_FLAGS
            .iter()
            .find(|f| lower.starts_with(&format!("{f}=")))
        {
            out.push_str(&piece[..flag.len() + 1]);
            out.push_str(REDACTED);
            continue;
        }
        if let Some((key, _)) = piece.split_once('=') {
            if is_sensitive_key(key) {
                out.push_str(key);
                out.push('=');
                out.push_str(REDACTED);
                continue;
            }
        }
        out.push_str(&mask_literals(piece));
    }
    out
}

/// Split into alternating whitespace / non-whitespace runs so masking can
/// rebuild the string byte-for-byte apart from the redactions.
fn split_keep_whitespace(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut current: Option<bool> = None;
    for (i, c) in s.char_indices() {
        let ws = c.is_whitespace();
        match current {
            None => {
                current = Some(ws);
                start = i;
            }
            Some(prev) if prev != ws => {
                out.push(&s[start..i]);
                start = i;
                current = Some(ws);
            }
            _ => {}
        }
    }
    if current.is_some() {
        out.push(&s[start..]);
    }
    out
}

fn is_sensitive_key(key: &str) -> bool {
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return false;
    }
    let upper = key.to_ascii_uppercase();
    SENSITIVE_KEY_PARTS.iter().any(|p| upper.contains(p))
}

/// Provider-shaped literals that are secrets wherever they appear, with no
/// surrounding flag to announce them.
fn mask_literals(token: &str) -> String {
    let bytes = token.as_bytes();
    let mut out = String::with_capacity(token.len());
    let mut i = 0usize;
    while i < bytes.len() {
        // Only match at a token-ish boundary, so `task-orientedlonger` isn't
        // mistaken for an `sk-` key.
        let boundary = i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_');
        if boundary {
            if let Some(len) = literal_len(&bytes[i..]) {
                out.push_str(REDACTED);
                i += len;
                continue;
            }
        }
        // Push whole chars so multi-byte input survives.
        let ch_len = token[i..].chars().next().map(char::len_utf8).unwrap_or(1);
        out.push_str(&token[i..i + ch_len]);
        i += ch_len;
    }
    out
}

/// Length of a known secret literal at the start of `b`, if any.
fn literal_len(b: &[u8]) -> Option<usize> {
    let run = |from: usize, allow_dash: bool| {
        b[from..]
            .iter()
            .take_while(|c| {
                c.is_ascii_alphanumeric() || **c == b'_' || (allow_dash && **c == b'-')
            })
            .count()
    };
    // sk-XXXXXXXXXXXX
    if b.starts_with(b"sk-") {
        let n = run(3, true);
        if n >= 12 {
            return Some(3 + n);
        }
    }
    // ghp_ / gho_ / ghu_ / ghs_ / ghr_
    if b.len() > 4 && b[0] == b'g' && b[1] == b'h' && b"pousr".contains(&b[2]) && b[3] == b'_' {
        let n = b[4..].iter().take_while(|c| c.is_ascii_alphanumeric()).count();
        if n >= 20 {
            return Some(4 + n);
        }
    }
    // xoxb- / xoxa- / xoxp- / xoxr- / xoxs-
    if b.len() > 5 && b.starts_with(b"xox") && b"baprs".contains(&b[3]) && b[4] == b'-' {
        let n = b[5..]
            .iter()
            .take_while(|c| c.is_ascii_alphanumeric() || **c == b'-')
            .count();
        if n >= 10 {
            return Some(5 + n);
        }
    }
    // JWT: eyJ<header>.<payload>.<signature>
    if b.starts_with(b"eyJ") {
        let head = run(3, true);
        if head >= 10 && b.get(3 + head) == Some(&b'.') {
            let mid = run(4 + head, true);
            if mid > 0 && b.get(4 + head + mid) == Some(&b'.') {
                let tail = run(5 + head + mid, true);
                if tail > 0 {
                    return Some(5 + head + mid + tail);
                }
            }
        }
    }
    None
}

// ---------- command plumbing ----------

/// wsl.exe writes UTF-16LE; everything else here writes UTF-8. Detect rather
/// than guess, so an error line stays readable in both cases.
fn decode(bytes: &[u8]) -> String {
    let utf16 = bytes.len() >= 2
        && (bytes.starts_with(&[0xFF, 0xFE])
            || bytes.iter().skip(1).step_by(2).take(16).filter(|b| **b == 0).count() > 4);
    if utf16 {
        let start = if bytes.starts_with(&[0xFF, 0xFE]) { 2 } else { 0 };
        let units: Vec<u16> = bytes[start..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

/// How much of a command's output belongs on the card.
#[derive(Clone, Copy)]
enum Detail {
    None,
    All,
    Head(usize),
    Tail(usize),
}

fn combined(out: &Output) -> String {
    let mut text = decode(&out.stdout);
    let err = decode(&out.stderr);
    if !err.trim().is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&err);
    }
    text
}

fn excerpt(text: &str, detail: Detail) -> Option<String> {
    let picked = match detail {
        Detail::None => return None,
        Detail::All => text.to_string(),
        Detail::Head(n) => text.lines().take(n).collect::<Vec<_>>().join("\n"),
        Detail::Tail(n) => {
            let lines: Vec<&str> = text.lines().collect();
            lines[lines.len().saturating_sub(n)..].join("\n")
        }
    };
    let masked = clip(&mask_secrets(&picked), DETAIL_MAX);
    if masked.trim().is_empty() {
        None
    } else {
        Some(masked)
    }
}

fn failure_message(program: &str, out: &Output) -> String {
    let stderr = decode(&out.stderr);
    let stdout = decode(&out.stdout);
    let first = stderr
        .lines()
        .chain(stdout.lines())
        .map(str::trim)
        .find(|l| !l.is_empty());
    match first {
        Some(line) => clip(&mask_secrets(line), 200),
        None => format!("{program} exited with {}", out.status),
    }
}

fn finish(program: &str, out: &Output, ok_msg: String, detail: Detail) -> ActionResult {
    let text = combined(out);
    let mut result = if out.status.success() {
        ActionResult::ok(ok_msg)
    } else {
        ActionResult::fail("failed", failure_message(program, out))
    };
    if let Some(d) = excerpt(&text, detail) {
        result = result.with_detail(d);
    }
    result
}

fn dispatch(
    program: &str,
    args: &[&str],
    timeout: Duration,
    ok_msg: String,
    detail: Detail,
) -> ActionResult {
    match run_silent_timeout(program, args, timeout) {
        Err(e) if is_not_found(&e) => ActionResult::fail(
            "not_installed",
            format!("{program} is not installed or not on PATH"),
        ),
        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => ActionResult::fail(
            "timeout",
            format!("{program} did not finish within {}s", timeout.as_secs()),
        ),
        Err(e) => ActionResult::fail("failed", format!("{program} could not be started: {e}")),
        Ok(out) => finish(program, &out, ok_msg, detail),
    }
}

// ---------- actions ----------

pub fn docker_container(verb: &str, name: &str) -> ActionResult {
    if !matches!(verb, "start" | "stop" | "restart") {
        return ActionResult::fail("invalid", format!("unsupported docker verb {verb:?}"));
    }
    let name = match validate_container_ref(name) {
        Ok(n) => n,
        Err(e) => return ActionResult::fail("invalid", e),
    };
    dispatch(
        "docker",
        &[verb, &name],
        Duration::from_secs(20),
        format!("{verb} {name}"),
        Detail::All,
    )
}

pub fn docker_logs(name: &str, lines: u32) -> ActionResult {
    let name = match validate_container_ref(name) {
        Ok(n) => n,
        Err(e) => return ActionResult::fail("invalid", e),
    };
    let tail = lines.clamp(1, 500).to_string();
    dispatch(
        "docker",
        &["logs", "--tail", &tail, &name],
        Duration::from_secs(15),
        format!("last {tail} log lines from {name}"),
        Detail::All,
    )
}

/// `wsl -d <name> -- true` is the cheapest way to boot a stopped distro: the
/// `--` guarantees the payload is read as a command, never as more flags.
pub fn wsl_start(name: &str) -> ActionResult {
    let name = match validate_distro_name(name) {
        Ok(n) => n,
        Err(e) => return ActionResult::fail("invalid", e),
    };
    dispatch(
        "wsl",
        &["-d", &name, "--", "true"],
        Duration::from_secs(20),
        format!("started {name}"),
        Detail::All,
    )
}

pub fn wsl_terminate(name: &str) -> ActionResult {
    let name = match validate_distro_name(name) {
        Ok(n) => n,
        Err(e) => return ActionResult::fail("invalid", e),
    };
    dispatch(
        "wsl",
        &["-t", &name],
        Duration::from_secs(15),
        format!("terminated {name}"),
        Detail::All,
    )
}

pub fn open_path(path: &str) -> ActionResult {
    let dir = match validate_existing_dir(path) {
        Ok(d) => d,
        Err(e) => return ActionResult::fail("invalid", e),
    };
    let dir = dir.to_string_lossy().into_owned();
    match run_silent_timeout("explorer.exe", &[&dir], Duration::from_secs(10)) {
        Err(e) if is_not_found(&e) => {
            ActionResult::fail("not_installed", "explorer.exe is not available")
        }
        Err(e) => ActionResult::fail("failed", format!("explorer.exe could not be started: {e}")),
        // explorer.exe returns 1 even when it opened the window, so its exit
        // code carries no information — spawning is the only signal there is.
        Ok(_) => ActionResult::ok(format!("opened {dir}")),
    }
}

pub fn open_terminal(dir: &str) -> ActionResult {
    let dir = match validate_existing_dir(dir) {
        Ok(d) => d,
        Err(e) => return ActionResult::fail("invalid", e),
    };
    let dir = dir.to_string_lossy().into_owned();
    if let Ok(out) = run_silent_timeout("wt.exe", &["-d", &dir], Duration::from_secs(10)) {
        if out.status.success() {
            return ActionResult::ok(format!("opened a terminal in {dir}"));
        }
    }
    // Fallback goes through cmd.exe, which re-parses its own command line. A
    // Windows directory name cannot contain `"`, so the quoting can't be
    // broken out of — but a name carrying another metacharacter is refused
    // rather than escaped, because escaping for cmd is not worth getting wrong.
    if dir.contains(['"', '%', '&', '^', '|', '<', '>', '!']) {
        return ActionResult::fail(
            "invalid",
            "directory name contains a character cmd.exe would reinterpret",
        );
    }
    dispatch(
        "cmd.exe",
        &["/c", "start", "", "/D", &dir, "cmd.exe"],
        Duration::from_secs(10),
        format!("opened a terminal in {dir}"),
        Detail::None,
    )
}

pub fn git_fetch(dir: &str) -> ActionResult {
    let dir = match validate_existing_dir(dir) {
        Ok(d) => d,
        Err(e) => return ActionResult::fail("invalid", e),
    };
    let dir = dir.to_string_lossy().into_owned();
    dispatch(
        "git",
        &["-C", &dir, "fetch", "--all", "--prune"],
        Duration::from_secs(20),
        "fetched".to_string(),
        Detail::All,
    )
}

pub fn git_status_detail(dir: &str) -> ActionResult {
    let dir = match validate_existing_dir(dir) {
        Ok(d) => d,
        Err(e) => return ActionResult::fail("invalid", e),
    };
    let dir = dir.to_string_lossy().into_owned();
    dispatch(
        "git",
        &["-C", &dir, "status", "--short"],
        Duration::from_secs(10),
        "read working tree".to_string(),
        Detail::Head(100),
    )
}

/// The literal argv forms this HUD is willing to execute. A project can
/// *declare* its test command; it cannot invent one.
const TEST_ALLOWLIST: &[&[&str]] = &[
    &["npm", "test"],
    &["npm", "run", "test"],
    &["pnpm", "test"],
    &["yarn", "test"],
    &["cargo", "test"],
    &["pytest"],
    &["go", "test", "./..."],
];

/// The only place a project-declared command runs — and it runs only if it is
/// character-for-character one of the allowlisted argv forms.
pub fn run_repo_tests(dir: &str, command: &str) -> ActionResult {
    let dir = match validate_existing_dir(dir) {
        Ok(d) => d,
        Err(e) => return ActionResult::fail("invalid", e),
    };
    let argv: Vec<&str> = command.split_whitespace().collect();
    let Some(allowed) = TEST_ALLOWLIST.iter().find(|a| ***a == argv[..]) else {
        return ActionResult::fail(
            "not_allowed",
            format!(
                "{:?} is not one of the test commands this HUD will run",
                clip(&mask_secrets(command), 120)
            ),
        );
    };
    let program = allowed[0];
    let rest: Vec<&str> = allowed[1..].to_vec();
    match run_in_dir(program, &rest, &dir, Duration::from_secs(180)) {
        Err(e) if is_not_found(&e) => ActionResult::fail(
            "not_installed",
            format!("{program} is not installed or not on PATH"),
        ),
        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
            ActionResult::fail("timeout", format!("{program} did not finish within 180s"))
        }
        Err(e) => ActionResult::fail("failed", format!("{program} could not be started: {e}")),
        Ok(out) => finish(
            program,
            &out,
            format!("{} passed", allowed.join(" ")),
            Detail::Tail(60),
        ),
    }
}

/// `cli::run_silent_timeout` has no working-directory hook and cli.rs is not
/// ours to change, so the test runner spawns its own child — same shape as
/// cli.rs: no console window, pipes drained on threads, hard deadline.
fn run_in_dir(
    program: &str,
    args: &[&str],
    dir: &Path,
    timeout: Duration,
) -> std::io::Result<Output> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn()?;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        format!("{program} timed out after {timeout:?}"),
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    };
    Ok(Output {
        status,
        stdout: out_handle.join().unwrap_or_default(),
        stderr: err_handle.join().unwrap_or_default(),
    })
}

// ---------- audit trail ----------

/// Ids must be stable and reproducible, so they come from a counter rather
/// than randomness. It lives outside the struct because the struct is a plain
/// newtype over the entry list (see types.rs's contract with the UI).
static AUDIT_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
pub struct AuditLog(pub Mutex<Vec<AuditEntry>>);

impl AuditLog {
    pub fn record(&self, action: &str, target: &str, result: &ActionResult) -> AuditEntry {
        let at_unix = chrono::Utc::now().timestamp();
        let seq = AUDIT_SEQ.fetch_add(1, Ordering::Relaxed);
        let entry = AuditEntry {
            id: format!("{at_unix}-{seq}"),
            at_unix,
            action: action.to_string(),
            target: target.to_string(),
            ok: result.ok,
            code: result.code.clone(),
            message: clip(&mask_secrets(&result.message), 400),
        };
        // A poisoned lock must not take the audit trail down with it.
        let mut log = self.0.lock().unwrap_or_else(|p| p.into_inner());
        log.push(entry.clone());
        if log.len() > AUDIT_MAX {
            let excess = log.len() - AUDIT_MAX;
            log.drain(..excess);
        }
        entry
    }

    /// Newest first — the UI reads this straight into a list.
    pub fn entries(&self) -> Vec<AuditEntry> {
        let log = self.0.lock().unwrap_or_else(|p| p.into_inner());
        log.iter().rev().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pid_and_port_bounds() {
        assert!(validate_pid(0).is_err());
        assert!(validate_pid(4).is_err());
        assert_eq!(validate_pid(1234).unwrap(), 1234);
        assert!(validate_port(0).is_err());
        assert!(validate_port(65536).is_err());
        assert_eq!(validate_port(65535).unwrap(), 65535);
        assert_eq!(validate_port(1).unwrap(), 1);
    }

    #[test]
    fn container_ref_rejects_injection_shapes() {
        assert_eq!(validate_container_ref("my_api-1.0").unwrap(), "my_api-1.0");
        for bad in [
            "; shutdown /s",
            "a && calc",
            "--exec=x",
            "../../../windows",
            "a\u{0}b",
            "",
            "$(whoami)",
            "-leading",
            "name with space",
            "back`tick",
            "pipe|it",
        ] {
            assert!(
                validate_container_ref(bad).is_err(),
                "accepted container ref {bad:?}"
            );
        }
        assert!(validate_container_ref(&"a".repeat(300)).is_err());
    }

    #[test]
    fn distro_name_rejects_injection_shapes() {
        assert_eq!(
            validate_distro_name("Ubuntu 22.04").unwrap(),
            "Ubuntu 22.04"
        );
        for bad in [
            "; shutdown /s",
            "a && calc",
            "--exec=x",
            "../../../windows",
            "a\u{0}b",
            "",
            "$(whoami)",
            "-d",
            "a..b",
            "quote\"name",
            "new\nline",
            "carriage\rreturn",
            "bell\u{7}",
        ] {
            assert!(
                validate_distro_name(bad).is_err(),
                "accepted distro name {bad:?}"
            );
        }
        assert!(validate_distro_name(&"a".repeat(300)).is_err());
    }

    #[test]
    fn existing_dir_rejects_relative_traversal_and_junk() {
        for bad in [
            "; shutdown /s",
            "a && calc",
            "--exec=x",
            "../../../windows",
            "a\u{0}b",
            "",
            "$(whoami)",
        ] {
            assert!(validate_existing_dir(bad).is_err(), "accepted dir {bad:?}");
        }
        assert!(validate_existing_dir(&"a".repeat(300)).is_err());

        let temp = std::env::temp_dir();
        let ok = validate_existing_dir(&temp.to_string_lossy()).unwrap();
        assert!(ok.is_dir());
        // Absolute but with a `..` component — rejected on the raw text.
        let sneaky = temp.join("..").join("Windows");
        assert!(validate_existing_dir(&sneaky.to_string_lossy()).is_err());
        // A file is not a directory.
        let file = temp.join("ai-hud-validate-dir-test.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(validate_existing_dir(&file.to_string_lossy()).is_err());
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn masks_flag_values_in_both_forms() {
        assert_eq!(
            mask_secrets("gh auth --token abc123 --verbose"),
            "gh auth --token \u{ab}redacted\u{bb} --verbose"
        );
        assert_eq!(
            mask_secrets("tool --api-key=SUPERSECRETVALUE run"),
            "tool --api-key=\u{ab}redacted\u{bb} run"
        );
        assert_eq!(
            mask_secrets("--password hunter2"),
            "--password \u{ab}redacted\u{bb}"
        );
        assert_eq!(
            mask_secrets("--secret=s3cr3t"),
            "--secret=\u{ab}redacted\u{bb}"
        );
    }

    #[test]
    fn masks_bearer_and_env_style_keys() {
        assert_eq!(
            mask_secrets("Authorization: Bearer abc.def"),
            "Authorization: Bearer \u{ab}redacted\u{bb}"
        );
        assert_eq!(
            mask_secrets("GITHUB_TOKEN=abcdef GOPATH=C:/go"),
            "GITHUB_TOKEN=\u{ab}redacted\u{bb} GOPATH=C:/go"
        );
        assert_eq!(
            mask_secrets("api_password=x AWS_SECRET_ACCESS_KEY=y"),
            "api_password=\u{ab}redacted\u{bb} AWS_SECRET_ACCESS_KEY=\u{ab}redacted\u{bb}"
        );
        // Not a credential-shaped key — left alone.
        assert_eq!(mask_secrets("PATH=C:/bin"), "PATH=C:/bin");
    }

    #[test]
    fn masks_provider_literals() {
        assert_eq!(
            mask_secrets("using sk-abcdefghijklmnop now"),
            "using \u{ab}redacted\u{bb} now"
        );
        assert_eq!(
            mask_secrets("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"),
            "\u{ab}redacted\u{bb}"
        );
        assert_eq!(
            mask_secrets("xoxb-1234567890-abcdef"),
            "\u{ab}redacted\u{bb}"
        );
        assert_eq!(
            mask_secrets("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSM"),
            "\u{ab}redacted\u{bb}"
        );
        // Punctuation around the literal survives.
        assert_eq!(
            mask_secrets("{\"key\":\"sk-abcdefghijklmnop\"}"),
            "{\"key\":\"\u{ab}redacted\u{bb}\"}"
        );
    }

    #[test]
    fn leaves_ordinary_text_untouched() {
        let plain = "fatal: not a git repository (or any of the parent directories): .git";
        assert_eq!(mask_secrets(plain), plain);
        // Too short to be a key, and not at a token boundary.
        assert_eq!(mask_secrets("sk-short"), "sk-short");
        assert_eq!(mask_secrets("task-orientedwork"), "task-orientedwork");
        assert_eq!(mask_secrets("  spaced\tout  "), "  spaced\tout  ");
    }

    #[test]
    fn repo_tests_reject_anything_off_the_allowlist() {
        let dir = std::env::temp_dir().to_string_lossy().into_owned();
        for bad in [
            "npm test && calc",
            "rm -rf /",
            "cargo run",
            "npm  test  --  --watch",
            "",
            "; shutdown /s",
        ] {
            let r = run_repo_tests(&dir, bad);
            assert!(!r.ok && r.code == "not_allowed", "allowed {bad:?}");
        }
    }

    #[test]
    fn audit_log_is_newest_first_capped_and_masked() {
        let log = AuditLog::default();
        let leaky = ActionResult::fail("failed", "auth failed for --token abc123");
        let entry = log.record("git_fetch", "C:/repo", &leaky);
        assert!(entry.message.contains(REDACTED));
        assert!(!entry.message.contains("abc123"));
        assert!(entry.id.starts_with(&entry.at_unix.to_string()));

        for i in 0..AUDIT_MAX + 10 {
            log.record("noop", &format!("t{i}"), &ActionResult::ok("done"));
        }
        let entries = log.entries();
        assert_eq!(entries.len(), AUDIT_MAX);
        assert_eq!(entries[0].target, format!("t{}", AUDIT_MAX + 9));
        // Ids are unique even inside the same second.
        assert_ne!(entries[0].id, entries[1].id);
    }
}
