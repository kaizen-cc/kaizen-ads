import { describe, expect, it } from "vitest";
import { contactsFromTab, contactsOfRow, isOtherEmailsHeader, isPocHeader, nameFrom, parseEmails } from "@/lib/sheet-contacts";

describe("email addresses in a sheet cell", () => {
  it("splits on commas, semicolons, spaces and new lines", () => {
    expect(parseEmails("a@x.com, b@x.com; c@x.com d@x.com\ne@x.com")).toEqual(["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"]);
  });
  it("takes addresses out of names, angle brackets and mailto links", () => {
    expect(parseEmails("Jane Doe <Jane@X.com>, mailto:bob@y.org")).toEqual(["jane@x.com", "bob@y.org"]);
  });
  it("drops what isn't an address, repeats, and the agency's own", () => {
    expect(parseEmails("n/a, jane@x, jane@x.com, JANE@x.com, ops@kaizenmarketing.agency, ads@contact.kaizenmarketing.agency")).toEqual(["jane@x.com"]);
    expect(parseEmails("")).toEqual([]);
    expect(parseEmails(undefined)).toEqual([]);
  });
});

describe("the name next to an address", () => {
  it("reads a clean name and refuses junk", () => {
    expect(nameFrom("Jane Doe <jane@x.com>")).toBe("Jane Doe");
    expect(nameFrom("Jane Doe - jane@x.com")).toBe("Jane Doe");
    expect(nameFrom("jane@x.com")).toBeNull();
    expect(nameFrom("N/A")).toBeNull();
    expect(nameFrom("call 555 1234")).toBeNull();
  });
});

describe("which columns hold contacts", () => {
  it("finds the points of contact", () => {
    for (const h of ["POC", "POC 1", "POC 2 Email", "Point of Contact", "Points of Contact", "Contact", "Client Contact"]) expect(isPocHeader(h)).toBe(true);
    for (const h of ["Media Buyer", "Client Name", "Any other emails", "Budget"]) expect(isPocHeader(h)).toBe(false);
  });
  it("finds the any-other-emails column however it's written", () => {
    for (const h of ["Any other emails", "Other Emails", "Other email addresses", "Additional Emails", "CC", "CC Emails", "Emails to CC"]) expect(isOtherEmailsHeader(h)).toBe(true);
    for (const h of ["POC", "Media Buyer", "Account Manager", "Budget"]) expect(isOtherEmailsHeader(h)).toBe(false);
  });
});

describe("a row's contacts", () => {
  const head = ["Client Name", "Media Buyer", "POC 1", "POC 2", "Any other emails"];
  it("adds each point of contact (the name when the cell gives one) and every other email", () => {
    const row = ["Acme", "Ana", "Pat Main <pat@acme.com>", "sam@acme.com", "ops@acme.com; billing@acme.com\nowner@acme.com"];
    expect(contactsOfRow(head, row)).toEqual([
      { email: "pat@acme.com", name: "Pat Main" },
      { email: "sam@acme.com", name: null },
      { email: "ops@acme.com", name: null },
      { email: "billing@acme.com", name: null },
      { email: "owner@acme.com", name: null },
    ]);
  });
  it("pairs a name column with its email column by number", () => {
    const h = ["Client Name", "POC 1 Name", "POC 1 Email", "POC 2 Name", "POC 2 Email"];
    expect(contactsOfRow(h, ["Acme", "Pat Main", "pat@acme.com", "Sam Second", "sam@acme.com"])).toEqual([
      { email: "pat@acme.com", name: "Pat Main" },
      { email: "sam@acme.com", name: "Sam Second" },
    ]);
  });
  it("lists an address once and keeps the name when a later cell repeats it without one", () => {
    expect(contactsOfRow(["Client Name", "POC", "Any other emails"], ["Acme", "Pat <pat@acme.com>", "pat@acme.com, x@acme.com"])).toEqual([
      { email: "pat@acme.com", name: "Pat" },
      { email: "x@acme.com", name: null },
    ]);
  });
  it("is empty when the cells hold no address", () => {
    expect(contactsOfRow(head, ["Acme", "Ana", "Pat", "", "n/a"])).toEqual([]);
  });
});

describe("a tab's rows", () => {
  it("reads every tab the same way and skips rows without a client or contact", () => {
    const meta = [
      ["Client Name", "Ad Account ID", "POC", "Any other emails"],
      ["Tier 1", "", "", ""],
      ["Acme", "act_123", "Pat <pat@acme.com>", "ops@acme.com"],
      ["Beta", "456", "", ""],
      ["", "789", "x@y.com", ""],
    ];
    const rows = contactsFromTab(meta);
    expect(rows.map((r) => r.name)).toEqual(["Acme"]);
    expect(rows[0].row["Ad Account ID"]).toBe("act_123");
    expect(rows[0].contacts.map((c) => c.email)).toEqual(["pat@acme.com", "ops@acme.com"]);
    const google = [["Clients", "POC", "Other Emails"], ["Acme", "", "g@acme.com"]];
    expect(contactsFromTab(google)[0].contacts).toEqual([{ email: "g@acme.com", name: null }]);
  });
});

describe("the All Clients tab", () => {
  it("reads POC First/Last Name, POC Email and Any other emails, with the client's ID", async () => {
    const { contactsFromTab } = await import("@/lib/sheet-contacts");
    const head = ["Client Name", "ID", "Status", "Type of Client", "Website", "Marketing Budget", "POC First Name", "POC Last Name", "POC Email", "Any other emails"];
    const rows = contactsFromTab([
      head,
      ["Sobelini", "396", "Paused", "Traditional", "https://sobelini.com/", "$25", "Heather", "Craig", "hcraig1@me.com", "Bralph@sobelini.com"],
      ["House of GRO", "386", "Paused", "Whitelabel", "", "", "Izzy and Maria", "-", "admin@therecreativeagency.com", "antonia@therecreativeagency.com"],
      ["Venus MIF Test", "55", "Paused", "Traditional", "", "", "Venus", "Bautista", "santi@kaizenmarketing.agency", ""],
    ]);
    expect(rows.map((r) => [r.name, r.id])).toEqual([["Sobelini", 396], ["House of GRO", 386]]);
    expect(rows[0].contacts).toEqual([{ email: "hcraig1@me.com", name: "Heather Craig" }, { email: "bralph@sobelini.com", name: null }]);
    expect(rows[1].contacts[0]).toEqual({ email: "admin@therecreativeagency.com", name: "Izzy and Maria" });
  });
});
