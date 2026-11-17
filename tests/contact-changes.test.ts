import { describe, expect, it } from "vitest";
import { companyDomain, contentKey, decide, describeChanges, parseForward, prefilter, resolveRemoval, type ContactLite } from "@/lib/contact-changes-core";
import { recipientsToUse, withoutRemoved } from "@/lib/reports/cc-core";

// A client's list as it was when their reply came in (the Nov 13 2026 case)
const CONTACTS: ContactLite[] = [
  { id: "ryan", email: "ryan@mcintyresusa.com", name: "Ryan Cole" },
  { id: "nilo", email: "asentzio@gmail.com", name: null },
  { id: "maria", email: "maria@mcintyresusa.com", name: "Maria Lopez" },
  { id: "ops", email: "ops@mcintyresusa.com", name: null },
];
const EMAIL = "Please remove Ryan@mcusa and Astenizo from this distribution list. Ryan is gone, and Nilo doesn't need to receive this. Please do start including jordan@mcintyresusa.com.";

describe("the prefilter", () => {
  it("passes emails about who's on the list", () => {
    expect(prefilter(EMAIL)).toBe(true);
    expect(prefilter("Can you take me off these emails? Thanks")).toBe(true);
    expect(prefilter("Please stop sending these to Mark, he has left the company.")).toBe(true);
    expect(prefilter("Please cc jordan@brand.com on these going forward")).toBe(true);
    expect(prefilter("Add Sarah to the reports please")).toBe(true);
    expect(prefilter("unsubscribe me")).toBe(true);
    expect(prefilter("Our new point of contact is Dana")).toBe(true);
  });
  it("lets everyday emails through untouched", () => {
    expect(prefilter("Thanks, the new ads look great. Can we push the budget up on Friday?")).toBe(false);
    expect(prefilter("please add more lifestyle shots to the next round")).toBe(false);
    expect(prefilter("")).toBe(false);
    expect(prefilter(null)).toBe(false);
  });
});

describe("a forwarded email", () => {
  it("reads the client's original out of a Gmail forward", () => {
    const fwd = parseForward(`FYI, see below\n\n---------- Forwarded message ---------\nFrom: Pat Client <pat@mcintyresusa.com>\nDate: Thu, Nov 13, 2026 at 9:12 AM\nSubject: Re: Monthly report\nTo: Exec <exec@kaizenmarketing.agency>\n\n${EMAIL}\n\nOn Wed, Nov 12, 2026 at 4:00 PM Kaizen wrote:\n> the report`);
    expect(fwd?.from).toBe("pat@mcintyresusa.com");
    expect(fwd?.fromName).toBe("Pat Client");
    expect(fwd?.body.startsWith("Please remove Ryan@mcusa")).toBe(true);
  });
  it("reads an Outlook forward", () => {
    const fwd = parseForward(`See below\n\nFrom: Pat Client <pat@mcintyresusa.com>\nSent: Thursday, November 13, 2026 9:12 AM\nTo: Exec\nSubject: RE: Monthly report\n\nTake Ryan off please.`);
    expect(fwd?.from).toBe("pat@mcintyresusa.com");
    expect(fwd?.body).toBe("Take Ryan off please.");
  });
  it("is null for an email that isn't a forward", () => {
    expect(parseForward(EMAIL)).toBeNull();
  });
  it("matches the same words in the original and the forward", () => {
    expect(contentKey("Pat@McIntyresUSA.com", EMAIL)).toBe(contentKey("pat@mcintyresusa.com", `${EMAIL}\n`));
  });
});

describe("who a removal means", () => {
  it("takes the exact address", () => {
    expect(resolveRemoval("ryan@mcintyresusa.com", CONTACTS)).toEqual({ contactId: "ryan", match: "exact" });
  });
  it("reads Ryan@mcusa as ryan@mcintyresusa.com (the part before the @)", () => {
    expect(resolveRemoval("Ryan@mcusa", CONTACTS)).toEqual({ contactId: "ryan", match: "local" });
  });
  it("uses the domain when two contacts share the name before the @", () => {
    const two = [...CONTACTS, { id: "ryan2", email: "ryan@othershop.com", name: null }];
    expect(resolveRemoval("Ryan@mcusa", two)).toEqual({ contactId: "ryan", match: "local" });
  });
  it("reads a first name", () => {
    expect(resolveRemoval("Maria", CONTACTS)).toEqual({ contactId: "maria", match: "name" });
  });
  it("reads Astenizo as asentzio@gmail.com (the same letters, misspelled)", () => {
    expect(resolveRemoval("Astenizo", CONTACTS)).toEqual({ contactId: "nilo", match: "fuzzy" });
  });
  it("takes the AI's pick for a nickname it can't spell its way to (Nilo)", () => {
    expect(resolveRemoval("Nilo", CONTACTS)).toMatchObject({ contactId: null });
    expect(resolveRemoval("Nilo", CONTACTS, "asentzio@gmail.com")).toEqual({ contactId: "nilo", match: "model" });
  });
  it("never takes a pick that isn't one of the contacts", () => {
    expect(resolveRemoval("Nilo", CONTACTS, "nilo@elsewhere.com")).toMatchObject({ contactId: null });
  });
  it("refuses a name that fits two contacts, or a pick that contradicts what's written", () => {
    const twins = [...CONTACTS, { id: "maria2", email: "maria.g@mcintyresusa.com", name: "Maria Gomez" }];
    expect(resolveRemoval("Maria", twins)).toMatchObject({ contactId: null });
    expect(resolveRemoval("Maria", twins, "maria.g@mcintyresusa.com")).toEqual({ contactId: "maria2", match: "model" });
    expect(resolveRemoval("Maria", CONTACTS, "ryan@mcintyresusa.com")).toMatchObject({ contactId: null });
  });
  it("refuses someone nobody is close to", () => {
    expect(resolveRemoval("Bartholomew", CONTACTS)).toMatchObject({ contactId: null });
  });
});

