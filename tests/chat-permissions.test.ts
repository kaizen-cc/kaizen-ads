import { describe, expect, it } from "vitest";
import { can, canChangeBuyer, clientPerms, permsPrompt, roleWidePerms, type AdPlatform, type PermAction } from "@/lib/chat-permissions";
import { quickActionIds } from "@/lib/kaizen-ai/agents";

// The matrix: what each role may DO from the chat (and the server actions behind it). Asking and reading stays open.

const who = (role: string) => ({ role, isExec: role === "executive" });
const ROLES = ["executive", "head_of_meta", "head_of_google", "media_buyer", "google_buyer", "head_of_creative", "lead_graphic_designer", "graphic_designer", "lead_video_editor", "video_editor", "copywriter", "customer_success", "coordinator", "member"] as const;

// [role] -> the ad account actions allowed on each platform with no seat, and with a seat on that platform
const ADS: Record<(typeof ROLES)[number], { noSeat: AdPlatform[]; seated: AdPlatform[] }> = {
  executive: { noSeat: ["meta", "google"], seated: ["meta", "google"] },
  head_of_meta: { noSeat: ["meta"], seated: ["meta"] },
  head_of_google: { noSeat: ["google"], seated: ["google"] },
  media_buyer: { noSeat: [], seated: ["meta"] },
  google_buyer: { noSeat: [], seated: ["google"] },
  head_of_creative: { noSeat: [], seated: [] },
  lead_graphic_designer: { noSeat: [], seated: [] },
  graphic_designer: { noSeat: [], seated: [] },
  lead_video_editor: { noSeat: [], seated: [] },
  video_editor: { noSeat: [], seated: [] },
  copywriter: { noSeat: [], seated: [] },
  customer_success: { noSeat: [], seated: [] },
  coordinator: { noSeat: [], seated: [] },
  member: { noSeat: [], seated: [] },
};

// [role] -> the brief formats allowed, copy, creative review
const CREATIVE: Record<(typeof ROLES)[number], { brief: string[]; copy: boolean; review: boolean }> = {
  executive: { brief: ["image", "carousel", "video"], copy: true, review: true },
  head_of_meta: { brief: ["image", "carousel", "video"], copy: true, review: true },
  head_of_google: { brief: ["image", "carousel", "video"], copy: true, review: true },
  media_buyer: { brief: ["image", "carousel", "video"], copy: true, review: true },
  google_buyer: { brief: ["image", "carousel", "video"], copy: true, review: true },
  head_of_creative: { brief: ["image", "carousel", "video"], copy: true, review: true },
  lead_graphic_designer: { brief: ["image", "carousel"], copy: false, review: true },
  graphic_designer: { brief: ["image", "carousel"], copy: false, review: true },
  lead_video_editor: { brief: ["video"], copy: false, review: true },
  video_editor: { brief: ["video"], copy: false, review: true },
  copywriter: { brief: [], copy: true, review: false },
  customer_success: { brief: [], copy: false, review: false },
  coordinator: { brief: [], copy: false, review: false },
  member: { brief: [], copy: false, review: false },
};

describe("can: ad account changes and launches", () => {
  for (const role of ROLES)
    for (const action of ["ads.change", "ads.launch"] as PermAction[])
      for (const platform of ["meta", "google"] as AdPlatform[]) {
        it(`${role} ${action} ${platform}`, () => {
          const noSeat = can(who(role), action, { platform, seats: [] });
          const seated = can(who(role), action, { platform, seats: [platform] });
          // Holding the OTHER platform's seat never opens this one
          const wrongSeat = can(who(role), action, { platform, seats: [platform === "meta" ? "google" : "meta"] });
          expect(noSeat.ok).toBe(ADS[role].noSeat.includes(platform));
          expect(seated.ok).toBe(ADS[role].seated.includes(platform));
          expect(wrongSeat.ok).toBe(ADS[role].noSeat.includes(platform));
          if (!noSeat.ok) expect(noSeat.reason).toMatch(platform === "meta" ? /Head of Meta/ : /Head of Google/);
        });
      }

  it("needs a platform", () => {
    expect(can(who("executive"), "ads.launch", {}).ok).toBe(false);
  });

  it("says who can, in a plain sentence", () => {
    expect(can(who("google_buyer"), "ads.launch", { platform: "meta" }).reason).toBe("Launching in Meta is for the Head of Meta, the client's Meta buyer and the executives.");
    expect(can(who("media_buyer"), "ads.change", { platform: "meta", seats: [] }).reason).toMatch(/You're not this client's Meta buyer\./);
    expect(can(who("graphic_designer"), "ads.change", { platform: "google" }).reason).toBe("Changing the Google Ads account is for the Head of Google, the client's Google buyer and the executives.");
  });

  it("isExec counts as an executive whatever the role", () => {
    expect(can({ role: "head_of_meta", isExec: true }, "ads.launch", { platform: "google" }).ok).toBe(true);
  });
});

