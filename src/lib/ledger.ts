import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { conversionFor } from "@/lib/kpi/conversions";

// The client playbook (a permanent activity log): every creative (ad), message angle and audience (ad set) a client has
// run, with when it ran, its numbers against the client's KPI and a verdict. Rebuilt from the ad-level data on every
// run, but never deleted: an ad that's turned off keeps its row (live = false) and everything it taught. The angles
// come from the ticket an ad was launched from, or the AI reads the ad's copy and names it, reusing the client's own
// angle names. What changes (a new winner, a new loser) is written into the Brand Bible's living learnings, dated.

type Admin = SupabaseClient;
type Row = { ad_id: string; ad_name: string | null; adset_id: string | null; adset_name: string | null; campaign_name: string | null; date: string; metrics: Record<string, unknown> };
type Agg = { spend: number; results: number; revenue: number; impressions: number; clicks: number; first: string; last: string; ads: Set<string> };

const num = (x: unknown) => Number(x) || 0;
const list = (x: unknown) => new Map(((x ?? []) as { action_type: string; value: string }[]).map((a) => [a.action_type, num(a.value)]));
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const daysAgo = (d: string) => Math.round((Date.parse(`${today()}T12:00:00Z`) - Date.parse(`${d}T12:00:00Z`)) / 86_400_000);

/** The account's KPI: which action counts as a result, the target, and whether it's judged on ROAS. */
async function kpiOf(admin: Admin, clientId: string) {
  const { data } = await admin.from("kpi_targets").select("ad_account_id, conversion, custom_action, target").eq("client_id", clientId).eq("platform", "meta").eq("active", true).not("ad_account_id", "is", null);
  return (data ?? []).map((t) => {
    const conv = conversionFor(String(t.conversion));
    return { account: String(t.ad_account_id).replace(/^act_/, ""), types: t.conversion === "custom" ? [String(t.custom_action ?? "")] : (conv.types ?? []), field: conv.field ?? null, roas: Boolean(conv.roas), label: conv.key === "custom" ? "results" : conv.label.toLowerCase(), target: t.target == null ? null : Number(t.target) };
  });
}

/** Results from one day's metrics, counted the way the KPI counts them (the first action type it reports). */
function resultsOf(m: Record<string, unknown>, k: { types: string[]; field: string | null }) {
  if (k.field === "unique_link_clicks" || k.field === "link_clicks") return num(m.inline_link_clicks);
  const acts = list(m.actions);
  for (const t of k.types) if (acts.has(t)) return acts.get(t)!;
  return 0;
}
function revenueOf(m: Record<string, unknown>, k: { types: string[] }) {
  const vals = list(m.action_values);
  for (const t of k.types) if (vals.has(t)) return vals.get(t)!;
  return 0;
}

/** The verdict against the client's KPI: enough spend to judge, then better or worse than target. */
function verdictOf(a: { spend: number; results: number; revenue: number; live: boolean }, k: { roas: boolean; target: number | null; label: string }) {
  const cpr = a.results ? a.spend / a.results : null;
  const roas = a.spend ? a.revenue / a.spend : null;
  const t = k.target;
  if (!t) {
    if (a.spend < 50) return { verdict: a.live ? "testing" : "inconclusive", reason: "Not enough spend to judge, and no KPI target set" };
    return { verdict: a.live ? "testing" : "inconclusive", reason: "No KPI target to judge against" };
  }
  if (k.roas) {
    if (a.spend < Math.max(100, 0)) return { verdict: a.live ? "testing" : "inconclusive", reason: "Not enough spend to judge yet" };
    if (roas != null && roas >= t) return { verdict: "winner", reason: `${roas.toFixed(2)}x ROAS against a ${t}x target` };
    if (a.spend >= 200 && (roas ?? 0) < t * 0.7) return { verdict: "loser", reason: `${(roas ?? 0).toFixed(2)}x ROAS against a ${t}x target` };
    return { verdict: a.live ? "testing" : "inconclusive", reason: `${(roas ?? 0).toFixed(2)}x ROAS so far, target ${t}x` };
  }
  if (a.results >= 3 && cpr != null && cpr <= t) return { verdict: "winner", reason: `$${cpr.toFixed(2)} per ${k.label.replace(/s$/, "")} against a $${t} target (${Math.round(a.results)} ${k.label})` };
  if (a.spend >= 2 * t && (cpr == null || cpr > t * 1.3)) return { verdict: "loser", reason: cpr == null ? `$${a.spend.toFixed(0)} spent with no ${k.label} (target $${t})` : `$${cpr.toFixed(2)} per ${k.label.replace(/s$/, "")} against a $${t} target` };
  return { verdict: a.live ? "testing" : "inconclusive", reason: a.spend < t ? "Not enough spend to judge yet" : `$${(cpr ?? 0).toFixed(2)} per ${k.label.replace(/s$/, "")} so far, target $${t}` };
}

