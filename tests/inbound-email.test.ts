import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { replyText, verifySvix } from "@/lib/inbound-email";

const secret = `whsec_${Buffer.from("a-very-secret-key").toString("base64")}`;
const sign = (id: string, ts: string, body: string) => createHmac("sha256", Buffer.from("a-very-secret-key")).update(`${id}.${ts}.${body}`).digest("base64");

describe("inbound email", () => {
  it("accepts Resend's signature and nothing else", () => {
    const body = JSON.stringify({ type: "email.received", data: { email_id: "x" } });
    const ts = String(Math.floor(Date.now() / 1000));
    const good = { id: "msg_1", timestamp: ts, signature: `v1,bogus v1,${sign("msg_1", ts, body)}` };
    expect(verifySvix(secret, good, body)).toBe(true);
    expect(verifySvix(secret, good, `${body} `)).toBe(false);
    expect(verifySvix(secret, { ...good, id: "msg_2" }, body)).toBe(false);
    expect(verifySvix(secret, good, body, Date.now() + 10 * 60_000)).toBe(false);
    expect(verifySvix("", good, body)).toBe(false);
    expect(verifySvix(secret, { ...good, signature: null }, body)).toBe(false);
  });

  it("keeps only what they wrote", () => {
    const text = "Onboarding started Nov 2, client is Crust Pizza Gleannloch.\n\nThanks\n\nOn Wed, Nov 5, 2026 at 10:02 AM Kaizen Ads <ads@contact.kaizenmarketing.agency>\nwrote:\n> Second notice: you said you'd keep the pilot\n> to Glenlock Farms";
    expect(replyText(text)).toBe("Onboarding started Nov 2, client is Crust Pizza Gleannloch.\n\nThanks");
    expect(replyText("done\r\n-- \r\nKyle")).toBe("done");
    expect(replyText("handled on a call\n\nFrom: Kaizen Ads\nSent: Wednesday\nSubject: x")).toBe("handled on a call");
  });
});
