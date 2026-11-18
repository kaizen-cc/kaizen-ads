import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import type { Staff } from "@/lib/auth";
import type { CallCard, CallEvent } from "@/lib/agent-call/core";
import { CARD_TOOLS, gateTools, type LoopTool } from "@/lib/agent-call/tool-loop";
import { askTools } from "@/lib/agent-call/ask-tools";
import { callCardTools, emailRequestTool, showCard as showCallCard, type CardCtx } from "@/lib/agent-call/call-cards";
import { chatTools, type ChatTool, type ToolCtx } from "@/lib/kaizen-ai/tools";
import { cleanMemory, safeAppPath, safeLink, saidYes, ASSISTANT_KEY, FACT_TOPICS, STYLE_TOPICS, SCREEN_PLACES, KPI_CARD_TABS, CHANNEL_SHEET_TABS, kpiCardHref, channelSheetHref } from "./core";
import { forgetContext, myWork } from "./context";
import { saveNotes } from "./memory";
import { commsTools } from "./comms-tools";
import { profileTools } from "./profile-tools";
import { lookupTools } from "./lookup-tools";
import { failedOnOurSide } from "./messages";

// What the assistant can do on a call, as the person and only within their rights: everything Kaizen AI's tools do
// for them (each checks the client and their permissions again), plus opening screens, link cards, asking for files,
// their day, reports, audits, requests and tickets, and their private memory (bringing specialists in and working a job
// together are the team tools, src/lib/assistant/team-server.ts). Anything that
// sends to a client, spends money or credits, or goes live needs a spoken yes on that very turn (the model's
// confirmed flag AND the person's own words), so it can't run on a guess. Cards the chat tools make (a brief, a change
// plan, a launch) are saved to a Kaizen AI thread for this call, where they're confirmed exactly as in the chat, and
// shown on the call as link cards.

export type CallState = {
  /** The Kaizen AI thread this call's cards live in */
  threadId: string | null;
};

export type AssistantCtx = {
  me: Staff;
  db: SupabaseClient;
  admin: SupabaseClient;
  callId: string;
  /** What the person said on this turn: a gated action runs only when this is a clear yes */
  said: string;
  emit: (e: CallEvent) => void;
  state: CallState;
  /** The screen they're on (a path), where they called from, and the client the call is about */
  path?: string | null;
  screen?: string | null;
  clientId?: string | null;
};

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const CLIENT = { type: "string", description: "The client's name" };
const NO_YES = "Not run: say in one sentence exactly what this will do and ask; run it again with confirmed: true only once they clearly say yes.";

/** The client named, if this person may see it (their own session decides) */
async function clientNamed(db: SupabaseClient, name: unknown): Promise<{ id: string; name: string; slug: string }> {
  const asked = clip(name, 120);
  if (!asked) throw new Error("Which client?");
  const safe = asked.replace(/[%_,()]/g, " ").trim();
  const { data } = await db.from("clients").select("id, name, slug").is("archived_at", null).ilike("name", `%${safe}%`).limit(5);
  const hit = (data ?? []).find((c) => String(c.name).toLowerCase() === asked.toLowerCase()) ?? (data ?? [])[0];
  if (!hit) throw new Error(`No client called "${asked}" that you can see.`);
  return hit as { id: string; name: string; slug: string };
}

const showCard = (ctx: AssistantCtx, c: Omit<CallCard, "id">) => showCallCard(ctx, c);

/** A gated action: the model said confirmed AND the person's own words this turn are a yes */
const yes = (ctx: AssistantCtx, input: Record<string, unknown>) => input.confirmed === true && saidYes(ctx.said);
const CONFIRMED = { type: "boolean", description: "True only after the person clearly said yes to this exact action on this turn" };

// ─── Reports: telling the person when it's ready ────────────────────────────

/** In-app, and a Slack direct message when their Slack is connected */
export async function tellReportReady(admin: SupabaseClient, profileId: string, r: { id: string; client: string; failed: boolean }) {
  const title = r.failed ? `The ${r.client} report didn't build` : `Your ${r.client} report is ready`;
  const body = r.failed ? "Open it to see what went wrong and build it again." : "Built from our call. Open it to review before it goes anywhere.";
  await admin.from("notifications").upsert({ profile_id: profileId, kind: "assistant", title, body, href: `/reports/${r.id}`, key: `assistant-report:${r.id}`, priority: "normal", read_at: null }, { onConflict: "profile_id,key", ignoreDuplicates: true });
  try {
    const { slackConnection, postAsApp } = await import("@/lib/slack-user");
    const s = await slackConnection(profileId);
    if (s.connected && s.slackUserId) {
      const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
      await postAsApp({ channel: s.slackUserId, text: `${title}. ${body}${base ? ` ${base}/reports/${r.id}` : ""}` });
    }
  } catch (e) {
    console.error("[assistant] slack dm", e instanceof Error ? e.message : e);
  }
}

type Watch = { kind: "report"; id: string; client: string; done?: boolean };

/** Checks the reports a call started; tells the person about each one that's ready (or failed). Returns how many are left. */
export async function checkWatches(admin: SupabaseClient, callId: string): Promise<number> {
  const { data: call } = await admin.from("ai_role_calls").select("profile_id, watches").eq("id", callId).maybeSingle();
  if (!call) return 0;
  const watches = ((call.watches ?? []) as Watch[]).slice();
  const open = watches.filter((w) => !w.done);
  if (!open.length) return 0;
  const { data: rows } = await admin.from("reports").select("id, status").in("id", open.map((w) => w.id));
  for (const w of open) {
    const st = (rows ?? []).find((r) => r.id === w.id)?.status as string | undefined;
    if (!st || st === "queued" || st === "drafting") continue;
    await tellReportReady(admin, call.profile_id as string, { id: w.id, client: w.client, failed: st === "failed" });
    w.done = true;
  }
  await admin.from("ai_role_calls").update({ watches }).eq("id", callId);
  return watches.filter((w) => !w.done).length;
}

