import "server-only";
import { EMAIL_CHECKS } from "@/lib/email-score";
import { klaviyoCampaignUrl } from "@/lib/channel-reports/email-cards";
import { loadChannelBoard } from "@/lib/channel-kpis/load";
import { LIVE } from "@/lib/live";
import { isChannelOnly, lineOfTeam, teamPlatform } from "@/lib/roles";
import { servicesOf } from "@/lib/services";
import { conversionValue } from "@/lib/kpi/conversion-value";
import { channelMaySee } from "./channel-access";
import { DEFAULT_METRIC, RANK_METRICS, asPeriod, moneyWords, pctWords, periodRange, rankEntries, rankLinesFor, sumDays, vsTarget, type RankEntry, type RankLine, type RankPeriod } from "./rank-core";
import type { ChatTool, ToolCtx } from "./tools";

// Rankings across clients, for Kaizen AI and the agents (on calls and in their chats): which clients lead or trail on
// a line (rank_clients), and the single emails, ads and posts that did best or worst (top_emails, email_detail,
// top_ads, top_posts). Every one reads only the clients the person may see on that line, the boards' own rule: the
// email and social teams their own line (their seats; a head the whole line), a Meta or Google buyer their own
// accounts, executives and leads everything. Read only.

const nyToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const num = (v: unknown) => (v == null || v === "" ? 0 : Number(v) || 0);
const SERVICE: Record<"email" | "social", string> = { email: "email-marketing", social: "social-media" };
const SEAT_ROLES: Record<"meta" | "google", string[]> = { meta: ["meta_buyer"], google: ["google_buyer"] };
type Client = { id: string; name: string; slug: string };

/** Every line's lines this person may rank, and a clear error when they ask for another */
function linesOf(ctx: ToolCtx): RankLine[] {
  return rankLinesFor(ctx.me, lineOfTeam(ctx.me.role), teamPlatform(ctx.me.role));
}
function lineFrom(ctx: ToolCtx, v: unknown): RankLine {
  const lines = linesOf(ctx);
  const asked = String(v ?? "").toLowerCase() as RankLine;
  if (!asked) return lines[0];
  if (!lines.includes(asked)) throw new Error(`You can rank ${lines.join(" and ")} clients only.`);
  return asked;
}