/** Rebuild one client's playbook from everything their Meta ads have done. Returns what turned into a winner or loser. */
export async function buildLedger(admin: Admin, clientId: string) {
  const kpis = await kpiOf(admin, clientId);
  const { data: c } = await admin.from("clients").select("meta_ad_account_id").eq("id", clientId).single();
  const accounts = [...new Set([...kpis.map((k) => k.account), String(c?.meta_ad_account_id ?? "").replace(/^act_/, "")].filter(Boolean))];
  if (!accounts.length) return { creatives: 0, changed: [] as string[] };
  const kpi = kpis[0] ?? { types: ["omni_purchase", "purchase", "lead", "onsite_conversion.lead_grouped"], field: null, roas: false, label: "results", target: null };

  // Every day of every ad (paged: an account can have tens of thousands of rows)
  const rows: Row[] = [];
  for (let from = 0; from < 200_000; from += 1000) {
    const { data } = await admin.from("meta_ad_daily").select("ad_id, ad_name, adset_id, adset_name, campaign_name, date, metrics").eq("client_id", clientId).order("date").range(from, from + 999);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  if (!rows.length) return { creatives: 0, changed: [] as string[] };

  // What each ad said and showed: from the synced snapshots (newest wins) and the Hall of Fame
  const [{ data: snaps }, { data: fame }, { data: launches }, { data: prior }, { data: angles }] = await Promise.all([
    admin.from("meta_snapshots").select("ads, fetched_at").eq("client_id", clientId).order("fetched_at", { ascending: true }).limit(400),
    admin.from("hall_of_fame").select("ad_id, creative").eq("client_id", clientId),
    admin.from("launches").select("result, request_id, board_requests(angle_name, format, number)").eq("client_id", clientId).not("result", "is", null),
    admin.from("client_ledger").select("kind, key, verdict, detail").eq("client_id", clientId),
    admin.from("angles").select("name, description").eq("client_id", clientId),
  ]);
  type Creative = { text?: string; headline?: string; image?: string; thumbnail?: string; cta?: string; link?: string; format?: string };
  const creative = new Map<string, Creative>();
  for (const s of snaps ?? []) for (const a of (s.ads ?? []) as (Creative & { id: string })[]) creative.set(a.id, { ...creative.get(a.id), ...Object.fromEntries(Object.entries(a).filter(([, v]) => v != null && v !== "")) });
  for (const f of fame ?? []) creative.set(f.ad_id as string, { ...(f.creative as Creative), ...creative.get(f.ad_id as string) });
  // The ticket an ad came from: its angle, format and number
  const fromTicket = new Map<string, { angle: string | null; format: string | null; ticket: number | null }>();
  for (const l of launches ?? []) {
    const r = l.board_requests as unknown as { angle_name: string | null; format: string | null; number: number } | null;
    for (const a of ((l.result as { ads?: { adId: string | null }[] } | null)?.ads ?? [])) if (a.adId) fromTicket.set(a.adId, { angle: r?.angle_name ?? null, format: r?.format ?? null, ticket: r?.number ?? null });
  }
  const before = new Map((prior ?? []).map((p) => [`${p.kind}|${p.key}`, p]));

  // Add each ad up, and each ad set
  const byAd = new Map<string, Agg & { name: string; adset: string; adsetId: string; campaign: string }>();
  const byAdset = new Map<string, Agg & { name: string; campaign: string }>();
  const add = (a: Agg, r: Row) => {
    const m = r.metrics;
    a.spend += num(m.spend);
    a.results += resultsOf(m, kpi);
    a.revenue += revenueOf(m, kpi);
    a.impressions += num(m.impressions);
    a.clicks += num(m.inline_link_clicks);
    if (r.date < a.first) a.first = r.date;
    if (r.date > a.last) a.last = r.date;
    a.ads.add(r.ad_id);
  };
  const blank = (d: string): Agg => ({ spend: 0, results: 0, revenue: 0, impressions: 0, clicks: 0, first: d, last: d, ads: new Set() });
  for (const r of rows) {
    const ad = byAd.get(r.ad_id) ?? { ...blank(r.date), name: r.ad_name ?? r.ad_id, adset: r.adset_name ?? "", adsetId: r.adset_id ?? "", campaign: r.campaign_name ?? "" };
    add(ad, r);
    if (r.ad_name) ad.name = r.ad_name;
    byAd.set(r.ad_id, ad);
    if (r.adset_id) {
      const s = byAdset.get(r.adset_id) ?? { ...blank(r.date), name: r.adset_name ?? r.adset_id, campaign: r.campaign_name ?? "" };
      add(s, r);
      byAdset.set(r.adset_id, s);
    }
  }

  const now = new Date().toISOString();
  const changed: string[] = [];
  const row = (kind: "creative" | "angle" | "audience", key: string, title: string, a: Agg, detail: Record<string, unknown>) => {
    const live = daysAgo(a.last) <= 2;
    const v = verdictOf({ ...a, live }, kpi);
    const was = before.get(`${kind}|${key}`);
    if ((v.verdict === "winner" || v.verdict === "loser") && was?.verdict !== v.verdict) changed.push(`${kind}|${key}`);
    return {
      client_id: clientId,
      platform: "meta",
      kind,
      key,
      title: title.slice(0, 300),
      detail: { ...((was?.detail as Record<string, unknown>) ?? {}), ...detail },
      first_seen: a.first,
      last_seen: a.last,
      live,
      spend: Math.round(a.spend * 100) / 100,
      results: Math.round(a.results * 10) / 10,
      revenue: Math.round(a.revenue * 100) / 100,
      impressions: a.impressions,
      clicks: a.clicks,
      cost_per_result: a.results ? Math.round((a.spend / a.results) * 100) / 100 : null,
      roas: a.spend && a.revenue ? Math.round((a.revenue / a.spend) * 100) / 100 : null,
      result_label: kpi.label,
      target: kpi.target,
      verdict: v.verdict,
      verdict_reason: v.reason,
      verdict_at: was?.verdict === v.verdict ? undefined : now,
      ads: a.ads.size,
      updated_at: now,
    };
  };

  const out: Record<string, unknown>[] = [];
  for (const [id, a] of byAd) {
    const cr = creative.get(id) ?? {};
    const t = fromTicket.get(id);
    out.push(
      row("creative", id, cr.headline || a.name, a, {
        name: a.name,
        adset: a.adset,
        adsetId: a.adsetId,
        campaign: a.campaign,
        ...(cr.text ? { text: cr.text.slice(0, 2000) } : {}),
        ...(cr.headline ? { headline: cr.headline } : {}),
        ...(cr.image || cr.thumbnail ? { image: cr.image ?? cr.thumbnail } : {}),
        ...(cr.cta ? { cta: cr.cta } : {}),
        ...(t?.format ? { format: t.format } : {}),
        ...(t?.ticket ? { ticket: t.ticket } : {}),
        // The ticket's angle wins over the AI's reading
        ...(t?.angle ? { angle: t.angle, angleFrom: "ticket" } : {}),
      }),
    );
  }
  for (const [id, s] of byAdset) out.push(row("audience", id, s.name, s, { name: s.name, campaign: s.campaign }));

  // Angles: every ad that carries one, added up
  const byAngle = new Map<string, Agg>();
  for (const r of out.filter((x) => x.kind === "creative")) {
    const name = (r.detail as { angle?: string }).angle;
    if (!name) continue;
    const a = byAngle.get(name) ?? blank(r.first_seen as string);
    a.spend += r.spend as number;
    a.results += r.results as number;
    a.revenue += r.revenue as number;
    a.impressions += r.impressions as number;
    a.clicks += r.clicks as number;
    if ((r.first_seen as string) < a.first) a.first = r.first_seen as string;
    if ((r.last_seen as string) > a.last) a.last = r.last_seen as string;
    a.ads.add(r.key as string);
    byAngle.set(name, a);
  }
  for (const [name, a] of byAngle) out.push(row("angle", name.toLowerCase(), name, a, { name, description: (angles ?? []).find((x) => x.name.toLowerCase() === name.toLowerCase())?.description ?? null }));

  for (let i = 0; i < out.length; i += 500) {
    const { error } = await admin.from("client_ledger").upsert(out.slice(i, i + 500).map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined))), { onConflict: "client_id,platform,kind,key" });
    if (error) throw new Error(error.message);
  }
  return { creatives: byAd.size, changed };
}

