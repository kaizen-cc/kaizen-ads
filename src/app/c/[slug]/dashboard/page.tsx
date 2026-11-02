import type { Metadata } from "next";
import Link from "next/link";
import { PortalNav } from "@/components/portal-nav";
import { portalSections } from "@/lib/portal-sections";
import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { DashboardView } from "./dashboard-view";

export const metadata: Metadata = { title: "Your dashboard · Kaizen", robots: { index: false, follow: false } };
export const maxDuration = 120;

// The client's live dashboard: their ad accounts for any dates, to dig into whenever they want. Their reports link here.
export default async function DashboardPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const viewer = await getViewer();
  const team = viewer.kind === "staff";
  if (!adminConfigured() || (!team && !viewer.brands.some((b) => b.slug === slug))) notFound();
  const admin = createAdminClient();
  const { data: client } = await admin.from("clients").select("id, name, slug, portal_live").eq("slug", slug).maybeSingle();
  if (!client || (!team && !client.portal_live)) notFound();
  if (team) {
    const { createClient } = await import("@/lib/supabase/server");
    const { data: mine } = await (await createClient()).from("clients").select("id").eq("id", client.id).maybeSingle();
    if (!mine) notFound();
  }
  const { data: asked } = await admin
    .from("dashboard_questions")
    .select("id, question, answer, flagged, created_at")
    .eq("client_id", client.id)
    .order("created_at", { ascending: false })
    .limit(12);
  const nav = adminConfigured() ? await portalSections(createAdminClient(), client.id) : { setup: false, plan: false };
  return (
    <div className="min-h-screen bg-bg">
      <header className="pt-safe sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2.5">
          <Link href={team ? `/clients/${client.slug}` : `/c/${client.slug}`} className="inline-flex min-h-11 items-center gap-1.5 text-[13px] text-muted hover:text-fg">
            <span aria-hidden>←</span> {team ? "Back to the client" : client.name}
          </Link>
          <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] text-muted">Kaizen</span>
        </div>
        <div className="mx-auto max-w-6xl px-4">
          <PortalNav slug={client.slug} {...nav} />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 pb-28 pt-5 md:pt-8">
        {team && <p className="mb-4 rounded-[14px] border border-warn/40 bg-warn-soft/40 px-4 py-3 text-[13px] text-warn">You&rsquo;re seeing the client&rsquo;s dashboard. A question you ask here is saved as the team testing.</p>}
        <DashboardView slug={client.slug} brand={client.name} asked={(asked ?? []).reverse() as { id: string; question: string; answer: string; flagged: boolean; created_at: string }[]} />
      </main>
    </div>
  );
}
