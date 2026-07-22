//! MCP Inspector: servers configured for Claude Desktop, Claude Code, and
//! Codex, cross-referenced against the live process table so a configured-
//! but-dead server is visible.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::fsutil::path_basename;
use crate::scanner::Scanner;
use crate::types::{McpServer, McpStatus};

fn push_json_servers(
    path: Option<PathBuf>,
    source: &str,
    out: &mut Vec<(String, String, String)>,
) {
    let Some(path) = path else { return };
    let Ok(raw) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return;
    };
    let Some(servers) = v.get("mcpServers").and_then(|s| s.as_object()) else {
        return;
    };
    for (name, cfg) in servers {
        let command = cfg.get("command").and_then(|c| c.as_str()).unwrap_or("");
        let args: Vec<String> = cfg
            .get("args")
            .and_then(|a| a.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str())
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
        let display = if args.is_empty() {
            command.to_string()
        } else {
            format!("{} {}", path_basename(command), args.join(" "))
        };
        out.push((name.clone(), source.to_string(), display));
    }
}

fn push_codex_servers(out: &mut Vec<(String, String, String)>) {
    let Some(home) = dirs::home_dir() else { return };
    let path = home.join(".codex").join("config.toml");
    let Ok(raw) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(v) = raw.parse::<toml::Value>() else {
        return;
    };
    let Some(servers) = v.get("mcp_servers").and_then(|s| s.as_table()) else {
        return;
    };
    for (name, cfg) in servers {
        let command = cfg.get("command").and_then(|c| c.as_str()).unwrap_or("");
        let args: Vec<String> = cfg
            .get("args")
            .and_then(|a| a.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str())
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
        let display = if args.is_empty() {
            command.to_string()
        } else {
            format!("{} {}", path_basename(command), args.join(" "))
        };
        out.push((name.clone(), "codex".to_string(), display));
    }
}

/// The most distinctive token of the launch command — used to spot the
/// server in live command lines. Heuristic by nature.
fn match_token(display: &str) -> Option<String> {
    display
        .split_whitespace()
        .filter(|t| !t.starts_with('-'))
        .map(|t| path_basename(t).to_ascii_lowercase())
        .filter(|t| {
            t.len() >= 4
                && ![
                    "node", "node.exe", "npx", "npx.cmd", "npx-cli.js", "cmd", "cmd.exe",
                    "python", "python.exe", "uvx", "uv", "bunx", "-y",
                ]
                .contains(&t.as_str())
        })
        .last()
}

/// Raw launch command per server name, re-read from disk on demand.
///
/// The health-check command resolves the name through this rather than
/// accepting a command from the frontend: what gets spawned is always what is
/// on disk, so a compromised or buggy renderer cannot choose the binary.
pub fn configured_commands() -> std::collections::HashMap<String, (String, Vec<String>)> {
    let mut out = std::collections::HashMap::new();
    let mut take_json = |path: Option<PathBuf>| {
        let Some(path) = path else { return };
        let Ok(raw) = fs::read_to_string(&path) else { return };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { return };
        let Some(servers) = v.get("mcpServers").and_then(|s| s.as_object()) else { return };
        for (name, cfg) in servers {
            let Some(command) = cfg.get("command").and_then(|c| c.as_str()) else { continue };
            let args = cfg
                .get("args")
                .and_then(|a| a.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str()).map(String::from).collect())
                .unwrap_or_default();
            out.entry(name.clone())
                .or_insert_with(|| (command.to_string(), args));
        }
    };
    take_json(dirs::config_dir().map(|c| c.join("Claude").join("claude_desktop_config.json")));
    take_json(dirs::home_dir().map(|h| h.join(".claude.json")));

    if let Some(home) = dirs::home_dir() {
        if let Ok(raw) = fs::read_to_string(home.join(".codex").join("config.toml")) {
            if let Ok(v) = raw.parse::<toml::Value>() {
                if let Some(servers) = v.get("mcp_servers").and_then(|s| s.as_table()) {
                    for (name, cfg) in servers {
                        let Some(command) = cfg.get("command").and_then(|c| c.as_str()) else {
                            continue;
                        };
                        let args = cfg
                            .get("args")
                            .and_then(|a| a.as_array())
                            .map(|a| {
                                a.iter().filter_map(|x| x.as_str()).map(String::from).collect()
                            })
                            .unwrap_or_default();
                        out.entry(name.clone())
                            .or_insert_with(|| (command.to_string(), args));
                    }
                }
            }
        }
    }
    out
}

pub fn status(scanner: &Arc<Mutex<Scanner>>) -> McpStatus {
    let mut configured: Vec<(String, String, String)> = Vec::new();
    push_json_servers(
        dirs::config_dir().map(|c| c.join("Claude").join("claude_desktop_config.json")),
        "claude-desktop",
        &mut configured,
    );
    push_json_servers(
        dirs::home_dir().map(|h| h.join(".claude.json")),
        "claude-code",
        &mut configured,
    );
    push_codex_servers(&mut configured);

    // (pid, cwd, lowercased command line) — the cwd is what tells apart two
    // copies of the same server launched from different projects.
    let procs: Vec<(u32, Option<String>, String)> = scanner
        .lock()
        .map(|sc| {
            sc.system()
                .processes()
                .iter()
                .map(|(pid, p)| {
                    (
                        pid.as_u32(),
                        p.cwd().map(|c| c.to_string_lossy().into_owned()),
                        p.cmd()
                            .iter()
                            .map(|c| c.to_string_lossy().to_ascii_lowercase())
                            .collect::<Vec<_>>()
                            .join(" "),
                    )
                })
                .collect()
        })
        .unwrap_or_default();

    let mut servers: Vec<McpServer> = configured
        .into_iter()
        .map(|(name, source, command)| {
            let matched = match_token(&command)
                .and_then(|token| procs.iter().find(|(_, _, cmd)| cmd.contains(&token)));
            McpServer {
                name,
                source,
                command,
                running: matched.is_some(),
                pid: matched.map(|(pid, _, _)| *pid),
                cwd: matched.and_then(|(_, cwd, _)| cwd.clone()),
            }
        })
        .collect();
    servers.sort_by(|a, b| (!a.running, a.name.clone()).cmp(&(!b.running, b.name.clone())));
    McpStatus { servers }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn match_token_skips_runtimes() {
        // path_basename strips the scope prefix — the package basename is
        // still a distinctive needle for command-line matching.
        assert_eq!(
            match_token("npx.cmd -y @modelcontextprotocol/server-filesystem"),
            Some("server-filesystem".into())
        );
        assert_eq!(match_token("node"), None);
    }
}
