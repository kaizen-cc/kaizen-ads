import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { itemSheetHref, pointsAtOverview, primaryHref, rowOpens } from "@/lib/exec-overview-core";

// Owner, Nov 24 2026: an ask's "Open it" showed "Opening..." and landed back on the Overview. No item's main action may
// point back at the Overview it's on: it goes to its real destination, else opens the item's own sheet (?item=).

describe("an item's main action never lands back on the Overview", () => {
  it("knows what only points at the Overview", () => {
    for (const h of [null, undefined, "", "#", "#next", "/pipeline", "/pipeline#next", "/pipeline?block=needs", "/pipeline?tab=work", "/today", "/today?topic=needs"]) expect(pointsAtOverview(h), String(h)).toBe(true);
    for (const h of ["/clients/acme", "https://app.asana.com/0/1/2", "/safety/abc", "/pipeline?block=needs&item=ask%3A1", "/pipeline?block=team&nudge=9", "/pipeline?block=asana&task=5", "/pipeline?tab=tracking&client=acme", "/kpis?p=review"]) expect(pointsAtOverview(h), h).toBe(false);
  });

  it("an item with nowhere to go opens its own sheet", () => {
    const c = { key: "ask:42", tab: "needs", action: { href: "/pipeline?block=needs" } };
    expect(primaryHref(c)).toBe("/pipeline?block=needs&item=ask%3A42");
    expect(primaryHref({ ...c, action: { href: null } })).toBe(itemSheetHref(c));
    expect(primaryHref({ ...c, action: { href: "/clients/acme" } })).toBe("/clients/acme");
    expect(pointsAtOverview(primaryHref({ ...c, action: { href: "#" } }))).toBe(false);
  });

  it("no item builder sets a main action back at the Overview", () => {
    // What builds the items on everyone's day: an action's href may not be the bare Overview, an anchor in it or a block
    const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : /\.ts$/.test(f) ? [join(d, f)] : []));
    const builders = files("src/lib").filter((f) => /[\\/](today|exec-overview|support-day|maker-day|item-owners|agent-asks)[\w-]*\.ts$/.test(f));
    const offenders: string[] = [];
    for (const f of builders)
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((l, i) => {
          for (const m of l.matchAll(/action: \{ label: [^}]*?href: ([`"])([^`"]*)\1/g)) {
            const href = m[2].replace(/\$\{[^}]*\}/g, "x");
            if (pointsAtOverview(href)) offenders.push(`${f}:${i + 1}: ${m[2]}`);
          }
        });
    expect(offenders).toEqual([]);
  });

  // Issue #153: on the Overview's list view (?open=mine), a row pointing at /pipeline reloaded the Overview without
  // ?open=, folding the list back up instead of opening the task
  it("a list row opens its item instead of folding the list", () => {
    for (const h of ["/pipeline", "/today?topic=mine", "#", null]) expect(rowOpens(h), String(h)).toBe("sheet");
    expect(rowOpens("https://app.asana.com/0/1/2")).toBe("external");
    for (const h of ["/board?t=12", "/clients/acme?tab=plan", "/pipeline?block=needs&item=ask%3A1"]) expect(rowOpens(h), h).toBe("page");
  });
});
