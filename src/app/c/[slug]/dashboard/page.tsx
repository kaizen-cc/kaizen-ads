import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { DashboardView } from "./dashboard-view";
import { ShotsBanner } from "../shots/shots-banner";

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
  const { currentShotList } = await import("@/lib/shot-list");
  const shots = await currentShotList(admin, client.id).catch(() => null);
  const { data: asked } = await admin
    .from("dashboard_questions")
    .select("id, question, answer, flagged, created_at")
    .eq("client_id", client.id)
    .order("created_at", { ascending: false })
    .limit(12);
  // What their own store or CRM recorded, when it's connected
  const s = await (await import("@/lib/integrations")).businessSummary(admin, client.id).catch(() => null);
  const business = s ? { store: s.store, crm: s.crm, month: { newCustomers: s.month.newCustomers, subscriptions: s.month.subscriptions, revenue: s.month.revenue, leads: s.month.leads, booked: s.month.booked, won: s.month.won }, last30: { newCustomers: s.last30.newCustomers, leads: s.last30.leads, fromMeta: s.last30.fromMeta, fromGoogle: s.last30.fromGoogle }, prior30: { newCustomers: s.prior30.newCustomers, leads: s.prior30.leads } } : null;
  return (
    <div>
      <main className="grid gap-4">
        {shots && <ShotsBanner slim slug={client.slug} month={shots.list.month} open={shots.list.shots.filter((x) => !x.delivered).length} total={shots.list.shots.length} />}
        <DashboardView business={business} slug={client.slug} brand={client.name} asked={(asked ?? []).reverse() as { id: string; question: string; answer: string; flagged: boolean; created_at: string }[]} />
      </main>
    </div>
  );
}
