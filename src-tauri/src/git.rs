//! Local git working copies: what is checked out, what is dirty, and how far
//! it has drifted from its upstream. Read-only — nothing here writes to a
//! repository, and the declared test command is reported but never executed
//! (that is `actions::run_repo_tests`, behind an allowlist).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use walkdir::{DirEntry, WalkDir};

use crate::actions::validate_existing_dir;
use crate::cli::{is_not_found, run_silent_timeout};
use crate::fsutil::path_basename;
use crate::types::{LocalRepo, LocalReposStatus};

/// Deep enough to find `dev/projects/thing`, shallow enough to stay off the
/// disk for a second.
const MAX_DEPTH: usize = 3;
const MAX_REPOS: usize = 40;
const GIT_TIMEOUT: Duration = Duration::from_secs(5);

/// Directories that are always noise and are often enormous.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    ".git",
    "dist",
    "build",
    "vendor",
    ".venv",
];

pub fn scan(roots: &[String], extra_paths: &[String]) -> LocalReposStatus {
    let mut out = LocalReposStatus::default();

    let mut walked: Vec<PathBuf> = Vec::new();
    for root in roots {
        if let Ok(dir) = validate_existing_dir(root) {
            out.roots.push(dir.to_string_lossy().into_owned());
            walked.push(dir);
        }
    }

    out.git_available = run_silent_timeout("git", &["--version"], GIT_TIMEOUT)
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !out.git_available {
        // Every per-repo number would have to be reported as a zero, which
        // reads as "clean" rather than "unknown". Say nothing instead.
        return out;
    }

    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut found: Vec<PathBuf> = Vec::new();
    for root in &walked {
        for repo in discover(root) {
            push_unique(&mut found, &mut seen, repo);
        }
    }
    // Working directories the UI already knows about (a running dev server,
    // an agent session) — the repo is somewhere at or above them.
    for extra in extra_paths {
        let Ok(dir) = validate_existing_dir(extra) else {
            continue;
        };
        if let Some(repo) = enclosing_repo(&dir) {
            push_unique(&mut found, &mut seen, repo);
        }
    }
    found.truncate(MAX_REPOS);

    out.repos = found.iter().map(|p| inspect(p)).collect();
    out.repos.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn push_unique(found: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, repo: PathBuf) {
    if found.len() >= MAX_REPOS {
        return;
    }
    let key = repo.canonicalize().unwrap_or_else(|_| repo.clone());
    if seen.insert(key) {
        found.push(repo);
    }
}

fn is_skipped(entry: &DirEntry) -> bool {
    entry.depth() > 0
        && entry.file_type().is_dir()
        && entry
            .file_name()
            .to_str()
            .map(|n| SKIP_DIRS.contains(&n))
            .unwrap_or(false)
}

fn discover(root: &Path) -> Vec<PathBuf> {
    WalkDir::new(root)
        .max_depth(MAX_DEPTH)
        .into_iter()
        .filter_entry(|e| !is_skipped(e))
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_dir())
        // `.git` is a directory in a normal clone and a file in a worktree or
        // submodule, so test for presence, not for kind.
        .filter(|e| e.path().join(".git").exists())
        .map(|e| e.path().to_path_buf())
        .collect()
}

fn enclosing_repo(start: &Path) -> Option<PathBuf> {
    let mut cursor = Some(start);
    while let Some(dir) = cursor {
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        cursor = dir.parent();
    }
    None
}

// ---------- per-repo ----------

fn git_out(dir: &Path, args: &[&str]) -> Result<String, String> {
    let dir = dir.to_string_lossy().into_owned();
    let mut argv: Vec<&str> = vec!["-C", dir.as_str()];
    argv.extend_from_slice(args);
    match run_silent_timeout("git", &argv, GIT_TIMEOUT) {
        Err(e) if is_not_found(&e) => Err("git is not installed".into()),
        Err(e) => Err(e.to_string()),
        Ok(out) if out.status.success() => {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let first = stderr.lines().map(str::trim).find(|l| !l.is_empty());
            Err(first
                .map(|l| l.chars().take(160).collect())
                .unwrap_or_else(|| format!("git exited with {}", out.status)))
        }
    }
}

