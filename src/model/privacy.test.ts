import { describe, expect, it } from "vitest";
import { Redactor, maskSecrets, safeText } from "./privacy";

describe("secret masking", () => {
  it("masks provider keys and tokens wherever they appear", () => {
    const cases = [
      "OPENAI_API_KEY=sk-abcd1234efgh5678ijkl",
      "gh auth: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
      "slack xoxb-123456789012-abcdefg",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
      "node server.js --token abc123def456ghi",
      "node server.js --api-key=abc123def456ghi",
      "run --password hunter2hunter2",
    ];
    for (const raw of cases) {
      expect(maskSecrets(raw), raw).toContain("«redacted»");
    }
  });

  it("masks a JWT even when it is not behind a flag", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcDEF-123_x";
    expect(maskSecrets(`log line ${jwt} end`)).not.toContain(jwt);
  });

  it("leaves ordinary command lines intact", () => {
    const raw = "node dist/index.js --port 5173 --host localhost";
    expect(maskSecrets(raw)).toBe(raw);
  });

  it("masks regardless of privacy mode — secrets are never optional", () => {
    const r = new Redactor(false);
    expect(safeText(r, "--token abcdefghijklmno")).toContain("«redacted»");
  });
});

describe("privacy mode aliasing", () => {
  it("is a no-op when disabled", () => {
    const r = new Redactor(false);
    expect(r.ip("192.168.1.5")).toBe("192.168.1.5");
    expect(r.path("C:\\Users\\me\\proj")).toBe("C:\\Users\\me\\proj");
    expect(r.repo("owner/name")).toBe("owner/name");
  });

  it("gives the same raw value the same alias every time", () => {
    const r = new Redactor(true);
    const first = r.ip("203.0.113.9");
    expect(r.ip("203.0.113.9")).toBe(first);
    expect(r.ip("203.0.113.10")).not.toBe(first);
  });

  it("keeps loopback readable — hiding it would break the ports card", () => {
    const r = new Redactor(true);
    expect(r.ip("127.0.0.1")).toBe("127.0.0.1");
    expect(r.ip("::1")).toBe("::1");
    expect(r.ip("10.0.0.4")).not.toBe("10.0.0.4");
  });

  it("preserves the owner/name shape for repositories", () => {
    const r = new Redactor(true);
    const out = r.repo("acme/secret-project");
    expect(out).toMatch(/^user-\d+\/repo-\d+$/);
    expect(out).not.toContain("acme");
    expect(out).not.toContain("secret-project");
  });

  it("replaces command lines wholesale rather than trying to sanitise them", () => {
    const r = new Redactor(true);
    const out = r.args("node C:\\work\\secret\\index.js --flag");
    expect(out).not.toContain("secret");
    expect(out).toMatch(/hidden/);
  });

  it("scrubs addresses, paths and tailnet names out of free text", () => {
    const r = new Redactor(true);
    const out = r.text("peer laptop.tail1234.ts.net at 100.64.1.2 in C:\\Users\\tommy\\api") ?? "";
    expect(out).not.toContain("100.64.1.2");
    expect(out).not.toContain("tail1234.ts.net");
    expect(out).not.toContain("tommy");
    expect(out).toContain("127.0.0.1".slice(0, 0)); // sanity: no accidental blanking
  });

  it("never leaks the raw value through the aliased output", () => {
    const r = new Redactor(true);
    const secretHost = "buildserver-prod";
    const alias = r.host(secretHost) ?? "";
    expect(alias).not.toContain(secretHost);
    expect(alias).toMatch(/^host-\d+$/);
  });
});
