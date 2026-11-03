import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth";
import { accessSetting, guideHas, industryExamples, loadGuide, styleExamples } from "@/lib/onboarding-guide";
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
  const { data: client } = await admin.from("clients").select("id, name, slug, kaizen_id, portal_live, services, services_extra, services_removed").eq("slug", slug).maybeSingle();
  if (!client || (!team && !client.portal_live)) notFound();
  if (team) {
    // The team's own access rules decide whether they may open it
    const { createClient } = await import("@/lib/supabase/server");
    const { data: mine } = await (await createClient()).from("clients").select("id").eq("id", client.id).maybeSingle();
    if (!mine) notFound();
  }
  const { loadHelp } = await import("@/lib/setup-help");
  const [guide, access, examples, { data: deck }, help, { count: intakes }, looks, has] = await Promise.all([
    loadGuide(admin, client.id),
    accessSetting(admin),
    industryExamples(admin, client.id).catch(() => []),
    admin.from("client_presentations").select("status").eq("client_id", client.id).maybeSingle(),
    loadHelp(admin, client.id),
    admin.from("client_intakes").select("id", { count: "exact", head: true }).eq("client_id", client.id),
    styleExamples(admin, client.id).catch(() => ({})),
    guideHas(admin, client.id),
  ]);
  const { managerId } = await import("@/lib/context/google-ads");
  const firstName = viewer.kind === "contact" ? (viewer.fullName?.split(" ")[0] ?? null) : null;

  return (
    <div>
      <main>
        <StartView
          slug={client.slug}
          brand={client.name}
          firstName={firstName}
          guide={guide}
          has={has}
          bmId={access.bmId}
          adminEmails={access.adminEmails}
          techEmail={access.techEmail}
          klaviyoEmail={access.klaviyoEmail}
          managerId={managerId() || null}
          examples={examples}
          looks={looks}
          help={help}
          intake={{ done: (intakes ?? 0) > 0, clientId: (client.kaizen_id as number | null) ?? null }}
          presentation={deck && ["sent", "approved"].includes(deck.status as string) ? (deck.status as string) : null}
        />
      </main>
    </div>
  );
}
