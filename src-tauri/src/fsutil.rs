//! Small file/JSON helpers shared by the usage scanners.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Read up to `bytes` from the end of the file (lossy UTF-8, safe on
/// mid-sequence seeks).
pub fn read_tail(path: &Path, bytes: u64) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(bytes);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Read up to `bytes` from the start of the file.
pub fn read_head(path: &Path, bytes: usize) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut buf = vec![0u8; bytes];
    let n = file.read(&mut buf).ok()?;
    buf.truncate(n);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Extract the string value of the LAST occurrence of `"key":"…"` in `hay`,
/// unescaping the common JSON escapes. Enough for pulling a `cwd` out of a
/// JSONL chunk without parsing every line.
pub fn extract_last_json_str(hay: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":\"");
    let at = hay.rfind(&needle)?;
    let rest = &hay[at + needle.len()..];
    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => match chars.next() {
                Some('\\') => out.push('\\'),
                Some('"') => out.push('"'),
                Some('/') => out.push('/'),
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => return Some(out),
            },
            _ => out.push(c),
        }
        if out.len() > 1024 {
            return None; // not a path — bail on runaway values
        }
    }
    None
}

/// Last path component of a windows/unix path, for display.
pub fn path_basename(p: &str) -> String {
    p.trim_end_matches(['\\', '/'])
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(p)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_last_escaped_windows_path() {
        let hay = r#"{"cwd":"C:\\old"}{"x":1,"cwd":"C:\\Users\\OSRS1\\Desktop\\Proj"}"#;
        assert_eq!(
            extract_last_json_str(hay, "cwd").as_deref(),
            Some("C:\\Users\\OSRS1\\Desktop\\Proj")
        );
    }

    #[test]
    fn basename_handles_both_separators() {
        assert_eq!(path_basename("C:\\a\\b\\AI Tools"), "AI Tools");
        assert_eq!(path_basename("/home/x/proj/"), "proj");
    }
}