describe("can: briefs, copy, reviews", () => {
  for (const role of ROLES) {
    it(`${role}`, () => {
      const c = CREATIVE[role];
      expect(can(who(role), "brief").ok).toBe(c.brief.length > 0);
      for (const f of ["image", "carousel", "video"]) expect(can(who(role), "brief", { format: f }).ok).toBe(c.brief.includes(f));
      // A mixed brief: every format must be theirs
      expect(can(who(role), "brief", { format: "mixed", formats: ["image", "video"] }).ok).toBe(c.brief.includes("image") && c.brief.includes("video"));
      expect(can(who(role), "copy").ok).toBe(c.copy);
      expect(can(who(role), "creative.review").ok).toBe(c.review);
      if (c.review) for (const f of ["image", "video"]) expect(can(who(role), "creative.review", { format: f }).ok).toBe(c.brief.includes(f));
    });
  }

  it("the copywriter is told they can write the copy", () => {
    const v = can(who("copywriter"), "brief");
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/As the copywriter you can write the copy/);
  });

  it("a designer asked for video is told who briefs video", () => {
    expect(can(who("graphic_designer"), "brief", { format: "video" }).reason).toMatch(/^Video briefs are for the video editors/);
    expect(can(who("video_editor"), "brief", { formats: ["Single image"] }).reason).toMatch(/^Image and carousel briefs/);
  });
});

describe("the buyer change and the summary for the browser", () => {
  it("only execs and the platform heads change a client's buyer", () => {
    for (const role of ROLES) expect(canChangeBuyer(who(role)).ok).toBe(["executive", "head_of_meta", "head_of_google"].includes(role));
  });

  it("clientPerms matches can()", () => {
    const p = clientPerms(who("google_buyer"), ["google"]);
    expect(p.change).toEqual({ meta: false, google: true });
    expect(p.launch).toEqual({ meta: false, google: true });
    expect(p.launchWhy.meta).toMatch(/Head of Meta/);
    expect(p.briefFormats).toEqual(["image", "carousel", "video"]);
    expect(clientPerms(who("google_buyer"), []).launch.google).toBe(false);
    expect(roleWidePerms(who("google_buyer")).launch.google).toBe(true);
    expect(roleWidePerms(who("media_buyer")).launch).toEqual({ meta: true, google: false });
  });

  it("the prompt names roles, never people, and has no em dashes", () => {
    for (const role of ROLES) {
      const text = permsPrompt(clientPerms(who(role), ["meta", "google"]));
      expect(text).not.toMatch(/—/);
      expect(text).toMatch(/^What this person may do here: /);
    }
    const creative = permsPrompt(clientPerms(who("graphic_designer")));
    expect(creative).toMatch(/Never offer, plan or start any of these/);
    expect(creative).toMatch(/single images and carousels only/);
    expect(permsPrompt(clientPerms(who("executive")))).not.toMatch(/Not theirs to do/);
  });
});

describe("Kaizen AI quick actions and tools", () => {
  it("quick actions leave out what the role doesn't do", () => {
    expect(quickActionIds(who("graphic_designer"))).not.toContain("search-terms");
    expect(quickActionIds(who("graphic_designer"))).not.toContain("copy-from-brief");
    expect(quickActionIds(who("media_buyer"))).not.toContain("search-terms");
    expect(quickActionIds(who("google_buyer"))).toContain("search-terms");
    expect(quickActionIds(who("copywriter"))).toContain("copy-from-brief");
    expect(quickActionIds(who("copywriter"))).not.toContain("creative-assessment");
    expect(quickActionIds(who("customer_success"))).toEqual(expect.arrayContaining(["what-changed", "rewrite"]));
  });

  it("tools leave out writes the role can't make, and plan_ad_changes only offers its platforms", async () => {
    const { toolsFor } = await import("@/lib/kaizen-ai/tools");
    const all = ["plan_ad_changes", "launch_sheet", "launch_reply", "write_ad_copy", "create_brief", "creative_assessment", "google_policy_apply_fix", "account_metrics"].map((name) => ({ name, input_schema: { type: "object", properties: { platform: { type: "string", enum: ["meta", "google", "team"] } } } }));
    const names = (role: string) => toolsFor(who(role), all).map((t) => t.name);
    expect(names("graphic_designer")).toEqual(["create_brief", "creative_assessment", "account_metrics"]);
    expect(names("copywriter")).toEqual(["write_ad_copy", "creative_assessment", "account_metrics"]);
    expect(names("customer_success")).toEqual(["creative_assessment", "account_metrics"]);
    expect(names("google_buyer")).toEqual(["plan_ad_changes", "write_ad_copy", "create_brief", "creative_assessment", "google_policy_apply_fix", "account_metrics"]);
    expect(names("media_buyer")).toContain("launch_sheet");
    expect(names("media_buyer")).not.toContain("google_policy_apply_fix");
    const plan = (role: string) => (toolsFor(who(role), all).find((t) => t.name === "plan_ad_changes")?.input_schema as { properties: { platform: { enum: string[] } } }).properties.platform.enum;
    expect(plan("google_buyer")).toEqual(["google"]);
    expect(plan("head_of_meta")).toEqual(["meta", "team"]);
    expect(plan("executive")).toEqual(["meta", "google", "team"]);
  });
});
