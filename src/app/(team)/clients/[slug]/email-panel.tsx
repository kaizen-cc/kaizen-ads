import type { ClientKlaviyo } from "@/lib/klaviyo/store";

// The Email tab: what their email and SMS (Klaviyo) brought in over the last 30 days against the 30 before, each
// day's revenue (campaigns and flows), recent campaigns with their numbers, the flows that earn most, and list sizes.
// Read only: nothing is sent, edited or scheduled in Klaviyo from here.

const money = (x: number, cur: string | null) => `${!cur || cur === "USD" ? "$" : `${cur} `}${Math.round(x).toLocaleString("en-US")}`;
const pct = (x: number | null) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const count = (x: number) => Math.round(x).toLocaleString("en-US");
const delta = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 100) : null);
const sent = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "Not sent");
const FLOW = "#6c7ee1";
const CAMPAIGN = "#5be3a5";

function Tile({ k, v, d, sub }: { k: string; v: string; d?: number | null; sub?: string }) {
  return (
    <div className="grid content-start gap-1 rounded-[14px] border border-line bg-surface p-3.5 md:p-4">
      <span className="text-[11px] uppercase tracking-[0.12em] text-faint">{k}</span>
      <span className="tabular font-display text-[26px] leading-none md:text-[30px]">{v}</span>
      {typeof d === "number" ? (
        <span className={`text-[11.5px] ${d >= 0 ? "text-ok" : "text-bad"}`}>
          {d >= 0 ? "▲" : "▼"} {Math.abs(d)}% vs the 30 days before
        </span>
      ) : sub ? (
        <span className="text-[11.5px] text-faint">{sub}</span>
      ) : null}
    </div>
  );
}

