import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth";
import { currentShotList } from "@/lib/shot-list";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { ShotsView } from "./shots-view";

export const metadata: Metadata = { title: "Your shot list · Kaizen", robots: { index: false, follow: false } };
export const maxDuration = 300;

// The client's shot list for their next cycle: each shot with what it's for and a reference from what's working in
// their market, and an upload right on it. What they send lands in their Drive folder and is marked off.
export default async function ShotsPage({ params }: { params: Promise<{ slug: string }> }) {
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
  const current = await currentShotList(admin, client.id);
  if (!current) notFound();
  return <ShotsView slug={client.slug} brand={client.name} listId={current.id} list={current.list} />;
}
