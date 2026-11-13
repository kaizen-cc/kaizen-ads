import { describe, expect, it } from "vitest";
import { assembleCc, ccProfileIds, cleanEmails, defaultRecipients, firstNameFor, greetingFor, recipientsToUse, reportCtaUrl } from "@/lib/reports/cc-core";
import { buildReportEmail, normalizeDelivery } from "@/lib/reports/delivery-core";

describe("the Cc line of a report email", () => {
  it("copies the buyers, then the always-copied staff, each address once and lowercased", () => {
    expect(assembleCc({ to: ["client@acme.com"], buyers: ["Ana@kaizen.com", "ana@kaizen.com", "bo@kaizen.com"], always: ["kyle@kaizen.com", "BO@kaizen.com"] })).toEqual(["ana@kaizen.com", "bo@kaizen.com", "kyle@kaizen.com"]);
  });
  it("never copies an address that is already in To", () => {
    expect(assembleCc({ to: ["Kyle@kaizen.com", "client@acme.com"], buyers: ["ana@kaizen.com"], always: ["kyle@kaizen.com"] })).toEqual(["ana@kaizen.com"]);
  });
  it("skips blanks and addresses that aren't real (an inactive profile has none to give)", () => {
    expect(assembleCc({ to: [], buyers: [null, undefined, "", "not an email"], always: ["ok@kaizen.com"] })).toEqual(["ok@kaizen.com"]);
  });
  it("is empty when nobody is to be copied", () => {
    expect(assembleCc({ to: ["a@b.co"], buyers: [], always: [] })).toEqual([]);
  });
  it("picks the profiles: the owners and buyers once, the always-copied who aren't already buyers", () => {
    expect(ccProfileIds({ owners: ["o1", null], buyers: ["b1", "o1", "b2"], always: ["k", "b1", "r", "k"] })).toEqual({ buyers: ["o1", "b1", "b2"], always: ["k", "r"] });
  });
  it("cleans a list of addresses", () => {
    expect(cleanEmails([" A@b.co ", "a@b.co", "x", "c@d.io"])).toEqual(["a@b.co", "c@d.io"]);
  });
});

describe("who the email goes to", () => {
  const contacts = [
    { email: "second@acme.com", name: "Sam Second", primary: false, addedAt: "2026-11-01T00:00:00Z" },
    { email: "main@acme.com", name: "Pat Main", primary: true, addedAt: "2026-10-01T00:00:00Z" },
    { email: "MAIN@acme.com", name: "Dup", primary: false, addedAt: null },
    { email: "bad", name: "Nope", primary: false, addedAt: null },
    { email: "third@acme.com", name: null, primary: false, addedAt: "2026-11-10T00:00:00Z" },
  ];
  it("is every contact by default (not only the primary), primary first, once each", () => {
    expect(defaultRecipients(contacts).map((c) => c.email)).toEqual(["main@acme.com", "second@acme.com", "third@acme.com"]);
  });
  it("is not capped at six or ten", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ email: `p${i}@acme.com`, name: null }));
    expect(defaultRecipients(many)).toHaveLength(14);
    expect(normalizeDelivery({ channels: ["email"], recipients: many.map((m) => m.email) }).recipients).toHaveLength(14);
  });
  it("keeps what the buyer ticked and adds contacts gained since they chose", () => {
    const got = recipientsToUse(contacts, [{ email: "main@acme.com", name: "Pat Main" }], "2026-11-05T00:00:00Z");
    expect(got.map((r) => r.email)).toEqual(["main@acme.com", "third@acme.com"]);
  });
  it("uses every contact when nothing was saved", () => {
    expect(recipientsToUse(contacts, [], null)).toHaveLength(3);
  });
  it("greets one contact by first name, several as the team", () => {
    expect(greetingFor([{ email: "a@b.co", name: "Pat Main" }])).toBe("Hi Pat,");
    expect(greetingFor([{ email: "a@b.co", name: null }])).toBe("Hi team,");
    expect(greetingFor([{ email: "a@b.co", name: "Pat" }, { email: "c@d.co", name: "Sam" }])).toBe("Hi team,");
    expect(firstNameFor([{ email: "a@b.co", name: "Pat Main" }, { email: "c@d.co" }])).toBeNull();
  });
});

describe("the email's button", () => {
  const site = "https://ads.example.com";
  it("links the dashboard only when the portal is live and the client isn't white label", () => {
    expect(reportCtaUrl({ slug: "acme", portal_live: true, client_type: "standard" }, site)).toBe(`${site}/c/acme/dashboard`);
    expect(reportCtaUrl({ slug: "acme", portal_live: false }, site)).toBeNull();
    expect(reportCtaUrl({ slug: "acme", portal_live: null }, site)).toBeNull();
    expect(reportCtaUrl({ slug: "acme", portal_live: true, client_type: "whitelabel" }, site)).toBeNull();
    expect(reportCtaUrl({ slug: "acme", portal_live: true, client_type: "White label" }, site)).toBeNull();
  });
  const base = { client: "Acme", kind: "weekly", periodLabel: "Nov 2 – Nov 8", parts: [], from: { name: "Ana Buyer", email: "ana@kaizen.com" } };
  it("has no button without a live dashboard, and says the PDF is attached", () => {
    const mail = buildReportEmail({ ...base, dashboard: null });
    expect(mail.cta).toBeNull();
    expect(mail.lines[0]).toContain("attached as a PDF");
    expect(mail.text).not.toContain("http");
  });
  it("has the button when given a live dashboard, but never for a white label client", () => {
    expect(buildReportEmail({ ...base, dashboard: `https://x.test/c/acme/dashboard` }).cta?.url).toBe("https://x.test/c/acme/dashboard");
    expect(buildReportEmail({ ...base, dashboard: `https://x.test/c/acme/dashboard`, whiteLabel: true }).cta).toBeNull();
  });
  it("opens with Hi team when it goes to several people", () => {
    expect(buildReportEmail({ ...base, first: null }).hello).toBe("Hi team,");
    expect(buildReportEmail({ ...base, first: "Pat" }).hello).toBe("Hi Pat,");
  });
});