fn inspect(path: &Path) -> LocalRepo {
    let mut repo = LocalRepo {
        path: path.to_string_lossy().into_owned(),
        name: path_basename(&path.to_string_lossy()),
        ..Default::default()
    };

    match git_out(path, &["status", "--porcelain=v2", "--branch"]) {
        Ok(text) => {
            let (branch, upstream, ahead, behind, dirty) = parse_status_v2(&text);
            repo.branch = branch;
            repo.upstream = upstream;
            repo.ahead = ahead;
            repo.behind = behind;
            repo.dirty_count = dirty;
        }
        Err(e) => {
            // One unreadable repo (permissions, a half-written index) must not
            // take the scan down — record it and move on.
            repo.error = Some(e);
            return repo;
        }
    }

    // A repo with no commits yet fails this; that is a missing value, not an
    // error worth surfacing.
    if let Ok(text) = git_out(path, &["log", "-1", "--format=%s%x1f%ct"]) {
        if let Some((subject, unix)) = text.trim_end().split_once('\u{1f}') {
            let subject = subject.trim();
            if !subject.is_empty() {
                repo.last_commit_subject = Some(subject.chars().take(100).collect());
            }
            repo.last_commit_unix = unix.trim().parse::<i64>().ok();
        }
    }

    if let Ok(url) = git_out(path, &["config", "--get", "remote.origin.url"]) {
        repo.remote_slug = parse_remote_slug(&url);
    }

    repo.test_command = detect_test_command(path);
    repo
}

/// Parse `git status --porcelain=v2 --branch` into
/// (branch, upstream, ahead, behind, dirty). A detached HEAD reports
/// `# branch.head (detached)`, which is an absent branch, not a branch named
/// "(detached)".
pub fn parse_status_v2(out: &str) -> (Option<String>, Option<String>, u32, u32, u32) {
    let mut branch = None;
    let mut upstream = None;
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut dirty = 0u32;

    for line in out.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let Some(header) = line.strip_prefix("# ") else {
            dirty += 1;
            continue;
        };
        if let Some(head) = header.strip_prefix("branch.head ") {
            let head = head.trim();
            if head != "(detached)" && !head.is_empty() {
                branch = Some(head.to_string());
            }
        } else if let Some(up) = header.strip_prefix("branch.upstream ") {
            let up = up.trim();
            if !up.is_empty() {
                upstream = Some(up.to_string());
            }
        } else if let Some(ab) = header.strip_prefix("branch.ab ") {
            for field in ab.split_whitespace() {
                match field.split_at(1) {
                    ("+", n) => ahead = n.parse().unwrap_or(0),
                    ("-", n) => behind = n.parse().unwrap_or(0),
                    _ => {}
                }
            }
        }
    }
    (branch, upstream, ahead, behind, dirty)
}

/// "owner/name" out of either remote form, so the card can be joined with the
/// GitHub card by slug.
pub fn parse_remote_slug(url: &str) -> Option<String> {
    let url = url.trim().trim_end_matches('/');
    if url.is_empty() {
        return None;
    }
    let path = if let Some((_, after)) = url.split_once("://") {
        // Drop the authority (userinfo@host:port).
        after.split_once('/')?.1
    } else if let Some((_, after)) = url.split_once(':') {
        // scp-like `git@host:owner/name`. A local path like `C:\repos\x`
        // also lands here and falls out below for want of a second component.
        after
    } else {
        return None;
    };
    let path = path.trim_start_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.split('/').filter(|p| !p.is_empty());
    let owner = parts.next()?;
    let name = parts.next()?;
    if owner.contains('\\') || name.contains('\\') {
        return None;
    }
    Some(format!("{owner}/{name}"))
}

