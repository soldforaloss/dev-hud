//! Available software updates via `winget upgrade`. Headers localize, so
//! columns are located by the header row's offsets; rows are sliced by those
//! offsets (winget pads columns with spaces).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::cli::{is_not_found, run_silent_timeout};
use crate::types::{WingetStatus, WingetUpdate};

/// Strip progress-bar control characters winget writes before the table.
fn clean(raw: &str) -> String {
    raw.chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .collect()
}

pub fn parse_upgrade_table(stdout: &str) -> Vec<WingetUpdate> {
    let text = clean(stdout);
    let lines: Vec<&str> = text.lines().collect();
    // Header is the line right above the dashed separator.
    let Some(sep_idx) = lines.iter().position(|l| {
        let t = l.trim();
        t.len() > 10 && t.chars().all(|c| c == '-')
    }) else {
        return vec![];
    };
    if sep_idx == 0 {
        return vec![];
    }
    let header = lines[sep_idx - 1];
    // Column starts: offsets of each header word run (2+ space separated).
    let mut offsets: Vec<usize> = Vec::new();
    let bytes: Vec<char> = header.chars().collect();
    let mut in_word = false;
    for (i, c) in bytes.iter().enumerate() {
        if !c.is_whitespace() && !in_word {
            let prev2 = i < 2 || (bytes[i - 1].is_whitespace() && bytes[i - 2].is_whitespace());
            if offsets.is_empty() || prev2 {
                offsets.push(i);
            }
            in_word = true;
        } else if c.is_whitespace() {
            in_word = false;
        }
    }
    if offsets.len() < 4 {
        return vec![];
    }
    let slice = |line: &str, i: usize| -> String {
        let chars: Vec<char> = line.chars().collect();
        let start = offsets[i].min(chars.len());
        let end = if i + 1 < offsets.len() {
            offsets[i + 1].min(chars.len())
        } else {
            chars.len()
        };
        chars[start..end].iter().collect::<String>().trim().to_string()
    };
    let mut out = Vec::new();
    for line in lines.iter().skip(sep_idx + 1) {
        if line.trim().is_empty() || line.contains("upgrades available") {
            continue;
        }
        // Footer notes ("The following packages…") have no version columns.
        let name = slice(line, 0);
        let id = slice(line, 1);
        let current = slice(line, 2);
        let available = slice(line, 3);
        if name.is_empty() || id.is_empty() || available.is_empty() {
            continue;
        }
        out.push(WingetUpdate {
            name,
            id,
            current,
            available,
        });
    }
    out
}

pub fn status() -> WingetStatus {
    let mut out = WingetStatus {
        checked_unix: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
        ..Default::default()
    };
    let result = run_silent_timeout(
        "winget",
        &[
            "upgrade",
            "--include-unknown",
            "--disable-interactivity",
            "--accept-source-agreements",
        ],
        Duration::from_secs(90),
    );
    let output = match result {
        Err(e) if is_not_found(&e) => return out,
        Err(e) => {
            out.installed = true;
            out.error = Some(e.to_string());
            return out;
        }
        Ok(o) => o,
    };
    out.installed = true;
    let stdout = String::from_utf8_lossy(&output.stdout);
    out.updates = parse_upgrade_table(&stdout);
    if !output.status.success() && out.updates.is_empty() {
        // Exit code is non-zero when zero upgrades too — only surface a real
        // failure when nothing parsed AND stderr says something.
        let stderr = String::from_utf8_lossy(&output.stderr);
        if let Some(first) = stderr.lines().find(|l| !l.trim().is_empty()) {
            out.error = Some(first.chars().take(100).collect());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_upgrade_table_by_header_offsets() {
        let sample = "\
Name                 Id                     Version      Available    Source
--------------------------------------------------------------------------------
Google Chrome        Google.Chrome          125.0.6422   126.0.6478   winget
Node.js              OpenJS.NodeJS          22.1.0       24.2.0       winget
2 upgrades available.
";
        let rows = parse_upgrade_table(sample);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "Google.Chrome");
        assert_eq!(rows[1].available, "24.2.0");
    }
}