/**
 * The AI reads the copy of ads that don't have an angle yet and names it, reusing the client's own angle names (or a
 * short new one), with the hook, the avatar it speaks to and the offer. A few dozen per client per run.
 */
export async function labelAngles(admin: Admin, clientId: string, max = 40) {
  const [{ data: todo }, { data: angles }, { data: used }] = await Promise.all([
    admin.from("client_ledger").select("id, key, detail, spend").eq("client_id", clientId).eq("kind", "creative").is("detail->>angle", null).not("detail->>text", "is", null).gte("spend", 10).order("spend", { ascending: false }).limit(max),
    admin.from("angles").select("name, description").eq("client_id", clientId).eq("status", "active"),
    admin.from("client_ledger").select("title").eq("client_id", clientId).eq("kind", "angle"),
  ]);
  if (!todo?.length) return 0;
  const known = [...new Set([...(angles ?? []).map((a) => a.name), ...(used ?? []).map((u) => u.title)])];
  const out = await askJson<{ items: { n: number; angle: string; hook: string; avatar: string; offer: string }[] }>({
    agent: "winners",
    label: "playbook angles",
    bare: true,
    maxTokens: 6000,
    override: { model: "haiku", effort: "low" },
    system:
      "You read a client's Meta ads and name the message angle of each: the core argument it makes to win the click (\"fresh, never frozen\", \"date night made easy\", \"save on your energy bill\"). Reuse one of the client's existing angle names whenever it fits, word for word; only create a new one (2 to 5 words, title case) when none fits. hook: the opening line's idea in a few words. avatar: who it speaks to, in a few words (\"busy parents\"), or \"\". offer: the offer or price if there is one, else \"\".",
    schema: {
      type: "object",
      properties: { items: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, angle: { type: "string" }, hook: { type: "string" }, avatar: { type: "string" }, offer: { type: "string" } }, required: ["n", "angle", "hook", "avatar", "offer"], additionalProperties: false } } },
      required: ["items"],
      additionalProperties: false,
    },
    prompt: `The client's angles so far: ${known.join("; ") || "(none yet)"}\n\n${todo.map((t, i) => `${i + 1}. ${((t.detail as { headline?: string }).headline ?? "").slice(0, 120)}\n${((t.detail as { text?: string }).text ?? "").slice(0, 900)}`).join("\n\n")}`,
  });
  for (const it of out.items) {
    const t = todo[it.n - 1];
    if (!t || !it.angle.trim()) continue;
    await admin
      .from("client_ledger")
      .update({ detail: { ...(t.detail as object), angle: it.angle.trim().slice(0, 80), angleFrom: "ai", hook: it.hook.slice(0, 160), avatar: it.avatar.slice(0, 120), offer: it.offer.slice(0, 160) } })
      .eq("id", t.id);
  }
  return out.items.length;
}

