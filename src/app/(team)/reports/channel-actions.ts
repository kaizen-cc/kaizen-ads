"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canAccessReport } from "@/lib/reports/access";
import { normalizeDelivery, type Delivery } from "@/lib/reports/delivery-core";
import type { ChatTurn, Qa, Sections } from "@/lib/reports/write";
import type { RefreshNote } from "@/lib/reports/refresh-core";
import { isChannelPlatform, lastMonthOf, channelPeriods, type ChannelKind, type ChannelLine } from "@/lib/channel-reports/core";
import { linesFor } from "@/lib/channel-reports/access-core";
import { channelClients, ownersFor } from "@/lib/channel-reports/clients";

// The email and organic social report studio's actions: the same things the ads studio does (revise with the AI, check,
// bring the text up to the numbers, send), written for a report with no ad account. Every action re-checks that this person
// may open the report (its client and its line) before touching anything. Saving, regenerating, skipping and the history
// use the ads actions, which already follow the same rule.

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function mine(id: string) {
  const me = await requireStaff();
  const admin = createAdminClient();
  const { data: r } = await admin.from("reports").select("id, owner_id, status, kind, client_id, platform").eq("id", id).maybeSingle();
  if (!r || !isChannelPlatform(r.platform)) return null;
  if (!(await canAccessReport(await createClient(), me, r))) return null;
  return { me, r, admin };
}
const done = (id: string) => {
  revalidatePath(`/reports/${id}`);
  revalidatePath("/reports");
};

export async function reviseChannel(id: string, ask: string): Promise<Result<{ chat: ChatTurn[]; message: string; sections: Sections; qa: Qa | null; lesson: string | null }>> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  if (!ask.trim()) return { ok: false, error: "Say what to change." };
  if (ok.r.status === "posted") return { ok: false, error: "It's already gone out." };
  try {
    const { reviseChannelReport } = await import("@/lib/channel-reports/write");
    const out = await reviseChannelReport(ok.admin, id, ask, ok.me.fullName, { byId: ok.me.id });
    done(id);
    return { ok: true, ...out };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't change it just now." };
  }
}

export async function checkChannel(id: string): Promise<Result<{ qa: Qa }>> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  try {
    const { qaChannelReport } = await import("@/lib/channel-reports/write");
    const qa = await qaChannelReport(ok.admin, id);
    done(id);
    return { ok: true, qa };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't check it just now." };
  }
}

/** The numbers were refreshed and the text may still show the old figures: brought up to date now, changing only the figures */
export async function updateChannelTextNow(id: string): Promise<Result<{ message: string; sections: Sections; qa: Qa | null; note: RefreshNote | null }>> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  if (ok.r.status !== "draft" && ok.r.status !== "submitted") return { ok: false, error: "It's already gone out, or being written." };
  const { updateChannelText } = await import("@/lib/channel-reports/refresh");
  const note = await updateChannelText(ok.admin, id, { id: ok.me.id, name: ok.me.fullName });
  const { data: now } = await ok.admin.from("reports").select("message, sections, qa").eq("id", id).single();
  done(id);
  if (note?.text === "needs_look") return { ok: false, error: "The text couldn't be updated just now. Ask the AI in the chat to update the figures, or edit them by hand." };
  return { ok: true, note, message: (now?.message as string | null) ?? "", sections: now?.sections as Sections, qa: (now?.qa as Qa | null) ?? null };
}

export async function keepChannelTextAsIs(id: string): Promise<Result> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  if (ok.r.status !== "draft" && ok.r.status !== "submitted") return { ok: false, error: "It's already gone out, or being written." };
  await (await import("@/lib/channel-reports/refresh")).keepChannelText(ok.admin, id);
  done(id);
  return { ok: true };
}

/** The owner edited the report by hand: the Slack message brought up to date with it */
export async function refreshChannelMessageNow(id: string): Promise<Result<{ message: string; basis: string }>> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  if (ok.r.status === "posted") return { ok: false, error: "It's already gone out." };
  try {
    const out = await (await import("@/lib/channel-reports/write")).refreshChannelMessage(ok.admin, id);
    done(id);
    return { ok: true, ...out };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't update the message just now." };
  }
}

