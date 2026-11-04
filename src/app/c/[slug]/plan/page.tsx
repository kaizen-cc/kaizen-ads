import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth";
import type { PlanTurn } from "@/lib/plan-chat-types";
import type { Deck, Reactions } from "@/lib/presentation-types";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { FirstAds, FirstAdsPost } from "./first-ads";
import { PlanView } from "./plan-view";

// A conversation answer reads files and voice messages; approving folds it all into the Bible and writes the first round
export const maxDuration = 800;

export const metadata: Metadata = { title: "How we see you · Kaizen", robots: { index: false, follow: false } };

// "Here's how we see you: are we getting this right?" The client's first look at the work, opened from the email or
// Slack message. A team member can open it too (to test), with a banner saying so.
export default async function PlanPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const viewer = await getViewer();
  const team = viewer.kind === "staff";
  if (!team && (!viewer.brands.some((b) => b.slug === slug) || !adminConfigured())) notFound();
  const db = team ? await createClient() : createAdminClient();
  const { data: client } = await db.from("clients").select("id, name, slug, portal_live, kaizen_id").eq("slug", slug).maybeSingle();
  if (!client || (!team && !client.portal_live)) notFound();
  const { data: p } = await db.from("client_presentations").select("status, deck, reactions, viewed_at, without_intake, chat, sent_at").eq("client_id", client.id).maybeSingle();
  // Their first ads (the 48-hour launch), once they've approved
  const { data: launch } = p?.status === "approved" ? await (team ? db : createAdminClient()).from("engagement_launches").select("status, posts, chosen, note, plan").eq("client_id", client.id).maybeSingle() : { data: null };
  const firstAds: FirstAds | null = launch ? { status: launch.status as string, posts: (launch.posts ?? []) as FirstAdsPost[], chosen: (launch.chosen ?? []) as string[], note: launch.note as string | null, geo: (launch.plan as { geo?: { label?: string } } | null)?.geo?.label ?? null } : null;
  // Once their intake form is in, the nudge to send it goes
  const { count: intakes } = p?.without_intake ? await createAdminClient().from("client_intakes").select("id", { count: "exact", head: true }).eq("client_id", client.id) : { count: 0 };
  const ready = p?.deck && (team || ["sent", "approved"].includes(p.status as string));
  // The first time the client opens it
  if (!team && ready && !p.viewed_at) await createAdminClient().from("client_presentations").update({ viewed_at: new Date().toISOString() }).eq("client_id", client.id);

  return (
    <div>
      <main>
        {ready ? (
          <PlanView measure={adminConfigured() ? await (await import("@/lib/success-measure")).measureFor(createAdminClient(), client.id as string).catch(() => null) : null} firstAds={firstAds} chat={(p.chat ?? []) as PlanTurn[]} intake={p.without_intake && !intakes ? { clientId: client.kaizen_id ?? null } : undefined} slug={client.slug} brand={client.name} deck={p.deck as Deck} reactions={(p.reactions ?? {}) as Reactions} approved={p.status === "approved"} approveBy={p.status === "sent" && p.sent_at ? (await import("@/lib/brand-bible")).addBusinessDays(p.sent_at as string, (await import("@/lib/presentation-types")).APPROVE_AFTER_DAYS).toISOString() : null} canAct={team ? ["sent", "approved"].includes(p.status as string) : true} />
        ) : (
          <div className="grid gap-2 rounded-[24px] border border-line bg-surface p-8 text-center">
            <p className="font-heading text-[18px]">Nothing to look at yet</p>
            <p className="text-[14px] text-muted">We&rsquo;ll let you know as soon as it&rsquo;s ready.</p>
          </div>
        )}
      </main>
    </div>
  );
}
