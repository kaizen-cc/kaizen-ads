import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { sendEmail } from "@/lib/email";
import { accessSetting, guideHas, loadGuide } from "@/lib/onboarding-guide";
import { STEP_LABELS, accessLeft, callType, googleTools } from "@/lib/onboarding-guide-types";
import type { HelpStep } from "@/lib/setup-help";
import { siteUrl } from "@/lib/site";

// Getting ready for a new client's onboarding call: when their setup hits something big (a restricted ad account,
// no permission to give access, can't make a Business Manager, a verification wall) or they save a step for the call,
// the CS team gets a recap of where things stand and what to prepare, on the client page and by email.

export type Blocker = { step: HelpStep; kind: string; detail: string; at: string };
export type CallPrep = { recap: string[]; prepare: string[]; at: string; reason: string };

export const BLOCKER_NAMES: Record<string, string> = {
  restricted: "Ad account restricted or disabled",
  no_permission: "Doesn't have the permissions to give access",
  cant_create: "Can't create a Business Manager or ad account",
  verification: "Stuck on a verification or security check",
  billing: "Billing or payment problem",
  other: "Something only our team can sort out",
};

const SCHEMA = {
  type: "object",
  properties: { recap: { type: "array", items: { type: "string" } }, prepare: { type: "array", items: { type: "string" } } },
  required: ["recap", "prepare"],
  additionalProperties: false,
};

