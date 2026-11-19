import { describe, expect, it } from "vitest";
import { clientInText, coreSubject } from "@/lib/owed-replies";

describe("a teammate's email filed to the client it's about", () => {
  const contacts = new Map([["hugo@oceanbox.com", { clientId: "ocean" }], ["jo@kore.com", { clientId: "kore" }]]);
  const domains = new Map<string, string | null>([["oceanbox.com", "ocean"], ["kore.com", "kore"]]);
  const team = new Map([["lawrence@kaizenmarketing.agency", {}]]);
  it("a forwarded client email names the client", () => {
    const text = "Hi Fernando, these are the prices.\n---------- Forwarded message ---------\nFrom: Hugo Silva <hugo@oceanbox.com>\nTo: Lawrence <lawrence@kaizenmarketing.agency>";
    expect(clientInText(text, contacts, domains, team)).toBe("ocean");
  });
  it("another person at the client's domain counts too", () => {
    expect(clientInText("Cc: jordan@oceanbox.com", contacts, domains, team)).toBe("ocean");
  });
  it("two clients, or none, is no client", () => {
    expect(clientInText("hugo@oceanbox.com and jo@kore.com", contacts, domains, team)).toBeNull();
    expect(clientInText("only lawrence@kaizenmarketing.agency here", contacts, domains, team)).toBeNull();
  });
  it("the same email across mailboxes, whatever Re: and Fwd: it carries", () => {
    expect(coreSubject("Re: Fwd: BFCM offer structure and margins")).toBe("bfcm offer structure and margins");
    expect(coreSubject("FW: RE:  BFCM  offer structure and margins")).toBe("bfcm offer structure and margins");
  });
});
