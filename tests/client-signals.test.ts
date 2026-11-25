import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { automatedTemplates, isTeamAuthor, onHold, recurringDue, refsToIds, templateOf } from "@/lib/client-signals-core";
import { originIds } from "@/lib/done-check-core";

// Nov 25 2026 safety check of the OS against an exec's Claude runs: what clients said that changes the work, items
// read from their source, and schemas the model accepts.

describe("client signals", () => {
  it("knows the team's messages from the client's", () => {
    expect(isTeamAuthor("Kyle Barry <kyle@kaizenmarketing.agency>", [])).toBe(true);
    expect(isTeamAuthor("Mark Adriel Ampeloquio", ["Mark Adriel Ampeloquio"])).toBe(true);
    expect(isTeamAuthor("Chris Marino <chris@limelightentertainmentnj.com>", ["Kyle Barry"])).toBe(false);
  });
  it("spots automated emails: the same subject sent to three or more clients", () => {
    expect(templateOf("Re: Limelight Entertainment - Monthly Review", "Limelight Entertainment")).toBe("monthly review");
    const t = automatedTemplates([
      { client: "Limelight Entertainment", title: "Limelight Entertainment - Monthly Review" },
      { client: "OceanBox", title: "OceanBox - Monthly Review" },
      { client: "Shupe Legal", title: "Shupe Legal - Monthly Review" },
      { client: "OceanBox", title: "Quick question about the BFCM offer" },
    ]);
    expect([...t]).toEqual(["monthly review"]);
  });
  it("a hold lasts until it's lifted", () => {
    const now = Date.parse("2026-11-25T12:00:00Z");
    expect(onHold([{ kind: "hold", said_at: "2026-11-24T10:00:00Z" }], now)).toEqual({ since: "2026-11-24T10:00:00Z" });
    expect(onHold([{ kind: "hold", said_at: "2026-11-24T10:00:00Z" }, { kind: "resume", said_at: "2026-11-25T09:00:00Z" }], now)).toBeNull();
    expect(onHold([{ kind: "hold", said_at: "2026-09-01T10:00:00Z" }], now)).toBeNull();
  });
  it("a recurring commitment is due each day of its cadence until its end", () => {
    const r = { cadence: "daily" as const, weekday: null, until: "2026-12-05", from: "2026-11-24T15:00:00Z" };
    expect(recurringDue(r, "2026-11-25", 3)).toBe(true);
    expect(recurringDue(r, "2026-12-06", 0)).toBe(false);
    expect(recurringDue(r, "2026-11-23", 1)).toBe(false);
    expect(recurringDue({ ...r, cadence: "weekdays" }, "2026-11-29", 0)).toBe(false);
    expect(recurringDue({ ...r, cadence: "weekly", weekday: 1 }, "2026-11-30", 1)).toBe(true);
  });
  it("maps the reader's refs back to items and promises", () => {
    expect(refsToIds(["A2", "p1", "X9", "A7"], [{ id: "a1" }, { id: "a2" }], [{ id: "p1" }])).toEqual({ asks: ["a2"], promises: ["p1"] });
  });
});

describe("items read from their source", () => {
  it("finds the message or call an item came from", () => {
    const id = "0f130332-51fc-4bbf-b966-5dcc745f41a9";
    const call = "299271da-c9d0-4660-bf35-9e2296b9114a";
    expect(originIds([`deleg:${id}:x`, `routine:call:${call}:0`, "nightly:abc"])).toEqual({ ctx: [id], calls: [call] });
  });
});

describe("AI schemas the model accepts", () => {
  // Nov 24-25 2026: an enum listing null beside type ["string", "null"] made every recap and call prep fail
  it("no enum lists null (use anyOf with a null type)", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f)) files.push(p);
      }
    };
    walk(join(__dirname, "..", "src"));
    const bad = files.filter((f) => /enum: \[[^\]]*\bnull\b[^\]]*\]/.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
});