async function watchReport(ctx: AssistantCtx, id: string, client: string) {
  const { data } = await ctx.admin.from("ai_role_calls").select("watches").eq("id", ctx.callId).maybeSingle();
  const watches = [...((data?.watches ?? []) as Watch[]), { kind: "report" as const, id, client }];
  await ctx.admin.from("ai_role_calls").update({ watches }).eq("id", ctx.callId);
  // Checked for a few minutes from here; the cron catches anything slower
  after(async () => {
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 15_000));
      if ((await checkWatches(ctx.admin, ctx.callId).catch(() => 1)) === 0) return;
    }
  });
}

// ─── Opening the exact thing ────────────────────────────────────────────────

const CLIENT_TABS: Record<string, string> = { ads: "?service=meta", email: "?service=email", social: "?service=social", creative: "?service=creative", team: "?tab=team", reports: "?tab=reports", overview: "" };

/**
 * Where open_screen goes: the exact card, sheet, ticket, report, audit or sprint asked for, looked up through the
 * person's own session (only what they may see), or a named place, or a path
 */
async function screenFor(ctx: AssistantCtx, input: Record<string, unknown>): Promise<{ href: string; label: string } | { note: string }> {
  const what = String(input.what ?? "");
  const tab = typeof input.card_tab === "string" ? input.card_tab : null;
  const platform = input.platform === "google" ? "google" : input.platform === "tiktok" ? "tiktok" : "meta";
  const pw = platform === "google" ? "Google" : platform === "tiktok" ? "TikTok" : "Meta";
  const onTab = tab && tab !== "overview" ? `, ${tab} tab` : "";
  if (typeof input.href === "string" && input.href.trim()) return { href: input.href.trim(), label: "that page" };
  if (!what && typeof input.place === "string" && SCREEN_PLACES[input.place]) return { href: SCREEN_PLACES[input.place], label: input.place };
  const n = Number(input.number);
  if (what === "ticket" || what === "email_ticket") {
    if (!Number.isFinite(n) || n <= 0) return { note: "Which ticket number?" };
    const { data } = what === "email_ticket" ? await ctx.db.from("email_tickets").select("id").eq("number", n).is("deleted_at", null).maybeSingle() : await ctx.db.from("requests").select("id").eq("number", n).maybeSingle();
    if (!data) return { note: `No ${what === "email_ticket" ? "email " : ""}ticket #${n} they can see.` };
    return { href: what === "email_ticket" ? `/board/email?t=${n}` : `/board?t=${n}`, label: `ticket #${n}` };
  }
  if (what === "profile") {
    // A teammate's profile by name (profiles are staff-wide), or their own
    const who = clip(input.person, 80).replace(/[%_,()]/g, " ").trim();
    if (!who) return { href: `/profile/${ctx.me.id}`, label: "your profile" };
    const { data } = await ctx.db.from("profiles").select("id, full_name, display_name").or(`full_name.ilike.%${who}%,display_name.ilike.%${who}%`).eq("is_active", true).limit(5);
    const hits = (data ?? []) as { id: string; full_name: string }[];
    if (!hits.length) return { note: `No teammate called ${who}.` };
    if (hits.length > 1) return { note: `More than one teammate fits: ${hits.map((h) => h.full_name).join(", ")}. Ask which.` };
    return { href: `/profile/${hits[0].id}`, label: `${hits[0].full_name}'s profile` };
  }
  if (what === "direction_change") {
    // A change by its id, or the client's newest open one
    const id = clip(input.id, 40);
    let q = ctx.db.from("client_direction_changes").select("id, clients(name, slug)");
    if (/^[0-9a-f-]{36}$/i.test(id)) q = q.eq("id", id);
    else if (input.client) {
      try {
        q = q.eq("client_id", (await clientNamed(ctx.db, input.client)).id).eq("status", "open");
      } catch (e) {
        return { note: `${e instanceof Error ? e.message : "No such client."} Ask which client they meant.` };
      }
    } else return { note: "Which client, or which change (its id from direction_changes)?" };
    const { data } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!data) return { note: "No open direction change there they can see." };
    const c = data.clients as unknown as { name: string; slug: string };
    return { href: `/clients/${c.slug}?direction=${data.id}`, label: `${c.name}'s change of direction` };
  }
  if (what === "feedback") {
    // A report they filed (by its id from submit_feedback): its group once it's been read, else their own list
    const id = clip(input.id, 40);
    if (!/^[0-9a-f-]{36}$/i.test(id)) return { href: "/feedback?tab=mine", label: "your feedback" };
    const { data } = await ctx.db.from("app_feedback").select("group_id").eq("id", id).maybeSingle();
    return data?.group_id ? { href: `/feedback?g=${data.group_id}`, label: "that feedback" } : { href: "/feedback?tab=mine", label: "your feedback" };
  }
  if (what === "agent") {
    const role = clip(input.role, 60).replace(/[^a-z_]/g, "");
    if (!role) return { note: "Which agent?" };
    return { href: `/settings?tab=agents&role=${role}`, label: `the ${role.replace(/_/g, " ")} agent` };
  }
  if (!input.client) return what ? { note: "Which client?" } : { note: "Where to? Name a client, a place, or what to open." };
  let c: { id: string; name: string; slug: string };
  try {
    c = await clientNamed(ctx.db, input.client);
  } catch (e) {
    return { note: `${e instanceof Error ? e.message : "No such client."} Ask which client they meant.` };
  }
  const targets = async () => {
    const { data } = await ctx.db.from("kpi_targets").select("id").eq("client_id", c.id).eq("platform", platform).eq("active", true).limit(5);
    return ((data ?? []) as { id: string }[]).map((t) => t.id);
  };
  switch (what) {
    case "kpi_card": {
      const [id] = await targets();
      if (!id) return { note: `${c.name} has no ${pw} account on the KPI board they can see.` };
      return { href: kpiCardHref(id, tab), label: `${c.name}'s ${pw} KPI card${onTab}` };
    }
    case "email_sheet":
    case "social_sheet": {
      const line = what === "email_sheet" ? "email" : "social";
      return { href: channelSheetHref(line, c.id, tab), label: `${c.name}'s ${line} sheet${onTab}` };
    }
    case "report": {
      const { data } = await ctx.db.from("reports").select("id").eq("client_id", c.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      return data ? { href: `/reports/${data.id}`, label: `${c.name}'s latest report` } : { note: `${c.name} has no report yet. Offer to build one.` };
    }
    case "audit": {
      const ids = await targets();
      const { data } = ids.length ? await ctx.db.from("account_audits").select("id").in("target_id", ids).order("created_at", { ascending: false }).limit(1).maybeSingle() : { data: null };
      return data ? { href: `/kpis/audit/${data.id}`, label: `${c.name}'s latest ${pw} audit` } : { note: `${c.name} has no ${pw} audit yet. Offer to run one.` };
    }
    case "email_audit": {
      const { data } = await ctx.db.from("email_audits").select("id").eq("client_id", c.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      return data ? { href: `/kpis/email-audit/${data.id}`, label: `${c.name}'s latest email audit` } : { note: `${c.name} has no email audit yet. Offer to run one.` };
    }
    case "sprint": {
      const ids = await targets();
      const { data } = ids.length ? await ctx.db.from("optimization_sprints").select("id").in("target_id", ids).order("started_at", { ascending: false }).limit(1).maybeSingle() : { data: null };
      return data ? { href: `/kpis/sprint/${data.id}`, label: `${c.name}'s ${pw} sprint` } : { note: `${c.name} has no ${pw} sprint.` };
    }
    case "email_sprint": {
      const { data } = await ctx.db.from("email_sprints").select("id").eq("client_id", c.id).order("started_at", { ascending: false }).limit(1).maybeSingle();
      return data ? { href: `/kpis/email-sprint/${data.id}`, label: `${c.name}'s email sprint` } : { note: `${c.name} has no email sprint.` };
    }
    case "social_audit": {
      const { data } = await ctx.db.from("social_audits").select("id").eq("client_id", c.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      return data ? { href: `/kpis/social-audit/${data.id}`, label: `${c.name}'s latest social audit` } : { note: `${c.name} has no social audit yet. Offer to run one.` };
    }
    case "social_sprint": {
      const { data } = await ctx.db.from("social_sprints").select("id").eq("client_id", c.id).order("started_at", { ascending: false }).limit(1).maybeSingle();
      return data ? { href: `/kpis/social-sprint/${data.id}`, label: `${c.name}'s social sprint` } : { note: `${c.name} has no social sprint.` };
    }
    default:
      return { href: `/clients/${c.slug}${CLIENT_TABS[String(input.tab ?? "overview")] ?? ""}`, label: `${c.name}'s page` };
  }
}

// ─── The tools ──────────────────────────────────────────────────────────────

export async function assistantTools(ctx: AssistantCtx): Promise<LoopTool[]> {
  const tctx: ToolCtx = { me: ctx.me, db: ctx.db, admin: ctx.admin, clientId: null, messageId: crypto.randomUUID(), cards: [], files: [] };
  // Files uploaded on this call are attachments for the chat tools (a launch sheet, a PDF)
  const { data: callRow } = await ctx.admin.from("ai_role_calls").select("uploads").eq("id", ctx.callId).maybeSingle();
  tctx.files = (((callRow?.uploads ?? []) as { path: string; name: string; mime: string; bytes: number; kind: string }[]) ?? []).map((u) => ({ path: u.path, name: u.name, mime: u.mime, bytes: u.bytes, kind: u.kind })) as ToolCtx["files"];

  const base = await chatTools(tctx).catch((e) => {
    console.error("[assistant tools]", e instanceof Error ? e.message : e);
    return [] as ChatTool[];
  });
  // Card tools (a brief, a plan, a launch, copy, a deck) and the Email Board request: made on this call's Kaizen AI
  // thread, then shown as a link card to review (shared with the agents' calls, src/lib/agent-call/call-cards.ts)
  const thread = {
    get id() {
      return ctx.state.threadId;
    },
    set id(v: string | null) {
      ctx.state.threadId = v;
    },
  };
  const cctx: CardCtx = { me: ctx.me, db: ctx.db, admin: ctx.admin, callId: ctx.callId, said: ctx.said, emit: ctx.emit, label: "your assistant", thread };
  const cardTools: LoopTool[] = [...callCardTools(cctx, tctx, base), ...emailRequestTool(cctx, () => forgetContext(ctx.me.id))];
  const rest = gateTools([...base.filter((t) => !CARD_TOOLS.has(t.name)), ...askTools(tctx, { roleKey: ASSISTANT_KEY, label: "assistant", callId: ctx.callId, said: ctx.said })]).map((t) => {
    const s = t.input_schema as { properties?: Record<string, unknown> };
    if (!s.properties || !("confirmed" in s.properties)) return t;
    // A gated tool: the person's own words on this turn must be a yes too
    return { ...t, run: async (input: Record<string, unknown>) => (input.confirmed === true && !saidYes(ctx.said) ? { done: false, note: NO_YES } : t.run(input)) };
  });

  const own: LoopTool[] = [
    {
      name: "my_work",
      description: "Everything on the person right now, in order: critical first, then simple to complex (their recap, Next for me, tickets on both boards, reports waiting, replies they owe, reminders, unread notifications). Use for 'what do I need to do today' and to go past the first items in your context. For an exec, what's outside their focus is left out unless they ask for everything else (only: everything_else).",
      input_schema: { type: "object", properties: { only: { type: "string", enum: ["all", "critical", "tickets", "reports", "replies", "reminders", "notifications", "everything_else"] }, limit: { type: "integer" } }, additionalProperties: false },
      run: async (input) => {
        const items = await myWork(ctx.db, ctx.me);
        const only = String(input.only ?? "all");
        const pick = items.filter((i) =>
          only === "everything_else" ? i.kind === "elsewhere" : i.kind === "elsewhere" ? false : only === "critical" ? i.tier === "critical" : only === "tickets" ? i.source === "ticket" || i.source === "email_ticket" : only === "reports" ? i.source === "report" : only === "replies" ? i.source === "owed" : only === "reminders" ? i.source === "ask" : only === "notifications" ? i.source === "notification" : true,
        );
        return { count: pick.length, items: pick.slice(0, Math.min(40, Number(input.limit) || 20)).map((i) => ({ id: i.id, tier: i.tier, client: i.client, title: i.title, why: i.why, open: i.href })) };
      },
    },
    {
      name: "creative_allotments",
      description: "This billing cycle's creative allotment gaps in the person's slice (head of creative and execs every client; the lead graphic designer images and carousels, the lead video editor video, across clients; a designer or editor their own clients), most urgent first: what's missing, when each resets, what's due this week to stay on pace, and (for the head of creative) this week's load against a usual week. Also accounts off target that need fresh creative. Paused clients and paused creative never show. To brief one, open its create link with open_screen (href).",
      input_schema: { type: "object", properties: { client: CLIENT }, additionalProperties: false },
      run: async (input) => {
        const { loadAllotmentDesk } = await import("@/lib/creative-allotments-load");
        const { createBriefHref, POOL_FORMAT } = await import("@/lib/creative-allotments");
        const d = await loadAllotmentDesk(ctx.db, ctx.me);
        const want = String(input.client ?? "").toLowerCase().trim();
        const gaps = d.gaps.filter((g) => !want || g.client.toLowerCase().includes(want));
        if (!d.gaps.length && !d.fresh.length) return { note: "No allotment gaps in their slice (or no creative allotments they see)." };
        return {
          gaps: gaps.filter((g) => g.missing > 0).slice(0, 25).map((g) => ({ client: g.client, pool: g.pool, line: g.line, detail: g.detail, pace: g.pace, resets_on: g.resetsOn, create: createBriefHref(g.slug, POOL_FORMAT[g.pool]) })),
          briefed: gaps.filter((g) => !g.missing).length,
          this_week: d.load?.map((w) => w.line) ?? null,
          needs_fresh_creative: d.fresh.map((f) => ({ client: f.client, why: f.why, create: createBriefHref(f.slug, null) })),
          overview: "/pipeline?tab=clients#allotments",
        };
      },
    },
    {
      name: "open_screen",
      description:
        "Takes the person to the exact thing in the app while the call carries on. Open the most specific thing they named, never the page around it: 'open Ocean Box's Google KPI card' is what: kpi_card, client, platform google (not the whole KPI board). what: client (a client's page, with tab), kpi_card (one ad account's card on the KPI board; card_tab: overview, numbers, actions, policy, creative, notes, settings), email_sheet or social_sheet (a client's sheet on the Email or Social KPI board; card_tab: overview, numbers, campaigns, flows, actions, notes, settings for email; overview, posts, actions, notes, settings for social), ticket (creative board, by number), email_ticket (Email Board, by number), report (the client's latest, or href for one), audit (the client's latest Meta or Google audit; platform), email_audit, social_audit, sprint (the client's Meta or Google sprint; platform), email_sprint, social_sprint, agent (an AI agent's page in Settings, by role key), direction_change (a client's change of direction with its flagged tasks: by id from direction_changes, or the client's newest), feedback (a report they filed: id from submit_feedback, or their own feedback list), profile (a teammate's profile by name in person, or their own). Or a place by name (place: a board, a KPI view, a Settings tab, the assistant's settings), or an exact in-app path (href). Say in a few words what you opened.",
      input_schema: {
        type: "object",
        properties: {
          what: { type: "string", enum: ["profile", "client", "kpi_card", "email_sheet", "social_sheet", "ticket", "email_ticket", "report", "audit", "email_audit", "social_audit", "sprint", "email_sprint", "social_sprint", "agent", "direction_change", "feedback"] },
          person: { type: "string", description: "A teammate's name (what: profile); leave out for their own profile" },
          id: { type: "string", description: "A direction change's id (what: direction_change), or a feedback report's id from submit_feedback (what: feedback)" },
          client: CLIENT,
          tab: { type: "string", enum: ["overview", "ads", "email", "social", "creative", "team", "reports"], description: "The client page's tab (what: client)" },
          platform: { type: "string", enum: ["meta", "google", "tiktok"], description: "The ad platform (kpi_card, audit, sprint)" },
          card_tab: { type: "string", enum: [...new Set<string>([...KPI_CARD_TABS, ...CHANNEL_SHEET_TABS])], description: "The tab inside the card or sheet" },
          number: { type: "integer", description: "A ticket's number" },
          role: { type: "string", description: "An agent's role key (what: agent), e.g. email_strategist, media_buyer, creative_director" },
          place: { type: "string", enum: Object.keys(SCREEN_PLACES) },
          href: { type: "string", description: "An in-app path starting with /" },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const opened = await screenFor(ctx, input);
        if ("note" in opened) return { opened: false, note: opened.note };
        const href = safeAppPath(opened.href);
        if (!href) return { opened: false, note: "That isn't a screen in the app." };
        ctx.emit({ t: "navigate", href });
        return { opened: href, what: opened.label };
      },
    },
    {
      name: "clear_my_item",
      description: "Clears something off the person's own day when they say it's handled, to dismiss it, or that it isn't theirs (those two are done, dismiss that nudge, that's not mine). Use the ids from my_work. done: they handled it; dismissed: drop the nudge; not_mine: it isn't theirs to do. It leaves their Overview and recap only; it stays for everyone else. Tickets and reports aren't cleared this way: move the ticket or send the report instead. Say what you cleared in a few words.",
      input_schema: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, description: "Item ids from my_work" }, how: { type: "string", enum: ["done", "dismissed", "not_mine"] } }, required: ["ids", "how"], additionalProperties: false },
      run: async (input) => {
        const ids = (Array.isArray(input.ids) ? input.ids : []).map(String).slice(0, 20);
        const status = input.how === "done" ? "done" : "dismissed";
        const items = new Map((await myWork(ctx.db, ctx.me)).map((i) => [i.id, i]));
        const { markItem } = await import("@/lib/item-state");
        const done: string[] = [];
        const skipped: string[] = [];
        for (const id of ids) {
          const it = items.get(id);
          const label = it?.title ?? id;
          try {
            if (id.startsWith("recap-")) {
              const { setItem } = await import("@/app/today/actions");
              await setItem(id.slice(6), status, { topic: it?.kind ?? "work", client: it?.client ?? "", title: label, clientId: null });
            } else if (id.startsWith("ag-")) {
              // A client's follow-ups gathered on one line: all of them
              await ctx.db.from("agent_asks").update({ status, done_at: new Date().toISOString() }).in("id", id.slice(3).split(",").slice(0, 60)).eq("owner_id", ctx.me.id);
            } else if (id.startsWith("a-") || id.startsWith("next-ask-")) {
              const askId = id.startsWith("a-") ? id.slice(2) : id.slice(9);
              await ctx.db.from("agent_asks").update({ status, done_at: new Date().toISOString() }).eq("id", askId).eq("owner_id", ctx.me.id);
            } else if (id.startsWith("o-")) {
              const { setItem, dismissOwed } = await import("@/app/today/actions");
              if (status === "done") await setItem(`owed:${id.slice(2)}`, "done", { topic: "promises", client: it?.client ?? "", title: label, clientId: null });
              else await dismissOwed(id.slice(2));
            } else if (id.startsWith("h-")) {
              await ctx.admin.from("assistant_heads_ups").update({ done_at: new Date().toISOString(), later: false }).eq("profile_id", ctx.me.id).eq("id", id.slice(2));
            } else if (id.startsWith("n-")) {
              await ctx.db.from("notifications").update({ read_at: new Date().toISOString() }).eq("profile_id", ctx.me.id).eq("id", id.slice(2));
            } else if (id.startsWith("next-")) {
              await markItem(ctx.db, ctx.me.id, `next:${id.slice(5)}`, status, { topic: "work", client: it?.client ?? "", title: label }, { label, href: it?.href ?? null });
            } else {
              skipped.push(label);
              continue;
            }
            done.push(label);
          } catch {
            skipped.push(label);
          }
        }
        return { cleared: done, not_cleared: skipped.length ? { items: skipped, why: "Tickets and reports move by their own steps (move_ticket, send the report), or the item wasn't found." } : undefined };
      },
    },
    {
      name: "show_link",
      description: "Shows a link card on the call ('take a look'): an ad in the ad account, a report, a ticket, a doc. In-app paths open in the app with the call still up; known outside sites (Meta, Google, Klaviyo, Loom) open in a new tab. Never invent a link: use one from your tools or context.",
      input_schema: { type: "object", properties: { title: { type: "string" }, detail: { type: "string" }, href: { type: "string" }, cta: { type: "string", description: "The button, two or three words" } }, required: ["title", "href"], additionalProperties: false },
      run: async (input) => {
        const l = safeLink(input.href);
        if (!l) return { shown: false, note: "That link can't be shown on a call." };
        showCard(ctx, { title: clip(input.title, 120), detail: clip(input.detail, 160), href: l.href, external: l.external, cta: clip(input.cta, 40) || "Open" });
        return { shown: true };
      },
    },
    {
      name: "keep_for_later",
      description: "When you called them about something urgent (your opening heads-up) and they say they'll look later: it stays at the top of their list (my_work, their day) until it's done. Say so in a few words and carry on. When they say yes instead, open it with open_screen (its link is in the heads-up).",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        const { keepForLater } = await import("./heads-up-server");
        const h = await keepForLater(ctx.admin, ctx.me.id).catch(() => null);
        forgetContext(ctx.me.id);
        return h ? { kept: true, items: h.items.map((i) => i.title) } : { kept: false, note: "There's no heads-up from the last couple of hours to keep." };
      },
    },
    {
      name: "urgent_call_settings",
      description: "How you reach them about urgent items, when they ask ('don't call me, just message me', 'no calls after 9pm', 'you can ring me again'): ring (you ring them in the app for ten seconds; missed ones wait in the chat) or chat (no ring, urgent things wait in the chat), and quiet hours when you never ring (HH:MM, their time zone). Leave a field out to keep it; quiet: false clears quiet hours. Without changes it says what's set.",
      input_schema: { type: "object", properties: { mode: { type: "string", enum: ["ring", "chat"] }, quiet_start: { type: "string", description: "HH:MM" }, quiet_end: { type: "string", description: "HH:MM" }, quiet: { type: "boolean" } }, additionalProperties: false },
      run: async (input) => {
        const [{ ringPrefs }, { cleanPrefs }] = await Promise.all([import("./heads-up-server"), import("./ring-core")]);
        const had = await ringPrefs(ctx.admin, ctx.me.id);
        const changing = input.mode != null || input.quiet_start != null || input.quiet_end != null || input.quiet != null;
        if (!changing) return { mode: had.mode, quiet_hours: had.quietStart && had.quietEnd ? `${had.quietStart} to ${had.quietEnd} (${had.tz})` : "none", settings: "/assistant#ring-title" };
        const off = input.quiet === false;
        const next = cleanPrefs({ mode: input.mode ?? had.mode, quietStart: off ? null : (input.quiet_start ?? had.quietStart), quietEnd: off ? null : (input.quiet_end ?? had.quietEnd), tz: had.tz });
        const { error } = await ctx.db.from("assistant_ring_prefs").upsert({ profile_id: ctx.me.id, mode: next.mode, quiet_start: next.quietStart, quiet_end: next.quietEnd, tz: next.tz, updated_at: new Date().toISOString() });
        if (error) return { saved: false, error: "It didn't save on our side. Try again." };
        return { saved: true, mode: next.mode, quiet_hours: next.quietStart && next.quietEnd ? `${next.quietStart} to ${next.quietEnd}` : "none" };
      },
    },
    {
      name: "switch_mode",
      description: "Moves this same conversation between a voice call and the typed chat window when they ask ('let's move to chat', 'I'll type', 'call me instead', 'let's talk'). Say one short line first ('Sure, moving us to chat.'); nothing is lost and you carry on where you were.",
      input_schema: { type: "object", properties: { to: { type: "string", enum: ["voice", "text"], description: "voice: a call; text: the chat window" } }, required: ["to"], additionalProperties: false },
      run: async (input) => {
        const to = input.to === "text" ? "text" : "voice";
        ctx.emit({ t: "switch", to });
        return { switching: to, note: "It switches once your line is out. Don't greet again afterwards." };
      },
    },
    {
      name: "ask_for_files",
      description: "Opens the upload panel on the call when you need files from them (launch creatives, a launch sheet, a PDF, screenshots): say what you need in a sentence. Once they upload, you'll get a turn telling you; then use read_uploads, confirm what you got and describe it briefly.",
      input_schema: { type: "object", properties: { purpose: { type: "string", enum: ["creatives", "files"] }, client: CLIENT, note: { type: "string", description: "What to upload, shown on the panel" } }, required: ["purpose", "note"], additionalProperties: false },
      run: async (input) => {
        ctx.emit({ t: "upload", ask: { purpose: input.purpose === "creatives" ? "creatives" : "files", client: clip(input.client, 120) || null, note: clip(input.note, 200) } });
        return { panel: "open", note: "Wait for them to upload; don't describe files you haven't read." };
      },
    },
    {
      name: "read_uploads",
      description: "What was uploaded on this call: each file's name, type, a short description of what's in it, and for documents how much was read (pages, characters: every page is kept). Use after they upload; read_upload reads a document's text itself.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        const { data } = await ctx.admin.from("ai_role_calls").select("uploads").eq("id", ctx.callId).maybeSingle();
        const ups = (data?.uploads ?? []) as { name: string; kind: string; purpose: string; client: string | null; about?: string; pages?: number; chars?: number; textPath?: string; textNote?: string }[];
        return { files: ups.map((u) => ({ name: u.name, kind: u.kind, purpose: u.purpose, client: u.client, about: u.about ?? "(still being read)", ...(u.textPath ? { whole_text_read: true, pages: u.pages ?? null, characters: u.chars ?? null } : {}), ...(u.textNote ? { note: u.textNote } : {}) })) };
      },
    },
    {
      name: "remember",
      description: "Saves something the person told you about themselves to their private memory (only they can see it): a birthday, family, a trip, a preference, how they like updates. Only what they said, never anything about clients, secrets or health. For a trip or event, set follow_up_on to the day after it ends so you can ask how it went.",
      input_schema: {
        type: "object",
        properties: { topic: { type: "string", enum: [...FACT_TOPICS] }, body: { type: "string", description: "One short sentence about them, in the second person" }, on_date: { type: "string", description: "YYYY-MM-DD when a date matters" }, follow_up_on: { type: "string", description: "YYYY-MM-DD to ask how it went" } },
        required: ["topic", "body"],
        additionalProperties: false,
      },
      run: async (input) => {
        const notes = cleanMemory({ notes: [{ kind: "fact", ...input }] });
        if (!notes.length) return { saved: false, note: "That isn't something you keep (secrets, health, clients). Say so kindly." };
        await saveNotes(ctx.admin, ctx.me.id, notes, ctx.callId);
        return { saved: true };
      },
    },
    {
      name: "set_style",
      description: "Notes how the person likes to talk when they say so ('keep it short', 'numbers first', 'no jokes'): saved to their private memory and used from now on.",
      input_schema: { type: "object", properties: { topic: { type: "string", enum: [...STYLE_TOPICS] }, body: { type: "string" } }, required: ["topic", "body"], additionalProperties: false },
      run: async (input) => {
        const notes = cleanMemory({ notes: [{ kind: "style", ...input }] });
        if (!notes.length) return { saved: false };
        await saveNotes(ctx.admin, ctx.me.id, notes, ctx.callId);
        return { saved: true };
      },
    },
    {
      name: "forget",
      description: "Deletes things from the person's private memory when they ask you to forget something (matching words), or everything when they say forget everything (all: true, after a spoken yes).",
      input_schema: { type: "object", properties: { about: { type: "string" }, all: { type: "boolean" }, confirmed: CONFIRMED }, additionalProperties: false },
      run: async (input) => {
        if (input.all === true) {
          if (!yes(ctx, input)) return { done: false, note: NO_YES };
          await ctx.admin.from("assistant_memory").delete().eq("profile_id", ctx.me.id);
          return { forgot: "everything" };
        }
        const about = clip(input.about, 80).replace(/[%_,()]/g, " ").trim();
        if (!about) return { done: false, note: "What should I forget?" };
        const { data } = await ctx.admin.from("assistant_memory").delete().eq("profile_id", ctx.me.id).ilike("body", `%${about}%`).select("id");
        return { forgot: data?.length ?? 0 };
      },
    },
    {
      name: "create_report",
      description: "Builds a report for a client as the person (the report builder's own checks: their clients, an ad account with a KPI, or a connected email or social account). It drafts in the background; they're told in the app (and on Slack when connected) when it's ready. Nothing goes to the client. It uses AI credits: ask first, run with confirmed: true after a yes.",
      input_schema: {
        type: "object",
        properties: {
          client: CLIENT,
          line: { type: "string", enum: ["ads", "email", "social"] },
          platforms: { type: "array", items: { type: "string", enum: ["meta", "google"] }, description: "Ads only (default both)" },
          period: { type: "string", enum: ["lastWeek", "mtd", "lastMonth", "last7", "last14", "last30", "custom"] },
          start: { type: "string", description: "YYYY-MM-DD (custom)" },
          end: { type: "string", description: "YYYY-MM-DD (custom)" },
          confirmed: CONFIRMED,
        },
        required: ["client", "line", "period"],
        additionalProperties: false,
      },
      run: async (input) => {
        if (!yes(ctx, input)) return { done: false, note: NO_YES };
        const c = await clientNamed(ctx.db, input.client);
        const range = { key: String(input.period), ...(input.period === "custom" ? { start: clip(input.start, 10), end: clip(input.end, 10) } : {}) };
        let id: string;
        if (input.line === "email" || input.line === "social") {
          const { buildChannelReportAction } = await import("@/app/(team)/reports/channel-actions");
          const r = await buildChannelReportAction(c.id, input.line, range);
          if (!r.ok) return { done: false, error: r.error };
          id = r.id;
        } else {
          const { buildReportAction } = await import("@/app/(team)/reports/actions");
          const platforms = Array.isArray(input.platforms) && input.platforms.length ? (input.platforms as string[]) : ["meta", "google"];
          const r = await buildReportAction(c.id, [range], platforms);
          if (!r.ok) return { done: false, error: r.error };
          id = r.id;
        }
        await watchReport(ctx, id, c.name);
        showCard(ctx, { title: `${c.name} report`, detail: "Drafting now. You'll get a notification when it's ready.", href: `/reports/${id}`, external: false, cta: "Open the report" });
        forgetContext(ctx.me.id);
        return { started: true, reportId: id, note: "Say it's building and they'll be told when it's ready." };
      },
    },
    {
      name: "run_audit",
      description: "Runs an account audit as the person: Meta or Google (the KPI audit, on the client's ad account with a KPI), email (the email account audit) or social (the organic social audit: every platform against the social score, posts, hooks, formats, posting times). The audit's own checks apply (their clients, one at a time per account). It takes a few minutes and uses AI credits: ask first, confirmed: true after a yes.",
      input_schema: { type: "object", properties: { client: CLIENT, kind: { type: "string", enum: ["meta", "google", "email", "social"] }, confirmed: CONFIRMED }, required: ["client", "kind"], additionalProperties: false },
      run: async (input) => {
        if (!yes(ctx, input)) return { done: false, note: NO_YES };
        const c = await clientNamed(ctx.db, input.client);
        if (input.kind === "social") {
          const { requestSocialAudit, runSocialAudit } = await import("@/lib/social-ops/audit");
          const out = await requestSocialAudit(ctx.db, ctx.admin, c.id, ctx.me.id);
          if ("error" in out) return { done: false, error: out.error };
          if (out.running) after(() => runSocialAudit(ctx.admin, out.id));
          showCard(ctx, { title: `${c.name} social audit`, detail: "Running now, a few minutes", href: `/kpis/social-audit/${out.id}`, external: false, cta: "Open the audit" });
          return { started: true };
        }
        if (input.kind === "email") {
          const [{ requestEmailAudit, runEmailAudit }] = await Promise.all([import("@/lib/email-ops/audit")]);
          const out = await requestEmailAudit(ctx.db, ctx.admin, c.id, ctx.me.id);
          if ("error" in out) return { done: false, error: out.error };
          if (out.running) after(() => runEmailAudit(ctx.admin, out.id));
          showCard(ctx, { title: `${c.name} email audit`, detail: "Running now, a few minutes", href: `/kpis/email-audit/${out.id}`, external: false, cta: "Open the audit" });
          return { started: true };
        }
        const { data: targets } = await ctx.db.from("kpi_targets").select("id, label").eq("client_id", c.id).eq("platform", input.kind === "google" ? "google" : "meta").limit(5);
        const target = (targets ?? [])[0];
        if (!target) return { done: false, error: `${c.name} has no ${input.kind === "google" ? "Google" : "Meta"} KPI you can see.` };
        const [{ requestAudit }, { runAudit }] = await Promise.all([import("@/lib/audit-queue"), import("@/lib/audit")]);
        const out = await requestAudit(ctx.db, ctx.admin, ctx.me, { targetId: target.id as string });
        if ("error" in out) return { done: false, error: out.error };
        const o = out as unknown as { id: string; status?: string; started?: boolean };
        if (o.started || o.status === "running") after(() => runAudit(ctx.admin, o.id));
        showCard(ctx, { title: `${c.name} ${input.kind === "google" ? "Google" : "Meta"} audit`, detail: o.status === "queued" ? "Queued behind your other audits" : "Running now, a few minutes", href: `/kpis/audit/${o.id}`, external: false, cta: "Open the audit" });
        return { started: true, status: o.status ?? "running" };
      },
    },
    {
      name: "start_sprint",
      description: "Opens a sprint as the person from a client's latest finished email or social audit: every move on the audit's plan (or one move by its number in the plan, 1 first), followed and re-measured against the score every few days. One live sprint per client and line (a newer audit's sprint replaces an older one). Ask first, confirmed: true after a yes.",
      input_schema: { type: "object", properties: { client: CLIENT, line: { type: "string", enum: ["email", "social"] }, move: { type: "integer", minimum: 1, description: "Only this move of the plan (optional)" }, confirmed: CONFIRMED }, required: ["client", "line"], additionalProperties: false },
      run: async (input) => {
        if (!yes(ctx, input)) return { done: false, note: NO_YES };
        const c = await clientNamed(ctx.db, input.client);
        const line = input.line === "social" ? "social" : "email";
        // The person's own session reads the audit: only a client they can see
        const { data: a } = await ctx.db.from(`${line}_audits`).select("id").eq("client_id", c.id).eq("status", "ready").order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (!a) return { done: false, error: `${c.name} has no finished ${line} audit. Offer to run one first.` };
        const only = Number.isInteger(input.move) ? Number(input.move) - 1 : undefined;
        const id = line === "social" ? await (await import("@/lib/social-ops/sprint")).openSocialSprint(ctx.admin, a.id as string, ctx.me.id, only) : await (await import("@/lib/email-ops/sprint")).openEmailSprint(ctx.admin, a.id as string, ctx.me.id, only);
        if (!id) return { done: false, error: "That audit has no moves to follow." };
        showCard(ctx, { title: `${c.name} ${line} sprint`, detail: only != null ? `Move ${only + 1} added` : "Every move on the plan", href: `/kpis/${line}-sprint/${id}`, external: false, cta: "Open the sprint" });
        return { started: true, sprint: `/kpis/${line}-sprint/${id}` };
      },
    },
    {
      name: "move_ticket",
      description: "Moves a ticket to another stage as the person, with the board's own checks (blockers stop it; a backwards move needs a note). creative: requested, in_production, internal_review, copy, copy_review, ready_for_client, client_review, client_revision, ready_for_launch, launched. email: copy_review, ready_for_design, for_review, with_client, revisions, ready_for_build, ready_to_send, live. Moving to the client or live sends or launches: always ask first, confirmed: true after a yes.",
      input_schema: { type: "object", properties: { board: { type: "string", enum: ["creative", "email"] }, number: { type: "integer" }, to: { type: "string" }, note: { type: "string" }, confirmed: CONFIRMED }, required: ["board", "number", "to"], additionalProperties: false },
      run: async (input) => {
        if (!yes(ctx, input)) return { done: false, note: NO_YES };
        const n = Number(input.number);
        const note = clip(input.note, 500) || undefined;
        if (input.board === "email") {
          const { data: t } = await ctx.db.from("email_tickets").select("id").eq("number", n).is("deleted_at", null).maybeSingle();
          if (!t) return { done: false, error: `No email ticket #${n} you can see.` };
          const { moveEmail } = await import("@/app/(team)/board/email/actions");
          const r = await moveEmail(t.id as string, String(input.to) as Parameters<typeof moveEmail>[1], note);
          if (!r.ok) return { done: false, error: (r as { error?: string }).error ?? "It couldn't move." };
        } else {
          const { data: t } = await ctx.db.from("requests").select("id").eq("number", n).maybeSingle();
          if (!t) return { done: false, error: `No ticket #${n} you can see.` };
          const { moveTicket } = await import("@/app/(team)/board/actions");
          const r = (await moveTicket(t.id as string, String(input.to) as Parameters<typeof moveTicket>[1], note)) as { ok?: boolean; error?: string };
          if (r && r.ok === false) return { done: false, error: r.error ?? "It couldn't move." };
          if (r && r.error) return { done: false, error: r.error };
        }
        forgetContext(ctx.me.id);
        return { moved: true, to: input.to };
      },
    },
    {
      name: "confirm_launch",
      description: "Puts a launch live (one started with launch_sheet and showing ready on its card): the launch's own checks apply (who may confirm, the plan ready, the account live). This goes LIVE and spends ad money: say exactly what goes live and ask; only on a clear spoken yes, confirmed: true.",
      input_schema: { type: "object", properties: { launchId: { type: "string" }, confirmed: CONFIRMED }, required: ["launchId"], additionalProperties: false },
      run: async (input) => {
        if (!yes(ctx, input)) return { done: false, note: NO_YES };
        const { confirmLaunch } = await import("@/app/(team)/clients/[slug]/launch-sheet-actions");
        const r = await confirmLaunch(clip(input.launchId, 40));
        if (!r.ok) return { done: false, error: r.error };
        return { launched: true, note: "Say it's going live; the card shows each ad as it's created." };
      },
    },
  ];
  const comms = commsTools({ me: ctx.me, db: ctx.db, admin: ctx.admin, callId: ctx.callId, said: () => ctx.said, emit: ctx.emit, roleKey: ASSISTANT_KEY, label: "assistant", path: ctx.path, screen: ctx.screen, clientId: ctx.clientId });
  // A document made here shows as its own card on the call or in the chat: Open, Download, Edit its text
  const docCards = (t: LoopTool): LoopTool =>
    t.name !== "create_document"
      ? t
      : {
          ...t,
          run: async (input: Record<string, unknown>) => {
            const before = tctx.cards.length;
            const out = await t.run(input);
            for (const c of tctx.cards.slice(before)) {
              if (c.type !== "document") continue;
              const document = { id: c.id, kind: c.kind, title: c.title, client: c.client, version: c.version, href: c.href, download: c.download, placeholders: c.placeholders };
              ctx.emit({ t: "card", card: { id: `doc-${c.id}`, title: c.title, detail: c.client ?? "", href: c.href, external: true, cta: "Open", document } });
            }
            return out;
          },
        };
  return carryYes(ctx, cctx, [...own, ...lookupTools(ctx), ...profileTools(ctx), ...comms, ...cardTools, ...rest.map(docCards)]);
}

