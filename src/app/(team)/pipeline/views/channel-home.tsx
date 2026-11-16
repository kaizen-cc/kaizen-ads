import Link from "next/link";
import { ChannelSpark } from "@/components/channel-spark";
import { ChannelStatusPill, ConnectCta, Gauge, SupportChips, TONE, mainCaption, mainText, needsConnecting, paceLine, targetText } from "@/components/channel-parts";
import { BAND_TONE, ScoreBadge, WeighingDown } from "@/components/email-score-parts";
import { loadChannelBoard, riskForRow, type ChannelRow } from "@/lib/channel-kpis/load";
import { moneyShort, orderByRisk, pctText, type Line, type Risk } from "@/lib/channel-kpis/calc";
import { roleLabel, type TeamRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, SectionTitle, Stats } from "./shared";

type Me = { id: string; role: TeamRole; isExec: boolean; isLead: boolean };
type Ranked = ChannelRow & { risk: Risk };

/** Messages owed on each client (the person's own, and ones escalated past a second notice), by client */
async function owedByClient(db: Awaited<ReturnType<typeof createClient>>, me: Me): Promise<Map<string, { n: number; escalated: number }>> {
  const out = new Map<string, { n: number; escalated: number }>();
  try {
    const { loadOwedReplies } = await import("@/lib/owed-replies");
    for (const o of await loadOwedReplies(db, me, false)) {
      if (!o.clientId) continue;
      const x = out.get(o.clientId) ?? { n: 0, escalated: 0 };
      x.n++;
      if (o.status === "escalated") x.escalated++;
      out.set(o.clientId, x);
    }
  } catch {
    // Owed replies are a signal, not the page: without them clients are ordered on the rest
  }
  return out;
}

/**
 * Overview for the email and organic social teams: their clients ordered by how likely each is to leave (off target,
 * gone quiet, owed a reply, or numbers we can't see), each with this month's main KPI against its target, then the
 * clients whose data still needs connecting. It reads nothing from the ad tables.
 */
