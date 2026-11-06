"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireStaff } from "@/lib/auth";
import { canOn } from "@/lib/chat-permissions-server";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The buyer's side of a new client's 48-hour launch: confirm the posts for the client, change the budget before it's
// built, find the posts again, and turn the built campaign on.

type Result = { ok: true } | { ok: false; error: string };

async function allowed(clientId: string) {
  const me = await requireStaff();
  if (!adminConfigured()) return { error: "Server key missing." } as const;
  const { data: mine } = await (await createClient()).from("clients").select("id, slug").eq("id", clientId).maybeSingle();
  if (!mine) return { error: "You don't work on this client." } as const;
  const admin = createAdminClient();
  // A Meta launch: the client's Meta buyer, the Head of Meta and the executives (src/lib/chat-permissions.ts)
  const ok = await canOn(admin, me, "ads.launch", { platform: "meta", clientId });
  if (!ok.ok) return { error: ok.reason } as const;
  return { me, admin, slug: mine.slug as string } as const;
}
const refresh = (slug: string) => {
  revalidatePath(`/clients/${slug}/launch`);
  revalidatePath(`/c/${slug}/plan`);
};

/** The client hasn't picked (or told the team on a call): the buyer confirms these posts and it's built */
export async function confirmForClient(clientId: string, chosen: string[]): Promise<Result> {
  const a = await allowed(clientId);
  if ("error" in a) return { ok: false, error: a.error! };
  const { data: l } = await a.admin.from("engagement_launches").select("status, posts").eq("client_id", clientId).maybeSingle();
  if (!l || !["proposed", "failed"].includes(l.status as string)) return { ok: false, error: "There's nothing to confirm." };
  const ids = new Set(((l.posts ?? []) as { id: string }[]).map((p) => p.id));
  const keep = chosen.filter((x) => ids.has(x));
  if (!keep.length) return { ok: false, error: "Keep at least one post." };
  await a.admin.from("engagement_launches").update({ status: "confirmed", chosen: keep, confirmed_at: new Date().toISOString(), confirmed_by: `${a.me.fullName} (team)`, updated_at: new Date().toISOString() }).eq("client_id", clientId);
  const admin = a.admin;
  after(async () => {
    const { buildEngagement } = await import("@/lib/engagement-launch");
    await buildEngagement(admin, clientId);
    refresh(a.slug);
  });
  refresh(a.slug);
  return { ok: true };
}

/** The daily budget, before it's built (after, change it in Ads Manager) */
export async function setLaunchBudget(clientId: string, daily: number): Promise<Result> {
  const a = await allowed(clientId);
  if ("error" in a) return { ok: false, error: a.error! };
  if (!(daily >= 5 && daily <= 2000)) return { ok: false, error: "Between $5 and $2,000 a day." };
  const { data: l } = await a.admin.from("engagement_launches").select("status, plan").eq("client_id", clientId).maybeSingle();
  if (!l?.plan || !["proposed", "failed", "none"].includes(l.status as string)) return { ok: false, error: "It's already built: change the budget in Ads Manager." };
  await a.admin.from("engagement_launches").update({ plan: { ...(l.plan as object), dailyBudget: Math.round(daily) } }).eq("client_id", clientId);
  refresh(a.slug);
  return { ok: true };
}

export async function findPostsAgain(clientId: string): Promise<Result> {
  const a = await allowed(clientId);
  if ("error" in a) return { ok: false, error: a.error! };
  const { data: l } = await a.admin.from("engagement_launches").select("status").eq("client_id", clientId).maybeSingle();
  if (l && ["building", "built", "live"].includes(l.status as string)) return { ok: false, error: "It's already built." };
  await a.admin.from("engagement_launches").upsert({ client_id: clientId, status: "finding", updated_at: new Date().toISOString() });
  const admin = a.admin;
  after(async () => {
    const { proposeEngagement } = await import("@/lib/engagement-launch");
    await proposeEngagement(admin, clientId);
    refresh(a.slug);
  });
  refresh(a.slug);
  return { ok: true };
}

/** The buyer turns it on (the one step a person takes): live, and the client hears it */
export async function turnOnLaunch(clientId: string): Promise<Result> {
  const a = await allowed(clientId);
  if ("error" in a) return { ok: false, error: a.error! };
  try {
    const { turnOnEngagement } = await import("@/lib/engagement-launch");
    const r = await turnOnEngagement(a.admin, clientId, a.me.id);
    refresh(a.slug);
    return r;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Meta didn't take it. Try again." };
  }
}
