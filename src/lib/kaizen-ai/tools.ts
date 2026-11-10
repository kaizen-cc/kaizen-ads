import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import type { AiTool } from "@/lib/ai";
import { conversionFor } from "@/lib/kpi/conversions";
import { shownStatus } from "@/lib/kpi/calc";
import { extensionTools } from "./extensions";
import { clampFormats, formatList, formatsFor, formatsRule } from "@/lib/creative-formats";
import { can, roleWidePerms, type Who } from "@/lib/chat-permissions";
import type { Attachment, BriefCard, Card, CopyCard, CopyField, MetricsCard, MetricsRow } from "./types";

// What Kaizen AI can look up and do. Every tool runs on the server with the person's own permissions: a client is only
// reachable when the person can see it (read through their own session, row-level security), reports follow the
// report rules, and ad account changes are only planned here (the plan card asks someone allowed to confirm before
// anything is written). Each tool says what it's doing ("Reading Meta data for Sierra Dreams…") and tools that have
// something to show return a card (a metrics table, a copy set, a brief, a report link, a change plan).

export type ToolCtx = {
  me: Staff;
  db: SupabaseClient; // the person's own session: what they may see
  admin: SupabaseClient; // the server's rights, only after the person's access is checked
  clientId: string | null; // the thread's client
  messageId: string; // the assistant message the cards belong to
  cards: Card[];
  files: Attachment[]; // attached to the newest message
  /** "<client id>|<platform>" whose copy context is already in the system prompt (so write_ad_copy doesn't send it again) */
  copyContextFor?: string | null;
};

/** A tool plus the line shown while it runs */
export type ChatTool = AiTool & { status: (input: Record<string, unknown>, client: string | null) => string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const nyToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const num = (v: unknown) => (v == null || v === "" ? 0 : Number(v) || 0);
const r2 = (x: number | null) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const CLIENT = { type: "string", description: "The client's name (or slug). Leave out to use the client the thread is pinned to." };

type ClientRow = { id: string; name: string; slug: string };
const names = new Map<string, string>();

/** The client the tool is about, if the person can see it (their own session decides) */
async function clientOf(ctx: ToolCtx, input: Record<string, unknown>): Promise<ClientRow> {
  const asked = String(input.client ?? "").trim();
  let q = ctx.db.from("clients").select("id, name, slug").is("archived_at", null);
  if (asked) {
    const safe = asked.replace(/[%_,()]/g, " ").trim();
    const { data } = await ctx.db.from("clients").select("id, name, slug").or(`slug.eq.${safe.toLowerCase().replace(/\s+/g, "-")},name.ilike.%${safe}%`).limit(5);
    const exact = (data ?? []).find((c) => c.name.toLowerCase() === asked.toLowerCase() || c.slug === asked.toLowerCase());
    const hit = exact ?? (data ?? [])[0];
    if (!hit) throw new Error(`No client called "${asked}" that you can see. Use list_clients to find the right name.`);
    names.set(hit.id, hit.name);
    return hit as ClientRow;
  }
  if (!ctx.clientId) throw new Error("Which client? Name the client (or pin one to the thread).");
  q = q.eq("id", ctx.clientId);
  const { data } = await q.maybeSingle();
  if (!data) throw new Error("You can't see this client.");
  names.set(data.id, data.name);
  return data as ClientRow;
}

const nameFor = (ctx: ToolCtx, input: Record<string, unknown>) => (String(input.client ?? "").trim() || (ctx.clientId ? (names.get(ctx.clientId) ?? null) : null));

// ─── Client context (cached a few minutes per client) ──────────────────────

const briefCache = new Map<string, { at: number; text: string }>();
/** The client's whole context: Brand Bible, strategy, rules, memory, learnings, what's happening now (newest first) */
export async function clientBrief(admin: SupabaseClient, clientId: string) {
  const hit = briefCache.get(clientId);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.text;
  const { accountBrief } = await import("@/lib/handoff");
  // A fresh read of their Slack first (at most two seconds, once a minute per client)
  const b = await accountBrief(admin, clientId, null, true);
  const text = b.text.slice(0, 160_000);
  briefCache.set(clientId, { at: Date.now(), text });
  return text;
}

// ─── Meta numbers from the synced daily rows ────────────────────────────────

type AdDay = { date: string; ad_id: string; ad_name: string; adset_id: string; adset_name: string; campaign_id: string; campaign_name: string; metrics: Record<string, unknown> };
const FALLBACK_RESULTS = ["omni_purchase", "purchase", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead", "lead", "complete_registration", "schedule_total", "landing_page_view", "link_click"];
const actionMap = (v: unknown) => Object.fromEntries(((v ?? []) as { action_type: string; value: string }[]).map((a) => [a.action_type, num(a.value)]));

function resultType(rows: AdDay[], conversion: string | null) {
  const conv = conversion ? conversionFor(conversion) : null;
  const prefs = [...(conv?.types?.filter((t) => t !== "campaign_goal") ?? []), ...FALLBACK_RESULTS];
  for (const t of prefs) if (rows.some((r) => num(actionMap(r.metrics.actions)[t]) > 0)) return { type: t, roas: Boolean(conv?.roas) || /purchase/.test(t) };
  return { type: prefs[0] ?? null, roas: Boolean(conv?.roas) };
}

function sumRows(rows: AdDay[], type: string | null, roas: boolean, name: string): MetricsRow {
  let spend = 0, impressions = 0, reach = 0, clicks = 0, results = 0, value = 0;
  for (const r of rows) {
    const m = r.metrics;
    spend += num(m.spend);
    impressions += num(m.impressions);
    reach += num(m.reach);
    clicks += num(m.inline_link_clicks ?? m.clicks);
    if (type) {
      results += num(actionMap(m.actions)[type]);
      value += num(actionMap(m.action_values)[type]);
    }
  }
  return {
    name,
    spend: r2(spend) ?? 0,
    results: type ? r2(results) : null,
    cpr: results ? r2(spend / results) : null,
    roas: roas && spend ? r2(value / spend) : null,
    ctr: impressions ? r2((clicks / impressions) * 100) : null,
    cpm: impressions ? r2((spend / impressions) * 1000) : null,
    freq: reach ? r2(impressions / reach) : null,
    clicks,
    impressions,
  };
}

async function metaRows(admin: SupabaseClient, clientId: string, account: string | null, since: string, until: string) {
  const out: AdDay[] = [];
  for (let page = 0; page < 20; page++) {
    let q = admin.from("meta_ad_daily").select("date, ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name, metrics").eq("client_id", clientId).gte("date", since).lte("date", until);
    if (account) q = q.eq("ad_account_id", account.replace(/^act_/, ""));
    const { data } = await q.order("date").range(page * 1000, page * 1000 + 999);
    out.push(...((data ?? []) as AdDay[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

function groupBy<T>(rows: T[], key: (r: T) => string) {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return m;
}

type Gaql = Record<string, Record<string, unknown> | undefined>;
const gm = (r: Gaql) => r.metrics as Record<string, string | number | undefined> | undefined;
function gRow(name: string, r: Gaql): MetricsRow {
  const m = gm(r) ?? {};
  const spend = num(m.costMicros) / 1_000_000;
  const conv = num(m.conversions);
  const imps = num(m.impressions);
  const clicks = num(m.clicks);
  return { name, spend: r2(spend) ?? 0, results: r2(conv), cpr: conv ? r2(spend / conv) : null, roas: spend && num(m.conversionsValue) ? r2(num(m.conversionsValue) / spend) : null, ctr: imps ? r2((clicks / imps) * 100) : null, cpm: imps ? r2((spend / imps) * 1000) : null, freq: null, clicks, impressions: imps };
}

// ─── Copy limits ─────────────────────────────────────────────────────────────

const field = (text: unknown, limit: number | null): CopyField => ({ text: String(text ?? "").trim(), limit });
const over = (f: CopyField) => f.limit != null && [...f.text].length > f.limit;

// ─── Google export (as the person, through the Workspace service account) ──

async function driveAs(email: string) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("Google isn't connected for exports yet.");
  const { JWT } = await import("google-auth-library");
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) as { client_email: string; private_key: string };
  return (await new JWT({ email: key.client_email, key: key.private_key, scopes: ["https://www.googleapis.com/auth/drive"], subject: email }).getAccessToken()).token!;
}

/** A new Google file in the person's own Drive, converted from the content given */
async function uploadAs(email: string, name: string, googleType: string, body: string, contentType: string) {
  const token = await driveAs(email).catch((e) => {
    throw new Error(`Google refused the export (${e instanceof Error ? e.message.slice(0, 120) : "unknown"}). Kaizen's service account needs Drive delegated in the Workspace admin.`);
  });
  const boundary = `kaizen${Date.now()}`;
  const payload = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType: googleType })}\r\n--${boundary}\r\ncontent-type: ${contentType}; charset=UTF-8\r\n\r\n${body}\r\n--${boundary}--`;
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` },
    body: payload,
  });
  if (!res.ok) throw new Error(`Google Drive said no (${res.status}): ${(await res.text()).slice(0, 160)}`);
  return (await res.json()) as { id: string; webViewLink: string };
}

