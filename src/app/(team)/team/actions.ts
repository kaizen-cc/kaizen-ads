"use server";

import { revalidatePath } from "next/cache";
import { requireExec } from "@/lib/auth";
import { ROLES, canAlsoDesignEmail, canAlsoSocial, teamsOfferedFor, type Team, type TeamRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email";

export type ActionResult = { ok: true } | { ok: false; error: string };

const isRole = (v: unknown): v is TeamRole => ROLES.some((r) => r.value === v);

/** Execs: change someone's role (which sets their access tier). */
export async function setRole(profileId: string, role: string): Promise<ActionResult> {
  const me = await requireExec();
  if (!isRole(role)) return { ok: false, error: "Pick a role from the list." };
  if (profileId === me.id && role !== "executive") return { ok: false, error: "You can't remove your own executive access." };
  const supabase = await createClient();
  const { error } = await supabase.from("profiles").update({ role }).eq("id", profileId);
  revalidatePath("/team");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Execs: set a per-person switch. also_social: a creative who also works on organic social (offered as a social creative
 * on clients with Social Media). also_designs_email: an email builder who also designs email (offered as an email designer).
 */
export async function setSwitch(profileId: string, which: "also_social" | "also_designs_email", on: boolean): Promise<ActionResult> {
  await requireExec();
  if (which !== "also_social" && which !== "also_designs_email") return { ok: false, error: "Unknown switch." };
  const supabase = await createClient();
  const { data: p } = await supabase.from("profiles").select("role").eq("id", profileId).maybeSingle();
  if (!p) return { ok: false, error: "Not found." };
  if (which === "also_social" && !canAlsoSocial(p.role as string)) return { ok: false, error: "That switch is for the creative team." };
  if (which === "also_designs_email" && !canAlsoDesignEmail(p.role as string)) return { ok: false, error: "That switch is for email builders." };
  const { error } = await supabase.from("profiles").update({ [which]: on }).eq("id", profileId);
  revalidatePath("/team");
  revalidatePath("/clients", "layout");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Execs: the other teams someone works on (badges on the Team page): each opens that team's seats that fit their craft.
 * Only the teams that mean something for their position are taken; the old social switch stays in step.
 */
export async function setTeams(profileId: string, teams: string[]): Promise<ActionResult> {
  await requireExec();
  const supabase = await createClient();
  const { data: p } = await supabase.from("profiles").select("role").eq("id", profileId).maybeSingle();
  if (!p) return { ok: false, error: "Not found." };
  const offered = teamsOfferedFor(p.role as string);
  const next = [...new Set((Array.isArray(teams) ? teams : []).filter((t): t is Team => offered.includes(t as Team)))].sort();
  const { error } = await supabase.from("profiles").update({ teams: next, also_social: next.includes("social") }).eq("id", profileId);
  revalidatePath("/team");
  revalidatePath("/clients", "layout");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Execs: turn someone's access on or off (history stays). */
export async function setActive(profileId: string, active: boolean): Promise<ActionResult> {
  const me = await requireExec();
  if (profileId === me.id && !active) return { ok: false, error: "You can't deactivate yourself." };
  const supabase = await createClient();
  const { error } = await supabase.from("profiles").update({ is_active: active }).eq("id", profileId);
  revalidatePath("/team");
  return error ? { ok: false, error: error.message } : { ok: true };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Execs: email someone on the team their invite (a link to sign in with their Google account). Sent again on demand. */
export async function sendInvite(profileId: string): Promise<ActionResult> {
  const me = await requireExec();
  const supabase = await createClient();
  const { data: p } = await supabase.from("profiles").select("email, full_name, role, is_active, joined_at").eq("id", profileId).maybeSingle();
  if (!p) return { ok: false, error: "Not found." };
  if (p.joined_at) return { ok: false, error: "They've already joined." };
  if (!p.is_active) return { ok: false, error: "Reactivate them first." };
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://ads.kaizenmarketing.agency";
  const link = `${base}/login`;
  const first = p.full_name.split(" ")[0];
  const role = ROLES.find((r) => r.value === p.role)?.label ?? "the team";
  const res = await sendEmail({
    to: p.email,
    subject: `${me.fullName.split(" ")[0]} invited you to Kaizen OS`,
    text: `Hi ${first},\n\n${me.fullName} added you to Kaizen OS as ${role}. Sign in with your Google account (${p.email}):\n${link}\n\nYour work, your clients and your daily recap will be waiting.`,
    html: `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#17131a">
<p style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#c8102e;margin:0 0 16px">Kaizen OS</p>
<h1 style="font-size:24px;line-height:1.25;margin:0 0 12px">You're in, ${esc(first)}.</h1>
<p style="font-size:15px;line-height:1.6;color:#4d464f;margin:0 0 24px">${esc(me.fullName)} added you to Kaizen OS as <b>${esc(role)}</b>. Your work, your clients and your daily recap are waiting.</p>
<a href="${link}" style="display:inline-block;background:#c8102e;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:999px">Sign in with Google</a>
<p style="font-size:12px;color:#8a8189;margin:24px 0 0">Use your ${esc(p.email)} Google account.</p>
</div>`,
  });
  if (!res.ok) return { ok: false, error: res.error };
  await supabase.from("profiles").update({ invited_at: new Date().toISOString() }).eq("id", profileId);
  revalidatePath("/team");
  return { ok: true };
}

/** Execs: invite a teammate. Creating the profile is the invite; they sign in with Google. */
export async function invitePerson(form: FormData): Promise<ActionResult> {
  await requireExec();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const fullName = String(form.get("full_name") ?? "").trim();
  const role = form.get("role");
  if (!fullName) return { ok: false, error: "Add their name." };
  if (!email.endsWith("@kaizenmarketing.agency")) return { ok: false, error: "Use their @kaizenmarketing.agency email." };
  if (!isRole(role)) return { ok: false, error: "Pick a role." };
  const supabase = await createClient();
  const { error } = await supabase.from("profiles").insert({ email, full_name: fullName, role });
  revalidatePath("/team");
  if (error?.code === "23505") return { ok: false, error: `${email} is already on the team.` };
  return error ? { ok: false, error: error.message } : { ok: true };
}
