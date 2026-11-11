"use server";

import { revalidatePath } from "next/cache";
import { AiUnavailable, askJson } from "@/lib/ai";
import { requireStaff } from "@/lib/auth";
import type { LaunchPlan, Overrides } from "@/lib/launcher";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { completedSearch, completedSince, type CompletedFilters } from "@/lib/ticket-completion";
import { loadLaunch, replanLaunch, type LaunchView } from "./launch-actions";
import { toTicket, type BoardRow } from "./to-ticket";
import type { Ticket } from "./types";

// The end of a ticket: launching it from the Ads launcher (with the media buyer AI to adjust it), completing it by
// hand, and the "Completed tasks" log on the Board.

/** The buyer completes the ticket by hand: it moves to Launched (completed), stamped with who and when */
export async function completeTicket(requestId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  const supabase = await createClient();
  const { data: r } = await supabase.from("requests").select("stage").eq("id", requestId).maybeSingle();
  if (!r) return { ok: false, error: "Ticket not found." };
  if (r.stage !== "launched") {
    const { error } = await supabase.rpc("move_request", { p_request: requestId, p_stage: "launched", p_note: "Completed by hand" });
    if (error) return { ok: false, error: error.message };
  }
  // Who and when (the columns come with 20261111190000_ticket_stage_views.sql; before it, launched reads as completed)
  if (adminConfigured()) await createAdminClient().from("requests").update({ completed_at: new Date().toISOString(), completed_by: me.id }).eq("id", requestId).is("completed_at", null);
  revalidatePath("/board");
  return { ok: true };
}

export type CompletedTicket = Ticket & { completedAt: string };

/** The Completed tasks log: launched tickets, newest first, filtered by search, client, format and date */
export async function completedTickets(f: CompletedFilters): Promise<CompletedTicket[]> {
  await requireStaff();
  const supabase = await createClient();
  let q = supabase.from("board_requests").select("*").eq("stage", "launched");
  const since = completedSince(f.range);
  if (since) q = q.gte("stage_entered_at", since);
  if (f.client) q = q.eq("client_slug", f.client);
  if (f.format) q = q.eq("format", f.format);
  const s = completedSearch(f.q);
  if (s.number) q = q.eq("number", s.number);
  if (s.title) q = q.ilike("title", `%${s.title}%`);
  const { data } = await q.order("stage_entered_at", { ascending: false }).limit(200);
  return ((data ?? []) as BoardRow[]).map((r) => ({ ...toTicket(r), completedAt: r.stage_entered_at }));
}

// ─── The media buyer AI in the Ads launcher ─────────────────────────────────

export type LaunchChatMessage = { role: "user" | "assistant"; text: string; at: string; changes?: string[] };

const str = { type: "string" };
const SCHEMA = {
  type: "object",
  properties: {
    reply: str,
    change: { type: "boolean" },
    adsetId: str,
    mode: { type: "string", enum: ["existing", "clone", ""] },
    newAdsetName: str,
    dailyBudget: { type: "number" },
    link: str,
    adNames: { type: "array", items: { type: "object", properties: { designId: str, name: str }, required: ["designId", "name"], additionalProperties: false } },
  },
  required: ["reply", "change", "adsetId", "mode", "newAdsetName", "dailyBudget", "link", "adNames"],
  additionalProperties: false,
};

const SYSTEM = `You are Kaizen Marketing's AI media buyer, in the Ads launcher with the buyer about to launch a ticket's ads in Meta. They ask you to adjust where the ads go (the campaign and ad set, or a new ad set cloned from one), the daily budget, the landing link or the ad names, or ask a question about the plan.
Answer briefly and plainly, like a colleague: one or two sentences saying what you changed and why. No emojis.
change: true when the plan should change; then fill only what changes: adsetId (one of the ad sets listed, by id; "" to keep), mode ("clone" for a new ad set copied from that one, "existing" to add to it, "" to keep), newAdsetName (for a clone; "" to keep), dailyBudget (dollars; 0 to keep), link ("" to keep), adNames (only the ads to rename, by designId; Kaizen's naming convention for the account, as the current names show).
The copy is what the client approved: you can't change its words here. When they ask to, say it goes back through copy review and offer the closest change you can make (none to the words).
Everything is created paused, per Kaizen's rules; turning it on happens in Ads Manager.`;