/** Markdown as simple HTML a Google Doc converts well (headings, lists, tables, bold) */
function mdToHtml(md: string) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\*(.+?)\*/g, "<i>$1</i>").replace(/`(.+?)`/g, "<code>$1</code>").replace(/\[(.+?)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>');
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      close();
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      out.push(`<table border="1" style="border-collapse:collapse"><tr>${cells(l).map((c) => `<th>${inline(c)}</th>`).join("")}</tr>`);
      i += 2;
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) out.push(`<tr>${cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`);
      i--;
      out.push("</table>");
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    const ul = l.match(/^\s*[-*]\s+(.*)$/);
    const ol = l.match(/^\s*\d+[.)]\s+(.*)$/);
    if (h) {
      close();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    } else if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (list !== want) {
        close();
        out.push(`<${want}>`);
        list = want;
      }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
    } else if (!l.trim()) close();
    else {
      close();
      out.push(`<p>${inline(l)}</p>`);
    }
  }
  close();
  return `<html><body>${out.join("\n")}</body></html>`;
}

const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ─── The tools ───────────────────────────────────────────────────────────────

export async function chatTools(ctx: ToolCtx): Promise<ChatTool[]> {
  const card = (c: Card) => {
    ctx.cards.push(c);
    return ctx.cards.length - 1;
  };
  const tools: ChatTool[] = [
    {
      name: "list_clients",
      description: "The clients the person can see (active and onboarding), optionally only the ones they're assigned to, or matching a search. Use it to find a client's exact name.",
      input_schema: { type: "object", properties: { search: { type: "string" }, mine: { type: "boolean", description: "Only clients the person is assigned to" } }, additionalProperties: false },
      status: () => "Looking up clients…",
      run: async (input) => {
        let q = ctx.db.from("clients").select("id, name, slug, status, industry_detail, client_assignments(profile_id, role)").is("archived_at", null).order("name").limit(300);
        const s = String(input.search ?? "").replace(/[%_,()]/g, " ").trim();
        if (s) q = q.ilike("name", `%${s}%`);
        const { data } = await q;
        type Row = { name: string; slug: string; status: string; industry_detail: string | null; client_assignments: { profile_id: string; role: string }[] | null };
        const rows = ((data ?? []) as unknown as Row[]).filter((c) => !input.mine || (c.client_assignments ?? []).some((a) => a.profile_id === ctx.me.id));
        return rows.map((c) => ({ name: c.name, slug: c.slug, status: c.status, industry: c.industry_detail, my_role: (c.client_assignments ?? []).find((a) => a.profile_id === ctx.me.id)?.role ?? null }));
      },
    },
    {
      name: "get_client_context",
      description: "Everything Kaizen Ads knows about a client, newest first: the Brand Bible, go-to-market strategy, rules and logged dos and don'ts, what to remember, the team's learnings, KPI targets and how the accounts are doing, what's happening now (tickets, comments, approvals, promises, replies owed), the last 45 days of Slack, email and calls, and recent creative. Read it before answering anything about a client that isn't already in the conversation.",
      input_schema: { type: "object", properties: { client: CLIENT }, additionalProperties: false },
      status: (input, client) => `Reading everything on ${nameFor(ctx, input) ?? client ?? "the client"}…`,
      run: async (input) => {
        const c = await clientOf(ctx, input);
        return clientBrief(ctx.admin, c.id);
      },
    },
    {
      name: "account_metrics",
      description:
        "A client's ad numbers for the last 1, 3, 7, 14 or 30 days (through yesterday), at the account, campaign, ad set or ad level (Meta) or campaign, ad group, keyword or search term level (Google), against the KPI target and the monthly budget pacing. Shows as a table in the chat. Use it for daily checks, CPA/ROAS drops, frequency, spend versus budget, keyword and search term reviews. TikTok's numbers (read only) are in get_client_context.",
      input_schema: {
        type: "object",
        properties: {
          client: CLIENT,
          platform: { type: "string", enum: ["meta", "google"] },
          days: { type: "integer", enum: [1, 3, 7, 14, 30] },
          level: { type: "string", enum: ["account", "campaign", "adset", "ad", "ad_group", "keyword", "search_term"] },
          compare: { type: "boolean", description: "Also the same number of days before, to compare" },
        },
        required: ["platform", "days", "level"],
        additionalProperties: false,
      },
      status: (input, client) => `Reading ${input.platform === "google" ? "Google Ads" : "Meta"} data for ${nameFor(ctx, input) ?? client ?? "the client"}…`,
      run: async (input) => {
        const c = await clientOf(ctx, input);
        const platform = input.platform === "google" ? "google" : "meta";
        const days = [1, 3, 7, 14, 30].includes(Number(input.days)) ? Number(input.days) : 7;
        const until = shift(nyToday(), -1);
        const since = shift(until, -(days - 1));
        const { data: targets } = await ctx.admin.from("kpi_targets").select("id, label, ad_account_id, conversion, target, monthly_budget").eq("client_id", c.id).eq("platform", platform).eq("active", true).not("ad_account_id", "is", null);
        const t = (targets ?? [])[0];
        if (!t) throw new Error(`${c.name} has no ${platform === "google" ? "Google Ads" : "Meta"} account on the KPI board.`);
        const { data: snap } = await ctx.admin.from("kpi_snapshots").select("windows, budget, status, deviation, data_through").eq("target_id", t.id).maybeSingle();
        const conv = conversionFor(t.conversion ?? "purchases");
        const w = (snap?.windows ?? {}) as Record<string, { spend: number; results: number; value: number | null }>;
        const b = snap?.budget as { budget: number; spent: number; projected: number; pace: number; status: string } | null;
        const level = String(input.level);
        let rows: MetricsRow[] = [];
        let previous: MetricsRow | null = null;
        if (platform === "meta") {
          const all = await metaRows(ctx.admin, c.id, t.ad_account_id, input.compare ? shift(since, -days) : since, until);
          const now = all.filter((r) => r.date >= since);
          const rt = resultType(now, t.conversion);
          if (input.compare) previous = sumRows(all.filter((r) => r.date < since), rt.type, rt.roas, "Before");
          if (level === "account") rows = [sumRows(now, rt.type, rt.roas, "Account")];
          else {
            const key = (r: AdDay) => (level === "campaign" ? r.campaign_name : level === "adset" ? `${r.campaign_name} › ${r.adset_name}` : `${r.ad_name}  (${r.ad_id})`);
            rows = [...groupBy(now, key)].map(([k, rs]) => sumRows(rs, rt.type, rt.roas, k));
          }
        } else {
          const { googleQuery } = await import("@/lib/context/google-ads");
          const between = (a: string, z: string) => `segments.date BETWEEN '${a}' AND '${z}'`;
          const metrics = "metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value";
          const q =
            level === "keyword"
              ? `SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ${metrics} FROM keyword_view WHERE ${between(since, until)} AND metrics.impressions > 0 ORDER BY metrics.cost_micros DESC LIMIT 200`
              : level === "search_term"
                ? `SELECT campaign.name, ad_group.name, search_term_view.search_term, search_term_view.status, ${metrics} FROM search_term_view WHERE ${between(since, until)} AND metrics.impressions > 0 ORDER BY metrics.cost_micros DESC LIMIT 300`
                : level === "ad_group" || level === "adset"
                  ? `SELECT campaign.name, ad_group.name, ${metrics} FROM ad_group WHERE ${between(since, until)} AND metrics.impressions > 0 ORDER BY metrics.cost_micros DESC LIMIT 200`
                  : `SELECT campaign.name, ${metrics} FROM campaign WHERE ${between(since, until)} AND metrics.impressions > 0 ORDER BY metrics.cost_micros DESC LIMIT 200`;
          const found = (await googleQuery(String(t.ad_account_id), q)) as unknown as Gaql[];
          const label = (r: Gaql) => {
            const camp = String(r.campaign?.name ?? "");
            const ag = String(r.adGroup?.name ?? "");
            if (level === "keyword") {
              const kw = (r.adGroupCriterion?.keyword ?? {}) as { text?: string; matchType?: string };
              return `${kw.text ?? "?"} [${(kw.matchType ?? "").toLowerCase()}] · ${ag}`;
            }
            if (level === "search_term") return `${String(r.searchTermView?.searchTerm ?? "?")}${r.searchTermView?.status && r.searchTermView.status !== "NONE" ? ` (${String(r.searchTermView.status).toLowerCase()})` : ""} · ${ag}`;
            if (level === "ad_group" || level === "adset") return `${camp} › ${ag}`;
            return camp;
          };
          rows = found.map((r) => gRow(label(r), r));
          if (level === "account") {
            const tot = rows.reduce((a, r) => ({ spend: a.spend + r.spend, results: a.results + (r.results ?? 0), clicks: a.clicks + (r.clicks ?? 0), imps: a.imps + (r.impressions ?? 0) }), { spend: 0, results: 0, clicks: 0, imps: 0 });
            rows = [{ name: "Account", spend: r2(tot.spend) ?? 0, results: r2(tot.results), cpr: tot.results ? r2(tot.spend / tot.results) : null, roas: null, ctr: tot.imps ? r2((tot.clicks / tot.imps) * 100) : null, cpm: tot.imps ? r2((tot.spend / tot.imps) * 1000) : null, freq: null, clicks: tot.clicks, impressions: tot.imps }];
          }
        }
        rows.sort((a, z) => z.spend - a.spend);
        const shown = rows.slice(0, 60);
        const m: MetricsCard = {
          type: "metrics",
          client: c.name,
          platform,
          title: `${c.name} · ${platform === "google" ? "Google Ads" : "Meta"} · ${level.replace("_", " ")}`,
          range: `${since} to ${until}`,
          kpi: { label: conv.label, target: t.target == null ? null : Number(t.target), roas: Boolean(conv.roas), value: w[`d${days >= 30 ? 30 : days >= 14 ? 14 : days >= 7 ? 7 : 3}`]?.value ?? null, status: snap ? shownStatus(snap.status as string | null, t.target) : null },
          budget: b && b.budget ? { budget: b.budget, spent: b.spent, projected: b.projected, pace: b.pace, status: b.status } : null,
          windows: (["d3", "d7", "d14", "d30"] as const).filter((k) => w[k]).map((k) => ({ label: `${k.slice(1)} days`, spend: w[k].spend, results: w[k].results, value: w[k].value })),
          rows: shown,
          level,
        };
        card(m);
        return {
          client: c.name,
          range: m.range,
          kpi: `${conv.label}${t.target != null ? `, target ${conv.roas ? `${t.target}x ROAS` : `$${t.target} per result`}` : ", no target set"}`,
          kpi_windows: m.windows,
          // No KPI set: "unset", numbers only, never on or off target
          kpi_status: snap ? shownStatus(snap.status as string | null, t.target) : null,
          data_through: snap?.data_through ?? null,
          budget_pacing: m.budget ?? (t.monthly_budget ? { budget: Number(t.monthly_budget) } : "no monthly budget set"),
          before: previous,
          rows: rows.slice(0, 150),
          note: platform === "meta" ? "Frequency is impressions over summed daily reach (an approximation over several days). Results use the KPI's conversion where the account reports it." : "Cost from Google is in dollars here.",
          shown_to_person: "a table of these rows is already on screen; don't repeat it in full, talk about what matters",
        };
      },
    },
    {
      name: "winners_and_fatigue",
      description: "A client's Meta ads by angle, concept or single ad over the last N days: what's winning (spend, results, cost per result, CTR) with why each winner works when it's been read, and which ads are wearing out (the fatigue watch). Use for creative performance, concepts and angles, and what to brief next.",
      input_schema: { type: "object", properties: { client: CLIENT, days: { type: "integer", enum: [7, 14, 30, 60, 90] }, by: { type: "string", enum: ["angle", "concept", "ad"] } }, required: ["by"], additionalProperties: false },
      status: (input, client) => `Reading what's winning for ${nameFor(ctx, input) ?? client ?? "the client"}…`,
      run: async (input) => {
        const c = await clientOf(ctx, input);
        const days = Number(input.days) || 30;
        const until = shift(nyToday(), -1);
        const [rows, { data: insights }, { data: tiring }, { data: targets }] = await Promise.all([
          metaRows(ctx.admin, c.id, null, shift(until, -(days - 1)), until),
          ctx.admin.from("winner_insights").select("ad_id, angle, hook, observation, takeaways").eq("client_id", c.id),
          ctx.admin.from("ad_fatigue").select("ad_id, ad_name, campaign, headline, severity, signals, first_flagged_at").eq("client_id", c.id).eq("state", "open").order("first_flagged_at", { ascending: false }).limit(20),
          ctx.admin.from("kpi_targets").select("conversion").eq("client_id", c.id).eq("platform", "meta").eq("active", true).limit(1),
        ]);
        const why = new Map((insights ?? []).map((i) => [i.ad_id as string, i]));
        const rt = resultType(rows, (targets ?? [])[0]?.conversion ?? null);
        // A concept: the ad's name without its sizes, versions and dates, so variations of one idea count together
        const concept = (name: string) =>
          name
            .split("|")
            .map((s) => s.trim())
            .filter((s) => s && !/^(img|vid|video|image|carousel|car|tof|mof|bof|v\d+|\d+x\d+|4x5|9x16|1x1|[a-z]{3}_\d{4})$/i.test(s))
            .join(" | ") || name;
        const key = (r: AdDay) => (input.by === "angle" ? String(why.get(r.ad_id)?.angle ?? "(angle not read yet)") : input.by === "concept" ? concept(r.ad_name) : r.ad_name);
        const groups = [...groupBy(rows, key)].map(([k, rs]) => ({ ...sumRows(rs, rt.type, rt.roas, k), ads: new Set(rs.map((r) => r.ad_id)).size, why: [...new Set(rs.map((r) => why.get(r.ad_id)?.observation).filter(Boolean))].slice(0, 2) }));
        groups.sort((a, z) => z.spend - a.spend);
        const top = groups.filter((g) => g.results).sort((a, z) => (rt.roas ? (z.roas ?? 0) - (a.roas ?? 0) : (a.cpr ?? 1e9) - (z.cpr ?? 1e9))).slice(0, 8);
        card({
          type: "list",
          title: `${c.name} · winning by ${input.by} · last ${days} days`,
          items: top.map((g) => ({ title: g.name, detail: `$${g.spend.toLocaleString()} · ${g.results ?? 0} results${g.cpr ? ` · $${g.cpr} each` : ""}${g.roas ? ` · ${g.roas}x` : ""}${g.ctr ? ` · CTR ${g.ctr}%` : ""}`, tone: "ok" })),
        });
        if ((tiring ?? []).length)
          card({ type: "list", title: `${c.name} · wearing out`, items: (tiring ?? []).slice(0, 10).map((f) => ({ title: String(f.ad_name), detail: `${f.severity} · ${f.campaign ?? ""}`, tone: f.severity === "high" ? "bad" : "warn", when: String(f.first_flagged_at).slice(0, 10) })) });
        return { client: c.name, result: rt.type, groups: groups.slice(0, 40), tiring: tiring ?? [] };
      },
    },
    {
      name: "what_changed",
      description: "What happened on a client since a date, with exact dates: changes in the ad accounts (ours and Meta's change history), launches, creative tickets, Asana tasks, what was said in Slack and email, recorded calls, replies we owe and promises still open. Use it for 'what changed and why' and to catch pending asks.",
      input_schema: { type: "object", properties: { client: CLIENT, since: { type: "string", description: "YYYY-MM-DD (default 7 days ago)" } }, additionalProperties: false },
      status: (input, client) => `Going through what changed on ${nameFor(ctx, input) ?? client ?? "the client"}…`,
      run: async (input) => {
        const c = await clientOf(ctx, input);
        const since = DAY.test(String(input.since ?? "")) ? String(input.since) : shift(nyToday(), -7);
        const a = ctx.admin;
        const cut = (s: unknown, n = 400) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
        const { data: targets } = await a.from("kpi_targets").select("ad_account_id, platform").eq("client_id", c.id).eq("active", true);
        const accounts = [...new Set((targets ?? []).map((t) => String(t.ad_account_id ?? "").replace(/^act_/, "")).filter(Boolean))];
        const [changes, history, messages, calls, tasks, launches, requests, owed, promises] = await Promise.all([
          a.from("ad_changes").select("platform, title, status, created_at, applied_at, note").eq("client_id", c.id).gte("created_at", since).order("created_at", { ascending: false }).limit(30),
          accounts.length ? a.from("ad_account_activity").select("ad_account_id, recent").in("ad_account_id", accounts) : Promise.resolve({ data: [] }),
          a.from("context_items").select("source, occurred_at, author, title, body, url").eq("client_id", c.id).in("source", ["slack_external", "slack_internal", "gmail"]).gte("occurred_at", since).order("occurred_at", { ascending: false }).limit(60),
          a.from("client_calls").select("title, occurred_at, summary, url").eq("client_id", c.id).gte("occurred_at", since).order("occurred_at", { ascending: false }).limit(8),
          a.from("asana_tasks").select("name, stage, open, completed_at, asana_modified_at, url").eq("client_id", c.id).gte("asana_modified_at", since).order("asana_modified_at", { ascending: false }).limit(25),
          a.from("launches").select("status, created_at, launched_at, live_at, sandbox, requests(number, title)").eq("client_id", c.id).gte("created_at", since).order("created_at", { ascending: false }).limit(15),
          a.from("requests").select("number, title, stage, created_at, launched_at").eq("client_id", c.id).is("deleted_at", null).gte("updated_at", since).order("updated_at", { ascending: false }).limit(25),
          a.from("owed_replies").select("source, from_name, asked_at, gist, subject, status, url").eq("client_id", c.id).in("status", ["watching", "nudged", "escalated"]).order("asked_at", { ascending: false }).limit(15),
          a.from("message_promises").select("what, said_at, due_at, status, url").eq("client_id", c.id).in("status", ["open", "in_motion", "overdue", "escalated"]).order("said_at", { ascending: false }).limit(15),
        ]);
        const accountHistory = ((history.data ?? []) as { ad_account_id: string; recent: unknown }[]).flatMap((h) => ((Array.isArray(h.recent) ? h.recent : []) as Record<string, unknown>[]).filter((e) => String(e.event_time ?? e.at ?? e.time ?? "") >= since).slice(0, 40));
        const out = {
          client: c.name,
          since,
          our_ad_changes: changes.data ?? [],
          ad_account_history: accountHistory,
          launches: launches.data ?? [],
          creative_tickets: requests.data ?? [],
          asana_tasks: tasks.data ?? [],
          slack_and_email: (messages.data ?? []).map((m) => ({ when: m.occurred_at, where: m.source, who: m.author, title: m.title, text: cut(m.body), link: m.url })),
          calls: (calls.data ?? []).map((k) => ({ when: k.occurred_at, title: k.title, summary: k.summary, link: k.url })),
          replies_we_owe: owed.data ?? [],
          promises_open: promises.data ?? [],
        };
        const open = [...(owed.data ?? []).map((o) => ({ title: `Reply owed: ${o.from_name ?? "someone"}`, detail: cut(o.gist ?? o.subject, 160), tone: o.status === "escalated" ? ("bad" as const) : ("warn" as const), href: o.url as string | null, when: String(o.asked_at).slice(0, 10) })), ...(promises.data ?? []).map((p) => ({ title: `Promised: ${cut(p.what, 120)}`, detail: p.due_at ? `due ${String(p.due_at).slice(0, 10)}` : String(p.status), tone: p.status === "overdue" ? ("bad" as const) : ("warn" as const), href: p.url as string | null, when: String(p.said_at).slice(0, 10) }))];
        if (open.length) card({ type: "list", title: `${c.name} · still waiting on us`, items: open.slice(0, 12) });
        return out;
      },
    },
    {
      name: "draft_weekly_report",
      description: "Starts a client report in the report builder (the same as Reports › Build): the AI drafts it in the buyer's voice in the background and the person reviews, edits and approves it there before anything is sent. Returns the link. Default: the last 7 days, every service with a KPI.",
      input_schema: { type: "object", properties: { client: CLIENT, range: { type: "string", enum: ["last7", "last14", "last30", "mtd", "lastMonth"] }, platforms: { type: "array", items: { type: "string", enum: ["meta", "google"] } } }, additionalProperties: false },
      status: (input, client) => `Starting the report for ${nameFor(ctx, input) ?? client ?? "the client"}…`,
      run: async (input) => {
        const c = await clientOf(ctx, input);
        const { resolveRange, buildReport, draftParts } = await import("@/lib/reports/builder");
        const range = resolveRange(String(input.range ?? "last7"));
        if (!range) throw new Error("That range isn't available.");
        const platforms = Array.isArray(input.platforms) && input.platforms.length ? (input.platforms as string[]) : ["meta", "google"];
        const out = await buildReport(ctx.admin, ctx.db, ctx.me, c.id, [range], platforms);
        const { after } = await import("next/server");
        after(() => draftParts(ctx.admin, out.partIds));
        const href = `/reports/${out.mineId ?? out.partIds[0]}`;
        card({ type: "link", title: `${c.name} report · ${range.label}`, detail: "Drafting now (about a minute). Review, edit and approve it there; nothing is sent until you do.", href, cta: "Open the report" });
        return { started: true, link: href, range: `${range.start} to ${range.end}`, parts: out.partIds.length };
      },
    },
    {
      name: "get_copy_library",
      description:
        "A client's Copy library: every primary text, headline and description that has run in their Meta ads, and every Google RSA headline and description, sitelink and callout (with Google's Best / Good / Low rating and pins), with its numbers added up across the ads that used it (spend, CTR, conversions, cost per result or ROAS against the KPI) and a badge (winner, solid, tired, not proven), best first. Use it to reuse what's proven, to write variations of a winning line, to carry what converts on one platform to the other, or to see what's wearing out. Filter by platform, type, badge, angle or words.",
      input_schema: {
        type: "object",
        properties: {
          client: CLIENT,
          platform: { type: "string", enum: ["meta", "google"] },
          type: { type: "string", enum: ["primary", "headline", "description", "long_headline", "sitelink", "callout"] },
          badge: { type: "string", enum: ["winner", "solid", "tired", "unproven"] },
          angle: { type: "string" },
          search: { type: "string", description: "Words to find in the copy, angle, avatar or hook" },
          limit: { type: "integer", description: "How many lines (default 15, at most 40)" },
        },
        additionalProperties: false,
      },
      status: (input, client) => `Reading the Copy library for ${nameFor(ctx, input) ?? client ?? "the client"}…`,
      run: async (input) => {
        const c = await clientOf(ctx, input);
        const { clientCopyLines } = await import("@/lib/copy-library");
        const kinds = ["primary", "headline", "description", "long_headline", "sitelink", "callout"] as const;
        const badges = ["winner", "solid", "tired", "unproven"] as const;
        const lines = await clientCopyLines(ctx.db, c.id, {
          platform: input.platform === "google" ? "google" : input.platform === "meta" ? "meta" : null,
          kind: kinds.find((k) => k === input.type) ?? null,
          badge: badges.find((b) => b === input.badge) ?? null,
          angle: input.angle ? String(input.angle) : null,
          search: input.search ? String(input.search) : null,
        });
        const n = Math.max(1, Math.min(40, Number(input.limit) || 15));
        return {
          client: c.name,
          judged_on: { meta: lines.find((l) => l.platform === "meta")?.roasKpi ? "ROAS" : "cost per result", google: lines.find((l) => l.platform === "google")?.roasKpi ? "ROAS" : "cost per conversion" },
          total: lines.length,
          link: `/clients/${c.slug}?service=meta&tab=copy`,
          lines: lines.slice(0, n).map((l) => ({ platform: l.platform, google_rating: l.label ?? undefined, pinned: l.pinned ?? undefined, type: l.kind, badge: l.badge, why: l.reason, text: l.text.slice(0, 1500), spend: l.spend, results: l.results, cost_per_result: l.cpa, roas: l.roas, vs_kpi: l.vsKpi, ctr: l.ctr, ads: l.ads, days_running: l.days, last_ran: l.lastSeen, live: l.live, angle: l.angle, avatar: l.avatar, hook: l.hook, offer: l.offer, starred: l.starred })),
        };
      },
    },
    {
      name: "write_ad_copy",
      description:
        "Shows ad copy you've written as a copy card with character counts (Meta: primary text, headline up to 40, description up to 30, call to action; Google RSA: headlines up to 30, descriptions up to 90, sitelinks text up to 25 with two lines up to 35, callouts up to 25), checks Meta copy against what the client told us to avoid, and flags anything over a limit so you can fix it. Write the copy first, then call this with it.",
      input_schema: {
        type: "object",
        properties: {
          client: CLIENT,
          platform: { type: "string", enum: ["meta", "google"] },
          meta: { type: "array", items: { type: "object", properties: { angle: { type: "string" }, primaryText: { type: "string" }, headline: { type: "string" }, description: { type: "string" }, cta: { type: "string" } }, required: ["primaryText", "headline"], additionalProperties: false } },
          google: {
            type: "object",
            properties: {
              headlines: { type: "array", items: { type: "string" } },
              descriptions: { type: "array", items: { type: "string" } },
              sitelinks: { type: "array", items: { type: "object", properties: { text: { type: "string" }, line1: { type: "string" }, line2: { type: "string" } }, required: ["text"], additionalProperties: false } },
              callouts: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
        },
        required: ["platform"],
        additionalProperties: false,
      },
      status: () => "Checking the copy…",
      run: async (input) => {
        const c = input.client || ctx.clientId ? await clientOf(ctx, input).catch(() => null) : null;
        const flags: string[] = [];
        const out: CopyCard = { type: "copy", client: c?.name ?? null, platform: input.platform === "google" ? "google" : "meta", flags };
        if (out.platform === "meta") {
          const ads = ((input.meta ?? []) as Record<string, string>[]).slice(0, 12);
          out.meta = ads.map((a) => ({ angle: a.angle ?? "", primaryText: String(a.primaryText ?? ""), headline: field(a.headline, 40), description: field(a.description, 30), cta: a.cta ?? "" }));
          out.meta.forEach((a, i) => {
            if (over(a.headline)) flags.push(`Ad ${i + 1}: headline is ${[...a.headline.text].length}/40`);
            if (over(a.description)) flags.push(`Ad ${i + 1}: description is ${[...a.description.text].length}/30`);
          });
          if (c && ads.length) {
            const { checkAgainstClient } = await import("@/lib/copy-draft");
            const v = await checkAgainstClient(ctx.admin, c.id, out.meta.map((a) => ({ kind: "short" as const, formula: "", angle: a.angle, primaryText: a.primaryText, headline: a.headline.text, linkDescription: a.description.text, cta: a.cta }))).catch(() => []);
            for (const x of v) flags.push(`Ad ${x.ad}: "${x.quote}" goes against ${x.rule}`);
            // A tired line from the Copy library reused as it is
            const [{ clientCopyLines }, { normalize }] = await Promise.all([import("@/lib/copy-library"), import("@/lib/copy-library-core")]);
            const tired = new Set((await clientCopyLines(ctx.db, c.id, { badge: "tired" }).catch(() => [])).map((l) => normalize(l.text)));
            out.meta.forEach((a, i) => {
              for (const [k, t] of [["primary text", a.primaryText], ["headline", a.headline.text], ["description", a.description.text]] as const) if (t && tired.has(normalize(t))) flags.push(`Ad ${i + 1}: the ${k} is a tired line in the Copy library (its ads are wearing out): write a fresh version`);
            });
          }
        } else {
          const g = (input.google ?? {}) as { headlines?: string[]; descriptions?: string[]; sitelinks?: { text: string; line1?: string; line2?: string }[]; callouts?: string[] };
          out.google = {
            headlines: (g.headlines ?? []).slice(0, 15).map((h) => field(h, 30)),
            descriptions: (g.descriptions ?? []).slice(0, 4).map((d) => field(d, 90)),
            sitelinks: (g.sitelinks ?? []).slice(0, 8).map((s) => ({ text: field(s.text, 25), line1: field(s.line1, 35), line2: field(s.line2, 35) })),
            callouts: (g.callouts ?? []).slice(0, 10).map((x) => field(x, 25)),
          };
          out.google.headlines.forEach((h, i) => over(h) && flags.push(`Headline ${i + 1} is ${[...h.text].length}/30`));
          out.google.descriptions.forEach((d, i) => over(d) && flags.push(`Description ${i + 1} is ${[...d.text].length}/90`));
          out.google.sitelinks.forEach((s, i) => [s.text, s.line1, s.line2].some(over) && flags.push(`Sitelink ${i + 1} is over its limit`));
          out.google.callouts.forEach((x, i) => over(x) && flags.push(`Callout ${i + 1} is ${[...x.text].length}/25`));
          const dupes = out.google.headlines.map((h) => h.text.toLowerCase()).filter((h, i, l) => h && l.indexOf(h) !== i);
          if (dupes.length) flags.push(`Repeated headlines: ${[...new Set(dupes)].join(", ")}`);
          // A line Google already rates Low for this client, reused as it is
          if (c) {
            const [{ clientCopyLines }, { normalize }] = await Promise.all([import("@/lib/copy-library"), import("@/lib/copy-library-core")]);
            const low = new Set((await clientCopyLines(ctx.db, c.id, { platform: "google" }).catch(() => [])).filter((l) => l.label === "LOW").map((l) => normalize(l.text)));
            for (const t of [...out.google.headlines, ...out.google.descriptions]) if (t.text && low.has(normalize(t.text))) flags.push(`"${t.text}" is already rated Low by Google for this client: write a fresh one`);
          }
          if (out.google.headlines.length && out.google.headlines.length < 8) flags.push("Fewer than 8 headlines: Google rates RSAs with more variety higher");
        }
        card(out);
        // Copy for a client not already read with its copy context: send it, so the next pass is written from it
        let context: string | null = null;
        const seen = `${c?.id}|${out.platform}`;
        if (c && ctx.copyContextFor !== seen) {
          const { copyContext } = await import("@/lib/copy-library");
          context = await copyContext(ctx.admin, c.id, 14_000, out.platform).catch(() => null);
          ctx.copyContextFor = seen;
        }
        const extra = context ? { copy_context: context, note_on_context: `This is the client's copy context for ${out.platform === "google" ? "Google" : "Meta"} (proven and tired lines on both platforms, voice, rules, limits). Check the copy you showed against it; if it falls short, rewrite and call write_ad_copy again.` } : {};
        return flags.length ? { shown: true, fix_these: flags, note: "Rewrite what's flagged and call write_ad_copy again with the fixed set.", ...extra } : { shown: true, all_within_limits: true, ...extra };
      },
    },
    {
      name: "creative_assessment",
      description:
        "Creative assessment. With a ticket number: starts the full AI creative review on that ticket's uploaded designs (the same as the Board's AI review) and returns the link. Without one: returns the client's creative standards (Brand Bible rules, what they asked us to avoid, the creative director's past disagreements) so you can assess the attached pictures or video yourself.",
      input_schema: { type: "object", properties: { client: CLIENT, ticket: { type: "integer", description: "The ticket number on the Board (#123)" } }, additionalProperties: false },
      status: (input) => (input.ticket ? `Starting the creative review on #${input.ticket}…` : "Reading the brand standards…"),
      run: async (input) => {
        if (input.ticket) {
          const { data: r } = await ctx.db.from("requests").select("id, number, title, client_id").eq("number", Number(input.ticket)).is("deleted_at", null).maybeSingle();
          if (!r) throw new Error(`No ticket #${input.ticket} that you can see.`);
          // Starting a review is the creative team's, the buyers' and the executives' (reading the standards is anyone's)
          const allowed = can(ctx.me, "creative.review");
          if (!allowed.ok) throw new Error(allowed.reason);
          const { startRun, runCreativeReview } = await import("@/lib/creative-review");
          const id = await startRun(ctx.admin, r.id as string, ctx.me.id);
          const { after } = await import("next/server");
          after(() => runCreativeReview(ctx.admin, id));
          card({ type: "link", title: `AI review · #${r.number} ${r.title}`, detail: "Reviewing each design against the brief, the brand and Meta policy (a minute or two).", href: `/board?t=${r.number}`, cta: "Open the ticket" });
          return { started: true, ticket: r.number, link: `/board?t=${r.number}` };
        }
        const c = await clientOf(ctx, input);
        const [{ data: bible }, { data: avoid }, { disagreementsBlock }] = await Promise.all([
          ctx.admin.from("client_brand_bibles").select("read_this_first, status").eq("client_id", c.id).maybeSingle(),
          ctx.admin.from("client_memory").select("body, dated").eq("client_id", c.id).eq("status", "active").eq("kind", "avoid").limit(60),
          import("@/lib/creative-review"),
        ]);
        const past = await disagreementsBlock(ctx.admin, c.id).catch(() => "");
        const { CREATIVE_REVIEW_SYSTEM } = await import("@/lib/ai");
        return {
          client: c.name,
          how_to_review: CREATIVE_REVIEW_SYSTEM.slice(0, 6000),
          brand_bible: String(bible?.read_this_first ?? "(no Brand Bible yet)").slice(0, 12_000),
          client_said_avoid: (avoid ?? []).map((m) => `${m.body}${m.dated ? ` (as of ${m.dated})` : ""}`),
          creative_director_disagreed_before: past || "(none)",
          attached_now: ctx.files.map((f) => `${f.name} (${f.kind})`),
        };
      },
    },
    {
      name: "create_brief",
      description: `Turns a creative idea into a brief card. Brief it on the card opens its quick preview right where the person is; the full brief is written only if they choose it (in the background, landing in Ready to send). Nothing is sent from here. In brief, give the idea in a few short lines: the concept, the hook, what to show, the copy direction, the offer and any references. One concept per brief: several distinct ideas are one card each. Every version counts toward the allotment (net new and variations alike, a carousel once per slide; sizes are free).${formatsRule(formatList(ctx.me)) ? ` ${formatsRule(formatList(ctx.me))}` : ""}`,
      input_schema: {
        type: "object",
        properties: {
          client: CLIENT,
          title: { type: "string" },
          // Only the formats the person asking requests (a designer images and carousels, a video editor video)
          formats: { type: "array", items: { type: "object", properties: { format: { type: "string", enum: formatList(ctx.me) }, new: { type: "integer" }, variations: { type: "integer" } }, required: ["format", "new", "variations"], additionalProperties: false } },
          angle: { type: "string" },
          audience: { type: "string" },
          brief: { type: "string" },
          landing: { type: "string" },
        },
        required: ["title", "formats", "brief"],
        additionalProperties: false,
      },
      status: (input, client) => `Writing up the brief for ${nameFor(ctx, input) ?? client ?? "the client"}…`,
      run: async (input) => {
        const c = await clientOf(ctx, input);
        const formats = clampFormats(
          ((input.formats ?? []) as BriefCard["formats"]).filter((f) => ["image", "video", "carousel"].includes(f.format)).map((f) => ({ format: f.format, new: Math.max(0, Math.min(10, Number(f.new) || 0)), variations: Math.max(0, Math.min(10, Number(f.variations) || 0)) })),
          formatsFor(ctx.me),
        );
        // A client who said no to AI content: the card isn't shown with AI media in it; the model rewrites it first
        const briefText = `${String(input.title ?? "")}\n${String(input.brief ?? "")}`;
        const { aiMediaIn, likenessIn, hasConsentLine } = await import("@/lib/ai-content");
        const aiMedia = aiMediaIn(briefText);
        if (aiMedia) {
          const { loadAiRule } = await import("@/lib/ai-content-rule");
          const rule = await loadAiRule(ctx.admin, c.id);
          if (!rule.allowed) return { shown: false, error: `${c.name} said no to AI content ("${rule.rule}"), and this brief uses "${aiMedia}". Rewrite it with real footage, real photos, real people and a real voiceover, then make the card again.` };
        }
        const likeness = likenessIn(briefText);
        const index = ctx.cards.length;
        const b: BriefCard = {
          type: "brief",
          client: { id: c.id, name: c.name, slug: c.slug },
          title: String(input.title ?? "").slice(0, 120),
          formats,
          angle: String(input.angle ?? "").slice(0, 200),
          audience: String(input.audience ?? "").slice(0, 500),
          brief: String(input.brief ?? "").slice(0, 8000),
          landing: String(input.landing ?? "").slice(0, 500),
          href: `/requests/new?ai=${ctx.messageId}&card=${index}`,
        };
        card(b);
        return {
          shown: true,
          note: `The card is on screen. Brief it opens its quick preview there; the full brief is written only if they choose it, and lands in Ready to send.${likeness && !hasConsentLine(briefText) ? ` It alters or generates a real person's face or voice ("${likeness}"): tell them it needs the client's written consent for that person's likeness/voice and an on-screen disclaimer.` : ""}`,
        };
      },
    },
    {
      name: "export_to_google_doc",
      description: "Saves something from this conversation (a report, a plan, a script, copy) as a new Google Doc in the person's own Drive and returns the link. Write the full content in markdown (headings, lists, tables).",
      input_schema: { type: "object", properties: { title: { type: "string" }, markdown: { type: "string" } }, required: ["title", "markdown"], additionalProperties: false },
      status: () => "Making the Google Doc…",
      run: async (input) => {
        const f = await uploadAs(ctx.me.email, String(input.title).slice(0, 200), "application/vnd.google-apps.document", mdToHtml(String(input.markdown)), "text/html");
        card({ type: "link", title: String(input.title), detail: "In your Google Drive", href: f.webViewLink, cta: "Open the Doc", external: true });
        return { link: f.webViewLink };
      },
    },
    {
      name: "export_to_google_sheet",
      description: "Saves a table as a new Google Sheet in the person's own Drive and returns the link. rows: the first row is the header.",
      input_schema: { type: "object", properties: { title: { type: "string" }, rows: { type: "array", items: { type: "array", items: { type: ["string", "number", "null"] } } } }, required: ["title", "rows"], additionalProperties: false },
      status: () => "Making the Google Sheet…",
      run: async (input) => {
        const rows = ((input.rows ?? []) as unknown[][]).slice(0, 5000);
        const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
        const f = await uploadAs(ctx.me.email, String(input.title).slice(0, 200), "application/vnd.google-apps.spreadsheet", csv, "text/csv");
        card({ type: "link", title: String(input.title), detail: `${Math.max(0, rows.length - 1)} rows · in your Google Drive`, href: f.webViewLink, cta: "Open the Sheet", external: true });
        return { link: f.webViewLink };
      },
    },
    {
      name: "plan_ad_changes",
      description:
        "Plans a change in a client's Meta or Google Ads account (pause or turn on campaigns, ad sets, ads or keywords, budgets, bids, names, links and UTMs, negatives, moving an ad) or a change of the client's media buyer (platform team). The buyer agent reads the live account and shows the exact objects on a plan card; nothing changes until someone allowed confirms on the card. Give the full instruction with every name, number and condition. TikTok changes aren't connected yet: never plan one; say so and point them to TikTok Ads Manager.",
      input_schema: { type: "object", properties: { client: CLIENT, platform: { type: "string", enum: ["meta", "google", "team"] }, instruction: { type: "string" } }, required: ["platform", "instruction"], additionalProperties: false },
      status: (input, client) => `Planning the change for ${nameFor(ctx, input) ?? client ?? "the client"}…`,
      run: async (input) => {
        const c = await clientOf(ctx, input);
        const instruction = String(input.instruction ?? "").trim().slice(0, 2000);
        if (!instruction) throw new Error("Say what to change.");
        const platform = input.platform === "google" ? "google" : input.platform === "team" ? "team" : "meta";
        const { startChatChange, planChatChange } = await import("@/lib/chat-changes");
        const r = await startChatChange(ctx.admin, c.id, ctx.me.id, platform, instruction);
        if ("error" in r) throw new Error(r.error);
        const { after } = await import("next/server");
        after(() => planChatChange(ctx.admin, r.id));
        card({ type: "plan", id: r.id, client: c.name, platform, instruction });
        return { planned: true, note: "The plan card is reading the live account now; the person checks the exact objects and confirms there. Say so; never say it's done." };
      },
    },
  ];

  // A launch sheet shared here (attached, or a Google Sheets / Drive link): the same launch as in the client's chat
  tools.push({
    name: "launch_sheet",
    description:
      "Starts a launch from a launch sheet (a PDF, Excel or CSV attached to this message, or a Google Sheets or Drive link): the Media Buyer reads it, checks it against the client's ad account and Drive, and asks the buyer what only they can decide, on a launch card. The plan is laid out and created only after the buyer answers and confirms on the card. Use it when they share a launch sheet to launch or set up. Afterwards, pass the buyer's answers about that launch with launch_reply.",
    input_schema: { type: "object", properties: { client: CLIENT, file: { type: "string", description: "The attached file's name (leave out for a link)" }, url: { type: "string", description: "A Google Sheets or Drive link (leave out for an attached file)" } }, additionalProperties: false },
    status: (input, client) => `Reading the launch sheet for ${nameFor(ctx, input) ?? client ?? "the client"}…`,
    run: async (input) => {
      const c = await clientOf(ctx, input);
      const { AI_BUCKET } = await import("./files");
      const want = String(input.file ?? "").trim().toLowerCase();
      const url = String(input.url ?? "").trim();
      const f = ctx.files.find((x) => (want ? x.name.toLowerCase() === want : ["pdf", "doc", "text"].includes(x.kind))) ?? null;
      const source = url ? { kind: "link" as const, url, name: url } : f ? { kind: "file" as const, bucket: AI_BUCKET, path: f.path, name: f.name, mime: f.mime } : null;
      if (!source) throw new Error("Attach the launch sheet (PDF, Excel or CSV) or paste its Google Sheets link.");
      const { startRun, prepareRun } = await import("@/lib/launch-sheet/runs");
      const r = await startRun(ctx.admin, c.id, ctx.me.id, source, "kaizen_ai");
      if ("error" in r) throw new Error(r.error);
      const { after } = await import("next/server");
      after(() => prepareRun(ctx.admin, r.id));
      card({ type: "launch", id: r.id, client: c.name });
      return { started: true, launchId: r.id, note: "The launch card is reading and checking the sheet now; the summary, the checklist and the questions appear on it. Say so in a sentence; don't list the questions yourself. Nothing goes to Meta until the buyer confirms the plan on the card." };
    },
  });
  tools.push({
    name: "launch_reply",
    description: "Passes the buyer's message about a launch started with launch_sheet (answers to its questions, changes to its plan, 'build the plan') to the Media Buyer running it, and returns its reply. Use the launchId launch_sheet returned. Never confirm a launch here: that's on the card.",
    input_schema: { type: "object", properties: { launchId: { type: "string" }, message: { type: "string" } }, required: ["launchId", "message"], additionalProperties: false },
    status: () => "Passing it to the Media Buyer…",
    run: async (input) => {
      const id = String(input.launchId ?? "");
      const { data: run } = await ctx.db.from("launch_runs").select("id, client_id, status").eq("id", id).maybeSingle();
      if (!run) throw new Error("That launch isn't one you can see.");
      if (!["asking", "ready", "failed"].includes(run.status as string)) return { status: run.status, note: "This launch isn't waiting on the buyer right now; the card shows where it is." };
      const { launchReply, planRun } = await import("@/lib/launch-sheet/runs");
      const r = await launchReply(ctx.admin, id, String(input.message ?? "").slice(0, 3000));
      if (r.building) {
        const { after } = await import("next/server");
        after(() => planRun(ctx.admin, id));
      }
      return r.offTopic ? { note: "The Media Buyer says this isn't about the launch." } : { reply: r.answer, planning: r.building };
    },
  });

  // Search everything on file, recorded calls: the report chat's own lookups, reused for the pinned client
  if (ctx.clientId) {
    const { reportTools } = await import("@/lib/reports/tools");
    const pulled: { label: string; data: string }[] = [];
    const reused = await reportTools(ctx.admin, { client_id: ctx.clientId, platform: "meta", kpi_targets: null }, pulled).catch(() => [] as AiTool[]);
    const label: Record<string, string> = { search_client: "Searching Slack, email, Drive and calls…", recent_calls: "Reading the recent calls…", read_call: "Reading the call…", earlier_reports: "Reading earlier reports…" };
    for (const t of reused) if (label[t.name]) tools.push({ ...t, description: `${t.description} (Only for the client this thread is pinned to.)`, status: () => label[t.name] });
  }

  // The connectors in src/lib/ai-tools (Google policy checker, monthly recap deck, ElevenLabs, Higgsfield, Motion)
  for (const t of await extensionTools(ctx)) if (!tools.some((x) => x.name === t.name)) tools.push(t);
  return toolsFor(ctx.me, tools);
}

/**
 * Only the tools this person may use (src/lib/chat-permissions.ts), so the AI never offers what isn't theirs: no ad
 * account changes for the creative team, a Meta launch only for the Meta side, briefs only for those who brief (in
 * their formats), copy only for those who write it. Every tool that's kept checks the client again on the server.
 */
export function toolsFor<T extends { name: string; input_schema?: unknown }>(me: Who, tools: T[]): T[] {
  const p = roleWidePerms(me);
  const changeOn = (["meta", "google"] as const).filter((x) => p.change[x]);
  const drop = new Set<string>();
  if (!changeOn.length && !p.buyer) drop.add("plan_ad_changes");
  if (!p.launch.meta) for (const n of ["launch_sheet", "launch_reply"]) drop.add(n);
  if (!p.copy) drop.add("write_ad_copy");
  if (!p.briefFormats.length) drop.add("create_brief");
  if (!p.change.google) drop.add("google_policy_apply_fix");
  return tools
    .filter((t) => !drop.has(t.name))
    .map((t) => {
      if (t.name !== "plan_ad_changes") return t;
      // The platforms they may change (and the buyer, for those who may change it)
      const s = t.input_schema as { properties: Record<string, unknown> };
      const platforms = [...changeOn, ...(p.buyer ? ["team"] : [])];
      return { ...t, input_schema: { ...s, properties: { ...s.properties, platform: { type: "string", enum: platforms } } } };
    });
}
