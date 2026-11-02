import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import type { Check, EngagementPlan, Post } from "@/lib/engagement-launch";
import { createClient } from "@/lib/supabase/server";
import { LaunchView } from "./launch-view";

// A new client's 48-hour launch, the buyer's side: the posts picked from their own Facebook and Instagram (and why),
// whether the client confirmed them, the paused campaign once it's built with the launch checklist checked, and the
// button that turns it on (and tells the client).

export const maxDuration = 300;

export default async function LaunchPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireStaff();
  const { slug } = await params;
  const supabase = await createClient();
  const { data: client } = await supabase.from("clients").select("id, name, slug").eq("slug", slug).maybeSingle();
  if (!client) notFound();
  const { data: l } = await supabase.from("engagement_launches").select("status, account, posts, chosen, plan, checklist, campaign_id, ad_ids, note, error, confirmed_by, built_at, live_at").eq("client_id", client.id).maybeSingle();
  return (
    <LaunchView
      client={{ id: client.id, name: client.name, slug: client.slug }}
      l={
        l
          ? {
              status: l.status as string,
              account: (l.account as string | null) ?? null,
              posts: (l.posts ?? []) as Post[],
              chosen: (l.chosen ?? []) as string[],
              plan: (l.plan ?? null) as EngagementPlan | null,
              checklist: (l.checklist ?? []) as Check[],
              campaignId: (l.campaign_id as string | null) ?? null,
              ads: ((l.ad_ids ?? []) as string[]).length,
              note: l.note as string | null,
              error: l.error as string | null,
              confirmedBy: l.confirmed_by as string | null,
              liveAt: l.live_at as string | null,
            }
          : null
      }
    />
  );
}
