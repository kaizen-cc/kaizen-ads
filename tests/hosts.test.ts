import { describe, expect, it } from "vitest";
import { hostRedirect, hostsFrom } from "@/lib/hosts";
import { cookieDomain } from "@/lib/site";

const moved = hostsFrom({ NEXT_PUBLIC_SITE_URL: "https://app.kaizenmarketing.agency", NEXT_PUBLIC_PORTAL_URL: "https://portal.kaizenmarketing.agency" });

describe("hostsFrom", () => {
  it("keeps everything on one address until the app moves", () => {
    expect(hostsFrom({ NEXT_PUBLIC_SITE_URL: "https://ads.kaizenmarketing.agency" })).toEqual({ app: "ads.kaizenmarketing.agency", portal: null, legacy: null });
  });
  it("knows the three addresses once moved", () => {
    expect(moved).toEqual({ app: "app.kaizenmarketing.agency", portal: "portal.kaizenmarketing.agency", legacy: "ads.kaizenmarketing.agency" });
  });
});

describe("hostRedirect", () => {
  const go = (host: string, path: string) => hostRedirect(host, path, moved);

  it("sends the old address's pages to app., and its portal pages to portal.", () => {
    expect(go("ads.kaizenmarketing.agency", "/reports")).toEqual({ to: "https://app.kaizenmarketing.agency", status: 308 });
    expect(go("ads.kaizenmarketing.agency", "/c/acme/chat")).toEqual({ to: "https://portal.kaizenmarketing.agency", status: 308 });
  });
  it("keeps webhooks, callbacks and sign-in links answering on the old address", () => {
    for (const p of ["/api/slack/events", "/api/connectors/callback", "/api/zapier/intake", "/auth/confirm"]) expect(go("ads.kaizenmarketing.agency", p)).toBeNull();
  });
  it("moves the portal off app., and runs OAuth starts on the registered address", () => {
    expect(go("app.kaizenmarketing.agency", "/c/acme")).toEqual({ to: "https://portal.kaizenmarketing.agency", status: 308 });
    expect(go("app.kaizenmarketing.agency", "/api/slack/connect")).toEqual({ to: "https://ads.kaizenmarketing.agency", status: 307 });
    expect(go("app.kaizenmarketing.agency", "/clients/acme")).toBeNull();
    expect(go("app.kaizenmarketing.agency", "/api/ai/chat")).toBeNull();
    expect(go("app.kaizenmarketing.agency", "/cards")).toBeNull();
  });
  it("serves only the portal on portal.", () => {
    for (const p of ["/", "/c", "/c/acme/reports", "/login", "/auth/callback", "/r/abc", "/privacy"]) expect(go("portal.kaizenmarketing.agency", p)).toBeNull();
    expect(go("portal.kaizenmarketing.agency", "/pipeline")).toEqual({ to: "https://app.kaizenmarketing.agency", status: 308 });
    expect(go("portal.kaizenmarketing.agency", "/clients/acme")).toEqual({ to: "https://app.kaizenmarketing.agency", status: 308 });
  });
  it("leaves localhost and previews alone", () => {
    expect(go("localhost:3000", "/c/acme")).toBeNull();
    expect(go("kaizen-ads-git-x.vercel.app", "/reports")).toBeNull();
  });
});

describe("cookieDomain", () => {
  const portal = "https://portal.kaizenmarketing.agency";
  it("shares the sign in across kaizenmarketing.agency only", () => {
    expect(cookieDomain("app.kaizenmarketing.agency", portal)).toBe(".kaizenmarketing.agency");
    expect(cookieDomain("portal.kaizenmarketing.agency:443", portal)).toBe(".kaizenmarketing.agency");
    expect(cookieDomain("localhost:3000", portal)).toBeUndefined();
    expect(cookieDomain("kaizen-ads.vercel.app", portal)).toBeUndefined();
  });
  it("keeps today's per-host cookie until the portal has its own address", () => {
    expect(cookieDomain("ads.kaizenmarketing.agency", "")).toBeUndefined();
  });
});