/** Read every page of a query (the API stops at a thousand rows a request) */
async function pages<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null }>, max = 20): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < max; p++) {
    const { data } = await page(p * 1000, p * 1000 + 999);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** The live clients on an email or social line the person may see (their session decides, then the channel rule) */
async function channelClients(ctx: ToolCtx, line: "email" | "social"): Promise<Client[]> {
  const { data } = await ctx.db.from("clients").select("id, name, slug, services, services_extra, services_removed").is("archived_at", null).in("status", [...LIVE]).order("name");
  const rows = (data ?? []).filter((c) => (servicesOf(c as Parameters<typeof servicesOf>[0]) as string[]).includes(SERVICE[line]));
  if (!isChannelOnly(ctx.me.role)) return rows.map((c) => ({ id: c.id as string, name: c.name as string, slug: c.slug as string }));
  const { data: seats } = await ctx.db.from("client_assignments").select("client_id").eq("profile_id", ctx.me.id);
  const mine = new Set((seats ?? []).map((s) => s.client_id as string));
  return rows
    .filter((c) => channelMaySee({ id: ctx.me.id, role: ctx.me.role }, { archived: false, services: servicesOf(c as Parameters<typeof servicesOf>[0]) as string[], seatHolders: mine.has(c.id as string) ? [ctx.me.id] : [] }))
    .map((c) => ({ id: c.id as string, name: c.name as string, slug: c.slug as string }));
}

type Target = { id: string; client_id: string; label: string | null; conversion: string | null; target: number | null; client: Client };

/** The KPI cards on Meta or Google the person may see: a buyer only the accounts they own or hold the seat on (the KPI board's rule) */
async function adTargets(ctx: ToolCtx, platform: "meta" | "google"): Promise<Target[]> {
  const { data } = await ctx.db
    .from("kpi_targets")
    .select("id, client_id, platform, label, conversion, target, owner_id, clients!inner(id, name, slug, archived_at)")
    .eq("active", true)
    .eq("platform", platform)
    .is("clients.archived_at", null);
  let rows = (data ?? []) as unknown as (Omit<Target, "client"> & { owner_id: string | null; clients: Client })[];
  const team = teamPlatform(ctx.me.role);
  if (team && !ctx.me.isExec && !ctx.me.isLead) {
    const { data: seats } = await ctx.db.from("client_assignments").select("client_id").eq("profile_id", ctx.me.id).in("role", SEAT_ROLES[platform]);
    const seated = new Set((seats ?? []).map((s) => s.client_id as string));
    rows = rows.filter((t) => t.owner_id === ctx.me.id || seated.has(t.client_id));
  }
  return rows.map((t) => ({ id: t.id, client_id: t.client_id, label: t.label, conversion: t.conversion, target: t.target == null ? null : Number(t.target), client: t.clients }));
}

// ─── rank_clients ─────────────────────────────────────────────────────────

async function rankEmail(ctx: ToolCtx, clients: Client[], metric: string, period: RankPeriod): Promise<RankEntry[]> {
  const ids = clients.map((c) => c.id);
  const range = periodRange(period, nyToday());
  if (metric === "score" || metric === "revenue_pace") {
    const board = await loadChannelBoard(ctx.db, "email", ctx.me, ids);
    return board.rows.map((r) => {
      if (metric === "score") {
        const s = r.score;
        const down = s?.weighingDown?.[0]?.label;
        return { client: r.name, value: s ? s.score : null, shown: s ? `score ${Math.round(s.score)} of 100` : "no score yet", why: s ? `${s.band === "good" ? "Green" : s.band === "watch" ? "Yellow" : "Red"}${down ? `; held back most by ${down.toLowerCase()}` : ""} (last 30 days)` : "Not connected or nothing read yet" };
      }
      return { client: r.name, value: r.ratio, shown: r.ratio == null ? "no target pace" : `${Math.round(r.ratio * 100)}% of the month's target pace`, why: r.projected != null && r.target != null ? `On pace for ${moneyWords(r.projected, r.currency)} against ${moneyWords(r.target, r.currency)} this month` : "No revenue target this month" };
    });
  }
  if (metric === "attributed_revenue") {
    const days = await pages<Record<string, unknown>>((a, b) => ctx.db.from("klaviyo_daily").select("client_id, date, revenue, campaign_revenue, flow_revenue").in("client_id", ids).gte("date", range.from).lte("date", range.to).order("client_id").order("date").range(a, b));
    return clients.map((c) => {
      const mine = days.filter((d) => d.client_id === c.id);
      const rev = sumDays(mine, "revenue", range.from, range.to);
      const camp = sumDays(mine, "campaign_revenue", range.from, range.to) ?? 0;
      const flow = sumDays(mine, "flow_revenue", range.from, range.to) ?? 0;
      return { client: c.name, value: rev, shown: rev == null ? "no data" : moneyWords(rev), why: rev == null ? "No email numbers synced" : `${moneyWords(camp)} from campaigns and ${moneyWords(flow)} from flows, ${range.label}` };
    });
  }
  // From the campaigns sent in the period: revenue per recipient, open rate, click rate
  const camps = await pages<Record<string, unknown>>((a, b) =>
    ctx.db.from("klaviyo_campaigns").select("client_id, channel, recipients, delivered, opens_unique, clicks_unique, revenue").in("client_id", ids).gte("send_time", `${range.from}T00:00:00Z`).order("client_id").order("campaign_id").range(a, b),
  );
  return clients.map((c) => {
    const em = camps.filter((x) => x.client_id === c.id && x.channel !== "sms" && num(x.recipients) > 0);
    const recipients = em.reduce((s, x) => s + num(x.recipients), 0);
    const delivered = em.reduce((s, x) => s + (num(x.delivered) || num(x.recipients)), 0);
    if (!em.length) return { client: c.name, value: null, shown: "no campaigns", why: `No email campaigns ${range.label}` };
    const sent = `${em.length} campaign${em.length === 1 ? "" : "s"} ${range.label}`;
    if (metric === "revenue_per_recipient") {
      const rpr = recipients ? em.reduce((s, x) => s + num(x.revenue), 0) / recipients : null;
      return { client: c.name, value: rpr, shown: rpr == null ? "n/a" : `$${rpr.toFixed(2)} per recipient`, why: `Campaign revenue over ${recipients.toLocaleString("en-US")} recipients, ${sent}` };
    }
    const hits = em.reduce((s, x) => s + num(metric === "open_rate" ? x.opens_unique : x.clicks_unique), 0);
    const rate = delivered ? hits / delivered : null;
    return { client: c.name, value: rate, shown: rate == null ? "n/a" : `${pctWords(rate, metric === "open_rate" ? 1 : 2)} ${metric === "open_rate" ? "open" : "click"} rate`, why: sent };
  });
}

async function rankSocial(ctx: ToolCtx, clients: Client[], metric: string, period: RankPeriod): Promise<RankEntry[]> {
  const ids = clients.map((c) => c.id);
  if (metric === "score") {
    const board = await loadChannelBoard(ctx.db, "social", ctx.me, ids);
    return board.rows.map((r) => ({ client: r.name, value: r.ratio, shown: r.ratio == null ? "no target" : `${Math.round(r.ratio * 100)}% of the engagement target`, why: r.value != null ? `Engagement ${pctWords(r.value, 2)} ${r.basis === "month" ? "this month" : "over the last 30 days"}` : "Not linked or nothing read yet" }));
  }
  const range = periodRange(period, nyToday());
  const days = await pages<Record<string, unknown>>((a, b) => ctx.db.from("social_daily").select("client_id, platform, date, reach, interactions, follows_gained, follows_lost").in("client_id", ids).gte("date", range.from).lte("date", range.to).order("client_id").order("date").range(a, b));
  return clients.map((c) => {
    const mine = days.filter((d) => d.client_id === c.id);
    if (metric === "followers_gained") {
      const g = sumDays(mine, "follows_gained", range.from, range.to);
      const l = sumDays(mine, "follows_lost", range.from, range.to) ?? 0;
      const net = g == null ? null : g - l;
      return { client: c.name, value: net, shown: net == null ? "no data" : `${net >= 0 ? "+" : ""}${net.toLocaleString("en-US")} followers`, why: net == null ? "Not linked or nothing read yet" : `${(g ?? 0).toLocaleString("en-US")} gained, ${l.toLocaleString("en-US")} lost, ${range.label}` };
    }
    const reach = sumDays(mine, "reach", range.from, range.to);
    const inter = sumDays(mine, "interactions", range.from, range.to);
    const rate = reach && inter != null ? inter / reach : null;
    return { client: c.name, value: rate, shown: rate == null ? "no data" : `${pctWords(rate, 2)} engagement`, why: rate == null ? "Not linked or nothing read yet" : `${(inter ?? 0).toLocaleString("en-US")} interactions on ${(reach ?? 0).toLocaleString("en-US")} reach, ${range.label}` };
  });
}

async function rankAds(ctx: ToolCtx, platform: "meta" | "google", metric: string, period: RankPeriod): Promise<RankEntry[]> {
  const targets = await adTargets(ctx, platform);
  if (!targets.length) return [];
  const { data: snaps } = await ctx.db.from("kpi_snapshots").select("target_id, deviation, status, windows, months").in("target_id", targets.map((t) => t.id));
  const by = new Map((snaps ?? []).map((s) => [s.target_id as string, s]));
  const many = new Map<string, number>();
  for (const t of targets) many.set(t.client_id, (many.get(t.client_id) ?? 0) + 1);
  const key = period === "month" ? "mtd" : `d${period}`;
  const label = period === "month" ? "this month so far" : `the last ${period} days`;
  return targets.map((t) => {
    const s = by.get(t.id);
    const name = (many.get(t.client_id) ?? 0) > 1 && t.label ? `${t.client.name} (${t.label})` : t.client.name;
    const w = (s ? ((period === "month" ? (s.months as Record<string, unknown>)?.[key] : (s.windows as Record<string, unknown>)?.[key]) ?? null) : null) as { spend?: number; results?: number; value?: number | null; revenue?: number } | null;
    const spend = w ? num(w.spend) : null;
    const results = w ? num(w.results) : null;
    const line = w ? `${moneyWords(spend ?? 0)} spent, ${Math.round(results ?? 0).toLocaleString("en-US")} results ${label}` : "No numbers read yet";
    if (metric === "kpi_vs_target") {
      const v = t.target == null ? { value: null, shown: "no KPI target" } : vsTarget(s?.deviation == null ? null : Number(s.deviation));
      return { client: name, ...v, why: `${s?.status ? `${String(s.status)} on the last 14 days` : "Not read yet"}; ${line}` };
    }
    if (metric === "spend") return { client: name, value: spend, shown: spend == null ? "no data" : moneyWords(spend), why: line };
    if (metric === "results") return { client: name, value: results, shown: results == null ? "no data" : `${Math.round(results).toLocaleString("en-US")} results`, why: line };
    // Meta: the window's value is cost per result (or ROAS on a ROAS KPI). Google: ROAS from the attributed conversion value, only when it looks real
    if (platform === "google") {
      const gv = w ? conversionValue({ spend: spend ?? 0, conversions: num(w.results), value: w.revenue }) : null;
      const none = !w ? "no data" : w.revenue == null ? "not read yet (next sync)" : gv?.tracked ? "no spend" : "value not tracked (tracking fix needed)";
      return { client: name, value: gv?.roas ?? null, shown: gv?.roas == null ? none : `${gv.roas.toFixed(2)}x ROAS`, why: gv?.tracked && gv.revenue != null ? `${line}; ${moneyWords(gv.revenue)} conversion value` : line };
    }
    const roas = w && w.value != null && spend ? num(w.value) / spend : null;
    return { client: name, value: roas, shown: roas == null ? "no ROAS (not a sales account)" : `${roas.toFixed(2)}x ROAS`, why: line };
  });
}

// ─── Single emails, ads and posts ─────────────────────────────────────────

const EMAIL_BARS = Object.fromEntries(EMAIL_CHECKS.map((c) => [c.key, c.bar])) as Record<string, number>;

/** An email's HTML read for what it's made of: headline, buttons, pictures, links, length */
function emailParts(html: string | null) {
  if (!html) return null;
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 5);
  const buttons = [...html.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()).filter((t) => t && t.length <= 40).slice(0, 8);
  return {
    words: text ? text.split(" ").length : 0,
    pictures: (html.match(/<img\b/gi) ?? []).length,
    links: (html.match(/<a\b/gi) ?? []).length,
    headings,
    buttons_and_links: buttons,
    opening_text: text.slice(0, 600),
  };
}