export async function ChannelHome({ me, line, today, greeting, firstName }: { me: Me; line: Line; today: string; greeting: string; firstName: string }) {
  const db = await createClient();
  const [board, owed] = await Promise.all([loadChannelBoard(db, line, me), owedByClient(db, me)]);
  const ranked: Ranked[] = orderByRisk(board.rows.map((r) => ({ ...r, risk: riskForRow(r, owed.get(r.clientId)) })));
  const channel = line === "email" ? "Email" : "Social";

  const connecting = ranked.filter(needsConnecting);
  const live = ranked.filter((r) => !needsConnecting(r));
  // A client needs a look when something about it is wrong; otherwise it's on track and just shown
  const attention = live.filter((r) => r.risk.score >= 30);
  const steady = live.filter((r) => r.risk.score < 30);
  const off = live.filter((r) => r.status === "off").length;
  const close = live.filter((r) => r.status === "close").length;
  const good = live.filter((r) => r.status === "good" || r.status === "excellent").length;

  const scored = live.filter((r) => r.score);
  const avg = scored.length ? Math.round(scored.reduce((t, r) => t + (r.score?.score ?? 0), 0) / scored.length) : null;
  const mtd = live.reduce((t, r) => t + (r.line === "email" ? (r.value ?? 0) : 0), 0);
  const reach = live.reduce((t, r) => t + (r.social?.reach ?? 0), 0);
  const inter = live.reduce((t, r) => t + (r.social?.interactions ?? 0), 0);
  const stats = [
    line === "email"
      ? { label: "Average score", value: avg ?? "n/a", hint: `${moneyShort(mtd)} attributed revenue this month`, tone: avg == null ? undefined : avg >= 80 ? ("ok" as const) : avg >= 60 ? ("warn" as const) : ("bad" as const) }
      : { label: "Engagement this month", value: pctText(reach > 0 ? inter / reach : null), hint: "Interactions over reach, all your clients" },
    { label: line === "email" ? "Red or yellow" : "Off or close", value: off + close, hint: line === "email" ? (off ? `${off} red${close ? `, ${close} yellow` : ""}` : close ? `${close} yellow` : "None slipping") : off ? `${off} off target` : close ? `${close} close` : "None slipping", tone: off ? ("bad" as const) : close ? ("warn" as const) : ("ok" as const) },
    { label: line === "email" ? "Green" : "On target", value: good, hint: line === "email" ? "Score 80 and up" : "At or better than target", tone: good ? ("ok" as const) : undefined },
    { label: "Need connecting", value: connecting.length, hint: connecting.length ? (line === "email" ? "Klaviyo key missing or failing" : "Page or Instagram not linked") : "All reading", tone: connecting.length ? ("warn" as const) : ("ok" as const) },
  ];

  const total = ranked.length;
  const needs = attention.length + connecting.length;
  return (
    <div className="mx-auto grid max-w-6xl gap-8">
      <PageHeader today={today} title={`${greeting}, ${firstName}`} subtitle={`${roleLabel(me.role)} · ${total} ${total === 1 ? "client" : "clients"} · ${needs ? `${needs} ${needs === 1 ? "needs" : "need"} a look` : total ? "all steady today" : "no clients yet"}`} />

      {total === 0 ? (
        <section className="grid justify-items-start gap-3 rounded-[18px] border border-dashed border-line p-6 md:p-8">
          <p className="font-heading text-xl">No clients yet</p>
          <p className="max-w-prose text-sm text-muted">
            {channel} clients show here once they buy {line === "email" ? "Email Marketing" : "Social Media"} and you hold a seat on them. Heads see every client with the service.
          </p>
          <Link href="/clients" className="inline-flex min-h-11 items-center rounded-full bg-fg px-5 text-sm font-medium text-bg">
            Open the clients
          </Link>
        </section>
      ) : (
        <>
          <Stats items={stats} />

          {/* Jump to a topic: the order inside each stays by risk */}
          <nav aria-label="Jump to" className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 md:mx-0 md:px-0">
            {[
              ["#attention", "Needs attention", attention.length],
              ["#connecting", "Needs connecting", connecting.length],
              ["#steady", "On track", steady.length],
            ]
              .filter(([, , n]) => (n as number) > 0)
              .map(([href, name, n]) => (
                <a key={href as string} href={href as string} className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-4 text-sm text-muted transition-colors hover:text-fg md:h-9">
                  {name} <span className="tabular text-xs text-faint">{n}</span>
                </a>
              ))}
            <Link href={`/kpis`} className="inline-flex h-11 shrink-0 items-center rounded-full px-4 text-sm text-muted hover:text-fg md:h-9">
              Open the {channel} board →
            </Link>
          </nav>

          {attention.length > 0 && (
            <section id="attention" className="grid scroll-mt-24 gap-3">
              <SectionTitle aside="Most at risk of leaving first">Needs attention</SectionTitle>
              <ul className="grid gap-3 md:grid-cols-2">
                {attention.map((r) => (
                  <Card key={r.clientId} r={r} />
                ))}
              </ul>
            </section>
          )}

          {connecting.length > 0 && (
            <section id="connecting" className="grid scroll-mt-24 gap-3">
              <SectionTitle aside={line === "email" ? "Paste the client's Klaviyo key" : "Share the Page, or pick it on their Social tab"}>Needs connecting</SectionTitle>
              <ul className="grid gap-3 md:grid-cols-2">
                {connecting.map((r) => (
                  <li key={r.clientId} className="grid content-start gap-3 rounded-[18px] border border-line bg-surface p-4">
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <Link href={`/clients/${r.slug}?service=${r.line}`} className="min-w-0 truncate font-heading text-[16px] hover:text-brand-text">
                        {r.name}
                      </Link>
                      <ChannelStatusPill status={r.status} line={r.line} />
                    </div>
                    <ConnectCta r={r} compact />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {steady.length > 0 && (
            <section id="steady" className="grid scroll-mt-24 gap-3">
              <SectionTitle aside="Nothing wrong">On track</SectionTitle>
              <ul className="grid gap-3 md:grid-cols-2">
                {steady.map((r) => (
                  <Card key={r.clientId} r={r} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** One client: why it's here, this month's KPI against its target with the trend, and the ways in */
function Card({ r }: { r: Ranked }) {
  const tone = TONE[r.status];
  const pace = paceLine(r);
  const goal = r.target != null && r.series.length ? (r.line === "email" ? { from: 0, to: r.target } : { from: r.target, to: r.target }) : null;
  const link = "inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[12.5px] text-muted transition-colors hover:text-fg md:min-h-9";
  return (
    <li className="relative isolate grid content-start gap-3 overflow-hidden rounded-[18px] border border-line bg-surface p-4" style={{ backgroundImage: `radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, ${tone.css} 12%, transparent), transparent 55%)` }}>
      <span aria-hidden className={`absolute inset-x-0 top-0 h-[3px] ${tone.bar}`} />
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={`/kpis?open=${r.clientId}`} className="block truncate font-heading text-[16px] leading-snug hover:text-brand-text">
            {r.name}
          </Link>
          <p className={`mt-0.5 truncate text-xs ${r.risk.reasons.length ? "text-muted" : "text-faint"}`}>{r.risk.reasons.length ? r.risk.reasons.join(" · ") : r.team.length ? r.team.map((t) => t.name).join(" + ") : "On track"}</p>
        </div>
        <ChannelStatusPill status={r.status} line={r.line} />
      </div>
      <div className="grid gap-1.5">
        {r.score ? (
          <>
            <div className="flex items-baseline gap-2">
              <ScoreBadge r={r.score} />
              <span className="truncate text-xs text-faint">{BAND_TONE[r.score.band].label.toLowerCase()} · {mainCaption(r)}</span>
            </div>
            <Gauge r={r} />
            <WeighingDown score={r.score} limit={2} currency={r.currency} />
          </>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className={`tabular font-display text-[28px] leading-none tracking-tight ${tone.text}`}>{mainText(r)}</span>
              {r.target != null ? <span className="tabular truncate text-xs text-faint">/ {targetText(r)}</span> : <span className="truncate text-xs text-faint">{mainCaption(r)}</span>}
            </div>
            <Gauge r={r} />
            {r.target == null ? (
              <Link href={`/kpis?open=${r.clientId}`} className="w-fit py-1 text-[11.5px] text-muted underline-offset-4 hover:text-fg hover:underline">
                No target yet. Set the target
              </Link>
            ) : (
              pace && <span className="truncate text-[11.5px] text-muted">{pace}</span>
            )}
            <ChannelSpark values={r.series} span={r.span} goal={goal} tone={tone.text} label={`${r.name} trend`} />
          </>
        )}
        <SupportChips r={r} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href={`/clients/${r.slug}?service=${r.line}`} className={link}>
          Client
        </Link>
        <Link href={`/kpis?open=${r.clientId}`} className={link}>
          {r.line === "email" ? "Email" : "Social"} board
        </Link>
        <Link href={`/reports?client=${r.slug}`} className={link}>
          Reports
        </Link>
      </div>
    </li>
  );
}