/** The recap for the call, written fresh from everything so far, kept on the client and sent to the CS team */
export async function prepareCall(admin: SupabaseClient, clientId: string, reason: string) {
  const [{ data: c }, { data: o }, guide, { data: help }, access, has] = await Promise.all([
    admin.from("clients").select("name, slug").eq("id", clientId).single(),
    admin.from("client_onboarding").select("blockers").eq("client_id", clientId).maybeSingle(),
    loadGuide(admin, clientId),
    admin.from("setup_help").select("step, role, text, topic, blocker, blocker_detail, created_at").eq("client_id", clientId).order("created_at").limit(120),
    accessSetting(admin),
    guideHas(admin, clientId),
  ]);
  if (!c) return null;
  const blockers = (o?.blockers ?? []) as Blocker[];
  const left = accessLeft(guide, has, blockers);
  const tools = googleTools(guide, has);
  const out = await askJson<{ recap: string[]; prepare: string[] }>({
    agent: "launcher",
    label: `setup call prep ${c.name}`,
    bare: true,
    override: { model: "sonnet", effort: "low" },
    system: `You brief Kaizen's client success team before a new client's onboarding call. From the client's setup progress and their help conversations, write:
recap: 2 to 6 short bullets on where setup stands and what went wrong, specific (what they tried, the exact error or wall, which account), no fluff.
prepare: 1 to 5 concrete things the team should have ready or do on the call (e.g. "Have them log in as the Business Manager's admin, or ask who is", "Check the ad account's restriction in Account Quality and request a review", "Send the partner request from our side"). Plain words, no names of team members.`,
    schema: SCHEMA,
    maxTokens: 2000,
    prompt: [
      `<client>${c.name}</client>`,
      `<setup_status>\nMeta: ${has.meta ? JSON.stringify(guide.meta) : "not theirs"}\nGoogle Ads: ${has.google ? JSON.stringify(guide.google) : "not theirs"}\n${tools.map((t) => `${STEP_LABELS[t]}: ${JSON.stringify(guide[t])}`).join("\n")}${has.tracking ? `\nWhere their orders, bookings or leads live (for the tracking team): ${JSON.stringify(guide.tracking)}` : ""}${has.website ? `\nWebsite:${JSON.stringify(guide.website)}` : ""}${has.email ? `\nEmail platform: ${JSON.stringify(guide.email)}` : ""}\nHow they sell: ${JSON.stringify(guide.business)}\nAccess still to share: ${left.items.map((k) => STEP_LABELS[k] ?? k).join(", ") || "none"} (call type: ${callType(left) === "dfy" ? "done-for-you, we take over their screen" : "done-with-you, they share their screen"})\nAssets: ${(guide.assets.files ?? 0) + (guide.assets.links ?? 0)} shared\nThe look: ${guide.style.styles?.length || guide.style.pacing ? "picked" : "not yet"}\n</setup_status>`,
      blockers.length ? `<big_issues>\n${blockers.map((b) => `${STEP_LABELS[b.step] ?? b.step}: ${BLOCKER_NAMES[b.kind] ?? b.kind}: ${b.detail}`).join("\n")}\n</big_issues>` : "",
      help?.length ? `<help_conversations>\n${help.map((h) => `[${h.step}] ${h.role === "client" ? "Client" : "Helper"}: ${String(h.text).slice(0, 500)}`).join("\n")}\n</help_conversations>` : "",
      `Why this brief now: ${reason}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  const prep: CallPrep = { recap: out.recap.slice(0, 6), prepare: out.prepare.slice(0, 5), at: new Date().toISOString(), reason };
  await admin.from("client_onboarding").upsert({ client_id: clientId, call_prep: prep, updated_at: prep.at });

  // The CS team (the admins clients invite), the client's buyers and the leads
  const [{ data: cs }, { data: buyers }, { data: leads }] = await Promise.all([
    access.adminEmails.length ? admin.from("profiles").select("id").in("email", access.adminEmails).eq("is_active", true) : Promise.resolve({ data: [] as { id: string }[] }),
    admin.from("client_assignments").select("profile_id").eq("client_id", clientId).in("role", ["meta_buyer", "google_buyer"]),
    admin.from("profiles").select("id").eq("is_active", true).eq("is_lead", true),
  ]);
  const ids = [...new Set([...(cs ?? []).map((x) => x.id as string), ...(buyers ?? []).map((x) => x.profile_id as string), ...(leads ?? []).map((x) => x.id as string)])];
  const body = `${reason}. ${prep.recap.join(" ")} To prepare: ${prep.prepare.join("; ")}`;
  if (ids.length)
    await admin.from("notifications").upsert(
      ids.map((id) => ({ profile_id: id, kind: "onboarding", title: `${c.name}: prepare for the onboarding call`.slice(0, 200), body: body.slice(0, 1000), href: `/clients/${c.slug}`, client_id: clientId, key: `call-prep:${clientId}:${prep.at}`, priority: "critical" })),
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  // And by email to the CS inboxes, so it's in front of them before the call
  const link = `${siteUrl()}/clients/${c.slug}`;
  const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  const text = [`${c.name}: before the onboarding call`, "", `Why now: ${reason}`, "", "Where it stands:", ...prep.recap.map((x) => `• ${x}`), "", "Prepare:", ...prep.prepare.map((x) => `• ${x}`), "", link].join("\n");
  const html = `<div style="font:14px/1.55 Helvetica,Arial,sans-serif;color:#222;max-width:560px"><p style="font-weight:700;font-size:17px;margin:0 0 6px">${esc(c.name)}: before the onboarding call</p><p style="color:#666;margin:0 0 14px">Why now: ${esc(reason)}</p><p style="font-weight:600;margin:0 0 4px">Where it stands</p><ul style="margin:0 0 14px;padding-left:18px">${prep.recap.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><p style="font-weight:600;margin:0 0 4px">Prepare</p><ul style="margin:0 0 16px;padding-left:18px">${prep.prepare.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><a href="${link}" style="color:#b21e2c">Open ${esc(c.name)} in Kaizen Ads →</a></div>`;
  for (const to of access.adminEmails) await sendEmail({ to, subject: `${c.name}: prepare for the onboarding call`, text, html }).catch(() => null);
  return prep;
}

/** A big issue found in the help chat: kept once per kind and step, and the call brief written and sent */
export async function recordBlocker(admin: SupabaseClient, clientId: string, b: Omit<Blocker, "at">) {
  const { data: o } = await admin.from("client_onboarding").select("blockers").eq("client_id", clientId).maybeSingle();
  const list = (o?.blockers ?? []) as Blocker[];
  if (list.some((x) => x.step === b.step && x.kind === b.kind)) return false;
  await admin.from("client_onboarding").upsert({ client_id: clientId, blockers: [...list, { ...b, at: new Date().toISOString() }], updated_at: new Date().toISOString() });
  await prepareCall(admin, clientId, `${BLOCKER_NAMES[b.kind] ?? "A big issue"} (${STEP_LABELS[b.step] ?? b.step}): ${b.detail}`);
  return true;
}
