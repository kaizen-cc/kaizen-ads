import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noticeItem, noticeLink, noticeToken, readNoticeToken, readReplyAddress, replyAddress, replyCode } from "@/lib/notice-links";

const id = "332c31bf-a2ae-43e0-829e-03fe58c5ed16";
const me = "4c7896ca-22a5-459f-9a67-cd2b5d963864";

describe("notice links", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.NOTICE_LINK_SECRET = "test-secret";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("reads back what it signed", () => {
    const t = noticeToken({ kind: "said", id, profileId: me });
    expect(readNoticeToken(t)).toEqual({ kind: "said", id, profileId: me });
  });

  it("refuses a changed, foreign or expired token", () => {
    const t = noticeToken({ kind: "owed", id, profileId: me });
    const [payload, sig] = t.split(".");
    const other = Buffer.from(JSON.stringify({ k: "owed", i: id, p: "someone-else", exp: Date.now() + 1e9 })).toString("base64url");
    expect(readNoticeToken(`${other}.${sig}`)).toBeNull();
    expect(readNoticeToken(`${payload}.${sig.slice(0, -2)}xx`)).toBeNull();
    expect(readNoticeToken(`${payload}`)).toBeNull();
    expect(readNoticeToken(null)).toBeNull();
    expect(readNoticeToken(t, Date.now() + 15 * 86_400_000)).toBeNull();
    process.env.NOTICE_LINK_SECRET = "another-secret";
    expect(readNoticeToken(t)).toBeNull();
  });

  it("knows which notices are about a promise or an owed reply", () => {
    expect(noticeItem(`said2:${id}`)).toEqual({ kind: "said", id });
    expect(noticeItem(`owed-lead:${id}`)).toEqual({ kind: "owed", id });
    expect(noticeItem(`said-moving:${id}`)).toBeNull();
    expect(noticeItem(`recap:2026-11-05:am`)).toBeNull();
  });

  it("signs a reply address that survives lowercasing and fits an address", () => {
    process.env.RESEND_WEBHOOK_SECRET = "whsec_x";
    process.env.RESEND_INBOUND_DOMAIN = "contact.example.com";
    const a = replyAddress("said", id)!;
    expect(a.split("@")[0].length).toBeLessThanOrEqual(64);
    expect(a.endsWith("@contact.example.com")).toBe(true);
    expect(readReplyAddress(["someone@else.com", `"Kaizen Ads" <${a.toUpperCase()}>`])).toEqual({ kind: "said", id });
    expect(readReplyAddress([a.replace("+s", "+o")])).toBeNull();
    expect(readReplyAddress([a.replace(/(.)@/, (_, c: string) => `${c === "0" ? "1" : "0"}@`)])).toBeNull();
    delete process.env.RESEND_WEBHOOK_SECRET;
    expect(replyAddress("said", id)).toBeNull();
    expect(replyCode("owed", id)).toMatch(/^o[0-9a-f]{48}$/);
  });

  it("builds the page link", () => {
    expect(noticeLink("https://ads.example", { kind: "said", id, profileId: me }, "context")).toMatch(/^https:\/\/ads\.example\/handled\?t=[\w-]+\.[\w-]+&do=context$/);
  });
});
