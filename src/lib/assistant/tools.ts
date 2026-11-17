import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import type { Staff } from "@/lib/auth";
import type { CallCard, CallEvent } from "@/lib/agent-call/core";
import { CARD_TOOLS, gateTools, type LoopTool } from "@/lib/agent-call/tool-loop";
import { askTools } from "@/lib/agent-call/ask-tools";
import { chatTools, type ChatTool, type ToolCtx } from "@/lib/kaizen-ai/tools";
import type { Card } from "@/lib/kaizen-ai/types";
import { cleanMemory, safeAppPath, safeLink, saidYes, specialistOf, SPECIALISTS, ASSISTANT_KEY, FACT_TOPICS, STYLE_TOPICS } from "./core";
import { forgetContext, myWork } from "./context";
import { saveNotes } from "./memory";

// What the assistant can do on a call, as the person and only within their rights: everything Kaizen AI's tools do
// for them (each checks the client and their permissions again), plus opening screens, link cards, asking for files,
// their day, reports, audits, requests and tickets, their private memory, and calling a specialist in. Anything that
// sends to a client, spends money or credits, or goes live needs a spoken yes on that very turn (the model's
// confirmed flag AND the person's own words), so it can't run on a guess. Cards the chat tools make (a brief, a change
// plan, a launch) are saved to a Kaizen AI thread for this call, where they're confirmed exactly as in the chat, and
// shown on the call as link cards.