/**
 * One spoken yes is enough: when an action they said yes to fails for a reason they didn't cause (an error on our
 * side, a send that didn't go through), its next try on this call within a few minutes runs on that same yes instead
 * of asking again. Gated tools only (those with `confirmed`).
 */
async function carryYes(ctx: AssistantCtx, cctx: CardCtx, tools: LoopTool[]): Promise<LoopTool[]> {
  const { carriedYes, carryYes: remember, dropYes } = await import("./handoff-server");
  const carried = await carriedYes(ctx.admin, ctx.callId).catch(() => new Set<string>());
  return tools.map((t) => {
    const s = t.input_schema as { properties?: Record<string, unknown> };
    if (!s.properties || !("confirmed" in s.properties)) return t;
    return {
      ...t,
      run: async (input: Record<string, unknown>) => {
        const spoken = saidYes(ctx.said);
        const carry = input.confirmed === true && !spoken && carried.has(t.name);
        const had = { said: ctx.said, card: cctx.said };
        if (carry) ctx.said = cctx.said = "yes";
        const yesd = input.confirmed === true && (spoken || carry);
        try {
          const out = await t.run(input);
          if (yesd) await (failedOnOurSide(out) ? remember(ctx.admin, ctx.callId, t.name) : carry ? dropYes(ctx.admin, ctx.callId, t.name) : Promise.resolve()).catch(() => undefined);
          return out;
        } catch (e) {
          if (yesd) await remember(ctx.admin, ctx.callId, t.name).catch(() => undefined);
          throw e;
        } finally {
          if (carry) {
            ctx.said = had.said;
            cctx.said = had.card;
          }
        }
      },
    };
  });
}

/** The cron's pass: reports the assistant started in the last day that haven't been told about yet */
export async function sweepReportWatches(admin: SupabaseClient): Promise<{ checked: number }> {
  const { data } = await admin.from("ai_role_calls").select("id, watches").eq("role_key", "assistant").gte("started_at", new Date(Date.now() - 86_400_000).toISOString()).limit(200);
  const open = (data ?? []).filter((c) => ((c.watches ?? []) as Watch[]).some((w) => !w.done));
  for (const c of open) await checkWatches(admin, c.id as string).catch(() => undefined);
  return { checked: open.length };
}
