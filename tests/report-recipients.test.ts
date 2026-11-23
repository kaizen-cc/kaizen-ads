import { describe, expect, it } from "vitest";
import { lineDelivery, normalizeDelivery, pastRecipients } from "@/lib/reports/delivery-core";

// "Eddie usually likes seeing the report, so I always send to Juan, Eddie and Lino": the report's email has To and Cc
// the sender picks, remembered per client and service line, and the people past report emails went to are offered.

describe("To and Cc", () => {
  it("keeps the copies apart from To, nobody twice", () => {
    const d = normalizeDelivery({ channels: ["email"], recipients: ["Juan@11miami.com", "eddie@11miami.com"], cc: ["lino@11miami.com", "juan@11miami.com", "not an email"] });
    expect(d.recipients.map((r) => r.email)).toEqual(["juan@11miami.com", "eddie@11miami.com"]);
    expect(d.cc?.map((r) => r.email)).toEqual(["lino@11miami.com"]);
  });
  it("no copies: no cc at all (older choices read the same)", () => {
    expect(normalizeDelivery({ channels: ["email"], recipients: ["juan@11miami.com"] })).toEqual({ channels: ["email"], recipients: [{ email: "juan@11miami.com", name: null }] });
  });
});

describe("remembered per service line", () => {
  const byLine = { email: { channels: ["email"], recipients: ["juan@11miami.com", "eddie@11miami.com"], cc: ["lino@11miami.com"] } };
  it("the email team's choice for the email line", () => {
    const d = lineDelivery(byLine, "email");
    expect(d?.recipients.map((r) => r.email)).toEqual(["juan@11miami.com", "eddie@11miami.com"]);
    expect(d?.cc?.map((r) => r.email)).toEqual(["lino@11miami.com"]);
  });
  it("another line without its own choice falls back (null here)", () => {
    expect(lineDelivery(byLine, "ads")).toBeNull();
    expect(lineDelivery(null, "email")).toBeNull();
  });
});

describe("who it went to before", () => {
  const sends = [
    { to: ["juan@11miami.com", "eddie@11miami.com"], cc: ["sam@kaizenmarketing.agency", "lino@11miami.com"] },
    { to: ["juan@11miami.com", "eddie@11miami.com"] },
    { to: ["juan@11miami.com"] },
  ];
  it("offers the people missing from this one, most often first, never the team", () => {
    const now = normalizeDelivery({ channels: ["email"], recipients: ["juan@11miami.com"] });
    expect(pastRecipients(sends, now, new Set(["sam@kaizenmarketing.agency"])).map((r) => r.email)).toEqual(["eddie@11miami.com", "lino@11miami.com"]);
  });
  it("nobody already on it", () => {
    const now = normalizeDelivery({ channels: ["email"], recipients: ["juan@11miami.com", "eddie@11miami.com"], cc: ["lino@11miami.com"] });
    expect(pastRecipients(sends, now, new Set())).toEqual([{ email: "sam@kaizenmarketing.agency", name: null }]);
  });
});
