import { describe, expect, it } from "vitest";
import { detailTwiml, inQuietHours, MAX_CALLS_PER_HOUR, noticeTwiml, prettyPhone, shouldCall, speakable, toE164, twilioConfigured, type Item, type PhoneSettings } from "@/lib/phone-core";
import { twilioSignature, validTwilioSignature } from "@/lib/phone-signature";

const now = new Date("2026-11-24T16:00:00Z"); // 11am New York
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
const on: PhoneSettings = { profile_id: "p", phone: "+15125550134", opted_in: true, consent_at: ago(1000), quiet_start: 21, quiet_end: 7, timezone: "America/New_York" };
const item = (o: Partial<Item> = {}): Item => ({ id: "n1", profile_id: "p", priority: "critical", read_at: null, cleared_at: null, created_at: ago(12), ...o });

describe("phone alerts: dormant until Twilio is set", () => {
  it("needs all three values", () => {
    expect(twilioConfigured({})).toBe(false);
    expect(twilioConfigured({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t" })).toBe(false);
    expect(twilioConfigured({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM_NUMBER: "+15125550100" })).toBe(true);
  });
});

describe("numbers", () => {
  it("reads numbers the way people type them", () => {
    expect(toE164("(512) 555-0134")).toBe("+15125550134");
    expect(toE164("1 512 555 0134")).toBe("+15125550134");
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
    expect(toE164("555-0134")).toBeNull();
    expect(prettyPhone("+15125550134")).toBe("(512) 555-0134");
  });
});

describe("who gets a call", () => {
  it("rings for a critical item unseen 10 minutes, for someone who opted in", () => {
    expect(shouldCall(item(), on, [], now)).toEqual({ call: true, why: "due" });
  });
  it("never for anything else", () => {
    expect(shouldCall(item({ priority: "normal" }), on, [], now).why).toBe("not critical");
    expect(shouldCall(item({ read_at: ago(1) }), on, [], now).why).toBe("seen");
    expect(shouldCall(item({ created_at: ago(5) }), on, [], now).why).toBe("not 10 minutes yet");
    expect(shouldCall(item(), { ...on, consent_at: null }, [], now).why).toBe("not opted in");
    expect(shouldCall(item(), { ...on, opted_in: false }, [], now).why).toBe("not opted in");
    expect(shouldCall(item(), null, [], now).why).toBe("not opted in");
  });
  it("respects quiet hours in their own time zone, across midnight", () => {
    const night = new Date("2026-11-25T04:00:00Z"); // 11pm New York
    expect(inQuietHours(night, on)).toBe(true);
    expect(inQuietHours(now, on)).toBe(false);
    expect(inQuietHours(now, { ...on, timezone: "Asia/Manila" })).toBe(true); // midnight in Manila
    expect(inQuietHours(night, { ...on, quiet_start: 7, quiet_end: 7 })).toBe(false);
    expect(shouldCall(item({ created_at: new Date(night.getTime() - 12 * 60_000).toISOString() }), on, [], night).why).toBe("quiet hours");
  });
  it("one call per item, a second only after a snooze ran out; at most three an hour", () => {
    expect(shouldCall(item(), on, [{ notification_id: "n1", created_at: ago(2), snoozed_until: null }], now).why).toBe("already called");
    expect(shouldCall(item(), on, [{ notification_id: "n1", created_at: ago(70), snoozed_until: ago(10) }], now).call).toBe(true);
    expect(shouldCall(item(), on, [{ notification_id: "n1", created_at: ago(70), snoozed_until: ago(10) }, { notification_id: "n1", created_at: ago(5), snoozed_until: null }], now).why).toBe("called enough for this item");
    const busy = Array.from({ length: MAX_CALLS_PER_HOUR }, (_, i) => ({ notification_id: `x${i}`, created_at: ago(10 + i), snoozed_until: null }));
    expect(shouldCall(item(), on, busy, now).why).toBe("rate limited");
  });
});

describe("Twilio's webhook signature", () => {
  const url = "https://app.kaizenmarketing.agency/api/phone/gather?call=abc";
  const params = { CallSid: "CA123", Digits: "1", From: "+15125550100", To: "+15125550134" };
  it("accepts exactly what was signed with our token, nothing else", () => {
    const sig = twilioSignature("token", url, params);
    expect(validTwilioSignature("token", sig, url, params)).toBe(true);
    expect(validTwilioSignature("token", sig, url, { ...params, Digits: "2" })).toBe(false);
    expect(validTwilioSignature("token", sig, `${url}x`, params)).toBe(false);
    expect(validTwilioSignature("other", sig, url, params)).toBe(false);
    expect(validTwilioSignature(undefined, sig, url, params)).toBe(false);
    expect(validTwilioSignature("token", null, url, params)).toBe(false);
  });
});

describe("what's said", () => {
  it("names them, says the item, offers 1 and 2; never reads a link or markdown, and escapes", () => {
    const x = noticeTwiml({ firstName: "Kyle", title: "**OceanBox** spend <doubled> https://x.co/a", gatherUrl: "https://a.b/api/phone/gather?call=1&x=2" });
    expect(x).toContain("Hi Kyle, this is Kaizen OS");
    expect(x).toContain("OceanBox spend &lt;doubled&gt;");
    expect(x).not.toContain("https://x.co");
    expect(x).toContain('action="https://a.b/api/phone/gather?call=1&amp;x=2"');
    expect(x).toContain("Press 1 to hear the details. Press 2 to snooze it for an hour.");
    expect(detailTwiml({ body: "Spend is up 80%.", textUrl: null })).not.toContain("text you the link");
    expect(speakable("a\n\n*b*")).toBe("a b");
  });
});