/** What the playbook taught since last time, added to the Brand Bible's living learnings (dated, never rewritten). */
export async function writeLearnings(admin: Admin, clientId: string, changed: string[]) {
  if (!changed.length) return 0;
  const { data: rows } = await admin.from("client_ledger").select("kind, key, title, detail, verdict, verdict_reason, first_seen, last_seen, spend").eq("client_id", clientId).in("verdict", ["winner", "loser"]);
  const fresh = (rows ?? []).filter((r) => changed.includes(`${r.kind}|${r.key}`)).slice(0, 25);
  if (!fresh.length) return 0;
  const out = await askJson<{ learnings: { kind: "works" | "avoid"; text: string }[] }>({
    agent: "winners",
    label: "playbook learnings",
    bare: true,
    maxTokens: 3000,
    override: { model: "haiku", effort: "low" },
    system:
      "You keep a client's Brand Bible current with what their ads proved. From the new winners and losers, write the lessons a creative team should act on: what works (angle, hook, audience, format, offer) and what to avoid. One sentence each, specific (name the angle, the audience, the numbers), at most 6. Skip anything that doesn't teach something.",
    schema: { type: "object", properties: { learnings: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["works", "avoid"] }, text: { type: "string" } }, required: ["kind", "text"], additionalProperties: false } } }, required: ["learnings"], additionalProperties: false },
    prompt: fresh
      .map((r) => {
        const d = r.detail as { angle?: string; hook?: string; avatar?: string; text?: string; adset?: string; format?: string };
        return `- ${r.verdict.toUpperCase()} ${r.kind}: "${r.title}"${d.angle ? ` · angle: ${d.angle}` : ""}${d.hook ? ` · hook: ${d.hook}` : ""}${d.avatar ? ` · avatar: ${d.avatar}` : ""}${d.adset ? ` · audience: ${d.adset}` : ""}${d.format ? ` · ${d.format}` : ""} · ${r.verdict_reason} · ran ${r.first_seen} to ${r.last_seen}${d.text ? `\n  copy: ${d.text.slice(0, 300)}` : ""}`;
      })
      .join("\n"),
  });
  if (!out.learnings.length) return 0;
  const { data: bible } = await admin.from("client_brand_bibles").select("learnings").eq("client_id", clientId).maybeSingle();
  const at = today();
  const next = [...((bible?.learnings ?? []) as { at: string; kind: string; text: string }[]), ...out.learnings.map((l) => ({ at, kind: l.kind, text: l.text.slice(0, 400) }))].slice(-200);
  if (bible) await admin.from("client_brand_bibles").update({ learnings: next, learnings_at: new Date().toISOString() }).eq("client_id", clientId);
  else await admin.from("client_brand_bibles").insert({ client_id: clientId, status: "none", learnings: next, learnings_at: new Date().toISOString() });
  return out.learnings.length;
}

