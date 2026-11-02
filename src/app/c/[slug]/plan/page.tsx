import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth";
import type { Deck, Reactions } from "@/lib/presentation-types";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { PlanView } from "./plan-view";

export const metadata: Metadata = { title: "How we see you · Kaizen", robots: { index: false, follow: false } };

// "Here's how we see you: are we getting this right?" The client's first look at the work, opened from the email or
// Slack message. A team member can open it too (to test), with a banner saying so.
export default async function PlanPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const viewer = await getViewer();
  const team = viewer.kind === "staff";
  if (!team && (!viewer.brands.some((b) => b.slug === slug) || !adminConfigured())) notFound();
  const db = team ? await createClient() : createAdminClient();
  const { data: client } = await db.from("clients").select("id, name, slug, portal_live").eq("slug", slug).maybeSingle();
  if (!client || (!team && !client.portal_live)) notFound();
  const { data: p } = await db.from("client_presentations").select("status, deck, reactions, viewed_at").eq("client_id", client.id).maybeSingle();
  const ready = p?.deck && (team || ["sent", "approved"].includes(p.status as string));
  // The first time the client opens it
  if (!team && ready && !p.viewed_at) await createAdminClient().from("client_presentations").update({ viewed_at: new Date().toISOString() }).eq("client_id", client.id);

  return (
    <div className="min-h-screen bg-bg">
      <header className="pt-safe sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-2.5">
          <Link href={team ? `/clients/${client.slug}/brand-bible/presentation` : `/c/${client.slug}`} className="inline-flex min-h-11 items-center gap-1.5 text-[13px] text-muted hover:text-fg">
            <span aria-hidden>←</span> {team ? "Back to the team view" : client.name}
          </Link>
          <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] text-muted">Kaizen</span>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 pb-24 pt-5 md:pt-8">
        {team && <p className="mb-4 rounded-[14px] border border-warn/40 bg-warn-soft/40 px-4 py-3 text-[13px] text-warn">You&rsquo;re seeing what the client sees. Anything you tap here is saved as the team testing.</p>}
        {ready ? (
          <PlanView slug={client.slug} brand={client.name} deck={p.deck as Deck} reactions={(p.reactions ?? {}) as Reactions} approved={p.status === "approved"} canAct={team ? ["sent", "approved"].includes(p.status as string) : true} />
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
