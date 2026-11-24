import { isMaker, noIdeas } from "./maker-day-core";
import { isChannelOnly, isSupportRole, seesEmailBoard } from "./roles";
import { mayTransferAny } from "./seat-transfer-core";

// What an assistant or Kaizen AI may reach for the person it works for: never wider than what they could open in the
// app themselves. Pure rules here (tested); the server side (src/lib/ai-access.ts) adds the checks that need the
// database (which clients they can see, whose thread it is). Every tool that reads with the server's rights must go
// through one of them first.

export type AccessWho = { id?: string; role: string | null | undefined; isExec?: boolean | null; isLead?: boolean | null; canViewAs?: boolean | null; viewAs?: unknown };
export type Gate = { ok: true } | { ok: false; why: string };
const OK: Gate = { ok: true };
const no = (why: string): Gate => ({ ok: false, why });

const isHead = (role: string | null | undefined) => String(role ?? "").startsWith("head_of_");

/**
 * Account numbers: KPIs, spend, targets, failing-account alerts, audits and sprints. The makers (designers and video
 * editors) work from their Today view and never see these in the app, so their assistant doesn't either.
 */
export const seesAccountNumbers = (me: AccessWho) => Boolean(me.isExec) || !isMaker(me.role);

/** Team, HR and money (salaries, terminations, billing, other people's performance, seat moves): executives, and a head for their own line's people */
export function mayManagePeople(me: AccessWho): Gate {
  if (me.isExec) return OK;
  if (isHead(me.role) || me.isLead) return OK;
  return no("That's for the executives and the line heads.");
}

/** Billing and the company's money: executives only */
export const seesMoney = (me: AccessWho): Gate => (me.isExec ? OK : no("Billing and the company's money are for the executives."));

const SETTINGS_EXEC = new Set(["data", "sync", "errors"]);
const SETTINGS_LEAD = new Set(["team", "deleted"]);

/**
 * Whether the person may open this page, by the same rules the pages use (the page itself would send them away).
 * Pages that depend on a record (a client, a thread, a report) are checked on the server too (src/lib/ai-access.ts).
 */
export function mayOpen(href: string, me: AccessWho): Gate {
  let u: URL;
  try {
    u = new URL(href, "https://app.local");
  } catch {
    return no("That isn't a page in the app.");
  }
  const p = u.pathname.replace(/\/+$/, "") || "/";
  const q = u.searchParams;
  const under = (base: string) => p === base || p.startsWith(`${base}/`);
  if ((under("/ideas") || under("/winners") || under("/market")) && noIdeas(me.role)) return no("Ideas, Winners and Market aren't part of your view.");
  if (p === "/pipeline" && q.get("tab") === "ideas" && noIdeas(me.role)) return no("Ideas aren't part of your view.");
  if ((under("/board") || under("/kpis") || under("/lab")) && isSupportRole(me.role)) return no("Boards, the KPI board and the Ads Lab aren't part of your view.");
  if (under("/reviews")) return me.isExec || ["head_of_meta", "head_of_google", "head_of_email", "head_of_social"].includes(String(me.role)) ? OK : no("Weekly reviews are for the line heads and the executives.");
  if (under("/scorecard")) return me.isExec || ["head_of_meta", "head_of_google", "head_of_email", "head_of_social"].includes(String(me.role)) ? OK : no("The scorecard is for the line heads and the executives.");
  if (under("/stepins")) return me.isExec ? OK : no("Step-ins are for the executives.");
  if (under("/economics")) return me.isExec ? OK : no("Billing and the company's money are for the executives.");
  if (under("/csuite") || under("/safety")) return me.isExec ? OK : no("That page is for the executives.");
  if (under("/lab")) return me.isExec || me.isLead ? OK : no("The Ads Lab is for the executives and leaders.");
  if (under("/sales")) return me.isExec || me.isLead ? OK : no("Sales is for the executives and leaders.");
  if (under("/team/handoffs")) return mayTransferAny(me) ? OK : no("Handoffs are for the executives and the line heads.");
  if (/^\/team\/[0-9a-f-]{36}$/i.test(p)) return me.isExec ? OK : no("Someone's activity page is for the executives.");
  if (under("/board/email") && !seesEmailBoard(me)) return no("The Email Board is for the email team and the executives.");
  if ((under("/kpis/audit") || under("/kpis/sprint")) && isChannelOnly(me.role)) return no("Ad account audits and sprints are for the ads team.");
  if ((under("/kpis/audit") || under("/kpis/sprint") || under("/watch") || under("/fatigue")) && !seesAccountNumbers(me)) return no("Account numbers aren't part of your view.");
  if (under("/settings")) {
    const tab = q.get("tab") ?? "";
    if (SETTINGS_EXEC.has(tab) && !me.isExec) return no("That part of Settings is for the executives.");
    if (SETTINGS_LEAD.has(tab) && !me.isExec && !me.isLead) return no("That part of Settings is for the executives and leaders.");
    if (tab === "calls" && (!me.canViewAs || me.viewAs)) return no("Calls & usage is for the owner only.");
  }
  return OK;
}
