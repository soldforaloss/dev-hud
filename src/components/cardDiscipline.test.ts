// The card rules, enforced against the source rather than against my memory.
//
// Every previous round of "make the cards less busy" was undone by the next
// feature adding one more chip or one more column. Those two mistakes are
// cheap to make and expensive to notice, so they are checked here.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname);

/** Card bodies only. Panels and overlays have their own space to spend. */
const NOT_CARDS = new Set([
  "AlertCenter.tsx",
  "CommandPalette.tsx",
  "Inspector.tsx",
  "SettingsPanel.tsx",
  "Timeline.tsx",
  "StatusBits.tsx",
  "DataRow.tsx",
  "Card.tsx",
]);

function cardSources(): [string, string][] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".tsx") && !f.includes(".test.") && !NOT_CARDS.has(f))
    .map((f) => [f, readFileSync(join(DIR, f), "utf8")]);
}

describe("card rows carry two columns", () => {
  it("has no row with a third thing competing for the width", () => {
    // .drow-metric and the .proc-* columns were the two ways a row could grow
    // a third child. Both are gone; keep them gone.
    const offenders = cardSources()
      .filter(([, src]) => /drow-metric|className="proc"|proc-name|proc-cpu|proc-mem/.test(src))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });
});

describe("cards do not decorate themselves with chips", () => {
  it("prints no chips or badges in a card body", () => {
    // One exception, deliberately spelled out rather than pattern-matched:
    // a disk that SMART says is dying earns a badge. Nothing else does.
    const offenders: string[] = [];
    for (const [file, src] of cardSources()) {
      for (const [i, line] of src.split("\n").entries()) {
        if (!/className="(chip|badge)[" ]/.test(line)) continue;
        if (line.includes("badge badge-warn")) continue; // SMART failing
        offenders.push(`${file}:${i + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the header is a name", () => {
  it("keeps status words out of every card header", () => {
    // Card.tsx renders the header for all of them, so the rule is enforced in
    // one place: it may show a glyph, never a word like "Healthy" or "Active".
    const shell = readFileSync(join(DIR, "Card.tsx"), "utf8");
    const header = shell.slice(shell.indexOf("card-head-row"), shell.indexOf("card-body"));
    expect(header).not.toMatch(/HealthBadge|AttentionBadge|FreshnessBadge/);
    expect(header).toContain("card-title");
  });
});
