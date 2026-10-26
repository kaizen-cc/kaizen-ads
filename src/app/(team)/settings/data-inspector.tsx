import { aggregate, computeSnapshot, nyParts, pickType, resultsOf, toDays, type Agg } from "@/lib/kpi/calc";
import { conversionFor, conversionLabel } from "@/lib/kpi/conversions";
import { kpiValue, money } from "@/lib/kpi/format";
import { accountRows } from "@/lib/kpi/sync";
import { createAdminClient } from "@/lib/supabase/admin";
import { CsvButton } from "./csv-button";

type Target = {
  id: string;
  client: string;
  label: string | null;
  platform: string;
  ad_account_id: string | null;
  conversion: string;
  custom_action: string | null;
  campaign_match: string | null;
  target: number | null;
  monthly_budget: number | null;
};

const shift = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const th = "px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[0.1em] text-faint";
const td = "px-2.5 py-2 tabular md:px-3";

/**
 * Raw Meta numbers behind a KPI, for a chosen date range: what came in per day and per campaign, which action
 * type counted as a result, and the dashboard's averages recomputed from these same rows next to what it shows.
 */
export async function DataInspector({ targets, targetId, from, to }: { targets: Target[]; targetId: string | null; from: string; to: string }) {
  const t = targets.find((x) => x.id === targetId) ?? null;
  const picker = (
    <form method="get" className="grid grid-cols-2 items-end gap-3 rounded-[14px] border border-line bg-surface p-4 sm:grid-cols-[minmax(0,1fr)_160px_160px_auto] md:p-5">
      <input type="hidden" name="tab" value="data" />
      <label className="grid gap-1.5 text-sm text-muted">
        KPI
        <select name="target" defaultValue={targetId ?? ""} className="h-11 w-full min-w-0 md:h-10 rounded-[8px] border border-line bg-bg px-3 text-sm text-fg">
          <option value="" disabled>
            Pick a client&apos;s KPI
          </option>
          {targets
            .filter((x) => x.ad_account_id)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.client}
                {x.label ? ` · ${x.label}` : ""} · {conversionLabel(x.conversion, x.custom_action)}
              </option>
            ))}
        </select>
      </label>
      <label className="grid gap-1.5 text-sm text-muted">
        From
        <input type="date" name="from" defaultValue={from} className="h-11 w-full min-w-0 md:h-10 rounded-[8px] border border-line bg-bg px-3 text-sm text-fg tabular" />
      </label>
      <label className="grid gap-1.5 text-sm text-muted">
        To
        <input type="date" name="to" defaultValue={to} className="h-11 w-full min-w-0 md:h-10 rounded-[8px] border border-line bg-bg px-3 text-sm text-fg tabular" />
      </label>
      <button className="col-span-2 h-11 rounded-[8px] bg-fg px-5 text-sm font-medium text-bg sm:col-span-1 md:h-10">Inspect</button>
    </form>
  );
  if (!t || !t.ad_account_id)
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        {picker}
        <p className="rounded-[14px] border border-dashed border-line px-6 py-14 text-center text-sm text-faint">Pick a KPI and a date range to see the raw numbers behind it.</p>
      </div>
    );

  const admin = createAdminClient();
  const account = t.platform === "google" ? t.ad_account_id.replace(/\D/g, "") : t.ad_account_id.replace(/^act_/, "");
  const [all, { data: snap }, { data: state }] = await Promise.all([
    accountRows(admin, account, t.platform),
    admin.from("kpi_snapshots").select("windows, computed_at, error").eq("target_id", t.id).maybeSingle(),
    admin.from("sync_state").select("last_run_at, last_result").eq("source", `kpi:${account}`).maybeSingle(),
  ]);
  const conv = conversionFor(t.conversion);
  const match = t.campaign_match?.trim().toLowerCase() || null;
  const included = (name: string | null | undefined) => !match || (name ?? "").toLowerCase().includes(match);
  const days = toDays(all, t.campaign_match);
  const type = pickType(days, conv, t.custom_action);
  const inRange = days.filter((d) => d.date >= from && d.date <= to).sort((a, b) => b.date.localeCompare(a.date));
  const rawInRange = all.filter((r) => r.date >= from && r.date <= to);
  const total = aggregate(inRange, conv, type);

  // Every action type Meta reported in the range, so the right one can be picked for the KPI
  const actionTotals = new Map<string, number>();
  for (const r of rawInRange) if (included(r.campaign_name)) for (const [k, v] of Object.entries(r.actions ?? {})) actionTotals.set(k, (actionTotals.get(k) ?? 0) + Number(v));
  const actions = [...actionTotals.entries()].sort((a, b) => b[1] - a[1]);

  // Per campaign
  const byCampaign = new Map<string, { name: string; spend: number; results: number; days: Set<string>; included: boolean }>();
  for (const r of rawInRange) {
    const c = byCampaign.get(r.campaign_id) ?? { name: r.campaign_name ?? r.campaign_id, spend: 0, results: 0, days: new Set<string>(), included: included(r.campaign_name) };
    c.spend += Number(r.spend) || 0;
    c.results += resultsOf({ date: r.date, spend: 0, actions: r.actions, values: {}, linkClicks: Number(r.link_clicks), uniqueLinkClicks: Number(r.unique_link_clicks) }, conv, type);
    c.days.add(r.date);
    byCampaign.set(r.campaign_id, c);
  }
  const campaigns = [...byCampaign.values()].sort((a, b) => b.spend - a.spend);

  // The dashboard's averages, recomputed now from these rows, next to what it last saved
  const now = new Date();
  const fresh = computeSnapshot(days, { conversion: t.conversion, custom: t.custom_action, target: t.target, budget: t.monthly_budget, now });
  const yesterday = shift(nyParts(now).date, -1);
  const stored = (snap?.windows ?? {}) as Record<string, Agg>;
  const checks = (["d3", "d7", "d14", "d30", "d60", "d90"] as const).map((k) => {
    const n = Number(k.slice(1));
    const a = fresh.windows[k];
    const b = stored[k];
    const same = b != null && Math.abs((a.spend ?? 0) - (b.spend ?? 0)) < 0.02 && Math.abs((a.results ?? 0) - (b.results ?? 0)) < 0.05;
    return { k, n, range: `${shift(yesterday, -(n - 1))} → ${yesterday}`, fresh: a, stored: b, same };
  });
  const lastUpdated = rawInRange.map((r) => r.updated_at).sort().at(-1);

  const csv = [
    ["date", "campaign_id", "campaign", "included", "spend", "impressions", "clicks", "link_clicks", "unique_link_clicks", "results", ...actions.map(([k]) => k)].join(","),
    ...rawInRange
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) =>
        [
          r.date,
          r.campaign_id,
          `"${(r.campaign_name ?? "").replace(/"/g, '""')}"`,
          included(r.campaign_name),
          r.spend,
          r.impressions,
          r.clicks,
          r.link_clicks,
          r.unique_link_clicks,
          resultsOf({ date: r.date, spend: 0, actions: r.actions, values: {}, linkClicks: Number(r.link_clicks), uniqueLinkClicks: Number(r.unique_link_clicks) }, conv, type),
          ...actions.map(([k]) => r.actions?.[k] ?? 0),
        ].join(","),
      ),
  ].join("\n");

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 md:gap-6">
      {picker}

      <section className="grid grid-cols-[minmax(0,1fr)] gap-5 rounded-[14px] border border-line bg-surface p-4 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-heading text-[18px] [overflow-wrap:anywhere] md:text-[20px]">
              {t.client}
              {t.label && <span className="text-muted"> · {t.label}</span>}
            </h2>
            <p className="mt-1 text-sm text-muted [overflow-wrap:anywhere]">
              act_{account} · counts <span className="text-fg">{conversionLabel(t.conversion, t.custom_action)}</span> as{" "}
              <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-fg">{conv.field ?? type ?? "nothing yet"}</code>
              {match && (
                <>
                  {" "}
                  · only campaigns containing <span className="text-fg">&ldquo;{t.campaign_match}&rdquo;</span>
                </>
              )}
            </p>
            <p className="mt-1 text-xs text-faint">
              Last pulled from Meta {state?.last_run_at ? new Date(state.last_run_at).toLocaleString("en-US", { timeZone: "America/New_York" }) : "never"}
              {lastUpdated && ` · newest row in this range updated ${new Date(lastUpdated).toLocaleString("en-US", { timeZone: "America/New_York" })}`}
              {snap?.error && <span className="text-bad"> · {snap.error}</span>}
            </p>
          </div>
          <CsvButton csv={csv} name={`${t.client}-${from}-${to}.csv`} />
        </div>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-line bg-line sm:grid-cols-4">
          {[
            ["Spend", money(total.spend)],
            ["Results", total.results.toLocaleString()],
            [conv.roas ? "ROAS" : "Cost per result", kpiValue(total.value, Boolean(conv.roas))],
            ["Target", kpiValue(t.target, Boolean(conv.roas))],
          ].map(([k, v]) => (
            <div key={k} className="grid gap-0.5 bg-surface px-4 py-3">
              <dt className="text-[11px] text-faint">{k}</dt>
              <dd className="tabular font-heading text-lg">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="grid grid-cols-[minmax(0,1fr)] gap-4 rounded-[14px] border border-line bg-surface p-4 md:p-6">
        <div>
          <h3 className="font-heading text-[17px]">Does it add up?</h3>
          <p className="mt-1 text-sm text-muted [overflow-wrap:anywhere]">
            The dashboard&apos;s averages recomputed from these rows right now, next to what it last saved
            {snap?.computed_at && ` (${new Date(snap.computed_at).toLocaleString("en-US", { timeZone: "America/New_York" })})`}. Windows end yesterday; today is still filling in.
          </p>
        </div>
        {/* Phones: one card per window */}
        <ul className="grid gap-2 md:hidden">
          {checks.map((c) => (
            <li key={c.k} className="grid gap-2 rounded-[10px] bg-bg/60 px-3 py-2.5 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{c.n} days</span>
                <span className={`text-right text-xs ${c.same ? "text-ok" : "text-warn"}`}>{c.stored ? (c.same ? "✓ matches" : "Changed since last sync") : "Not saved yet"}</span>
              </div>
              <p className="tabular text-xs text-faint">{c.range}</p>
              <dl className="grid grid-cols-4 gap-2 text-xs">
                {(
                  [
                    ["Spend", money(c.fresh.spend)],
                    ["Results", String(c.fresh.results)],
                    ["Now", kpiValue(c.fresh.value, Boolean(conv.roas))],
                    ["Dashboard", kpiValue(c.stored?.value, Boolean(conv.roas))],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="grid min-w-0 gap-0.5">
                    <dt className="truncate text-[10px] uppercase tracking-[0.08em] text-faint">{k}</dt>
                    <dd className="truncate tabular">{v}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className={th}>Window</th>
                <th className={th}>Dates</th>
                <th className={`${th} text-right`}>Spend</th>
                <th className={`${th} text-right`}>Results</th>
                <th className={`${th} text-right`}>Now</th>
                <th className={`${th} text-right`}>Dashboard</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.k} className="border-b border-line/60 last:border-0">
                  <td className={td}>{c.n} days</td>
                  <td className={`${td} text-faint`}>{c.range}</td>
                  <td className={`${td} text-right`}>{money(c.fresh.spend)}</td>
                  <td className={`${td} text-right`}>{c.fresh.results}</td>
                  <td className={`${td} text-right`}>{kpiValue(c.fresh.value, Boolean(conv.roas))}</td>
                  <td className={`${td} text-right text-muted`}>{kpiValue(c.stored?.value, Boolean(conv.roas))}</td>
                  <td className={`${td} text-xs ${c.same ? "text-ok" : "text-warn"}`}>{c.stored ? (c.same ? "✓ matches" : "Changed since last sync") : "Not saved yet"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 md:gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <section className="grid grid-cols-[minmax(0,1fr)] content-start gap-4 rounded-[14px] border border-line bg-surface p-4 md:p-6">
          <h3 className="font-heading text-[17px]">By day</h3>
          <div className="max-h-[60vh] overflow-auto overscroll-contain md:max-h-[520px]">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-line">
                  <th className={th}>Date</th>
                  <th className={`${th} text-right`}>Spend</th>
                  <th className={`${th} text-right`}>Link clicks</th>
                  <th className={`${th} text-right`}>Results</th>
                  <th className={`${th} text-right`}>{conv.roas ? "ROAS" : "Cost / result"}</th>
                </tr>
              </thead>
              <tbody>
                {inRange.map((d) => {
                  const a = aggregate([d], conv, type);
                  return (
                    <tr key={d.date} className="border-b border-line/60 last:border-0">
                      <td className={td}>{d.date}</td>
                      <td className={`${td} text-right`}>{money(a.spend)}</td>
                      <td className={`${td} text-right text-muted`}>{(d.uniqueLinkClicks ?? 0).toLocaleString()}</td>
                      <td className={`${td} text-right`}>{a.results}</td>
                      <td className={`${td} text-right`}>{kpiValue(a.value, Boolean(conv.roas))}</td>
                    </tr>
                  );
                })}
                {!inRange.length && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-faint">
                      No rows in this range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="grid grid-cols-[minmax(0,1fr)] content-start gap-4 rounded-[14px] border border-line bg-surface p-4 md:p-6">
          <div className="min-w-0">
            <h3 className="font-heading text-[17px]">Everything Meta reported</h3>
            <p className="mt-1 text-sm text-muted">Totals for each action type in this range. If the KPI is counting the wrong one, change it on the KPI page.</p>
          </div>
          <ul className="grid max-h-[460px] gap-1 overflow-auto">
            {actions.map(([k, v]) => (
              <li key={k} className={`flex items-center justify-between gap-3 rounded-[8px] px-3 py-1.5 text-xs ${k === type ? "bg-brand-soft text-brand-text" : "odd:bg-bg"}`}>
                <code className="min-w-0 truncate">{k}</code>
                <span className="tabular">{v.toLocaleString()}</span>
              </li>
            ))}
            {!actions.length && <li className="text-sm text-faint">Nothing reported.</li>}
          </ul>
        </section>
      </div>

      <section className="grid grid-cols-[minmax(0,1fr)] gap-4 rounded-[14px] border border-line bg-surface p-4 md:p-6">
        <h3 className="font-heading text-[17px]">By campaign</h3>
        {/* Phones: one card per campaign */}
        <ul className="grid gap-2 md:hidden">
          {campaigns.map((c) => (
            <li key={c.name} className={`grid gap-2 rounded-[10px] bg-bg/60 px-3 py-2.5 text-sm ${c.included ? "" : "opacity-50"}`}>
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 [overflow-wrap:anywhere]">{c.name}</span>
                <span className={`shrink-0 text-xs ${c.included ? "text-ok" : "text-faint"}`}>{c.included ? "Included" : "Filtered out"}</span>
              </div>
              <dl className="grid grid-cols-4 gap-2 text-xs">
                {(
                  [
                    ["Days", String(c.days.size)],
                    ["Spend", money(Math.round(c.spend * 100) / 100)],
                    ["Results", String(Math.round(c.results * 10) / 10)],
                    ["Cost / result", c.results ? money(Math.round((c.spend / c.results) * 100) / 100) : "—"],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="grid min-w-0 gap-0.5">
                    <dt className="truncate text-[10px] uppercase tracking-[0.08em] text-faint">{k}</dt>
                    <dd className="truncate tabular">{v}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className={th}>Campaign</th>
                <th className={`${th} text-right`}>Days</th>
                <th className={`${th} text-right`}>Spend</th>
                <th className={`${th} text-right`}>Results</th>
                <th className={`${th} text-right`}>Cost / result</th>
                <th className={th}>In the KPI</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.name} className={`border-b border-line/60 last:border-0 ${c.included ? "" : "opacity-50"}`}>
                  <td className={`${td} max-w-[360px] truncate font-sans`}>{c.name}</td>
                  <td className={`${td} text-right text-muted`}>{c.days.size}</td>
                  <td className={`${td} text-right`}>{money(Math.round(c.spend * 100) / 100)}</td>
                  <td className={`${td} text-right`}>{Math.round(c.results * 10) / 10}</td>
                  <td className={`${td} text-right`}>{c.results ? money(Math.round((c.spend / c.results) * 100) / 100) : "—"}</td>
                  <td className={`${td} text-xs ${c.included ? "text-ok" : "text-faint"}`}>{c.included ? "Included" : "Filtered out"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