/** The step: each client with Meta data, oldest-updated first, as many as fit. */
export async function runLedger(admin: Admin, budgetMs = 600_000) {
  const until = Date.now() + budgetMs;
  const { data: clients } = await admin.from("clients").select("id, name").not("meta_ad_account_id", "is", null).is("archived_at", null);
  const { data: last } = await admin.from("client_ledger").select("client_id, updated_at").order("updated_at", { ascending: false }).limit(5000);
  const seen = new Map<string, string>();
  for (const l of last ?? []) if (!seen.has(l.client_id as string)) seen.set(l.client_id as string, l.updated_at as string);
  const order = [...(clients ?? [])].sort((a, b) => (seen.get(a.id) ?? "").localeCompare(seen.get(b.id) ?? ""));
  let done = 0;
  const errors: string[] = [];
  for (const c of order) {
    if (Date.now() > until - 60_000) break;
    try {
      const r = await buildLedger(admin, c.id);
      if (r.creatives) {
        await labelAngles(admin, c.id).catch(() => 0);
        // Angles named by the AI just now count toward the angle rows next run; learnings from what changed
        // Changes the AI couldn't write up yet (paused) are kept and written with the next ones
        const { data: kept } = await admin.from("client_brand_bibles").select("pending_learnings").eq("client_id", c.id).maybeSingle();
        const changed = [...new Set([...((kept?.pending_learnings ?? []) as string[]), ...r.changed])];
        await writeLearnings(admin, c.id, changed)
          .then(() => kept?.pending_learnings?.length && admin.from("client_brand_bibles").update({ pending_learnings: [] }).eq("client_id", c.id))
          .catch(async () => {
            if (!changed.length) return;
            if (kept) await admin.from("client_brand_bibles").update({ pending_learnings: changed.slice(-200) }).eq("client_id", c.id);
            else await admin.from("client_brand_bibles").insert({ client_id: c.id, status: "none", pending_learnings: changed.slice(-200) });
          });
      }
      done++;
    } catch (e) {
      errors.push(`${c.name}: ${e instanceof Error ? e.message : e}`.slice(0, 200));
    }
  }
  return { clients: done, of: order.length, errors: errors.slice(0, 5) };
}

// ─── Reading ────────────────────────────────────────────────────────────────

export type LedgerItem = {
  id: string;
  kind: "creative" | "angle" | "audience";
  title: string;
  detail: { text?: string; headline?: string; image?: string; adset?: string; campaign?: string; angle?: string; angleFrom?: string; hook?: string; avatar?: string; offer?: string; format?: string; ticket?: number; name?: string; description?: string | null };
  firstSeen: string | null;
  lastSeen: string | null;
  live: boolean;
  spend: number;
  results: number;
  costPerResult: number | null;
  roas: number | null;
  resultLabel: string | null;
  target: number | null;
  verdict: "winner" | "loser" | "testing" | "inconclusive";
  reason: string | null;
  ads: number;
};

