import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth";
import { accessSetting, industryExamples, loadGuide } from "@/lib/onboarding-guide";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { StartView } from "./start-view";

export const metadata: Metadata = { title: "Get set up · Kaizen", robots: { index: false, follow: false } };
// "I've done it" checks Meta and Google right away; sharing assets uploads and reads them
export const maxDuration = 300;

// A new client's onboarding guide: Meta access, their Google Ads ID, their assets and the look they want, each a few
// minutes and walked through visually. Opened from the welcome email and Slack message; the team can open it to test.
export default async function StartPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const viewer = await getViewer();
  const team = viewer.kind === "staff";
  if (!adminConfigured() || (!team && !viewer.brands.some((b) => b.slug === slug))) notFound();
  const admin = createAdminClient();
  const { data: client } = await admin.from("clients").select("id, name, slug, portal_live, services").eq("slug", slug).maybeSingle();
  if (!client || (!team && !client.portal_live)) notFound();
  if (team) {
    // The team's own access rules decide whether they may open it
    const { createClient } = await import("@/lib/supabase/server");
    const { data: mine } = await (await createClient()).from("clients").select("id").eq("id", client.id).maybeSingle();
    if (!mine) notFound();
  }
  const [guide, access, examples, { data: deck }] = await Promise.all([
    loadGuide(admin, client.id),
    accessSetting(admin),
    industryExamples(admin, client.id).catch(() => []),
    admin.from("client_presentations").select("status").eq("client_id", client.id).maybeSingle(),
  ]);
  const { managerId } = await import("@/lib/context/google-ads");
  const firstName = viewer.kind === "contact" ? (viewer.fullName?.split(" ")[0] ?? null) : null;

  return (
    <div className="min-h-screen bg-bg">
      <header className="pt-safe sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-2.5">
          <Link href={team ? `/clients/${client.slug}` : `/c/${client.slug}`} className="inline-flex min-h-11 items-center gap-1.5 text-[13px] text-muted hover:text-fg">
            <span aria-hidden>←</span> {team ? "Back to the client" : client.name}
          </Link>
          <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] text-muted">Kaizen</span>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 pb-24 pt-5 md:pt-8">
        {team && <p className="mb-4 rounded-[14px] border border-warn/40 bg-warn-soft/40 px-4 py-3 text-[13px] text-warn">You&rsquo;re seeing what the client sees. Anything you do here is saved as the team testing.</p>}
        <StartView
          slug={client.slug}
          brand={client.name}
          firstName={firstName}
          guide={guide}
          google={((client.services ?? []) as string[]).includes("google-ads")}
          bmId={access.bmId}
          adminEmails={access.adminEmails}
          managerId={managerId() || null}
          examples={examples}
          presentation={deck && ["sent", "approved"].includes(deck.status as string) ? (deck.status as string) : null}
        />
      </main>
    </div>
  );
}