export type CallState = {
  /** The specialist on the line (changed by call_in_specialist and dismiss_specialist) */
  guest: string | null;
  /** What the specialist was called in to answer (it answers it at once) */
  guestQuestion: string | null;
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

const cardId = () => crypto.randomUUID().slice(0, 8);
const showCard = (ctx: AssistantCtx, c: Omit<CallCard, "id">) => ctx.emit({ t: "card", card: { id: cardId(), ...c } });

/** A gated action: the model said confirmed AND the person's own words this turn are a yes */
const yes = (ctx: AssistantCtx, input: Record<string, unknown>) => input.confirmed === true && saidYes(ctx.said);
const CONFIRMED = { type: "boolean", description: "True only after the person clearly said yes to this exact action on this turn" };

// ─── The Kaizen AI thread a call's cards live in ────────────────────────────

/** A message on this call's thread for a card tool to write into (the thread made on first use) */
async function cardMessage(ctx: AssistantCtx, tctx: ToolCtx, label: string): Promise<string> {
  const { admin, me } = ctx;
  if (!ctx.state.threadId) {
    const day = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
    const { data: t, error } = await admin.from("ai_threads").insert({ profile_id: me.id, title: `Call with your assistant · ${day}`, model: "sonnet" }).select("id").single();
    if (error || !t) throw new Error("Couldn't open a place for it in Kaizen AI.");
    ctx.state.threadId = t.id as string;
    await admin.from("ai_role_calls").update({ thread_id: t.id }).eq("id", ctx.callId);
  }
  await admin.from("ai_messages").insert({ thread_id: ctx.state.threadId, role: "user", content: clip(ctx.said, 4000) || "(on the call)" });
  const { data: m, error } = await admin.from("ai_messages").insert({ thread_id: ctx.state.threadId, role: "assistant", content: `From our call: ${label}.` }).select("id").single();
  if (error || !m) throw new Error("Couldn't save it to Kaizen AI.");
  await admin.from("ai_threads").update({ last_message_at: new Date().toISOString() }).eq("id", ctx.state.threadId);
  tctx.messageId = m.id as string;
  tctx.cards.length = 0;
  return m.id as string;
}

/** A card the chat tool made, as a link card on the call */
function cardLink(ctx: AssistantCtx, c: Card): Omit<CallCard, "id"> {
  const thread = `/ai?t=${ctx.state.threadId}`;
  const r = c as unknown as Record<string, unknown>;
  if (c.type === "link") {
    const l = safeLink(r.href);
    return { title: clip(r.title, 120), detail: clip(r.detail, 160), href: l?.href ?? thread, external: l?.external ?? false, cta: clip(r.cta, 40) || "Open" };
  }
  if (c.type === "brief") return { title: `Brief: ${clip(r.title, 100)}`, detail: "Open it to preview and send it to the board", href: safeAppPath(r.href) ?? thread, external: false, cta: "Open the brief" };
  if (c.type === "plan") return { title: `Change plan for ${clip(r.client, 60)}`, detail: "Check the exact changes and confirm there", href: thread, external: false, cta: "Review the plan" };
  if (c.type === "launch") return { title: `Launch for ${clip(r.client, 60)}`, detail: "The checklist and questions are on the card", href: thread, external: false, cta: "Open the launch" };
  return { title: "From our call", detail: "Saved in Kaizen AI", href: thread, external: false, cta: "Open" };
}

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
  // Card tools: run on this call's thread, then shown as a link card
  const cardTools: LoopTool[] = base
    .filter((t) => CARD_TOOLS.has(t.name))
    .map((t) => ({
      ...t,
      description: `${t.description} On a call: the card is saved to a Kaizen AI thread for this call and shown on the call as a link; nothing is sent or changed until they confirm it there.`,
      run: async (input: Record<string, unknown>) => {
        await cardMessage(ctx, tctx, t.status(input, null).replace(/…$/, ""));
        const out = await t.run(input);
        if (tctx.cards.length) {
          await ctx.admin.from("ai_messages").update({ cards: tctx.cards }).eq("id", tctx.messageId);
          for (const c of tctx.cards) showCard(ctx, cardLink(ctx, c));
        }
        return out;
      },
    }));
  const rest = gateTools([...base.filter((t) => !CARD_TOOLS.has(t.name)), ...askTools(tctx, { roleKey: ASSISTANT_KEY, label: "assistant", callId: ctx.callId })]).map((t) => {
    const s = t.input_schema as { properties?: Record<string, unknown> };
    if (!s.properties || !("confirmed" in s.properties)) return t;
    // A gated tool: the person's own words on this turn must be a yes too
    return { ...t, run: async (input: Record<string, unknown>) => (input.confirmed === true && !saidYes(ctx.said) ? { done: false, note: NO_YES } : t.run(input)) };
  });

  const own: LoopTool[] = [
    {
      name: "my_work",
      description: "Everything on the person right now, in order: critical first, then simple to complex (their recap, Next for me, tickets on both boards, reports waiting, replies they owe, reminders, unread notifications). Use for 'what do I need to do today' and to go past the first items in your context.",
      input_schema: { type: "object", properties: { only: { type: "string", enum: ["all", "critical", "tickets", "reports", "replies", "reminders", "notifications"] }, limit: { type: "integer" } }, additionalProperties: false },
      run: async (input) => {
        const items = await myWork(ctx.db, ctx.me);
        const only = String(input.only ?? "all");
        const pick = items.filter((i) =>
          only === "critical" ? i.tier === "critical" : only === "tickets" ? i.source === "ticket" || i.source === "email_ticket" : only === "reports" ? i.source === "report" : only === "replies" ? i.source === "owed" : only === "reminders" ? i.source === "ask" : only === "notifications" ? i.source === "notification" : true,
        );
        return { count: pick.length, items: pick.slice(0, Math.min(40, Number(input.limit) || 20)).map((i) => ({ id: i.id, tier: i.tier, client: i.client, title: i.title, why: i.why, open: i.href })) };
      },
    },
    {
      name: "open_screen",
      description: "Takes the person to a screen in the app while the call carries on (take me to a client's page, open the Email Board, show me my reports). Give a client by name (client, with an optional tab: overview, ads, email, social, creative, team, reports) or a place (overview, boards, creative board, email board, clients, kpis, email kpis, reports, kaizen ai, ideas, ads lab, settings, my assistant, notifications), or an exact in-app path (href: a report /reports/<id>, a ticket /board?t=<number> or /board/email?t=<number>). Use it whenever they ask to go somewhere or when showing beats telling; say in a few words what you opened.",
      input_schema: {
        type: "object",
        properties: {
          client: CLIENT,
          tab: { type: "string", enum: ["overview", "ads", "email", "social", "creative", "team", "reports"] },
          place: { type: "string", enum: ["overview", "boards", "creative board", "email board", "clients", "kpis", "email kpis", "reports", "kaizen ai", "ideas", "ads lab", "settings", "my assistant", "notifications"] },
          href: { type: "string", description: "An in-app path starting with /" },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const PLACES: Record<string, string> = { overview: "/pipeline", boards: "/board", "creative board": "/board", "email board": "/board/email", clients: "/clients", kpis: "/kpis", "email kpis": "/kpis?p=email", reports: "/reports", "kaizen ai": "/ai", ideas: "/ideas", "ads lab": "/lab", settings: "/settings", "my assistant": "/assistant", notifications: "/notifications" };
        const TABS: Record<string, string> = { ads: "?service=meta", email: "?service=email", social: "?service=social", creative: "?service=creative", team: "?tab=team", reports: "?tab=reports", overview: "" };
        let wanted = typeof input.href === "string" ? input.href : null;
        if (!wanted && input.place) wanted = PLACES[String(input.place)] ?? null;
        if (!wanted && input.client) {
          // The client by name, through the person's own session (only clients they can see)
          const name = String(input.client).trim();
          const { data } = await ctx.db.from("clients").select("name, slug").is("archived_at", null).ilike("name", `%${name.replace(/[%_]/g, "")}%`).limit(5);
          const list = (data ?? []) as { name: string; slug: string }[];
          const hit = list.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? list[0];
          if (!hit) return { opened: false, note: `No client called ${name} that they can see. Ask which client they meant.` };
          wanted = `/clients/${hit.slug}${TABS[String(input.tab ?? "overview")] ?? ""}`;
        }
        const href = safeAppPath(wanted);
        if (!href) return { opened: false, note: "That isn't a screen in the app." };
        ctx.emit({ t: "navigate", href });
        return { opened: href };
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
            } else if (id.startsWith("a-") || id.startsWith("next-ask-")) {
              const askId = id.startsWith("a-") ? id.slice(2) : id.slice(9);
              await ctx.db.from("agent_asks").update({ status, done_at: new Date().toISOString() }).eq("id", askId).eq("owner_id", ctx.me.id);
            } else if (id.startsWith("o-")) {
              const { setItem, dismissOwed } = await import("@/app/today/actions");
              if (status === "done") await setItem(`owed:${id.slice(2)}`, "done", { topic: "promises", client: it?.client ?? "", title: label, clientId: null });
              else await dismissOwed(id.slice(2));
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
      description: "What was uploaded on this call: each file's name, type and a short description of what's in it (pictures, video frames and PDFs are looked at). Use after they upload.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        const { data } = await ctx.admin.from("ai_role_calls").select("uploads").eq("id", ctx.callId).maybeSingle();
        const ups = (data?.uploads ?? []) as { name: string; kind: string; purpose: string; client: string | null; about?: string }[];
        return { files: ups.map((u) => ({ name: u.name, kind: u.kind, purpose: u.purpose, client: u.client, about: u.about ?? "(still being read)" })) };
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
      name: "call_in_specialist",
      description: `Brings a specialist agent onto this call (it joins with its own voice, playbook and tools; you stay on and take notes). ALWAYS ask first ("Want me to call in the Media Buyer for that?") and only call this once they say yes, with confirmed: true. Specialists: ${SPECIALISTS.map((s) => `${s.key} (${s.label}: ${s.about})`).join("; ")}.`,
      input_schema: { type: "object", properties: { role: { type: "string", enum: SPECIALISTS.map((s) => s.key) }, question: { type: "string", description: "What they want the specialist to answer, in their words" }, confirmed: CONFIRMED }, required: ["role", "question"], additionalProperties: false },
      run: async (input) => {
        const sp = specialistOf(String(input.role));
        if (!sp) return { joined: false, note: "Not one of the specialists." };
        if (!yes(ctx, input)) return { joined: false, note: NO_YES };
        const { data: role } = await ctx.admin.from("ai_roles").select("key, label, icon, offline").eq("key", sp.key).maybeSingle();
        if (!role || (role as { offline?: boolean }).offline) return { joined: false, note: `The ${sp.label} isn't online yet. Offer to help yourself.` };
        await ctx.admin.from("ai_role_calls").update({ guest_role: sp.key }).eq("id", ctx.callId);
        ctx.state.guest = sp.key;
        ctx.state.guestQuestion = clip(input.question, 1000);
        ctx.emit({ t: "guest", role: sp.key, label: role.label as string, icon: (role.icon as string) ?? "spark" });
        return { joined: true, note: `Say one short line ("Bringing in the ${role.label}.") and stop: they answer next.` };
      },
    },
    {
      name: "dismiss_specialist",
      description: "Lets the specialist go when they're done with it or they ask you to take it from here. Thank it in a few words.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        if (!ctx.state.guest) return { note: "Nobody else is on the call." };
        await ctx.admin.from("ai_role_calls").update({ guest_role: null }).eq("id", ctx.callId);
        ctx.state.guest = null;
        ctx.emit({ t: "guest", role: null, label: null, icon: null });
        return { left: true };
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
      description: "Runs an account audit as the person: Meta or Google (the KPI audit, on the client's ad account with a KPI) or email (the email account audit). The audit's own checks apply (their clients, one at a time per account). It takes a few minutes and uses AI credits: ask first, confirmed: true after a yes.",
      input_schema: { type: "object", properties: { client: CLIENT, kind: { type: "string", enum: ["meta", "google", "email"] }, confirmed: CONFIRMED }, required: ["client", "kind"], additionalProperties: false },
      run: async (input) => {
        if (!yes(ctx, input)) return { done: false, note: NO_YES };
        const c = await clientNamed(ctx.db, input.client);
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
      name: "create_email_request",
      description: "Creates an Email Board ticket for a client as the person (the email team and execs only): the AI writes the brief from the idea, then the ticket starts in Copy for review. A campaign batch is up to 5 emails, a flow up to 6 messages (texts allowed). Nothing goes to the client. Ask first, confirmed: true after a yes.",
      input_schema: {
        type: "object",
        properties: { client: CLIENT, kind: { type: "string", enum: ["batch", "flow"] }, idea: { type: "string" }, count: { type: "integer" }, due: { type: "string", description: "YYYY-MM-DD" }, texts: { type: "boolean" }, priority: { type: "string", enum: ["normal", "high", "urgent"] }, confirmed: CONFIRMED },
        required: ["client", "kind", "idea"],
        additionalProperties: false,
      },
      run: async (input) => {
        if (!yes(ctx, input)) return { done: false, note: NO_YES };
        const c = await clientNamed(ctx.db, input.client);
        const { writeEmailBrief, createEmailTicket } = await import("@/app/(team)/board/email/new/actions");
        const due = /^\d{4}-\d{2}-\d{2}$/.test(String(input.due ?? "")) ? String(input.due) : null;
        const brief = await writeEmailBrief({ clientId: c.id, kind: input.kind === "flow" ? "flow" : "batch", idea: clip(input.idea, 2000), count: Number(input.count) || null, dueOn: due, texts: input.texts === true });
        if (!brief.ok) return { done: false, error: brief.error };
        const t = await createEmailTicket({ clientId: c.id, draft: brief.draft, priority: input.priority === "urgent" || input.priority === "high" ? input.priority : "normal", dueOn: due, suggestionId: null });
        if (!t.ok) return { done: false, error: t.error };
        showCard(ctx, { title: `Email #${t.number}: ${clip(brief.draft.title, 80)}`, detail: `${c.name} · Copy for review`, href: `/board/email?t=${t.number}`, external: false, cta: "Open the ticket" });
        forgetContext(ctx.me.id);
        return { created: true, number: t.number, title: brief.draft.title };
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
  return [...own, ...cardTools, ...rest];
}

/** The cron's pass: reports the assistant started in the last day that haven't been told about yet */
export async function sweepReportWatches(admin: SupabaseClient): Promise<{ checked: number }> {
  const { data } = await admin.from("ai_role_calls").select("id, watches").eq("role_key", "assistant").gte("started_at", new Date(Date.now() - 86_400_000).toISOString()).limit(200);
  const open = (data ?? []).filter((c) => ((c.watches ?? []) as Watch[]).some((w) => !w.done));
  for (const c of open) await checkWatches(admin, c.id as string).catch(() => undefined);
  return { checked: open.length };
}
