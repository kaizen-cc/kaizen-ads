"use server";

import { after } from "next/server";
import { requireStaff } from "@/lib/auth";
import { canOn } from "@/lib/chat-permissions-server";
import type { ChatTurn } from "@/lib/handoff";
import type { MoreState } from "@/lib/launch-more";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The end of a launch card, once what the buyer asked for is deployed: "Want me to suggest some more changes while you
// have me here?" (src/lib/launch-more.ts), each suggestion then started right away as a chat change or kept for later.
// Also the warm-up when "Launch with the chat" is opened on a Google KPI card: the account read starts before they type.

export type LaunchMoreView = { clientId: string; status: string; platform: "meta" | "google"; more: MoreState | null };

/** The run, if this person can see its client (RLS decides) */
async function visible(runId: string) {
  const { data } = await (await createClient()).from("launch_runs").select("id, client_id, platform, status").eq("id", runId).maybeSingle();
  return (data as { id: string; client_id: string; platform: "meta" | "google"; status: string } | null) ?? null;
}

export async function loadLaunchMore(runId: string): Promise<LaunchMoreView | null> {
  await requireStaff();
  const r = await visible(runId);
  if (!r) return null;
  const { runBasics } = await import("@/lib/launch-more");
  const b = await runBasics(createAdminClient(), runId);
  return b ? { clientId: r.client_id, status: b.status, platform: b.platform, more: b.more } : null;
}

type Answer = { ok: true; view: LaunchMoreView; chat: ChatTurn[] } | { ok: false; error: string };

/** Yes (suggest, then add them to the sprint or the buyer's tasks) or no thanks; said in the chat too */
export async function answerLaunchMore(runId: string, yes: boolean): Promise<Answer> {
  const me = await requireStaff();
  const r = await visible(runId);
  if (!r) return { ok: false, error: "Not found." };
  if (r.status !== "applied") return { ok: false, error: "Suggestions come once the launch is deployed." };
  const admin = createAdminClient();
  // Suggestions become sprint actions or tasks for this platform's account: only for someone who may change it
  if (yes) {
    const allowed = await canOn(admin, me, "ads.change", { platform: r.platform, clientId: r.client_id });
    if (!allowed.ok) return { ok: false, error: allowed.reason };
  }
  const m = await import("@/lib/launch-more");
  const asked: ChatTurn = { role: "user", text: yes ? "Yes, suggest more changes" : "No thanks", at: new Date().toISOString() };
  if (!yes) {
    await m.declineMore(admin, runId);
    const chat = await m.appendChat(admin, r.client_id, me.id, [asked, { role: "assistant", text: "No problem. The launch is done.", at: new Date().toISOString() }]);
    return { ok: true, view: { clientId: r.client_id, status: r.status, platform: r.platform, more: (await m.runBasics(admin, runId))?.more ?? null }, chat };
  }
  const { more } = await m.suggestMore(admin, runId, me.id);
  const chat = await m.appendChat(admin, r.client_id, me.id, [asked, m.moreTurn(runId, r.platform, more)]);
  return { ok: true, view: { clientId: r.client_id, status: r.status, platform: r.platform, more }, chat };
}

/**
 * One suggestion started now: a chat change (Plan the change) built from it, its plan card in the chat. Planning and
 * applying it check the role and the client's live switch as any chat change does; the sprint action or task stays
 * on the list until it's ticked.
 */
export async function startLaunchMoreItem(runId: string, index: number): Promise<{ ok: true; chat: ChatTurn[]; view: LaunchMoreView } | { ok: false; error: string }> {
  const me = await requireStaff();
  const r = await visible(runId);
  if (!r) return { ok: false, error: "Not found." };
  const admin = createAdminClient();
  // startChatChange checks this too; said here first so nothing is marked started for someone who can't
  const allowed = await canOn(admin, me, "ads.change", { platform: r.platform, clientId: r.client_id });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  const m = await import("@/lib/launch-more");
  const b = await m.runBasics(admin, runId);
  const item = b?.more?.items[index];
  if (!item) return { ok: false, error: "That suggestion isn't there anymore." };
  if (item.started) return { ok: false, error: "It's already started: its plan is in the chat." };
  const { startChatChange, planChatChange } = await import("@/lib/chat-changes");
  const c = await startChatChange(admin, r.client_id, me.id, r.platform, `${item.title}. ${item.detail}`.slice(0, 1500));
  if ("error" in c) return { ok: false, error: c.error };
  after(() => planChatChange(admin, c.id));
  await m.markMoreStarted(admin, runId, index, c.id);
  const at = new Date().toISOString();
  const chat = await m.appendChat(admin, r.client_id, me.id, [
    { role: "user", text: `Do it now: ${item.title}`, at },
    { role: "assistant", text: "Pulling the exact objects from the live account so you can check them before anything changes.", at, plan: { id: c.id } },
  ]);
  return { ok: true, chat, view: { clientId: r.client_id, status: r.status, platform: r.platform, more: (await m.runBasics(admin, runId))?.more ?? null } };
}

/** "Launch with the chat" opened on a Google KPI card: start reading the account now, so the launch card is quick */
export async function warmLaunchRead(clientId: string, targetId: string | null): Promise<void> {
  const me = await requireStaff();
  const { data: c } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!c) return;
  const admin = createAdminClient();
  // Only warmed for someone who may launch in this client's Google Ads (no read for a launch that won't start)
  if (!(await canOn(admin, me, "ads.launch", { platform: "google", clientId })).ok) return;
  after(async () => {
    const { warmGoogleLaunch } = await import("@/lib/google-launch/runs");
    await warmGoogleLaunch(admin, clientId, typeof targetId === "string" ? targetId : null);
  });
}