export function EmailPanel({ k, storeRevenue }: { k: ClientKlaviyo; /** Their store's revenue over the same 30 days, when a store is connected */ storeRevenue: number | null }) {
  const { now, before, currency: cur } = k;
  const peak = Math.max(1, ...k.daily.map((d) => d.revenue));
  const recent = k.campaigns.slice(0, 12);
  const flows = k.flows.filter((f) => f.revenue90 > 0 || f.status === "live").slice(0, 8);
  const lists = k.audiences.filter((a) => a.profiles != null).slice(0, 8);
  const biggest = Math.max(1, ...lists.map((a) => a.profiles ?? 0));
  const share = storeRevenue ? Math.round((now.revenue / storeRevenue) * 100) : null;

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-muted">
          {k.account ?? "Klaviyo"} · last 30 days{k.through ? `, through ${sent(`${k.through}T12:00:00Z`)}` : ""}. Revenue is what Klaviyo attributes to email and SMS on Placed Order.
        </p>
        <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] text-muted">Read only</span>
      </div>

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
        <Tile k="Email revenue" v={money(now.revenue, cur)} d={delta(now.revenue, before.revenue)} />
        <Tile k="Share of revenue" v={share != null ? `${share}%` : "n/a"} sub={share != null ? `of ${money(storeRevenue ?? 0, cur)} in the store` : "No store connected"} />
        <Tile k="Campaigns sent" v={count(now.campaignsSent)} d={delta(now.campaignsSent, before.campaignsSent)} />
        <Tile k="Open rate" v={pct(now.openRate)} sub={before.openRate != null ? `${pct(before.openRate)} the 30 days before` : "Campaigns, unique opens"} />
        <Tile k="Click rate" v={pct(now.clickRate)} sub={before.clickRate != null ? `${pct(before.clickRate)} the 30 days before` : "Campaigns, unique clicks"} />
      </div>

      {k.daily.length > 0 && (
        <section className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-heading text-[16px]">Revenue by day</h3>
            <span className="flex gap-4 text-[11.5px] text-muted">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: FLOW }} />
                Flows {money(now.flowRevenue, cur)}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: CAMPAIGN }} />
                Campaigns {money(now.campaignRevenue, cur)}
              </span>
            </span>
          </div>
          <div className="flex h-28 items-end gap-[3px]" role="img" aria-label={`Email revenue per day over the last 30 days, ${money(now.revenue, cur)} in total`}>
            {k.daily.map((d) => (
              <div key={d.date} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${d.date}: ${money(d.revenue, cur)} (flows ${money(d.flowRevenue, cur)}, campaigns ${money(d.campaignRevenue, cur)})`}>
                <span className="block rounded-t-[3px]" style={{ height: `${(d.campaignRevenue / peak) * 100}%`, background: CAMPAIGN }} />
                <span className={`block ${d.campaignRevenue ? "" : "rounded-t-[3px]"}`} style={{ height: `${(d.flowRevenue / peak) * 100}%`, background: FLOW }} />
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="grid gap-3">
        <h3 className="font-heading text-[16px]">Recent campaigns</h3>
        {recent.length ? (
          <ul className="grid gap-2">
            {recent.map((c) => (
              <li key={c.id} className="grid gap-2 rounded-[14px] border border-line bg-surface p-3.5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-4">
                <div className="grid min-w-0 gap-0.5">
                  <span className="flex items-center gap-2 text-[12px] text-faint">
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] uppercase tracking-[0.08em] text-muted">{c.channel === "sms" ? "SMS" : "Email"}</span>
                    {sent(c.sendTime)}
                    {c.audiences.length > 0 && <span className="truncate">· {c.audiences.slice(0, 2).join(", ")}</span>}
                  </span>
                  <span className="truncate text-sm font-medium">{c.subject ?? c.name}</span>
                  {(c.subject && c.subject !== c.name) || c.previewText ? <span className="truncate text-[12px] text-muted">{[c.subject && c.subject !== c.name ? c.name : null, c.previewText].filter(Boolean).join(" · ")}</span> : null}
                </div>
                <dl className="grid grid-cols-4 gap-2 text-[12px] md:flex md:gap-5">
                  {[
                    ["Recipients", count(c.recipients)],
                    ["Open", pct(c.openRate)],
                    ["Click", pct(c.clickRate)],
                    ["Revenue", money(c.revenue, cur)],
                  ].map(([key, v]) => (
                    <div key={key} className="grid gap-0.5 md:text-right">
                      <dt className="text-[10.5px] text-faint">{key}</dt>
                      <dd className="tabular text-fg">{v}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-faint">No campaigns sent in the last 120 days.</p>
        )}
      </section>

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <section className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-5">
          <h3 className="font-heading text-[16px]">Top flows by revenue</h3>
          {flows.length ? (
            <ul className="grid gap-3">
              {flows.map((f) => (
                <li key={f.id} className="grid gap-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-sm">{f.name}</span>
                    <span className="tabular shrink-0 text-sm">{money(f.revenue30, cur)}</span>
                  </div>
                  <span className="text-[11.5px] text-faint">
                    {[f.status, f.trigger].filter(Boolean).join(" · ")} · 30 days: {count(f.recipients30)} recipients, open {pct(f.openRate30)}, click {pct(f.clickRate30)} · 90 days {money(f.revenue90, cur)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-faint">No flow revenue in the last 90 days.</p>
          )}
        </section>

        <section className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-5">
          <h3 className="font-heading text-[16px]">Lists and segments</h3>
          {lists.length ? (
            <ul className="grid gap-2.5">
              {lists.map((a) => (
                <li key={a.id} className="grid gap-1">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate">
                      {a.name} <span className="text-[11px] text-faint">{a.kind}</span>
                    </span>
                    <span className="tabular shrink-0">{count(a.profiles ?? 0)}</span>
                  </div>
                  <span className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.max(2, ((a.profiles ?? 0) / biggest) * 100)}%` }} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-faint">{k.audiences.length ? `${k.audiences.length} lists and segments; their sizes are read on the next sync.` : "No lists or segments read yet."}</p>
          )}
        </section>
      </div>
    </div>
  );
}
