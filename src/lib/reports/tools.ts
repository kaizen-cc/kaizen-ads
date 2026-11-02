import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiTool } from "@/lib/ai";

// What the report chat can look up while it works, all read only: the report's own ad account (Meta insights at any
// level, range and breakdown, and any ad's copy and creative; or a Google Ads query), Motion's creative analytics for
// the client, and this client's earlier reports (the format the buyer wants to follow). Each lookup is noted, so the
// buyer sees where a number came from and the QA can check it.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const META_FIELDS = ["spend", "impressions", "reach", "frequency", "clicks", "inline_link_clicks", "ctr", "inline_link_click_ctr", "cpc", "cpm", "actions", "action_values", "cost_per_action_type", "purchase_roas", "video_p25_watched_actions", "video_p50_watched_actions", "video_p100_watched_actions", "video_thruplay_watched_actions"];
const META_BREAKDOWNS = ["age", "gender", "publisher_platform", "platform_position", "device_platform", "region", "country"];

/** Insight rows made small for the AI: the names, the numbers, the actions as one map */
function slim(rows: Record<string, unknown>[]) {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === "date_stop" && r.date_start === v) continue;
      if (Array.isArray(v)) out[k] = Object.fromEntries((v as { action_type: string; value: string }[]).map((a) => [a.action_type, Number(a.value)]));
      else out[k] = v;
    }
    return out;
  });
}

export type Pulled = { label: string; data: string };

