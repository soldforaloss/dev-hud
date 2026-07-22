//! GitHub repo status for the authenticated user's OWN repositories.
//!
//! Auth comes from the gh CLI (`gh auth token`), with `GITHUB_TOKEN`/`GH_TOKEN`
//! env vars as fallback. The repo list is discovered from the account
//! (`/user/repos?affiliation=owner`, most recently pushed first) — there is no
//! manual watch-list.
//!
//! Note GitHub's `open_issues_count` includes PRs; real issue count is
//! `open_issues_count - open PR count` (RepoBar makes the same correction).

use std::sync::OnceLock;

use futures::future::join_all;

use crate::types::{GithubPayload, RepoRelease, RepoStatus};

static TOKEN: OnceLock<Option<String>> = OnceLock::new();

fn gh_cli_token() -> Option<String> {
    use std::process::Command;
    let mut cmd = Command::new("gh");
    cmd.args(["auth", "token"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

/// Resolve once per app run; `gh` is a subprocess, so do it off the async
/// pool. gh CLI is the primary credential source, env vars are fallback.
pub async fn token() -> Option<String> {
    if let Some(t) = TOKEN.get() {
        return t.clone();
    }
    let resolved = tauri::async_runtime::spawn_blocking(|| {
        gh_cli_token().or_else(|| {
            std::env::var("GH_TOKEN")
                .or_else(|_| std::env::var("GITHUB_TOKEN"))
                .ok()
                .filter(|t| !t.trim().is_empty())
        })
    })
    .await
    .ok()
    .flatten();
    TOKEN.get_or_init(|| resolved).clone()
}

const MAX_REPOS: usize = 8;

/// The authenticated user's login plus their own most recently pushed repos.
async fn discover_own_repos(
    http: &reqwest::Client,
    token: &Option<String>,
) -> (Option<String>, Vec<String>) {
    if token.is_none() {
        return (None, vec![]);
    }
    let login = get_json(http, "https://api.github.com/user", token)
        .await
        .ok()
        .and_then(|v| v.get("login").and_then(|l| l.as_str()).map(String::from));
    let url = format!(
        "https://api.github.com/user/repos?affiliation=owner&sort=pushed&direction=desc&per_page={MAX_REPOS}"
    );
    let repos = match get_json(http, &url, token).await {
        Ok(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|r| {
                r.get("full_name")
                    .and_then(|n| n.as_str())
                    .map(String::from)
            })
            .collect(),
        _ => vec![],
    };
    (login, repos)
}

fn req(
    http: &reqwest::Client,
    url: &str,
    token: &Option<String>,
) -> reqwest::RequestBuilder {
    let mut r = http
        .get(url)
        .header("User-Agent", "ai-hud")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .timeout(std::time::Duration::from_secs(12));
    if let Some(t) = token {
        r = r.bearer_auth(t);
    }
    r
}

async fn get_json(
    http: &reqwest::Client,
    url: &str,
    token: &Option<String>,
) -> Result<serde_json::Value, String> {
    let resp = req(http, url, token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if status.as_u16() == 404 {
        return Err("404".into());
    }
    if status.as_u16() == 403 || status.as_u16() == 429 {
        return Err("rate limited".into());
    }
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

async fn repo_status(http: &reqwest::Client, token: &Option<String>, repo: String) -> RepoStatus {
    let mut out = RepoStatus {
        repo: repo.clone(),
        ..Default::default()
    };
    let base = format!("https://api.github.com/repos/{repo}");

    let meta_url = base.clone();
    let prs_url = format!(
        "https://api.github.com/search/issues?q=repo:{repo}+is:pr+is:open&per_page=1"
    );
    let release_url = format!("{base}/releases/latest");
    let runs_url = format!("{base}/actions/runs?per_page=1");

    let (meta, prs, release, runs) = tokio_join(
        get_json(http, &meta_url, token),
        get_json(http, &prs_url, token),
        get_json(http, &release_url, token),
        get_json(http, &runs_url, token),
    )
    .await;

    match meta {
        Ok(v) => {
            out.ok = true;
            out.stars = v.get("stargazers_count").and_then(|s| s.as_u64());
            out.open_issues = v.get("open_issues_count").and_then(|s| s.as_u64());
            out.default_branch = v
                .get("default_branch")
                .and_then(|b| b.as_str())
                .map(String::from);
            out.pushed_at = v
                .get("pushed_at")
                .and_then(|p| p.as_str())
                .map(String::from);
        }
        Err(e) => {
            out.ok = false;
            out.error = Some(if e == "404" { "not found".into() } else { e });
            return out;
        }
    }

    if let Ok(v) = prs {
        out.open_prs = v.get("total_count").and_then(|t| t.as_u64());
        // open_issues_count includes PRs — correct it.
        if let (Some(all), Some(prs)) = (out.open_issues, out.open_prs) {
            out.open_issues = Some(all.saturating_sub(prs));
        }
    }

    if let Ok(v) = release {
        let tag = v.get("tag_name").and_then(|t| t.as_str());
        let url = v.get("html_url").and_then(|u| u.as_str());
        if let (Some(tag), Some(url)) = (tag, url) {
            out.release = Some(RepoRelease {
                tag: tag.to_string(),
                published_at: v
                    .get("published_at")
                    .and_then(|p| p.as_str())
                    .map(String::from),
                url: url.to_string(),
            });
        }
    }

    out.ci_status = Some(match runs {
        Ok(v) => {
            let run = v.get("workflow_runs").and_then(|r| r.get(0));
            match run {
                None => "none".to_string(),
                Some(run) => {
                    let status = run.get("status").and_then(|s| s.as_str()).unwrap_or("");
                    if status != "completed" {
                        "pending".to_string()
                    } else {
                        run.get("conclusion")
                            .and_then(|c| c.as_str())
                            .unwrap_or("none")
                            .to_string()
                    }
                }
            }
        }
        Err(_) => "none".to_string(),
    });

    out
}

// Small alias so repo_status reads cleanly without importing tokio directly.
async fn tokio_join<A, B, C, D>(
    a: impl std::future::Future<Output = A>,
    b: impl std::future::Future<Output = B>,
    c: impl std::future::Future<Output = C>,
    d: impl std::future::Future<Output = D>,
) -> (A, B, C, D) {
    futures::join!(a, b, c, d)
}

pub async fn fetch(http: &reqwest::Client) -> GithubPayload {
    let token = token().await;
    let (login, discovered) = discover_own_repos(http, &token).await;
    let futures: Vec<_> = discovered
        .into_iter()
        .filter(|r| r.contains('/'))
        .map(|r| repo_status(http, &token, r))
        .collect();
    let repos = join_all(futures).await;
    // "No token" and "the API refused us" look identical from an empty repo
    // list, so name the reason rather than showing a blank card.
    let error = if token.is_none() {
        Some("not signed in — run `gh auth login`".to_string())
    } else if login.is_none() {
        Some("GitHub did not identify the token holder (expired or rate limited)".to_string())
    } else {
        None
    };
    GithubPayload {
        authenticated: token.is_some(),
        login,
        repos,
        error,
    }
}
