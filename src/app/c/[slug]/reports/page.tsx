import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

export const metadata: Metadata = { title: "Your reports · Kaizen", robots: { index: false, follow: false } };

// Every report Kaizen has sent the client: monthly recaps and built reports open in full; weekly reports show their
// headline (they went to their Slack channel). Newest first.
export default async function ReportsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const viewer = await getViewer();
  if (!adminConfigured() || (viewer.kind === "contact" && !viewer.brands.some((b) => b.slug === slug))) notFound();
  const admin = createAdminClient();
  const { data: client } = await admin.from("clients").select("id, name, slug, portal_live").eq("slug", slug).maybeSingle();
  if (!client || (viewer.kind === "contact" && !client.portal_live)) notFound();
  const [{ data: bundles }, { data: weekly }] = await Promise.all([
    admin.from("report_bundles").select("id, token, kind, period_start, period_end, sent_at, ranges").eq("client_id", client.id).eq("status", "sent").order("sent_at", { ascending: false }).limit(24),
    admin.from("reports").select("id, platform, period_start, period_end, posted_at, sections").eq("client_id", client.id).eq("kind", "weekly").eq("status", "posted").order("posted_at", { ascending: false }).limit(24),
  ]);
  const { data: heads } = bundles?.length ? await admin.from("reports").select("bundle_id, platform, sections").in("bundle_id", bundles.map((b) => b.id)).in("status", ["submitted", "posted"]) : { data: [] };
  const date = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", o);
  const items = [
    ...(bundles ?? []).map((b) => ({
      key: b.id as string,
      at: (b.sent_at as string) ?? (b.period_end as string),
      kicker: b.kind === "built" ? "Report" : "Monthly recap",
      title: b.kind === "built" ? `${date(b.period_start as string, { month: "short", day: "numeric" })} – ${date(b.period_end as string, { month: "short", day: "numeric", year: "numeric" })}` : date(b.period_start as string, { month: "long", year: "numeric" }),
      lines: (heads ?? []).filter((h) => h.bundle_id === b.id).map((h) => ({ platform: h.platform as string, text: ((h.sections ?? {}) as { headline?: string }).headline ?? "" })),
      href: `/r/${b.token}`,
    })),
    ...(weekly ?? []).map((w) => ({
      key: w.id as string,
      at: (w.posted_at as string) ?? (w.period_end as string),
      kicker: "Weekly report",
      title: `${date(w.period_start as string, { month: "short", day: "numeric" })} – ${date(w.period_end as string, { month: "short", day: "numeric" })}`,
      lines: [{ platform: w.platform as string, text: ((w.sections ?? {}) as { headline?: string }).headline ?? "" }],
      href: null as string | null,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-faint max-lg:hidden">{client.name}</p>
        <h1 className="font-heading text-[30px] leading-tight tracking-tight md:text-[40px]">Your reports</h1>
        <p className="text-[14px] text-muted">
          The story of each week and month: what we did, why, and what&rsquo;s next. For every number, any dates, open{" "}
          <Link href={`/c/${client.slug}/dashboard`} className="text-brand-text hover:underline">
            your dashboard
          </Link>
          .
        </p>
      </div>
      {items.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {items.map((r) => {
            const body = (
              <>
                <span className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">{r.kicker}</span>
                  <span className="text-[12px] text-faint">{date(r.at, { month: "short", day: "numeric" })}</span>
                </span>
                <span className="font-heading text-[19px] leading-snug">{r.title}</span>
                {r.lines
                  .filter((l) => l.text)
                  .map((l) => (
                    <span key={l.platform} className="flex gap-2 text-[13.5px] leading-snug text-muted">
                      <span className="mt-0.5 shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px]">{l.platform === "google" ? "Google" : "Meta"}</span>
                      <span className="line-clamp-2">{l.text}</span>
                    </span>
                  ))}
                <span className="mt-1 text-[13px] text-brand-text">{r.href ? "Read it →" : "Sent to your Slack channel"}</span>
              </>
            );
            return r.href ? (
              <Link key={r.key} href={r.href} className="grid content-start gap-2 rounded-[22px] border border-line bg-surface p-5 transition-all hover:-translate-y-0.5 hover:border-faint">
                {body}
              </Link>
            ) : (
              <div key={r.key} className="grid content-start gap-2 rounded-[22px] border border-line bg-surface p-5">
                {body}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="rounded-[24px] border border-dashed border-line p-12 text-center text-[14px] text-muted">Your first report shows here after your first full week of ads.</p>
      )}
    </div>
  );
}
