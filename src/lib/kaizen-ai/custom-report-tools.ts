import "server-only";
import { adsLinesFor, lineOfTeam } from "@/lib/roles";
import { clip } from "./deck-core";
import type { ChatTool, ToolCtx } from "./tools";
import type { MetricsCard } from "./types";
import { sourceLabel, type StyleLine } from "@/lib/reports/style-core";
import type { MatchOn, OfferGroup } from "@/lib/reports/custom-core";

// Custom client reports in Kaizen AI and the assistant: the question a client asked in their own words (offers compared,
// before and after a change, the top and worst creatives, over any range up to 37 months), answered from the ad account
// and handed over as an editable deck (make_deck) or as a Kaizen report (draft_weekly_report with the ask). And the
// client's report style: what a buyer says the client always wants is saved, so every later report has it.

const CLIENT = { type: "string", description: "The client's name (or slug). Leave out to use the client the thread is pinned to." };
const nyToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** Which line's style a person may teach: an exec any; the ads teams ads; the email and social teams their own */
export function styleLinesFor(me: { role: string; isExec: boolean }): StyleLine[] {
  if (me.isExec) return ["ads", "email", "social"];
  const own = lineOfTeam(me.role);
  if (own) return [own];
  return adsLinesFor(me).length ? ["ads"] : [];
}