/** A message to the media buyer AI: it answers and, when it should, plans the launch again with the change */
export async function launchChat(launchId: string, text: string, history: LaunchChatMessage[] = []): Promise<{ ok: true; messages: LaunchChatMessage[]; launch: LaunchView | null } | { ok: false; error: string }> {
  await requireStaff();
  const t = text.trim().slice(0, 1500);
  if (!t) return { ok: false, error: "Say what to change." };
  const v = await loadLaunch(launchId);
  if (!v) return { ok: false, error: "No launch to adjust yet." };
  if (!v.canLaunch) return { ok: false, error: "Only the client's Meta buyer, the Head of Meta or an exec can change the launch." };
  const p = v.plan as LaunchPlan | null;
  if (!p) return { ok: false, error: "The launch is still being planned." };
  const adsets = [...p.options.adsets, ...(p.options.allAdsets ?? [])].filter((a, i, all) => all.findIndex((x) => x.id === a.id) === i).slice(0, 60);
  try {
    const out = await askJson<{ reply: string; change: boolean; adsetId: string; mode: "existing" | "clone" | ""; newAdsetName: string; dailyBudget: number; link: string; adNames: { designId: string; name: string }[] }>({
      agent: "launcher",
      label: "launch chat",
      system: SYSTEM,
      schema: SCHEMA,
      maxTokens: 4000,
      prompt: `<plan>
Ad set now: ${p.adsetId} (${p.mode === "clone" ? `a new ad set "${p.newAdsetName ?? ""}" cloned from it` : "adding to it"})
Daily budget: ${p.budget?.value ?? p.budget?.current ?? "unchanged"}
Link: ${p.link ?? "none"}
Ads:
${p.ads.map((a) => `- ${a.designId}: ${a.name}`).join("\n")}
Copy (client approved): ${p.copy.titles.join(" | ")}
Why the plan: ${p.reason}
</plan>
<ad_sets>
${adsets.map((a) => `- ${a.id}: ${a.name} · campaign ${a.campaign} · ${a.status} · ${a.objective}${a.daily ? ` · $${a.daily}/day` : ""}`).join("\n")}
</ad_sets>
${history.length ? `<conversation>\n${history.slice(-10).map((m) => `${m.role === "user" ? "Buyer" : "You"}: ${m.text}`).join("\n")}\n</conversation>\n` : ""}
The buyer says: ${t}`,
    });
    const changes: string[] = [];
    if (out.change) {
      const overrides: Overrides = {
        acks: p.acks ?? [],
        adsetId: p.adsetId,
        mode: p.mode,
        newAdsetName: p.newAdsetName ?? undefined,
        pageId: p.pageId ?? undefined,
        igId: p.igId ?? null,
        link: p.link ?? undefined,
        dailyBudget: p.budget?.value ?? null,
        pixelId: p.pixelId ?? undefined,
        event: p.event ?? undefined,
        trackingPixel: p.trackingPixel ?? null,
        urlTags: p.urlTags ?? null,
        leadFormId: p.leadFormId ?? undefined,
        names: Object.fromEntries(p.ads.map((a) => [a.designId, a.name])),
      };
      const set = adsets.find((a) => a.id === out.adsetId);
      const names = overrides.names!;
      const name = out.newAdsetName.trim();
      const link = out.link.trim();
      if (set && set.id !== p.adsetId) {
        overrides.adsetId = set.id;
        changes.push(`Ad set: ${set.name} (${set.campaign})`);
      }
      if (out.mode && out.mode !== p.mode) {
        overrides.mode = out.mode;
        changes.push(out.mode === "clone" ? "A new ad set, cloned" : "Into the existing ad set");
      }
      if (name && name !== p.newAdsetName) {
        overrides.newAdsetName = name;
        changes.push(`New ad set name: ${name}`);
      }
      if (out.dailyBudget > 0 && out.dailyBudget !== p.budget?.value) {
        overrides.dailyBudget = Math.round(out.dailyBudget);
        changes.push(`Daily budget: $${Math.round(out.dailyBudget)}`);
      }
      if (/^https?:\/\/\S+$/i.test(link) && link !== p.link) {
        overrides.link = link;
        changes.push(`Link: ${link}`);
      }
      for (const n of out.adNames) {
        const to = n.name.trim().slice(0, 200);
        if (names[n.designId] === undefined || !to || to === names[n.designId]) continue;
        names[n.designId] = to;
        changes.push(`Ad name: ${to}`);
      }
      if (changes.length) {
        const r = await replanLaunch(launchId, overrides);
        if (!r.ok) return { ok: false, error: r.error };
      }
    }
    const now = new Date().toISOString();
    return {
      ok: true,
      messages: [...history, { role: "user", text: t, at: now }, { role: "assistant", text: out.reply, at: now, ...(changes.length ? { changes } : {}) }],
      launch: await loadLaunch(launchId),
    };
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "The media buyer couldn't answer just now." };
  }
}