export async function loadLedger(db: SupabaseClient, clientId: string): Promise<LedgerItem[]> {
  const { data } = await db.from("client_ledger").select("*").eq("client_id", clientId).order("last_seen", { ascending: false }).limit(3000);
  return (data ?? []).map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    detail: r.detail ?? {},
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    live: r.live,
    spend: Number(r.spend),
    results: Number(r.results),
    costPerResult: r.cost_per_result == null ? null : Number(r.cost_per_result),
    roas: r.roas == null ? null : Number(r.roas),
    resultLabel: r.result_label,
    target: r.target == null ? null : Number(r.target),
    verdict: r.verdict,
    reason: r.verdict_reason,
    ads: r.ads,
  }));
}

/** The playbook as the AI reads it: winners and losers by kind (with dates), and the Brand Bible's learnings. */
export async function playbookBlock(db: SupabaseClient, clientId: string) {
  const [{ data: rows }, { data: bible }] = await Promise.all([
    db.from("client_ledger").select("kind, title, detail, verdict, verdict_reason, first_seen, last_seen, spend").eq("client_id", clientId).in("verdict", ["winner", "loser"]).order("spend", { ascending: false }).limit(80),
    db.from("client_brand_bibles").select("learnings").eq("client_id", clientId).maybeSingle(),
  ]);
  const line = (r: { kind: string; title: string; detail: unknown; verdict_reason: string | null; first_seen: string | null; last_seen: string | null }) => {
    const d = r.detail as { angle?: string; hook?: string; avatar?: string; adset?: string };
    return `- ${r.kind === "audience" ? "Audience" : r.kind === "angle" ? "Angle" : "Ad"} "${r.title.slice(0, 90)}"${d.angle && r.kind === "creative" ? ` (angle: ${d.angle})` : ""}${d.adset && r.kind === "creative" ? ` (audience: ${d.adset})` : ""}: ${r.verdict_reason} · ${r.first_seen} to ${r.last_seen}`;
  };
  const win = (rows ?? []).filter((r) => r.verdict === "winner");
  const lose = (rows ?? []).filter((r) => r.verdict === "loser");
  const pick = (xs: typeof win) => [...xs.filter((x) => x.kind === "angle").slice(0, 5), ...xs.filter((x) => x.kind === "audience").slice(0, 5), ...xs.filter((x) => x.kind === "creative").slice(0, 8)];
  const learnings = ((bible?.learnings ?? []) as { at: string; kind: string; text: string }[]).slice(-12);
  if (!win.length && !lose.length && !learnings.length) return "";
  return `<client_playbook>
Everything this client has run, judged against their KPI. Build on what won; don't repeat what lost unless something changed (the offer, the audience).
${win.length ? `What won:\n${pick(win).map(line).join("\n")}` : ""}
${lose.length ? `What lost:\n${pick(lose).map(line).join("\n")}` : ""}
${learnings.length ? `Learnings (dated):\n${learnings.map((l) => `- ${l.at} · ${l.kind === "avoid" ? "Avoid" : "Works"}: ${l.text}`).join("\n")}` : ""}
</client_playbook>`;
}

/** Winning angles and audiences from other clients in the same industry (anonymized): a new client's head start. */
export async function peersBlock(db: SupabaseClient, clientId: string, industry: string | null, detail: string | null) {
  if (!industry || industry === "other") return "";
  const { data: peers } = await db.from("clients").select("id, industry_detail").eq("industry", industry).neq("id", clientId).neq("status", "offboarded");
  if (!peers?.length) return "";
  // Same sub-category first
  const ids = [...peers].sort((a, b) => Number(b.industry_detail === detail) - Number(a.industry_detail === detail)).map((p) => p.id as string).slice(0, 30);
  const { data } = await db.from("client_ledger").select("client_id, kind, title, detail, verdict_reason").in("client_id", ids).eq("verdict", "winner").in("kind", ["angle", "audience"]).order("spend", { ascending: false }).limit(20);
  if (!data?.length) return "";
  const sub = new Map(peers.map((p) => [p.id as string, p.industry_detail as string | null]));
  return `<what_wins_for_similar_clients>
Angles and audiences that won for other Kaizen clients in this industry${detail ? ` (this client: ${detail})` : ""}. Start from these rather than from scratch; adapt them, never copy, never name another client.
${data.map((r) => `- ${r.kind === "angle" ? "Angle" : "Audience"} "${r.title.slice(0, 90)}" for a ${sub.get(r.client_id as string) ?? "similar business"}: ${r.verdict_reason}`).join("\n")}
</what_wins_for_similar_clients>`;
}
