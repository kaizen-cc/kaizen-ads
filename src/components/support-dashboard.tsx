import Link from "next/link";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// The support positions' dashboards on their Overview, under Today: the tracking specialist's tracking problems across
// accounts, the customer success coordinator's reply times, sentiment and quiet accounts (low sentiment first), and the
// onboarding specialist's stuck onboardings (no intake, no assets, no access, no weekly check-in). src/lib/oversight.

const shell = "grid gap-4 rounded-[20px] border border-line bg-surface p-5 md:p-6";
const kicker = "text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-text";
const KIND: Record<string, string> = { tracking_audit: "Audit", tracking_mismatch: "Platform vs store", cvr_drop: "Conversion rate", zero_results: "No results", lead_no_crm: "Leads, no CRM", access_lost: "Access", integration_auth: "Integration" };

function Head({ title, line, n }: { title: string; line: string; n: number }) {
  return (
    <div className="grid gap-1">
      <span className={kicker}>{title}</span>
      <h2 className="font-heading text-xl">{line}</h2>
      {n === 0 && <p className="text-sm text-muted">Nothing needs you here right now.</p>}
    </div>
  );
}

async function Tracking() {
  const { trackingBoard } = await import("@/lib/oversight/support");
  const rows = await trackingBoard(createAdminClient()).catch(() => []);
  const clients = new Set(rows.map((r) => r.slug)).size;
  return (
    <section className={shell}>
      <Head title="Tracking" line={rows.length ? `${rows.length} tracking problem${rows.length === 1 ? "" : "s"} on ${clients} client${clients === 1 ? "" : "s"}` : "Tracking is clean everywhere"} n={rows.length} />
      <ul className="grid max-h-[26rem] gap-2 overflow-y-auto overscroll-contain pr-1">
        {rows.slice(0, 25).map((r) => (
          <li key={r.id}>
            <Link href={`/clients/${r.slug}`} className="grid gap-1 rounded-[14px] border border-line px-4 py-3 transition-colors hover:border-faint">
              <span className="flex items-center justify-between gap-3">
                <span className="truncate font-medium">{r.client}</span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] ${r.severity === "critical" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"}`}>{KIND[r.kind] ?? r.kind}</span>
              </span>
              <span className="text-[13px]">{r.title}</span>
              {r.body && <span className="line-clamp-2 text-xs text-muted">{r.body}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

async function CustomerSuccess() {
  const { csBoard } = await import("@/lib/oversight/support");
  const rows = (await csBoard(createAdminClient()).catch(() => [])).filter((r) => r.rank > 0);
  const tone = (n: number | null) => (n == null ? "–" : n >= 0.25 ? "Positive" : n <= -0.25 ? "Negative" : "Neutral");
  return (
    <section className={shell}>
      <Head title="Client health" line={rows.length ? `${rows.length} client${rows.length === 1 ? "" : "s"} to look after, low sentiment first` : "Every client sounds happy and hears from us"} n={rows.length} />
      <ul className="grid max-h-[26rem] gap-2 overflow-y-auto overscroll-contain pr-1">
        {rows.slice(0, 25).map((r) => (
          <li key={r.clientId}>
            <Link href={`/clients/${r.slug}`} className="grid gap-2 rounded-[14px] border border-line px-4 py-3 transition-colors hover:border-faint md:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)] md:items-center">
              <span className="truncate font-medium">{r.client}</span>
              <span className="grid grid-cols-4 gap-2 text-[12px]">
                <span className="grid">
                  <span className={r.sentiment.now != null && r.sentiment.now < 0 ? "text-bad" : ""}>
                    {tone(r.sentiment.now)}
                    {r.sentiment.trend === "down" ? " ↓" : r.sentiment.trend === "up" ? " ↑" : ""}
                  </span>
                  <span className="text-faint">Sentiment</span>
                </span>
                <span className="grid">
                  <span className={r.replyHours != null && r.replyHours > 24 ? "text-warn" : ""}>{r.replyHours == null ? "–" : `${Math.round(r.replyHours)} h`}</span>
                  <span className="text-faint">Reply time</span>
                </span>
                <span className="grid">
                  <span className={r.waiting ? "text-bad" : ""}>{r.waiting}</span>
                  <span className="text-faint">Waiting</span>
                </span>
                <span className="grid">
                  <span className={r.quietDays == null || r.quietDays >= 5 ? "text-warn" : ""}>{r.quietDays == null ? "4w+" : `${r.quietDays} d`}</span>
                  <span className="text-faint">Since update</span>
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-[11.5px] text-faint">Sentiment is read from the words in clients&apos; own messages over the last 2 weeks against the 2 before: a guide, not a verdict.</p>
    </section>
  );
}

async function Onboarding() {
  const { onboardingBoard } = await import("@/lib/oversight/support");
  const rows = await onboardingBoard(createAdminClient()).catch(() => []);
  const stuck = rows.filter((r) => r.state.stuck);
  return (
    <section className={shell}>
      <Head title="Onboarding" line={rows.length ? `${stuck.length} of ${rows.length} onboarding${rows.length === 1 ? "" : "s"} stuck` : "No clients onboarding"} n={rows.length} />
      <ul className="grid max-h-[26rem] gap-2 overflow-y-auto overscroll-contain pr-1">
        {rows.map((r) => (
          <li key={r.clientId}>
            <Link href={`/clients/${r.slug}`} className={`grid gap-1.5 rounded-[14px] border px-4 py-3 transition-colors ${r.state.stuck ? "border-bad/40 hover:border-bad/70" : "border-line hover:border-faint"}`}>
              <span className="flex items-center justify-between gap-3">
                <span className="truncate font-medium">{r.client}</span>
                <span className={`shrink-0 text-[11px] ${r.state.stuck ? "text-bad" : "text-muted"}`}>
                  {r.state.daysIn} day{r.state.daysIn === 1 ? "" : "s"} in{r.state.stuck ? " · stuck" : ""}
                </span>
              </span>
              <span className="flex flex-wrap gap-1.5 text-[11px]">
                {[
                  { ok: r.state.intake, label: "Intake" },
                  { ok: r.state.assets, label: "Assets" },
                  { ok: r.state.access, label: "Access" },
                  { ok: r.state.checkInDays != null && r.state.checkInDays < 7, label: "Weekly check-in" },
                ].map((x) => (
                  <span key={x.label} className={`rounded-full px-2 py-0.5 ${x.ok ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"}`}>
                    {x.ok ? "✓" : "✕"} {x.label}
                  </span>
                ))}
              </span>
              {r.state.blockers.length > 0 && <span className="text-xs text-muted">{r.state.blockers.join(" · ")}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Reports not sent, company-wide (the Client Success Coordinator): by whoever owns sending each, then by client. Each
 * owner gets a drafted nudge on the coordinator's Overview (the escalation ladder); the coordinator builds reports for
 * anyone but never sends one.
 */
async function ReportsNotSent() {
  const { reportsNotSent } = await import("@/lib/oversight/support-extra");
  const rows = await reportsNotSent(createAdminClient()).catch(() => []);
  const owners = [...new Map(rows.map((r) => [r.owner, rows.filter((x) => x.owner === r.owner)])).entries()].sort((a, b) => b[1].length - a[1].length);
  return (
    <section id="reports-not-sent" className={shell}>
      <Head title="Reports" line={rows.length ? `${rows.length} report${rows.length === 1 ? "" : "s"} not sent` : "Every report is out"} n={rows.length} />
      <ul className="grid max-h-[26rem] gap-3 overflow-y-auto overscroll-contain pr-1">
        {owners.map(([owner, list]) => (
          <li key={owner} className="grid gap-1.5 rounded-[14px] border border-line px-4 py-3">
            <span className="flex items-center justify-between gap-3">
              <span className="truncate font-medium">{owner}</span>
              <span className="shrink-0 text-[11px] text-muted">{list.length} not sent</span>
            </span>
            <span className="grid gap-1">
              {list.map((r) => (
                <Link key={r.id} href={`/reports/${r.id}`} className="flex min-h-11 items-center justify-between gap-3 rounded-[10px] px-2 text-[13px] hover:bg-surface-2 md:min-h-8">
                  <span className="min-w-0 truncate">
                    {r.client} · {r.label}
                  </span>
                  <span className={`shrink-0 text-[11.5px] ${r.daysLate >= 7 ? "text-bad" : "text-muted"}`}>{r.daysLate}d late</span>
                </Link>
              ))}
            </span>
          </li>
        ))}
      </ul>
      {rows.length > 0 && <p className="text-xs text-muted">A message nudging each owner is drafted under Check in with your team.</p>}
    </section>
  );
}

/** Every client Slack channel with messages waiting on us: how long each has waited and who owes the reply */
async function ChannelHealth() {
  const { channelHealth } = await import("@/lib/oversight/support-extra");
  const rows = await channelHealth(createAdminClient()).catch(() => []);
  const waiting = rows.reduce((n, r) => n + r.messages.length, 0);
  return (
    <section id="channel-health" className={shell}>
      <Head title="Client channels" line={waiting ? `${waiting} message${waiting === 1 ? "" : "s"} waiting in ${rows.length} channel${rows.length === 1 ? "" : "s"}` : "Every client channel is answered"} n={waiting} />
      <ul className="grid max-h-[26rem] gap-2 overflow-y-auto overscroll-contain pr-1">
        {rows.map((r) => (
          <li key={r.channel} className="grid gap-1.5 rounded-[14px] border border-line px-4 py-3">
            <span className="flex items-center justify-between gap-3">
              <span className="truncate font-medium">
                {r.client ? `${r.client} · ` : ""}#{r.channel}
              </span>
              <span className={`shrink-0 text-[11px] ${r.oldestHours >= 12 ? "text-bad" : "text-muted"}`}>oldest {Math.round(r.oldestHours)}h</span>
            </span>
            <span className="grid gap-1">
              {r.messages.slice(0, 5).map((m) => (
                <a key={m.id} href={m.url ?? "#"} target="_blank" rel="noreferrer" className="flex min-h-11 items-center justify-between gap-3 rounded-[10px] px-2 text-[13px] hover:bg-surface-2 md:min-h-8">
                  <span className="min-w-0 truncate">
                    {m.from}: {m.gist}
                  </span>
                  <span className={`shrink-0 text-[11.5px] ${m.hours >= 12 ? "text-bad" : "text-muted"}`}>
                    {Math.round(m.hours)}h · {m.owes}
                  </span>
                </a>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export async function SupportDashboard({ role }: { role: string }) {
  if (!adminConfigured()) return null;
  if (role === "tracking_specialist") return <Tracking />;
  if (role === "customer_success")
    return (
      <>
        <CustomerSuccess />
        <ChannelHealth />
        <ReportsNotSent />
      </>
    );
  if (role === "onboarding_specialist") return <Onboarding />;
  return null;
}