describe("applied on its own, or confirmed by the team", () => {
  // The AI's read of the email, stubbed: Astenizo and Nilo are one person, so one removal
  const read = { add: [{ email: "jordan@mcintyresusa.com", name: null }], remove: [{ asWritten: "Ryan@mcusa", reason: "Ryan is gone" }, { asWritten: "Astenizo", reason: "doesn't need to receive this", pick: "asentzio@gmail.com" }], quote: EMAIL };

  it("applies the whole email when a contact sent it and everyone resolves", () => {
    const out = decide(read, { senderIsContact: true, forwarded: false, contacts: CONTACTS });
    expect(out.auto).toBe(true);
    expect(out.why).toEqual([]);
    expect(out.changes.map((c) => [c.kind, c.contactId ?? c.email])).toEqual([
      ["remove", "ryan"],
      ["remove", "nilo"],
      ["add", "jordan@mcintyresusa.com"],
    ]);
    expect(describeChanges(out.changes)).toBe("took Ryan Cole (ryan@mcintyresusa.com) and asentzio@gmail.com off and added jordan@mcintyresusa.com");
  });
  it("takes one person off once when the email names them twice", () => {
    const twice = { ...read, remove: [...read.remove, { asWritten: "Nilo", pick: "asentzio@gmail.com" }] };
    expect(decide(twice, { senderIsContact: true, forwarded: false, contacts: CONTACTS }).changes.filter((c) => c.kind === "remove")).toHaveLength(2);
  });
  it("waits for the team when only the sender's domain matches", () => {
    const out = decide(read, { senderIsContact: false, forwarded: false, contacts: CONTACTS });
    expect(out.auto).toBe(false);
    expect(out.why.join(" ")).toMatch(/domain/);
  });
  it("never applies a forward on its own", () => {
    const out = decide(read, { senderIsContact: true, forwarded: true, contacts: CONTACTS });
    expect(out.auto).toBe(false);
    expect(out.why.join(" ")).toMatch(/Forwarded/);
  });
  it("waits for the team when a name doesn't resolve to one contact", () => {
    const out = decide({ ...read, remove: [{ asWritten: "Nilo" }] }, { senderIsContact: true, forwarded: false, contacts: CONTACTS });
    expect(out.auto).toBe(false);
    expect(out.changes[0]).toMatchObject({ kind: "remove", contactId: null, status: "pending" });
  });
  it("waits for the team when an add isn't a full address", () => {
    const out = decide({ add: [{ email: "jordan@", name: "Jordan" }], remove: [], quote: "" }, { senderIsContact: true, forwarded: false, contacts: CONTACTS });
    expect(out.auto).toBe(false);
  });
  it("never adds one of our own team as a client contact", () => {
    const out = decide({ add: [{ email: "buyer@kaizenmarketing.agency" }], remove: [], quote: "" }, { senderIsContact: true, forwarded: false, contacts: CONTACTS });
    expect(out.auto).toBe(false);
    expect(out.changes[0].status).toBe("blocked");
  });
  it("skips adding someone already on the list", () => {
    const out = decide({ add: [{ email: "Maria@McIntyresUSA.com" }], remove: [], quote: "" }, { senderIsContact: true, forwarded: false, contacts: CONTACTS });
    expect(out.changes).toEqual([]);
    expect(out.auto).toBe(false);
  });
});

describe("the last contact", () => {
  const solo: ContactLite[] = [{ id: "ryan", email: "ryan@mcintyresusa.com", name: "Ryan Cole" }];
  it("is never taken off on its own", () => {
    const out = decide({ add: [], remove: [{ asWritten: "Ryan" }], quote: "" }, { senderIsContact: true, forwarded: false, contacts: solo });
    expect(out.auto).toBe(false);
    expect(out.why.join(" ")).toMatch(/no contact/);
  });
  it("can be swapped for someone new in the same email", () => {
    const out = decide({ add: [{ email: "jordan@mcintyresusa.com" }], remove: [{ asWritten: "Ryan" }], quote: "" }, { senderIsContact: true, forwarded: false, contacts: solo });
    expect(out.auto).toBe(true);
  });
});

describe("free mail", () => {
  it("is never a company domain", () => {
    expect(companyDomain("asentzio@gmail.com")).toBeNull();
    expect(companyDomain("someone@kaizenmarketing.agency")).toBeNull();
    expect(companyDomain("ryan@mcintyresusa.com")).toBe("mcintyresusa.com");
  });
});

describe("report recipients", () => {
  it("drop anyone taken off since the choice was saved", () => {
    const saved = [{ email: "ryan@mcintyresusa.com", name: "Ryan" }, { email: "maria@mcintyresusa.com", name: "Maria" }];
    expect(withoutRemoved(saved, new Set(["ryan@mcintyresusa.com"]))).toEqual([{ email: "maria@mcintyresusa.com", name: "Maria" }]);
    // A contact added later (from the client's email) still joins a remembered choice
    const contacts = [{ email: "maria@mcintyresusa.com", addedAt: "2026-11-01" }, { email: "jordan@mcintyresusa.com", addedAt: "2026-11-13" }];
    expect(recipientsToUse(contacts, withoutRemoved(saved, new Set(["ryan@mcintyresusa.com"])), "2026-11-05").map((r) => r.email)).toEqual(["maria@mcintyresusa.com", "jordan@mcintyresusa.com"]);
  });
});
