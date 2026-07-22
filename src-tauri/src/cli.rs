//! Silent CLI invocation shared by the tailscale/docker/github integrations.

use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn configure(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Run a command with no console window flash. `Err` with `NotFound` means
/// the binary isn't installed.
pub fn run_silent(program: &str, args: &[&str]) -> std::io::Result<Output> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    configure(&mut cmd);
    cmd.output()
}

/// Like `run_silent`, but kills the child if it exceeds `timeout` — some
/// tools (nvidia-smi on a broken driver, winget resolving sources) can hang.
pub fn run_silent_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> std::io::Result<Output> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure(&mut cmd);
    let mut child = cmd.spawn()?;

    // Drain pipes on threads so a chatty child can't deadlock on a full pipe.
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
                std::thread::sleep(Duration::from_millis(40));
            }
        }
    };
    Ok(Output {
        status,
        stdout: out_handle.join().unwrap_or_default(),
        stderr: err_handle.join().unwrap_or_default(),
    })
}

pub fn is_not_found(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::NotFound
}
