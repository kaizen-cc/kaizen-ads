import Link from "next/link";
import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth";
import { loadPortal } from "@/lib/portal";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Portal } from "./portal";
import { ShotsBanner } from "./shots/shots-banner";

// A client's portal home: a greeting, what's waiting on them (their ads to review, front and centre), and beside it how
// their ads are doing, their latest recap, their setup while onboarding and their brand plan when it's ready.
export default async function ClientHome({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const viewer = await getViewer();
  if (viewer.kind === "contact" && (!viewer.brands.some((b) => b.slug === slug) || !adminConfigured())) notFound();
  // Contacts read through the server (only live brands reach here); the team through its own access rules
  const db = viewer.kind === "contact" ? createAdminClient() : await createClient();
  const { data: client } = await db.from("clients").select("id, name, slug, portal_live, status, services, services_extra, services_removed").eq("slug", slug).maybeSingle();
  if (!client || (viewer.kind === "contact" && !client.portal_live)) notFound();
  const admin = createAdminClient();

  const { currentShotList } = await import("@/lib/shot-list");
  const [data, { data: snaps }, { data: recap }, { data: deck }, shots] = await Promise.all([
    loadPortal(db, client.id),
    admin.from("kpi_snapshots").select("windows, kpi_targets!inner(platform, conversion, active)").eq("client_id", client.id).eq("kpi_targets.active", true),
    admin.from("report_bundles").select("token, kind, period_start, sent_at").eq("client_id", client.id).eq("status", "sent").order("sent_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("client_presentations").select("status").eq("client_id", client.id).maybeSingle(),
    currentShotList(admin, client.id).catch(() => null),
  ]);
  let setup: { done: number; total: number } | null = null;
  if (client.status === "onboarding") {
    const [{ guideHas, loadGuide }, { guideProgress }] = await Promise.all([import("@/lib/onboarding-guide"), import("@/lib/onboarding-guide-types")]);
    const [g, has] = await Promise.all([loadGuide(admin, client.id), guideHas(admin, client.id)]);
    const p = guideProgress(g, has);
    if (p.done < p.total) setup = p;
  }
  // The last 30 days across their accounts, from the KPI board's own numbers
  const d30 = (snaps ?? []).map((s) => ((s.windows ?? {}) as Record<string, { spend?: number; results?: number }>).d30 ?? {});
  const spend = d30.reduce((n, w) => n + (Number(w.spend) || 0), 0);
  const results = d30.reduce((n, w) => n + (Number(w.results) || 0), 0);
  const firstName = viewer.kind === "contact" ? (viewer.fullName?.split(" ")[0] ?? null) : null;
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date()));
  const hello = `${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}${firstName ? `, ${firstName}` : ""}`;
  const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : 2 })}`;

  const aside = (
    <>
      {shots && <ShotsBanner slug={client.slug} month={shots.list.month} open={shots.list.shots.filter((x) => !x.delivered).length} total={shots.list.shots.length} />}
      {setup && (
        <Link href={`/c/${client.slug}/start`} className="group grid gap-3 rounded-[24px] border border-brand/40 bg-brand/[0.07] p-5 transition-colors hover:border-brand">
          <div className="flex items-center gap-3">
            <span className="tabular grid h-12 w-12 shrink-0 place-items-center rounded-full bg-brand font-heading text-[14px] text-white">
              {setup.done}/{setup.total}
            </span>
            <span className="min-w-0">
              <span className="block font-heading text-[16px]">Finish getting set up</span>
              <span className="block text-[12.5px] text-muted">A few quick steps so we can start building</span>
            </span>
          </div>
          <span className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <span className="block h-full rounded-full bg-brand" style={{ width: `${(setup.done / setup.total) * 100}%` }} />
          </span>
        </Link>
      )}
      {deck && ["sent", "approved"].includes(deck.status as string) && (
        <Link href={`/c/${client.slug}/plan`} className="grid gap-1 rounded-[24px] border border-line bg-surface p-5 transition-colors hover:border-faint">
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Your brand plan</span>
          <span className="font-heading text-[17px]">{deck.status === "approved" ? "Approved: here's how we see you" : "Ready for you: are we getting it right?"}</span>
          <span className="text-[13px] text-brand-text">Open →</span>
        </Link>
      )}
      <Link href={`/c/${client.slug}/dashboard`} className="relative isolate grid gap-1 overflow-hidden rounded-[24px] border border-line bg-deep p-5 transition-colors hover:border-faint">
        <span aria-hidden className="pointer-events-none absolute -right-16 -top-20 -z-10 h-56 w-56 rounded-full bg-brand/25 blur-[80px]" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Last 30 days</span>
        {spend > 0 ? (
          <>
            <span className="tabular font-heading text-[40px] leading-none tracking-tight">{Math.round(results).toLocaleString("en-US")}</span>
            <span className="text-[13.5px] text-muted">
              results from {money(spend)}
              {results ? `, ${money(spend / results)} each` : ""}
            </span>
          </>
        ) : (
          <span className="text-[14px] text-muted">Your results show here as soon as your ads run.</span>
        )}
        <span className="mt-2 text-[13px] text-brand-text">Open your dashboard →</span>
      </Link>
      {recap && (
        <Link href={`/r/${recap.token}`} className="grid gap-1 rounded-[24px] border border-line bg-surface p-5 transition-colors hover:border-faint">
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Latest recap</span>
          <span className="font-heading text-[16px]">{new Date(`${recap.period_start}T12:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
          <span className="text-[13px] text-brand-text">Read it →</span>
        </Link>
      )}
    </>
  );

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-faint max-lg:hidden">{client.name}</p>
        <h1 className="font-heading text-[30px] leading-tight tracking-tight md:text-[40px]">{hello}</h1>
      </div>
      <Portal slug={client.slug} clientName={client.name} firstName={firstName} data={data} aside={aside} />
    </div>
  );
}