export function customReportTools(ctx: ToolCtx): ChatTool[] {
  const card = (c: MetricsCard | { type: "list"; title: string; items: { title: string; detail?: string; tone?: "ok" | "warn" | "bad" | null; href?: string | null }[] }) => ctx.cards.push(c);
  const tools: ChatTool[] = [];

  if (adsLinesFor(ctx.me).includes("meta")) {
    tools.push({
      name: "custom_report_data",
      description:
        "The numbers for a client's custom report request, read live from their Meta ad account (read only) over ANY range up to 37 months back (several months at once is fine): offers or price points compared side by side (e.g. $99, $89, $49 and $7, matched in ad, ad set and campaign names; optionally month by month), before and after a dated change (a new checkout page: conversion rates per link click, per landing page view and per checkout started, cost per result, ROAS, each side the same number of days), and the top and worst creatives with their preview pictures and links. Only the KPI's campaigns count. Use it whenever a client wants a report in their own format; then hand it over the way they want it: an editable deck with make_deck (PowerPoint you can edit, plus a PDF; bars and table slides for comparisons, image_notes slides with image \"ad:<ad_id>\" for each creative), or a Kaizen report with draft_weekly_report (pass the ask). When the person says the client wants this in every report from now on, also save it with report_style.",
      input_schema: {
        type: "object",
        properties: {
          client: CLIENT,
          since: { type: "string", description: "YYYY-MM-DD, the first day" },
          until: { type: "string", description: "YYYY-MM-DD, defaults to yesterday" },
          offers: {
            type: "array",
            description: "The offers or price points to compare. Each: a label and what its ads, ad sets or campaigns are called (a price like 99 matches $99 but never $199 or $9.99; any other word matches anywhere in the name).",
            items: { type: "object", properties: { label: { type: "string" }, match: { type: "array", items: { type: "string" } } }, required: ["label", "match"] },
          },
          offers_on: { type: "string", enum: ["any", "campaign", "adset", "ad"], description: "Which names carry the offer. any (default): the ad's name, then its ad set's, then its campaign's" },
          by_month: { type: "boolean", description: "Offers month by month too" },
          change: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD the change went live (counts as after)" }, label: { type: "string", description: "What changed, e.g. new checkout page" }, days: { type: "integer", description: "Days on each side (default: the days since, at most 30; up to 90)" } }, required: ["date"] },
          creatives: { type: "object", properties: { top: { type: "integer", minimum: 0, maximum: 10 }, worst: { type: "integer", minimum: 0, maximum: 10 }, min_spend: { type: "number", description: "Least spend to be judged (default the larger of $50 and 2% of spend)" } } },
        },
        required: ["since"],
        additionalProperties: false,
      },
      status: (input, client) => `Reading ${String(input.client ?? "") || client || "the client"}'s Meta account for the custom report…`,
      run: async (input) => {
        const c = await (await import("./tools")).clientNamedForTools(ctx, input);
        const { data: targets } = await ctx.admin.from("kpi_targets").select("ad_account_id, conversion, target, campaign_match, excluded_campaigns").eq("client_id", c.id).eq("platform", "meta").eq("active", true).not("ad_account_id", "is", null);
        const t = (targets ?? [])[0];
        if (!t) throw new Error(`${c.name} has no Meta account on the KPI board.`);
        const offers: OfferGroup[] = (Array.isArray(input.offers) ? input.offers : [])
          .map((o) => ({ label: clip((o as { label?: unknown }).label, 40), match: (Array.isArray((o as { match?: unknown }).match) ? ((o as { match: unknown[] }).match) : []).map((m) => clip(m, 60)).filter(Boolean).slice(0, 6) }))
          .filter((o) => o.label && o.match.length)
          .slice(0, 12);
        const ch = input.change as { date?: unknown; label?: unknown; days?: unknown } | undefined;
        const cr = input.creatives as { top?: unknown; worst?: unknown; min_spend?: unknown } | undefined;
        const { customAnalysis } = await import("@/lib/reports/custom-analysis");
        const out = await customAnalysis(
          t,
          {
            since: String(input.since ?? ""),
            until: input.until ? String(input.until) : null,
            offers,
            offersOn: (["any", "campaign", "adset", "ad"].includes(String(input.offers_on)) ? input.offers_on : "any") as MatchOn,
            byMonth: input.by_month === true,
            change: ch?.date ? { date: String(ch.date), label: ch.label ? clip(ch.label, 120) : null, days: Number(ch.days) || null } : null,
            creatives: cr ? { top: Number(cr.top ?? 5), worst: Number(cr.worst ?? 5), minSpend: cr.min_spend != null ? Number(cr.min_spend) : null } : null,
          },
          nyToday(),
        );
        const range = out.range as { since: string; until: string };
        type A = { label: string; spend: number; results: number; cost_per_result: number | null; roas: number | null; ctr: number | null; cpm: number | null; clicks: number; impressions: number; revenue: number | null; click_to_result: number | null };
        const row = (a: A, name = a.label) => ({ name, spend: a.spend, results: a.results, cpr: a.cost_per_result, roas: a.roas, ctr: a.ctr, cpm: a.cpm, freq: null, clicks: a.clicks, impressions: a.impressions, revenue: a.revenue, note: a.click_to_result != null ? `${a.click_to_result}% of clicks converted` : null });
        const kpi = { label: String(out.result).split(" (")[0], target: t.target == null ? null : Number(t.target), roas: (out.total as A).roas != null, value: null, status: null };
        const offersOut = out.offers as { groups: A[]; by_month?: { month: string; groups: A[] }[] } | undefined;
        if (offersOut) {
          const rows = offersOut.by_month?.length ? offersOut.by_month.flatMap((m) => m.groups.filter((g) => g.spend > 0).map((g) => row(g, `${m.month} · ${g.label}`))) : offersOut.groups.map((g) => row(g));
          card({ type: "metrics", client: c.name, platform: "meta", title: `${c.name} · offers compared${offersOut.by_month?.length ? " by month" : ""}`, range: `${range.since} to ${range.until}`, kpi, budget: null, windows: [], rows: rows.slice(0, 150), level: "offer" });
        }
        const changeOut = out.change as { before?: A; after?: A; what?: string } | undefined;
        if (changeOut?.before && changeOut.after)
          card({ type: "metrics", client: c.name, platform: "meta", title: `${c.name} · before and after ${changeOut.what ?? "the change"}`, range: `${changeOut.before.label.replace(/^Before \(|\)$/g, "")} vs ${changeOut.after.label.replace(/^After \(|\)$/g, "")}`, kpi, budget: null, windows: [], rows: [row(changeOut.before, "Before"), row(changeOut.after, "After")], level: "change" });
        const crOut = out.creatives as { top: (A & { ad_name: string; preview: { link: string | null } | null })[]; worst: (A & { ad_name: string; preview: { link: string | null } | null })[] } | undefined;
        if (crOut) {
          const item = (a: (typeof crOut.top)[number], tone: "ok" | "bad") => ({ title: a.ad_name, detail: `$${a.spend.toLocaleString()} · ${a.results} results${a.cost_per_result != null ? ` · $${a.cost_per_result} each` : ""}${a.roas != null ? ` · ${a.roas}x` : ""}`, tone, href: a.preview?.link ?? null });
          if (crOut.top.length) card({ type: "list", title: `${c.name} · top creatives · ${range.since} to ${range.until}`, items: crOut.top.map((a) => item(a, "ok")) });
          if (crOut.worst.length) card({ type: "list", title: `${c.name} · worst creatives · ${range.since} to ${range.until}`, items: crOut.worst.map((a) => item(a, "bad")) });
        }
        return {
          client: c.name,
          ...out,
          shown_to_person: "tables and lists of these are already on screen; say what matters (which offer wins on cost per result and why, what moved after the change), don't repeat them in full",
          next: "To hand it over: make_deck (editable PowerPoint and PDF) with a stats slide of the headline, a bars slide per comparison, a table slide for the numbers, image_notes slides with image \"ad:<ad_id>\" for each creative; or draft_weekly_report with the ask for a Kaizen report.",
        };
      },
    });
  }

  const lines = styleLinesFor(ctx.me);
  if (lines.length)
    tools.push({
      name: "report_style",
      description:
        "A client's report style: what the team has taught Kaizen OS about how THIS client wants their reports (sections, metrics, comparisons, order, length, tone, the format they're handed over in). Every later report for the client (the Monday weekly, the monthly recap, built reports) is drafted with it, so improvements compound. list: the rules in use and the recent changes (with who taught each). teach: save lasting preferences, as short plain rules a writer can follow (\"Compare cost per purchase across the $99, $89, $49 and $7 offers\", \"Always show the top and worst creatives with previews\", \"Show conversion rate before and after the Oct 14 checkout update\"); forget: drop rules; undo: step back one version. Save only lasting asks the person confirms the client wants every time, never one-off requests. Roles, never names.",
      input_schema: {
        type: "object",
        properties: {
          client: CLIENT,
          line: { type: "string", enum: lines, description: lines.length > 1 ? "ads (default), email or social" : undefined },
          action: { type: "string", enum: ["list", "teach", "forget", "undo"] },
          rules: { type: "array", items: { type: "string" }, description: "teach: the rules to add; forget: the rules (or a few words of each) to drop" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      status: (input, client) => `${input.action === "list" ? "Reading" : "Updating"} ${String(input.client ?? "") || client || "the client"}'s report style…`,
      run: async (input) => {
        const c = await (await import("./tools")).clientNamedForTools(ctx, input);
        const line = (lines.includes(input.line as StyleLine) ? input.line : lines[0]) as StyleLine;
        const { loadStyle, teachStyle, undoStyle } = await import("@/lib/reports/style");
        const by = { id: ctx.me.id, name: ctx.me.fullName };
        const source = ctx.threadId ? ("kaizen_ai" as const) : ("assistant" as const);
        const rules = (Array.isArray(input.rules) ? input.rules : []).map((r) => clip(r, 280)).filter(Boolean).slice(0, 10);
        if (input.action === "teach" || input.action === "forget") {
          if (!rules.length) throw new Error("Say the rules.");
          const out = await teachStyle(ctx.admin, { clientId: c.id, line, ...(input.action === "teach" ? { rules } : { remove: rules }), source, by });
          return { client: c.name, line, changed: out.changed, version: out.version, change: out.change, rules_now: out.rules.map((r) => r.text), note: out.changed ? "Saved. Every report drafted for this client from now on follows it; the report page shows it and can undo it." : "Already in the style; nothing changed." };
        }
        if (input.action === "undo") {
          const out = await undoStyle(ctx.admin, c.id, line, by);
          return { client: c.name, line, undone: out.undone, now_version: out.now?.version ?? null, rules_now: (out.now?.rules ?? []).map((r) => r.text) };
        }
        const s = await loadStyle(ctx.admin, c.id, line);
        return {
          client: c.name,
          line,
          version: s.current?.version ?? null,
          rules: (s.current?.rules ?? []).map((r) => ({ rule: r.text, taught_by: r.by, how: sourceLabel(r.source), at: r.at.slice(0, 10) })),
          changes: s.history.slice(0, 8).map((h) => ({ version: h.version, change: h.change, by: h.taught_by_name, how: sourceLabel(h.source), at: h.created_at.slice(0, 10), undone: Boolean(h.undone_at) })),
        };
      },
    });
  return tools;
}