const NY_TIME = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function rankTools(ctx: ToolCtx): ChatTool[] {
  const PERIOD = { type: "string", enum: ["7", "30", "90", "month"], description: "The last 7, 30 or 90 days, or this month so far (default 30)" };
  const ORDER = { type: "string", enum: ["top", "bottom"], description: "Best first (top) or worst first (bottom). Default top." };
  const LIMIT = { type: "integer", minimum: 1, maximum: 25, description: "How many (default 3)" };
  const lines = linesOf(ctx);
  return [
    {
      name: "rank_clients",
      description: `Ranks the clients the person may see on one line by one number: the top or bottom few with each client's number and a one-line why. Lines and metrics: email (score: the account score, the main email KPI; attributed_revenue; revenue_pace: this month against the revenue target; revenue_per_recipient; open_rate; click_rate), social (score: engagement against its target; engagement; followers_gained), meta and google (kpi_vs_target: the 14 day KPI against target; spend; results; roas). Use it for "top three clients", "who's doing worst on email", "best ROAS this month". This person may rank: ${lines.join(", ")}.`,
      input_schema: {
        type: "object",
        properties: { line: { type: "string", enum: lines }, metric: { type: "string", description: "One of the line's metrics above (default: its main KPI)" }, period: PERIOD, order: ORDER, limit: LIMIT },
        required: ["line"],
        additionalProperties: false,
      },
      status: (input) => `Ranking ${String(input.line ?? "")} clients…`,
      run: async (input) => {
        const line = lineFrom(ctx, input.line);
        const metric = RANK_METRICS[line].includes(String(input.metric ?? "")) ? String(input.metric) : DEFAULT_METRIC[line];
        const period = asPeriod(input.period);
        const order = input.order === "bottom" ? "bottom" : "top";
        const rows = line === "email" || line === "social" ? await (async () => {
          const clients = await channelClients(ctx, line);
          if (!clients.length) return [];
          return line === "email" ? rankEmail(ctx, clients, metric, period) : rankSocial(ctx, clients, metric, period);
        })() : await rankAds(ctx, line, metric, period);
        const { ranked, without } = rankEntries(rows, order, Number(input.limit) || 3);
        return {
          line,
          metric,
          period: metric === "score" || metric === "revenue_pace" || metric === "kpi_vs_target" ? "its own window (said in each why)" : periodRange(period, nyToday()).label,
          order,
          clients_ranked_from: rows.length,
          left_out_without_a_number: without,
          ranking: ranked.map((r) => ({ rank: r.rank, client: r.client, number: r.shown, why: r.why })),
        };
      },
    },
    {
      name: "top_emails",
      description:
        "Ranks single emails (campaigns, or flows) across the email clients the person may see (or one client), by click_rate, open_rate, revenue, revenue_per_recipient or orders, with each one's numbers and a link to it. Use for 'best performing email', 'worst subject lines this month', 'which flows make the most'. Designers and copywriters lead with click rate; strategists with revenue per recipient. Small sends are left out (min_recipients). Then email_detail explains one.",
      input_schema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["campaigns", "flows"], description: "Default campaigns" },
          metric: { type: "string", enum: ["click_rate", "open_rate", "revenue", "revenue_per_recipient", "orders"] },
          period: PERIOD,
          order: ORDER,
          limit: LIMIT,
          client: { type: "string", description: "Only this client (name). Leave out for every email client they may see." },
          channel: { type: "string", enum: ["email", "sms"], description: "Campaigns only: default email" },
          min_recipients: { type: "integer", minimum: 0, description: "Leave out sends smaller than this (default 500)" },
        },
        required: ["metric"],
        additionalProperties: false,
      },
      status: () => "Ranking emails…",
      run: async (input) => {
        if (!linesOf(ctx).includes("email")) throw new Error("Email numbers aren't on your line.");
        let clients = await channelClients(ctx, "email");
        const asked = String(input.client ?? "").trim().toLowerCase();
        if (asked) clients = clients.filter((c) => c.name.toLowerCase().includes(asked) || c.slug === asked);
        if (!clients.length) return { emails: [], note: asked ? `No email client called "${input.client}" that you can see.` : "No email clients you can see." };
        const nameOf = new Map(clients.map((c) => [c.id, c.name]));
        const ids = clients.map((c) => c.id);
        const metric = String(input.metric ?? "click_rate");
        const order = input.order === "bottom" ? "bottom" : "top";
        const min = input.min_recipients == null ? 500 : Math.max(0, Number(input.min_recipients) || 0);
        if (input.kind === "flows") {
          const long = input.period === "90";
          const flows = await pages<Record<string, unknown>>((a, b) => ctx.db.from("klaviyo_flows").select("client_id, flow_id, name, status, trigger_type, revenue_30, recipients_30, open_rate_30, click_rate_30, conversions_30, revenue_90, recipients_90, open_rate_90, click_rate_90, conversions_90").in("client_id", ids).order("client_id").order("flow_id").range(a, b));
          const sfx = long ? "_90" : "_30";
          const entries = flows
            .filter((f) => num(f[`recipients${sfx}`]) >= min)
            .map((f) => {
              const rec = num(f[`recipients${sfx}`]);
              const rev = num(f[`revenue${sfx}`]);
              const v = metric === "open_rate" ? f[`open_rate${sfx}`] : metric === "click_rate" ? f[`click_rate${sfx}`] : metric === "revenue" ? rev : metric === "orders" ? f[`conversions${sfx}`] : rec ? rev / rec : null;
              return { f, value: v == null ? null : Number(v), rec, rev };
            })
            .filter((e) => e.value != null && Number.isFinite(e.value));
          entries.sort((a, b) => (order === "top" ? (b.value as number) - (a.value as number) : (a.value as number) - (b.value as number)));
          return {
            kind: "flows",
            window: long ? "last 90 days" : "last 30 days",
            metric,
            emails: entries.slice(0, Math.min(25, Number(input.limit) || 3)).map((e, i) => ({
              rank: i + 1,
              client: nameOf.get(e.f.client_id as string),
              flow: e.f.name,
              status: e.f.status,
              trigger: e.f.trigger_type,
              recipients: e.rec,
              open_rate_pct: e.f[`open_rate${sfx}`] == null ? null : Math.round(num(e.f[`open_rate${sfx}`]) * 1000) / 10,
              click_rate_pct: e.f[`click_rate${sfx}`] == null ? null : Math.round(num(e.f[`click_rate${sfx}`]) * 10000) / 100,
              revenue: Math.round(e.rev),
              revenue_per_recipient: e.rec ? Math.round((e.rev / e.rec) * 100) / 100 : null,
            })),
          };
        }
        const range = periodRange(asPeriod(input.period), nyToday());
        const channel = input.channel === "sms" ? "sms" : "email";
        const camps = await pages<Record<string, unknown>>((a, b) =>
          ctx.db.from("klaviyo_campaigns").select("client_id, campaign_id, name, channel, send_time, audiences, subject, preview_text, recipients, delivered, opens_unique, clicks_unique, conversions, revenue, source").in("client_id", ids).gte("send_time", `${range.from}T00:00:00Z`).order("client_id").order("campaign_id").range(a, b),
        );
        const entries = camps
          .filter((x) => (channel === "sms" ? x.channel === "sms" : x.channel !== "sms") && num(x.recipients) >= Math.max(1, min))
          .map((x) => {
            const delivered = num(x.delivered) || num(x.recipients);
            const open = delivered ? num(x.opens_unique) / delivered : null;
            const click = delivered ? num(x.clicks_unique) / delivered : null;
            const rpr = num(x.recipients) ? num(x.revenue) / num(x.recipients) : null;
            const value = metric === "open_rate" ? open : metric === "click_rate" ? click : metric === "revenue" ? num(x.revenue) : metric === "orders" ? num(x.conversions) : rpr;
            return { x, value, open, click, rpr };
          })
          .filter((e) => e.value != null && Number.isFinite(e.value));
        entries.sort((a, b) => (order === "top" ? (b.value as number) - (a.value as number) : (a.value as number) - (b.value as number)));
        return {
          kind: "campaigns",
          period: range.label,
          metric,
          compared: entries.length,
          emails: entries.slice(0, Math.min(25, Number(input.limit) || 3)).map((e, i) => ({
            rank: i + 1,
            client: nameOf.get(e.x.client_id as string),
            campaign_id: e.x.campaign_id,
            subject: e.x.subject ?? e.x.name,
            preview_text: e.x.preview_text,
            sent: e.x.send_time ? NY_TIME(String(e.x.send_time)) : null,
            audiences: e.x.audiences,
            recipients: num(e.x.recipients),
            open_rate_pct: e.open == null ? null : Math.round(e.open * 1000) / 10,
            click_rate_pct: e.click == null ? null : Math.round(e.click * 10000) / 100,
            revenue: Math.round(num(e.x.revenue)),
            revenue_per_recipient: e.rpr == null ? null : Math.round(e.rpr * 100) / 100,
            link: (e.x.source ?? "klaviyo") === "klaviyo" ? klaviyoCampaignUrl(String(e.x.campaign_id)) : null,
          })),
        };
      },
    },
    {
      name: "email_detail",
      description:
        "Why one email campaign worked (or didn't): its subject and preview text, what the email is made of (headline, buttons, pictures, length, opening text), the offer, audience and send time, its open, click and revenue numbers against the client's own 90 day campaign average and against Kaizen's bars. Give the client and the campaign_id from top_emails (or a subject to find it).",
      input_schema: { type: "object", properties: { client: { type: "string" }, campaign_id: { type: "string" }, subject: { type: "string", description: "Words from the subject, when there's no campaign_id" } }, required: ["client"], additionalProperties: false },
      status: (input) => `Reading the email for ${String(input.client ?? "the client")}…`,
      run: async (input) => {
        if (!linesOf(ctx).includes("email")) throw new Error("Email numbers aren't on your line.");
        const asked = String(input.client ?? "").trim().toLowerCase();
        const client = (await channelClients(ctx, "email")).find((c) => c.name.toLowerCase() === asked || c.slug === asked) ?? (await channelClients(ctx, "email")).find((c) => c.name.toLowerCase().includes(asked));
        if (!client) throw new Error(`No email client called "${input.client}" that you can see.`);
        const since = periodRange("90", nyToday()).from;
        const { data: camps } = await ctx.db.from("klaviyo_campaigns").select("campaign_id, name, channel, send_time, audiences, subject, preview_text, recipients, delivered, opens_unique, clicks_unique, unsubscribes, spam_complaints, conversions, revenue, source").eq("client_id", client.id).gte("send_time", `${since}T00:00:00Z`).order("send_time", { ascending: false }).limit(400);
        const all = (camps ?? []).filter((x) => x.channel !== "sms" && num(x.recipients) > 0);
        const words = String(input.subject ?? "").toLowerCase().trim();
        const one = all.find((x) => x.campaign_id === input.campaign_id) ?? (words ? all.find((x) => String(x.subject ?? x.name ?? "").toLowerCase().includes(words)) : null);
        if (!one) throw new Error("That campaign isn't among this client's emails from the last 90 days. Use top_emails to find it.");
        const rate = (rows: typeof all, k: "opens_unique" | "clicks_unique") => {
          const d = rows.reduce((s, x) => s + (num(x.delivered) || num(x.recipients)), 0);
          return d ? rows.reduce((s, x) => s + num(x[k]), 0) / d : null;
        };
        const rprOf = (rows: typeof all) => {
          const r = rows.reduce((s, x) => s + num(x.recipients), 0);
          return r ? rows.reduce((s, x) => s + num(x.revenue), 0) / r : null;
        };
        const pct = (x: number | null, d = 1) => (x == null ? null : Math.round(x * 100 * 10 ** d) / 10 ** d);
        const { data: prev } = await ctx.db.from("klaviyo_previews").select("html, body").eq("client_id", client.id).eq("campaign_id", one.campaign_id).maybeSingle();
        const parts = emailParts((prev?.html as string | null) ?? null);
        return {
          client: client.name,
          campaign: { subject: one.subject ?? one.name, preview_text: one.preview_text, name: one.name, sent: one.send_time ? NY_TIME(String(one.send_time)) : null, audiences: one.audiences, recipients: num(one.recipients) },
          numbers: { open_rate_pct: pct(rate([one], "opens_unique")), click_rate_pct: pct(rate([one], "clicks_unique"), 2), revenue: Math.round(num(one.revenue)), orders: num(one.conversions), revenue_per_recipient: rprOf([one]) == null ? null : Math.round((rprOf([one]) as number) * 100) / 100, unsubscribes: num(one.unsubscribes), spam_complaints: num(one.spam_complaints) },
          account_average_90d: { campaigns: all.length, open_rate_pct: pct(rate(all, "opens_unique")), click_rate_pct: pct(rate(all, "clicks_unique"), 2), revenue_per_recipient: rprOf(all) == null ? null : Math.round((rprOf(all) as number) * 100) / 100 },
          kaizen_bars: { campaign_open_rate_pct: pct(EMAIL_BARS.campaignOpen ?? null), campaign_click_rate_pct: pct(EMAIL_BARS.campaignClick ?? null, 2), revenue_per_recipient: EMAIL_BARS.rpr ?? null },
          what_the_email_is_made_of: parts ?? (prev?.body ? { plain_text: String(prev.body).slice(0, 1200) } : "No preview saved yet: judge from the subject, preview text and numbers."),
          link: (one.source ?? "klaviyo") === "klaviyo" ? klaviyoCampaignUrl(String(one.campaign_id)) : null,
        };
      },
    },
    {
      name: "top_ads",
      description: "Ranks single Meta ads across the clients the person may see (or one client) by ctr, roas, spend or cost_per_purchase over the last 7, 14 or 30 days, with each ad's numbers. Use for 'best performing ad', 'which creative has the best CTR'. Ads with little spend are left out (min_spend).",
      input_schema: {
        type: "object",
        properties: { metric: { type: "string", enum: ["ctr", "roas", "spend", "cost_per_purchase"] }, days: { type: "integer", enum: [7, 14, 30] }, order: ORDER, limit: LIMIT, client: { type: "string" }, min_spend: { type: "number", description: "Default 100" } },
        required: ["metric"],
        additionalProperties: false,
      },
      status: () => "Ranking ads…",
      run: async (input) => {
        if (!linesOf(ctx).includes("meta")) throw new Error("Meta ads aren't on your line.");
        let targets = await adTargets(ctx, "meta");
        const asked = String(input.client ?? "").trim().toLowerCase();
        if (asked) targets = targets.filter((t) => t.client.name.toLowerCase().includes(asked) || t.client.slug === asked);
        const ids = [...new Set(targets.map((t) => t.client_id))];
        if (!ids.length) return { ads: [], note: "No Meta accounts you can see." };
        const names = new Map(targets.map((t) => [t.client_id, t.client.name]));
        const days = [7, 14, 30].includes(Number(input.days)) ? Number(input.days) : 14;
        const until = new Date(Date.parse(`${nyToday()}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
        const from = new Date(Date.parse(`${until}T12:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
        const rows = await pages<Record<string, unknown>>((a, b) => ctx.admin.from("meta_ad_daily").select("client_id, ad_id, ad_name, campaign_name, metrics").in("client_id", ids).gte("date", from).lte("date", until).order("client_id").order("date").range(a, b), 40);
        const act = (v: unknown, types: string[]) => {
          const list = (v ?? []) as { action_type: string; value: string }[];
          for (const t of types) {
            const hit = list.find((a) => a.action_type === t);
            if (hit) return num(hit.value);
          }
          return 0;
        };
        const agg = new Map<string, { client: string; ad: string; campaign: string; spend: number; imp: number; clicks: number; buys: number; value: number }>();
        for (const r of rows) {
          const k = `${r.client_id}:${r.ad_id}`;
          const m = (r.metrics ?? {}) as Record<string, unknown>;
          const a = agg.get(k) ?? { client: names.get(r.client_id as string) ?? "", ad: String(r.ad_name ?? r.ad_id), campaign: String(r.campaign_name ?? ""), spend: 0, imp: 0, clicks: 0, buys: 0, value: 0 };
          a.spend += num(m.spend);
          a.imp += num(m.impressions);
          a.clicks += num(m.inline_link_clicks ?? m.clicks);
          a.buys += act(m.actions, ["omni_purchase", "purchase"]);
          a.value += act(m.action_values, ["omni_purchase", "purchase"]);
          agg.set(k, a);
        }
        const min = input.min_spend == null ? 100 : Number(input.min_spend) || 0;
        const metric = String(input.metric);
        const list = [...agg.values()]
          .filter((a) => a.spend >= min)
          .map((a) => ({ a, value: metric === "ctr" ? (a.imp ? a.clicks / a.imp : null) : metric === "roas" ? (a.spend && a.value ? a.value / a.spend : null) : metric === "spend" ? a.spend : a.buys ? -(a.spend / a.buys) : null }))
          .filter((e) => e.value != null);
        list.sort((x, y) => (input.order === "bottom" ? (x.value as number) - (y.value as number) : (y.value as number) - (x.value as number)));
        return {
          days,
          metric,
          compared: list.length,
          ads: list.slice(0, Math.min(25, Number(input.limit) || 3)).map(({ a }, i) => ({ rank: i + 1, client: a.client, ad: a.ad, campaign: a.campaign, spend: Math.round(a.spend), ctr_pct: a.imp ? Math.round((a.clicks / a.imp) * 10000) / 100 : null, purchases: Math.round(a.buys), roas: a.spend && a.value ? Math.round((a.value / a.spend) * 100) / 100 : null, cost_per_purchase: a.buys ? Math.round((a.spend / a.buys) * 100) / 100 : null })),
          note: rows.length >= 40_000 ? "Only the first 40,000 day rows were read: name a client for the full picture." : undefined,
        };
      },
    },
    {
      name: "top_posts",
      description: "Ranks single organic Facebook and Instagram posts across the social clients the person may see (or one client) by engagement (interactions over reach), interactions, reach or saves, with each post's numbers, format and link. Use for 'best performing post', 'what reels worked this month'.",
      input_schema: {
        type: "object",
        properties: { metric: { type: "string", enum: ["engagement", "interactions", "reach", "saves"] }, period: PERIOD, order: ORDER, limit: LIMIT, client: { type: "string" }, min_reach: { type: "integer", minimum: 0, description: "Default 200" } },
        required: ["metric"],
        additionalProperties: false,
      },
      status: () => "Ranking posts…",
      run: async (input) => {
        if (!linesOf(ctx).includes("social")) throw new Error("Organic social isn't on your line.");
        let clients = await channelClients(ctx, "social");
        const asked = String(input.client ?? "").trim().toLowerCase();
        if (asked) clients = clients.filter((c) => c.name.toLowerCase().includes(asked) || c.slug === asked);
        if (!clients.length) return { posts: [], note: "No social clients you can see." };
        const names = new Map(clients.map((c) => [c.id, c.name]));
        const range = periodRange(asPeriod(input.period), nyToday());
        const posts = await pages<Record<string, unknown>>((a, b) => ctx.db.from("social_posts").select("client_id, platform, post_id, format, caption, permalink, posted_at, reach, interactions, saves, shares, comments").in("client_id", [...names.keys()]).gte("posted_at", `${range.from}T00:00:00Z`).order("client_id").order("post_id").range(a, b));
        const min = input.min_reach == null ? 200 : Number(input.min_reach) || 0;
        const metric = String(input.metric);
        const list = posts
          .filter((p) => num(p.reach) >= min)
          .map((p) => ({ p, value: metric === "engagement" ? (num(p.reach) ? num(p.interactions) / num(p.reach) : null) : num(p[metric]) }))
          .filter((e) => e.value != null);
        list.sort((x, y) => (input.order === "bottom" ? (x.value as number) - (y.value as number) : (y.value as number) - (x.value as number)));
        return {
          period: range.label,
          metric,
          compared: list.length,
          posts: list.slice(0, Math.min(25, Number(input.limit) || 3)).map(({ p }, i) => ({ rank: i + 1, client: names.get(p.client_id as string), platform: p.platform, format: p.format, posted: p.posted_at ? NY_TIME(String(p.posted_at)) : null, caption: String(p.caption ?? "").slice(0, 200), reach: num(p.reach), interactions: num(p.interactions), saves: num(p.saves), shares: num(p.shares), comments: num(p.comments), engagement_pct: num(p.reach) ? Math.round((num(p.interactions) / num(p.reach)) * 10000) / 100 : null, link: p.permalink })),
        };
      },
    },
  ];
}