/// What the project says its tests are. Reported only — running it goes
/// through the allowlist in actions.rs.
fn detect_test_command(dir: &Path) -> Option<String> {
    let package = dir.join("package.json");
    if package.is_file() {
        if let Some(text) = read_small(&package) {
            if npm_has_test_script(&text) {
                return Some("npm test".into());
            }
        }
    }
    if dir.join("Cargo.toml").is_file() {
        return Some("cargo test".into());
    }
    if dir.join("pytest.ini").is_file() {
        return Some("pytest".into());
    }
    let pyproject = dir.join("pyproject.toml");
    if pyproject.is_file() {
        if let Some(text) = read_small(&pyproject) {
            if text.contains("[tool.pytest") {
                return Some("pytest".into());
            }
        }
    }
    None
}

/// Manifests are small; anything larger is not one we want to parse.
fn read_small(path: &Path) -> Option<String> {
    let len = std::fs::metadata(path).ok()?.len();
    if len > 512 * 1024 {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

pub fn npm_has_test_script(package_json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(package_json)
        .ok()
        .and_then(|v| v.get("scripts")?.get("test").cloned())
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
# branch.oid 8f2c1d0e5b6a7c8d9e0f1a2b3c4d5e6f70819293
# branch.head feature/local-repos
# branch.upstream origin/feature/local-repos
# branch.ab +2 -3
1 .M N... 100644 100644 100644 8f2c1d0 8f2c1d0 src/lib.rs
1 A. N... 000000 100644 100644 0000000 1a2b3c4 src/git.rs
? notes.md
";

    #[test]
    fn parses_branch_tracking_and_dirty_count() {
        let (branch, upstream, ahead, behind, dirty) = parse_status_v2(SAMPLE);
        assert_eq!(branch.as_deref(), Some("feature/local-repos"));
        assert_eq!(upstream.as_deref(), Some("origin/feature/local-repos"));
        assert_eq!((ahead, behind, dirty), (2, 3, 3));
    }

    #[test]
    fn detached_head_has_no_branch() {
        let out = "# branch.oid 8f2c1d0e5b6a7c8d9e0f1a2b3c4d5e6f70819293\n# branch.head (detached)\n";
        let (branch, upstream, ahead, behind, dirty) = parse_status_v2(out);
        assert_eq!(branch, None);
        assert_eq!(upstream, None);
        assert_eq!((ahead, behind, dirty), (0, 0, 0));
    }

    #[test]
    fn clean_repo_with_no_upstream() {
        let out = "# branch.oid 8f2c1d0\n# branch.head main\n";
        let (branch, upstream, _, _, dirty) = parse_status_v2(out);
        assert_eq!(branch.as_deref(), Some("main"));
        assert_eq!(upstream, None);
        assert_eq!(dirty, 0);
    }

    #[test]
    fn parses_slug_from_both_remote_forms() {
        for url in [
            "git@github.com:owner/name.git",
            "https://github.com/owner/name.git",
            "https://github.com/owner/name",
            "https://github.com/owner/name/",
            "ssh://git@github.com/owner/name.git",
            "https://user@github.com/owner/name.git\n",
        ] {
            assert_eq!(
                parse_remote_slug(url).as_deref(),
                Some("owner/name"),
                "failed on {url}"
            );
        }
    }

    #[test]
    fn rejects_non_slug_remotes() {
        for url in ["", "   ", "C:\\repos\\thing", "/srv/git/thing", "github.com"] {
            assert_eq!(parse_remote_slug(url), None, "accepted {url}");
        }
    }

    #[test]
    fn npm_test_script_detection() {
        assert!(npm_has_test_script(r#"{"scripts":{"test":"vitest run"}}"#));
        assert!(!npm_has_test_script(r#"{"scripts":{"build":"tsc"}}"#));
        assert!(!npm_has_test_script(r#"{"name":"x"}"#));
        assert!(!npm_has_test_script("not json"));
    }
}
