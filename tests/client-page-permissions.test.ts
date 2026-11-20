import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clientPerms } from "@/lib/chat-permissions";
import { seesAccountNumbers } from "@/lib/ai-access-core";
import { mayBusinessAudit } from "@/lib/line-actions";
import { mayEditSetup } from "@/lib/setup-access";

const src = (p: string) => readFileSync(join(__dirname, "..", "src", p), "utf8");
const PAGE = "app/(team)/clients/[slug]/page.tsx";

describe("the client page: audits", () => {
  it("a graphic designer gets no audit button, line by line or for the whole business", () => {
    const p = clientPerms({ role: "graphic_designer" }, [], ["graphic_designer"]);
    expect(p.business).toBe(false);
    expect(p.audit).toEqual({ meta: false, google: false, email: false, social: false });
  });

  it("the client's buyer audits their line and the whole business; a Google buyer never Meta", () => {
    const g = clientPerms({ role: "google_buyer" }, ["google"], ["google_buyer"]);
    expect(g.audit.google).toBe(true);
    expect(g.audit.meta).toBe(false);
    expect(g.business).toBe(true);
  });

  it("the whole-business audit: execs, line heads and the client's seated buyers and strategists only", () => {
    expect(mayBusinessAudit({ role: "executive", isExec: true }, []).ok).toBe(true);
    expect(mayBusinessAudit({ role: "head_of_social" }, []).ok).toBe(true);
    expect(mayBusinessAudit({ role: "email_strategist" }, ["email_strategist"]).ok).toBe(true);
    expect(mayBusinessAudit({ role: "email_strategist" }, []).ok).toBe(false);
    for (const role of ["graphic_designer", "video_editor", "email_builder", "copywriter", "customer_success"]) expect(mayBusinessAudit({ role }, [role]).ok).toBe(false);
  });

  it("the server refuses it too (the route, not just the button)", () => {
    expect(src("app/api/business-audits/route.ts")).toMatch(/mayBusinessAudit\(/);
    expect(src("app/(team)/clients/[slug]/business-audit-panel.tsx")).toMatch(/canRun && <button/);
  });
});

describe("the client page: makers see the creative side only", () => {
  it("a graphic designer gets no spend, KPIs or audits", () => {
    expect(seesAccountNumbers({ role: "graphic_designer" })).toBe(false);
    expect(seesAccountNumbers({ role: "media_buyer" })).toBe(true);
    // Left out on the server render: the page hands these to the browser only when the person sees account numbers
    const page = src(PAGE);
    for (const prop of ["kpis={numbers ? kpis : []}", "campaigns={off(campaigns)}", "audits={off(audits)}", "sprints={off(sprints)}", "fatigue={off(fatigue)}", "googleSync={off(googleSync)}", "klaviyo={off(klaviyo)}"]) expect(page).toContain(prop);
    expect(page).toMatch(/businessAudit=\{\s*numbers \?/);
  });
});

describe("Team & setup: executives and team leads only", () => {
  it("a strategist, buyer or designer can't change a seat, tier or service", () => {
    for (const role of ["email_strategist", "social_media_manager", "media_buyer", "google_buyer", "graphic_designer", "video_editor", "copywriter", "customer_success"]) expect(mayEditSetup({ role }), role).toBe(false);
    for (const who of [{ role: "executive", isExec: true }, { role: "head_of_meta", isLead: true }, { role: "head_of_email" }, { role: "head_of_social" }]) expect(mayEditSetup(who)).toBe(true);
  });

  it("every server action behind the tab checks it", () => {
    const tiers = src("app/(team)/clients/[slug]/tier-actions.ts");
    expect(tiers).toMatch(/isExecOrLead\(me\)/);
    const actions = src("app/(team)/clients/[slug]/actions.ts");
    for (const fn of ["saveClientDetails", "addContact", "removeContact", "saveAllotment", "markOnboarded", "pushStageEmail"]) {
      const body = actions.slice(actions.indexOf(`export async function ${fn}(`)).split("\nexport ")[0];
      expect(body, fn).toMatch(/mayEditSetup\(/);
    }
    for (const fn of ["setClientPaused", "setClientService", "setServiceTier", "archiveClient", "restoreClient", "setClientIndustry"]) {
      const body = actions.slice(actions.indexOf(`export async function ${fn}(`)).split("\nexport ")[0];
      expect(body, fn).toMatch(/isExecOrLead\(me\)|mayEditSetup\(/);
    }
    for (const fn of ["setPortalLive", "setClientNotifications", "setSprintPackage", "endCreativePackage", "setOngoingPackage"]) {
      const body = actions.slice(actions.indexOf(`export async function ${fn}(`)).split("\nexport ")[0];
      expect(body, fn).toMatch(/isExec/);
    }
    expect(src("app/(team)/clients/actions.ts")).toMatch(/isExecOrLead\(me\)/);
    expect(src("app/(team)/clients/[slug]/klaviyo-actions.ts")).toMatch(/isExecOrLead\(me\)/);
    for (const f of ["social-actions.ts", "integrations-actions.ts", "drive-actions.ts", "email-scope-actions.ts"]) expect(src(`app/(team)/clients/[slug]/${f}`), f).toMatch(/mayEditSetup\(/);
    expect(src("lib/ai-tools/email-allotment.ts")).toMatch(/mayEditSetup\(user\)/);
  });
});