/** Sends it where the owner picked: Slack as them, email to the people chosen (the PDF attached), or both; the choice is remembered for this client */
export async function sendChannel(id: string, delivery: Delivery, note?: string): Promise<Result<{ note: string; needsConnect?: boolean }>> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  if (ok.r.status === "posted") return { ok: false, error: "It's already gone out. Resend it from the history." };
  if (ok.r.status === "skipped") return { ok: false, error: "It's skipped. Bring it back first." };
  if (ok.r.status !== "draft" && ok.r.status !== "submitted") return { ok: false, error: "It's still being written." };
  const d = normalizeDelivery(delivery);
  if (d.channels.includes("email") && !d.recipients.length) return { ok: false, error: "Add at least one email address to send it to." };
  try {
    const { sendChannelReport } = await import("@/lib/channel-reports/send");
    const out = await sendChannelReport(ok.admin, id, { id: ok.me.id, fullName: ok.me.fullName, email: ok.me.email }, d, note?.slice(0, 600) ?? null);
    if (!out.ok) return { ok: false, error: out.error ?? "It didn't go out.", ...(out.needsConnect ? { needsConnect: true } : {}) } as { ok: false; error: string };
    const { rememberDelivery, sentNote } = await import("@/lib/reports/send");
    await rememberDelivery(ok.admin, ok.r.client_id as string, d, ok.me.id).catch(() => null);
    done(id);
    return { ok: true, note: sentNote(out, "the client") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't send it." };
  }
}

// ─── The Reports page ──────────────────────────────────────────────────────

/** Turns the optional Monday weekly on or off for one client's line (the monthly is always drafted) */
export async function setChannelWeekly(clientId: string, line: ChannelLine, on: boolean): Promise<Result> {
  const me = await requireStaff();
  if (line !== "email" && line !== "social") return { ok: false, error: "Not found." };
  const admin = createAdminClient();
  if (!(await channelClients(admin, me, line)).some((c) => c.id === clientId)) return { ok: false, error: "Not found." };
  const { data } = await admin.from("client_report_prefs").select("channel_weekly").eq("client_id", clientId).maybeSingle();
  const had = ((data as { channel_weekly?: string[] | null } | null)?.channel_weekly ?? []) as string[];
  const next = on ? [...new Set([...had, line])] : had.filter((x) => x !== line);
  const { error } = data ? await admin.from("client_report_prefs").update({ channel_weekly: next }).eq("client_id", clientId) : await admin.from("client_report_prefs").insert({ client_id: clientId, notes: [], channel_weekly: next });
  if (error) return { ok: false, error: /channel_weekly/.test(error.message) ? "The channel reports migration hasn't been applied yet." : error.message };
  revalidatePath("/reports");
  return { ok: true };
}

/** Drafts a report now for a client: the month just over, or the week just over (an existing one is opened instead) */
export async function draftChannelAction(clientId: string, line: ChannelLine, kind: ChannelKind): Promise<Result<{ id: string; existing: boolean }>> {
  const me = await requireStaff();
  if (!linesFor(me).includes(line) || (kind !== "monthly" && kind !== "weekly")) return { ok: false, error: "Not found." };
  const admin = createAdminClient();
  if (!(await channelClients(admin, me, line)).some((c) => c.id === clientId)) return { ok: false, error: "Not found." };
  const { coverageFor } = await import("@/lib/channel-reports/clients");
  const cover = (await coverageFor(admin, line, [clientId])).get(clientId);
  if (cover?.state !== "connected") return { ok: false, error: cover?.what ?? "It isn't connected yet." };
  const { draftChannelNow, draftChannelQueued } = await import("@/lib/channel-reports/queue");
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const period = kind === "monthly" ? lastMonthOf(today) : channelPeriods("weekly", today).main;
  const owners = await ownersFor(admin, line, [clientId]);
  const out = await draftChannelNow(admin, { clientId, line, kind, period, ownerId: owners.get(clientId) ?? me.id });
  if (!out.ok) return out;
  if (!out.existing) after(() => draftChannelQueued(admin, 200_000));
  revalidatePath("/reports");
  return { ok: true, id: out.id, existing: out.existing };
}
