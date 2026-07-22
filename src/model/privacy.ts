// Privacy / screen-sharing mode.
//
// Blur is not redaction: if the raw value is still in the DOM, in a tooltip,
// in an accessibility label or in what the copy button puts on the clipboard,
// it has leaked. Everything user-facing therefore runs through these
// functions, which return *replacement text* — the original never reaches the
// rendered tree.
//
// Aliases are stable for the lifetime of the session so a redacted HUD stays
// readable: the same peer is always "device-3", not a different number each
// poll.

export type RedactKind =
  | "ip"
  | "host"
  | "repo"
  | "path"
  | "user"
  | "args"
  | "peer"
  | "session"
  | "token";

const ALIAS_PREFIX: Record<RedactKind, string> = {
  ip: "ip",
  host: "host",
  repo: "repo",
  path: "path",
  user: "user",
  args: "args",
  peer: "device",
  session: "session",
  token: "token",
};

export class Redactor {
  private aliases = new Map<string, string>();
  private counters = new Map<RedactKind, number>();

  constructor(public enabled: boolean) {}

  /** Stable pseudonym for one raw value. */
  alias(kind: RedactKind, raw: string): string {
    const key = `${kind}:${raw}`;
    const existing = this.aliases.get(key);
    if (existing) return existing;
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    const label = `${ALIAS_PREFIX[kind]}-${n}`;
    this.aliases.set(key, label);
    return label;
  }

  value(kind: RedactKind, raw: string | null | undefined): string | null {
    if (raw == null || raw === "") return raw ?? null;
    if (!this.enabled) return raw;
    return this.alias(kind, raw);
  }

  ip(raw: string | null | undefined): string | null {
    if (!this.enabled || raw == null) return raw ?? null;
    // Loopback is not identifying and hiding it makes ports unreadable.
    if (raw === "127.0.0.1" || raw === "::1" || raw === "localhost") return raw;
    return this.alias("ip", raw);
  }

  host(raw: string | null | undefined): string | null {
    return this.value("host", raw);
  }

  /** "owner/name" keeps its shape so the row still looks like a repository. */
  repo(raw: string | null | undefined): string | null {
    if (!this.enabled || raw == null) return raw ?? null;
    const parts = raw.split("/");
    return parts.length === 2
      ? `${this.alias("user", parts[0])}/${this.alias("repo", parts[1])}`
      : this.alias("repo", raw);
  }

  /** Keeps the basename shape ("…\\project-2") so paths stay navigable. */
  path(raw: string | null | undefined): string | null {
    if (!this.enabled || raw == null) return raw ?? null;
    return `…\\${this.alias("path", raw)}`;
  }

  /** Command lines can carry tokens and absolute paths — replace wholesale. */
  args(raw: string | null | undefined): string | null {
    if (!this.enabled || raw == null) return raw ?? null;
    return raw.trim() === "" ? raw : `«${this.alias("args", raw)} hidden»`;
  }

  peer(raw: string | null | undefined): string | null {
    return this.value("peer", raw);
  }

  session(raw: string | null | undefined): string | null {
    return this.value("session", raw);
  }

  /**
   * Free text (alert bodies, timeline details, exports) where the sensitive
   * values are embedded rather than in their own field.
   */
  text(raw: string | null | undefined): string | null {
    if (!this.enabled || raw == null) return raw ?? null;
    let out = raw;
    out = out.replace(IPV4, (m) => (isLoopbackV4(m) ? m : this.alias("ip", m)));
    out = out.replace(WIN_PATH, (m) => `…\\${this.alias("path", m)}`);
    out = out.replace(UNIX_PATH, (m) => `…/${this.alias("path", m)}`);
    out = out.replace(TAILNET_NAME, (m) => this.alias("peer", m));
    return out;
  }
}

const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const WIN_PATH = /\b[A-Za-z]:\\[^\s"'<>|]{1,200}/g;
const UNIX_PATH = /(?:^|\s)(\/(?:home|Users|root|mnt|var)\/[^\s"'<>|]{1,200})/g;
const TAILNET_NAME = /\b[a-z0-9-]{2,30}\.[a-z0-9-]{2,30}\.ts\.net\b/gi;

function isLoopbackV4(ip: string): boolean {
  return ip.startsWith("127.");
}

/**
 * Secret masking, applied even when privacy mode is OFF.
 *
 * Unlike the aliasing above this is not reversible and not optional: a token
 * must never reach the screen, the clipboard or an export, in any mode.
 */
export function maskSecrets(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "«redacted»");
  // `--token VALUE` / `--api-key=VALUE` style flags.
  out = out.replace(
    /(--?(?:token|api[-_]?key|password|passwd|secret|auth)(?:[=\s]+))(\S+)/gi,
    (_m, flag: string) => `${flag}«redacted»`,
  );
  // KEY=VALUE environment pairs with a sensitive-looking key.
  out = out.replace(
    /\b([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]*)=(\S+)/g,
    (_m, key: string) => `${key}=«redacted»`,
  );
  return out;
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

/** Convenience for the common "mask, then alias" pipeline. */
export function safeText(r: Redactor, raw: string | null | undefined): string | null {
  if (raw == null) return null;
  return r.text(maskSecrets(raw));
}