export async function reportTools(admin: SupabaseClient, r: { client_id: string; platform: string; kpi_targets: unknown; period_end?: string }, pulled: Pulled[]): Promise<AiTool[]> {
  const t = r.kpi_targets as { ad_account_id: string | null } | null;
  const account = t?.ad_account_id ?? null;
  const { data: client } = await admin.from("clients").select("name, motion_workspace_id").eq("id", r.client_id).maybeSingle();
  const note = (label: string, data: unknown) => {
    const text = typeof data === "string" ? data : JSON.stringify(data);
    pulled.push({ label, data: text.slice(0, 12_000) });
    return data;
  };
  const tools: AiTool[] = [
    {
      name: "trend",
      description: "A metric week by week or month by month, counted exactly as the report counts it (each campaign's own result; CPL, CPA and cost per purchase are cost_per_result). Use it before writing a trend chart (a story), so what you say matches the chart, which is drawn from these same numbers.",
      input_schema: {
        type: "object",
        properties: { metric: { type: "string", enum: ["spend", "results", "cost_per_result", "revenue", "roas", "ctr", "clicks", "cpc", "cpm", "impressions"] }, grain: { type: "string", enum: ["week", "month"] }, periods: { type: "integer", minimum: 2, maximum: 12 } },
        required: ["metric", "grain", "periods"],
        additionalProperties: false,
      },
      run: async (input) => {
        const { trendSeries } = await import("./metrics");
        const end = r.period_end ?? new Date().toISOString().slice(0, 10);
        const series = await trendSeries(admin, r.kpi_targets as never, input.metric as never, input.grain === "month" ? "month" : "week", Number(input.periods) || 5, end);
        return note(`${String(input.metric).replace(/_/g, " ")} by ${input.grain} (${series.length})`, series);
      },
    },
    {
      name: "earlier_reports",
      description: "This client's earlier reports that were sent (newest first): the period, the Slack message and the sections. Use it when the buyer asks to follow last week's or last month's format, or to compare with what was reported before.",
      input_schema: { type: "object", properties: { count: { type: "integer", minimum: 1, maximum: 6 }, kind: { type: "string", enum: ["any", "weekly", "monthly"] } }, additionalProperties: false },
      run: async (input) => {
        let q = admin.from("reports").select("kind, platform, period_start, period_end, message, sections").eq("client_id", r.client_id).in("status", ["posted", "submitted"]).order("period_end", { ascending: false }).limit(Math.min(6, Number(input.count) || 2));
        if (input.kind === "weekly" || input.kind === "monthly") q = q.eq("kind", input.kind);
        const { data } = await q;
        return note(`Earlier reports (${data?.length ?? 0})`, data ?? []);
      },
    },
    {
      name: "client_overview",
      description: `Everything Kaizen Ads knows about ${client?.name ?? "the client"} in one read: the Brand Bible, the go-to-market strategy, what to remember about them, the latest briefing from Slack, email and Drive, recent messages, what their ads proved (the playbook), KPI targets, recent creative requests and what earlier reports promised. Read it when the report needs context beyond the numbers.`,
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        const { clientContext, contextBlock } = await import("@/lib/ai");
        const ctx = await clientContext(admin, r.client_id);
        if (!ctx) throw new Error("Client not found.");
        return note("Client overview", contextBlock(ctx, undefined, { allotment: false }).slice(0, 60_000));
      },
    },
    {
      name: "search_client",
      description: `Searches everything on file for ${client?.name ?? "the client"}: client and internal Slack, email (Gmail), Drive files, recorded calls (Fireflies and Gemini notes, transcripts included), creative requests and review comments, and what's remembered about them. Give words to look for (any of them match), optionally which sources and a start date. Use it when the buyer mentions a conversation, a promise, a launch, feedback, an offer or anything said outside the ad account.`,
      input_schema: {
        type: "object",
        properties: {
          words: { type: "array", items: { type: "string" }, description: "Words or short phrases; a match on any of them counts" },
          sources: { type: "array", items: { type: "string", enum: ["slack", "email", "drive", "calls", "creative", "memory"] } },
          since: { type: "string", description: "YYYY-MM-DD, optional" },
        },
        required: ["words"],
        additionalProperties: false,
      },
      run: async (input) => {
        const words = ((input.words as string[]) ?? []).map((w) => w.replace(/[%_,()]/g, " ").trim()).filter((w) => w.length >= 2).slice(0, 6);
        if (!words.length) throw new Error("Give at least one word to look for.");
        const want = new Set(((input.sources as string[] | undefined)?.length ? input.sources : ["slack", "email", "drive", "calls", "creative", "memory"]) as string[]);
        const since = DAY.test(String(input.since ?? "")) ? String(input.since) : "2000-01-01";
        const any = (cols: string[]) => words.flatMap((w) => cols.map((c) => `${c}.ilike.%${w}%`)).join(",");
        // A short window of text around the first match, so a long transcript comes back as the part that matters
        const around = (text: string | null) => {
          const t = (text ?? "").replace(/\s+/g, " ");
          const at = Math.max(0, Math.min(...words.map((w) => t.toLowerCase().indexOf(w.toLowerCase())).filter((i) => i >= 0), t.length));
          return t.slice(Math.max(0, at - 600), at + 1400);
        };
        const kinds = [...want].map((s) => ({ slack: ["slack_external", "slack_internal"], email: ["gmail"], drive: ["drive"], calls: ["call"] })[s as "slack"] ?? []).flat();
        const [items, calls, comments, requests, memory] = await Promise.all([
          kinds.length ? admin.from("context_items").select("source, occurred_at, author, title, body, url").eq("client_id", r.client_id).in("source", kinds).gte("occurred_at", since).or(any(["title", "body"])).order("occurred_at", { ascending: false }).limit(25) : { data: [] },
          want.has("calls") ? admin.from("client_calls").select("source, title, occurred_at, url, notes").eq("client_id", r.client_id).gte("occurred_at", since).or(any(["title", "notes"])).order("occurred_at", { ascending: false }).limit(8) : { data: [] },
          want.has("creative") ? admin.from("review_comments").select("body, created_at, author_name, requests(number, title)").eq("client_id", r.client_id).gte("created_at", since).or(any(["body"])).order("created_at", { ascending: false }).limit(20) : { data: [] },
          want.has("creative") ? admin.from("requests").select("number, title, stage, created_at, launched_at, brief").eq("client_id", r.client_id).is("deleted_at", null).gte("created_at", since).or(any(["title", "brief"])).order("created_at", { ascending: false }).limit(15) : { data: [] },
          want.has("memory") ? admin.from("client_memory").select("kind, body, source, created_at").eq("client_id", r.client_id).eq("status", "active").or(any(["body"])).limit(20) : { data: [] },
        ]);
        const found = {
          messages_and_files: (items.data ?? []).map((i) => ({ when: String(i.occurred_at).slice(0, 10), where: i.source, who: i.author, title: i.title, text: around(i.body as string), link: i.url })),
          calls: (calls.data ?? []).map((k) => ({ when: String(k.occurred_at).slice(0, 10), source: k.source, title: k.title, link: k.url, excerpt: around(k.notes as string) })),
          review_comments: (comments.data ?? []).map((x) => ({ when: String(x.created_at).slice(0, 10), who: x.author_name, on: x.requests, text: x.body })),
          creative_requests: (requests.data ?? []).map((q) => ({ number: q.number, title: q.title, stage: q.stage, made: String(q.created_at).slice(0, 10), launched: q.launched_at ? String(q.launched_at).slice(0, 10) : null, brief: String(q.brief ?? "").slice(0, 500) })),
          remembered: memory.data ?? [],
        };
        const n = Object.values(found).reduce((a, l) => a + (l as unknown[]).length, 0);
        return note(`Searched the client's ${[...want].join(", ")} for "${words.join('", "')}" (${n} found)`, found);
      },
    },
    {
      name: "recent_calls",
      description: "The client's recorded calls (Fireflies and Gemini), newest first: date, title, what was said and decided. Use read_call for one call's full notes and transcript.",
      input_schema: { type: "object", properties: { count: { type: "integer", minimum: 1, maximum: 15 } }, additionalProperties: false },
      run: async (input) => {
        const { data } = await admin.from("client_calls").select("id, source, title, occurred_at, url, summary").eq("client_id", r.client_id).order("occurred_at", { ascending: false }).limit(Math.min(15, Number(input.count) || 6));
        return note("Recent calls", (data ?? []).map((k) => ({ id: k.id, when: String(k.occurred_at).slice(0, 10), source: k.source, title: k.title, link: k.url, summary: k.summary })));
      },
    },
    {
      name: "read_call",
      description: "One recorded call's full notes and transcript, by its id from recent_calls.",
      input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      run: async (input) => {
        const { data } = await admin.from("client_calls").select("title, occurred_at, url, notes").eq("client_id", r.client_id).eq("id", String(input.id)).maybeSingle();
        if (!data) throw new Error("No call with that id for this client.");
        return note(`Call · ${data.title} (${String(data.occurred_at).slice(0, 10)})`, { title: data.title, when: String(data.occurred_at).slice(0, 10), link: data.url, notes: String(data.notes ?? "").slice(0, 40_000) });
      },
    },
  ];

  if (r.platform !== "google" && account) {
    const { metaInsights, adDetail } = await import("@/lib/context/meta");
    tools.push(
      {
        name: "meta_insights",
        description: `Pulls live numbers from ${client?.name ?? "the client"}'s Meta ad account (read only). Any date range, at the account, campaign, ad set or ad level, optionally broken down (age, gender, placement, device, region) or by day/week. Use it whenever the buyer asks for a number, a comparison or a breakdown the report doesn't already have.`,
        input_schema: {
          type: "object",
          properties: {
            since: { type: "string", description: "YYYY-MM-DD" },
            until: { type: "string", description: "YYYY-MM-DD" },
            level: { type: "string", enum: ["account", "campaign", "adset", "ad"] },
            fields: { type: "array", items: { type: "string", enum: META_FIELDS }, description: "Defaults to spend, impressions, reach, clicks, ctr, actions, cost_per_action_type" },
            breakdown: { type: "string", enum: META_BREAKDOWNS },
            time_increment: { type: "string", enum: ["all_days", "1", "7", "monthly"] },
          },
          required: ["since", "until", "level"],
          additionalProperties: false,
        },
        run: async (input) => {
          const since = String(input.since);
          const until = String(input.until);
          if (!DAY.test(since) || !DAY.test(until) || since > until) throw new Error("Dates must be YYYY-MM-DD, since before until.");
          const level = String(input.level);
          const fields = (Array.isArray(input.fields) && input.fields.length ? (input.fields as string[]) : ["spend", "impressions", "reach", "clicks", "ctr", "actions", "cost_per_action_type"]).filter((f) => META_FIELDS.includes(f));
          const names = level === "campaign" ? ["campaign_name"] : level === "adset" ? ["campaign_name", "adset_name"] : level === "ad" ? ["campaign_name", "ad_id", "ad_name"] : [];
          const rows = await metaInsights(account, {
            level,
            time_range: JSON.stringify({ since, until }),
            fields: [...names, ...fields].join(","),
            ...(input.breakdown && META_BREAKDOWNS.includes(String(input.breakdown)) ? { breakdowns: String(input.breakdown) } : {}),
            ...(input.time_increment && input.time_increment !== "all_days" ? { time_increment: String(input.time_increment) } : {}),
          });
          return note(`Meta · ${level}${input.breakdown ? ` by ${input.breakdown}` : ""} · ${since} to ${until}`, slim(rows as unknown as Record<string, unknown>[]));
        },
      },
      {
        name: "meta_ad",
        description: "One Meta ad's copy and creative (primary text, headline, call to action, link, image or video) by its ad_id from meta_insights.",
        input_schema: { type: "object", properties: { ad_id: { type: "string" } }, required: ["ad_id"], additionalProperties: false },
        run: async (input) => note(`Meta · ad ${input.ad_id}`, await adDetail(String(input.ad_id))),
      },
    );
  }

  if (r.platform === "google" && account) {
    const { googleQuery } = await import("@/lib/context/google-ads");
    tools.push({
      name: "google_ads_query",
      description: `Runs a read-only GAQL SELECT on ${client?.name ?? "the client"}'s Google Ads account, e.g. "SELECT campaign.name, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date BETWEEN '2026-10-26' AND '2026-11-01'". Cost is in micros (divide by 1,000,000). Use it for any number, search term, keyword or breakdown the report doesn't already have.`,
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
      run: async (input) => {
        const rows = await googleQuery(account, String(input.query));
        return note(`Google Ads · ${String(input.query).replace(/\s+/g, " ").slice(0, 120)}`, rows.slice(0, 300));
      },
    });
  }

  const { motionConnected, openSession } = await import("@/lib/motion");
  if (await motionConnected(admin).catch(() => null)) {
    let session: Awaited<ReturnType<typeof openSession>> | null = null;
    const open = async () => (session ??= await openSession(admin));
    const workspace = client?.motion_workspace_id ?? null;
    tools.push(
      {
        name: "motion_tools",
        description: `Lists what Motion (creative analytics, read only) can look up: each tool's name, what it does and what it takes. Call this first, then motion_call.${workspace ? ` ${client?.name}'s Motion workspace id is ${workspace}.` : " This client has no Motion workspace linked; look it up by name if a tool allows."}`,
        input_schema: { type: "object", properties: {}, additionalProperties: false },
        run: async () => (await (await open()).list()).map((x) => ({ name: x.name, description: x.description?.slice(0, 400), input: x.inputSchema?.properties ? Object.keys(x.inputSchema.properties) : [], required: x.inputSchema?.required ?? [] })),
      },
      {
        name: "motion_call",
        description: "Calls one Motion tool by name with its arguments (from motion_tools). Read only: Motion can't change anything.",
        input_schema: { type: "object", properties: { tool: { type: "string" }, arguments: { type: "object" } }, required: ["tool"], additionalProperties: false },
        run: async (input) => {
          const args = { ...((input.arguments ?? {}) as Record<string, unknown>) };
          // The client's workspace, when the tool takes one and the AI left it out
          const s = await open();
          const takes = Object.keys((await s.list()).find((x) => x.name === input.tool)?.inputSchema?.properties ?? {});
          if (workspace && takes.includes("workspaceId") && !("workspaceId" in args)) args.workspaceId = workspace;
          return note(`Motion · ${input.tool}`, await s.call(String(input.tool), args));
        },
      },
    );
  }
  return tools;
}

/** What the tools can reach for this report, in one line for the prompt */
export function toolsLine(tools: AiTool[]) {
  const has = (n: string) => tools.some((t) => t.name === n);
  const reach = [
    has("meta_insights") && "the Meta ad account (live)",
    has("google_ads_query") && "the Google Ads account (live)",
    has("motion_tools") && "Motion's creative analytics",
    "everything on file for the client (Slack, email, Drive, recorded calls with transcripts, creative requests and comments, the Brand Bible, the strategy, what's remembered)",
    "this client's earlier reports",
  ].filter(Boolean);
  return `You can look things up before you answer: ${reach.join("; ")}. When the buyer asks for a number, a breakdown, a comparison, creative performance, something said on a call or in Slack, or an earlier report's format, use the tools; never say you can't reach them. Numbers you pull are real data: use them exactly, say the range, and keep the report's own numbers unless the buyer asks to change the period. What's in Slack, email, calls and internal notes informs the report; nothing internal goes into what the client reads.`;
}
