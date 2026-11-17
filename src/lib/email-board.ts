import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addBusinessDays } from "@/lib/approval-notices-core";
import {
  emailStageInfo,
  handle,
  nextStage,
  ownerFor,
  routeFallback,
  turnaroundDays,
  type EmailKind,
  type EmailPriority,
  type EmailStage,
  type MessageChannel,
  type MessageLite,
  type Route,
  type SeatRow,
} from "@/lib/email-board-core";

// The Email Board's server side: reading tickets, moving them (the clock, the owner and what each stage sets off), and
// the AI's three jobs on it: writing the copy the moment a ticket is made, reviewing each design as it's uploaded (notes
// pinned on the design), and routing each client comment to copy or design. The pure rules are in email-board-core.ts.
// Every write here is with the service role, after the caller checked who's asking.

type Admin = SupabaseClient;
export const DESIGN_BUCKET = "creative";

export type EmailLink = { label: string; url: string; box: { x: number; y: number; w: number; h: number } | null };
export type ReviewNote = { severity: "fix" | "watch" | "good"; note: string; box: { x: number; y: number; w: number; h: number } | null };
export type AiReview = { verdict: "ready" | "minor" | "fix"; headline: string; notes: ReviewNote[] };

export type EmailMessage = {
  id: string;
  position: number;
  channel: MessageChannel;
  name: string;
  sendOn: string | null;
  delayHours: number | null;
  subject: string | null;
  preheader: string | null;
  body: string | null;
  copyApproved: boolean;
  designPath: string | null;
  designMime: string | null;
  designVersion: number;
  designUrl?: string | null;
  links: EmailLink[];
  aiReview: AiReview | null;
  aiReviewStatus: "none" | "running" | "done" | "failed";
  clientStatus: "pending" | "approved" | "changes" | null;
  clientNote: string | null;
  builtAt: string | null;
  liveAt: string | null;
  providerRef: string | null;
};

export type EmailTicket = {
  id: string;
  number: number;
  clientId: string;
  clientName: string;
  clientSlug: string;
  kind: EmailKind;
  title: string;
  brief: string | null;
  goal: string | null;
  trigger: string | null;
  provider: string;
  stage: EmailStage;
  priority: EmailPriority;
  assigneeId: string | null;
  assigneeName: string | null;
  stageEnteredAt: string;
  stageDueAt: string | null;
  dueOn: string | null;
  minutesInStage: number;
  minutesOver: number;
  clientRounds: number;
  copyStatus: "writing" | "ready" | "failed";
  createdAt: string;
  messages: EmailMessage[];
};

export type EmailComment = {
  id: string;
  messageId: string | null;
  authorKind: "ai" | "team" | "client" | "asana";
  authorName: string | null;
  body: string;
  box: { x: number; y: number; w: number; h: number } | null;
  designVersion: number | null;
  severity: "fix" | "watch" | "good" | null;
  route: Route | null;
  routedBy: "ai" | "team" | "rule" | null;
  routedTo: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

export type EmailEvent = { id: string; kind: string; fromStage: string | null; toStage: string | null; actor: string | null; body: string | null; data: Record<string, unknown>; at: string };

type Row = Record<string, unknown>;

export function toMessage(m: Row): EmailMessage {
  return {
    id: m.id as string,
    position: (m.position as number) ?? 0,
    channel: m.channel as MessageChannel,
    name: m.name as string,
    sendOn: (m.send_on as string | null) ?? null,
    delayHours: (m.delay_hours as number | null) ?? null,
    subject: (m.subject as string | null) ?? null,
    preheader: (m.preheader as string | null) ?? null,
    body: (m.body as string | null) ?? null,
    copyApproved: Boolean(m.copy_approved_at),
    designPath: (m.design_path as string | null) ?? null,
    designMime: (m.design_mime as string | null) ?? null,
    designVersion: (m.design_version as number) ?? 0,
    links: ((m.links as EmailLink[] | null) ?? []).map((l) => ({ label: String(l.label ?? ""), url: String(l.url ?? ""), box: l.box ?? null })),
    aiReview: (m.ai_review as AiReview | null) ?? null,
    aiReviewStatus: (m.ai_review_status as EmailMessage["aiReviewStatus"]) ?? "none",
    clientStatus: (m.client_status as EmailMessage["clientStatus"]) ?? null,
    clientNote: (m.client_note as string | null) ?? null,
    builtAt: (m.built_at as string | null) ?? null,
    liveAt: (m.live_at as string | null) ?? null,
    providerRef: (m.provider_ref as string | null) ?? null,
  };
}

export function toTicket(r: Row, messages: EmailMessage[]): EmailTicket {
  return {
    id: r.id as string,
    number: r.number as number,
    clientId: r.client_id as string,
    clientName: (r.client_name as string) ?? "Client",
    clientSlug: (r.client_slug as string) ?? "",
    kind: r.kind as EmailKind,
    title: r.title as string,
    brief: (r.brief as string | null) ?? null,
    goal: (r.goal as string | null) ?? null,
    trigger: (r.trigger as string | null) ?? null,
    provider: (r.provider as string) ?? "klaviyo",
    stage: r.stage as EmailStage,
    priority: (r.priority as EmailPriority) ?? "normal",
    assigneeId: (r.assignee_id as string | null) ?? null,
    assigneeName: (r.assignee_name as string | null) ?? null,
    stageEnteredAt: r.stage_entered_at as string,
    stageDueAt: (r.stage_due_at as string | null) ?? null,
    dueOn: (r.due_on as string | null) ?? null,
    minutesInStage: (r.minutes_in_stage as number) ?? 0,
    minutesOver: (r.minutes_over as number) ?? 0,
    clientRounds: (r.client_rounds as number) ?? 0,
    copyStatus: (r.copy_status as EmailTicket["copyStatus"]) ?? "ready",
    createdAt: r.created_at as string,
    messages: [...messages].sort((a, b) => a.position - b.position),
  };
}

export const lite = (m: EmailMessage): MessageLite => ({ channel: m.channel, copyApproved: m.copyApproved, hasDesign: Boolean(m.designPath), aiReview: m.aiReviewStatus, clientStatus: m.clientStatus, builtAt: m.builtAt, liveAt: m.liveAt });

const MSG_COLS = "id, ticket_id, position, channel, name, send_on, delay_hours, subject, preheader, body, copy_approved_at, design_path, design_mime, design_version, links, ai_review, ai_review_status, client_status, client_note, built_at, live_at, provider_ref";

/** Every ticket still moving (the board), with its messages; read with the reader's own rights */
export async function loadEmailBoard(db: SupabaseClient, opts: { clientId?: string; number?: number | null } = {}): Promise<EmailTicket[]> {
  let q = db.from("email_board").select("*").neq("stage", "live").order("created_at", { ascending: false }).limit(600);
  if (opts.clientId) q = q.eq("client_id", opts.clientId);
  const [{ data: rows }, one] = await Promise.all([q, opts.number ? db.from("email_board").select("*").eq("number", opts.number).maybeSingle() : Promise.resolve({ data: null })]);
  const all = [...(rows ?? []), ...(one.data && !(rows ?? []).some((r) => r.id === (one.data as Row).id) ? [one.data as Row] : [])];
  if (!all.length) return [];
  const ids = all.map((r) => r.id as string);
  const msgs: Row[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db.from("email_messages").select(MSG_COLS).in("ticket_id", ids.slice(i, i + 200));
    msgs.push(...(data ?? []));
  }
  return all.map((r) => toTicket(r, msgs.filter((m) => m.ticket_id === r.id).map(toMessage)));
}

/** Signed links to each message's design (an hour) */
export async function withDesignUrls(admin: Admin, messages: EmailMessage[]): Promise<EmailMessage[]> {
  const paths = messages.map((m) => m.designPath).filter((p): p is string => Boolean(p));
  if (!paths.length) return messages;
  const { data } = await admin.storage.from(DESIGN_BUCKET).createSignedUrls(paths, 3600);
  const url = new Map((data ?? []).map((d) => [d.path, d.signedUrl]));
  return messages.map((m) => ({ ...m, designUrl: m.designPath ? (url.get(m.designPath) ?? null) : null }));
}

export function toComment(c: Row): EmailComment {
  return {
    id: c.id as string,
    messageId: (c.message_id as string | null) ?? null,
    authorKind: c.author_kind as EmailComment["authorKind"],
    authorName: (c.author_name as string | null) ?? null,
    body: c.body as string,
    box: (c.box as EmailComment["box"]) ?? null,
    designVersion: (c.design_version as number | null) ?? null,
    severity: (c.severity as EmailComment["severity"]) ?? null,
    route: (c.route as Route | null) ?? null,
    routedBy: (c.routed_by as EmailComment["routedBy"]) ?? null,
    routedTo: (c.routed_to as string | null) ?? null,
    resolvedAt: (c.resolved_at as string | null) ?? null,
    createdAt: c.created_at as string,
  };
}

/** A client's email seats (strategist, designer, builder), primary first */
export async function seatsOf(admin: Admin, clientId: string): Promise<SeatRow[]> {
  const { data } = await admin.from("client_assignments").select("profile_id, role, is_primary, created_at").eq("client_id", clientId).in("role", ["email_strategist", "email_designer", "email_builder"]);
  return (data ?? []) as SeatRow[];
}

async function holidays(admin: Admin) {
  const now = Date.now();
  const { data } = await admin.from("holidays").select("day").gte("day", new Date(now - 30 * 86_400_000).toISOString().slice(0, 10)).lte("day", new Date(now + 60 * 86_400_000).toISOString().slice(0, 10));
  return new Set((data ?? []).map((h) => String(h.day).slice(0, 10)));
}

/** When a stage's turnaround runs out, from now */
export async function dueFor(admin: Admin, stage: EmailStage, from = new Date()) {
  const days = turnaroundDays(stage);
  if (!days) return null;
  return addBusinessDays(from, days, await holidays(admin).catch(() => new Set<string>())).toISOString();
}

export async function logEvent(admin: Admin, e: { ticketId: string; clientId: string; kind: string; from?: string | null; to?: string | null; actorId?: string | null; actorName?: string | null; body?: string | null; data?: Record<string, unknown>; at?: string }) {
  await admin.from("email_ticket_events").insert({
    ticket_id: e.ticketId,
    client_id: e.clientId,
    kind: e.kind,
    from_stage: e.from ?? null,
    to_stage: e.to ?? null,
    actor_id: e.actorId ?? null,
    actor_name: e.actorName ?? null,
    body: e.body ?? null,
    data: e.data ?? {},
    ...(e.at ? { created_at: e.at } : {}),
  });
}

async function ticketWithMessages(admin: Admin, ticketId: string) {
  const [{ data: t }, { data: m }] = await Promise.all([admin.from("email_tickets").select("*").eq("id", ticketId).maybeSingle(), admin.from("email_messages").select(MSG_COLS).eq("ticket_id", ticketId).order("position")]);
  if (!t) return null;
  return { t, messages: (m ?? []).map(toMessage) };
}

/**
 * Move a ticket to a stage: its clock starts again with that stage's turnaround, it goes to the stage's owner (unless
 * someone was picked), and the stage's own work starts (the AI reviews designs at For review, the client hears at With
 * client, every message is marked live at the end).
 */
export async function moveEmailTicket(admin: Admin, ticketId: string, to: EmailStage, actor: { id: string | null; name: string | null }, note?: string | null) {
  const got = await ticketWithMessages(admin, ticketId);
  if (!got) throw new Error("Ticket not found.");
  const { t, messages } = got;
  const from = t.stage as EmailStage;
  if (from === to) return { stage: to };
  const clientId = t.client_id as string;
  const { data: open } = to === "revisions" ? await admin.from("email_comments").select("route").eq("ticket_id", ticketId).eq("author_kind", "client").is("resolved_at", null) : { data: [] };
  const assignee = ownerFor(to, await seatsOf(admin, clientId), ((open ?? []) as { route: Route | null }[]).map((c) => c.route).filter((r): r is Route => Boolean(r)));
  const now = new Date().toISOString();
  const patch: Row = { stage: to, stage_entered_at: now, stage_due_at: await dueFor(admin, to), assignee_id: assignee, updated_at: now };
  if (to === "live") patch.live_at = now;
  if (to === "revisions" && from === "with_client") patch.client_rounds = ((t.client_rounds as number) ?? 0) + 1;
  await admin.from("email_tickets").update(patch).eq("id", ticketId);
  await logEvent(admin, { ticketId, clientId, kind: "stage", from, to, actorId: actor.id, actorName: actor.name, body: note ?? null });
  if (assignee !== t.assignee_id) await logEvent(admin, { ticketId, clientId, kind: "assign", actorId: null, actorName: "Kaizen", data: { from: t.assignee_id, to: assignee, auto: true } });
  // With the client: every message not approved yet waits on them
  if (to === "with_client") {
    const waiting = messages.filter((m) => m.clientStatus !== "approved").map((m) => m.id);
    if (waiting.length) await admin.from("email_messages").update({ client_status: "pending", updated_at: now }).in("id", waiting);
  }
  if (to === "live") await admin.from("email_messages").update({ live_at: now, live_by: actor.id, updated_at: now }).eq("ticket_id", ticketId).is("live_at", null);
  return { stage: to, assignee };
}

/** Where the ticket goes next on its own path (the forward button and the automatic steps) */
export async function advance(admin: Admin, ticketId: string, actor: { id: string | null; name: string | null }, note?: string | null) {
  const got = await ticketWithMessages(admin, ticketId);
  if (!got) throw new Error("Ticket not found.");
  const to = nextStage({ kind: got.t.kind as EmailKind, stage: got.t.stage as EmailStage }, got.messages.map(lite));
  return moveEmailTicket(admin, ticketId, to, actor, note);
}

// ─── The AI's jobs ───────────────────────────────────────────────────────────

const COPY_SCHEMA = {
  type: "object",
  properties: {
    messages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n: { type: "integer" },
          subject: { type: "string" },
          preheader: { type: "string" },
          body: { type: "string" },
          buttons: { type: "array", items: { type: "string" } },
        },
        required: ["n", "subject", "preheader", "body", "buttons"],
        additionalProperties: false,
      },
    },
  },
  required: ["messages"],
  additionalProperties: false,
};

const COPY_SYSTEM = `You are Kaizen Marketing's email copywriter. You write the copy for every message in an email ticket: a campaign batch (separate sends) or a flow (a sequence that runs on a trigger), in the client's own voice, inside the client's rules about claims, discounts and words to avoid.
For each email: a subject line (under 55 characters unless the client's data says longer works), preview text that adds to the subject rather than repeating it, and the body as short sections in plain text: a headline line, two to four short paragraphs or a few bullets, each section on its own line, written to be designed (say [Image: what it shows] where a picture goes). Then the button labels, the actions the reader takes (Shop the sale, Book now), one to three.
For each text message (SMS): body only, under 160 characters, the brand name first, one link placeholder written as {link}, and no subject, preview text or buttons (leave those empty).
In a flow, each message builds on the one before: the first welcomes or reminds, later ones add proof, answer doubts and then press with urgency. In a batch, each send stands on its own and they don't repeat each other's angle.
Write people by role, never by name. No em dashes. No emojis unless the client's own emails use them.`;

/** The AI copywriter writes every message's copy for a ticket (on create, and again on Rewrite with the team's note) */
export async function writeEmailCopy(admin: Admin, ticketId: string, note?: string | null) {
  const got = await ticketWithMessages(admin, ticketId);
  if (!got) return;
  const { t, messages } = got;
  const clientId = t.client_id as string;
  const { askJson } = await import("@/lib/ai");
  const { emailBrief } = await import("@/lib/email-ops/chat");
  await admin.from("email_tickets").update({ copy_status: "writing" }).eq("id", ticketId);
  try {
    const ctx = await emailBrief(admin, clientId);
    const todo = messages.filter((m) => !m.copyApproved);
    if (!todo.length) return;
    const out = await askJson<{ messages: { n: number; subject: string; preheader: string; body: string; buttons: string[] }[] }>({
      agent: "email_copy",
      label: "email board copy",
      clientId,
      system: COPY_SYSTEM,
      schema: COPY_SCHEMA,
      maxTokens: 12000,
      prompt: `Client: ${ctx.name}.\n\n${ctx.text}\n\n<ticket kind="${t.kind}" title="${String(t.title).replace(/"/g, "'")}">\n${t.brief ?? ""}\n${t.goal ? `Goal: ${t.goal}\n` : ""}${t.trigger ? `Flow trigger: ${t.trigger}\n` : ""}</ticket>\n\n<messages>\n${todo
        .map((m, i) => `${i + 1}. ${m.channel === "sms" ? "Text message" : "Email"} "${m.name}"${m.sendOn ? `, sends ${m.sendOn}` : ""}${m.delayHours != null ? `, ${m.delayHours} hours after the step before` : ""}${m.body ? `\nCurrent draft:\n${m.subject ? `Subject: ${m.subject}\n` : ""}${m.body}` : ""}`)
        .join("\n\n")}\n</messages>${note ? `\n\nThe strategist's note for this rewrite: ${note}` : ""}\n\nWrite the copy for each message by number.`,
    });
    for (const [i, m] of todo.entries()) {
      const o = out.messages.find((x) => x.n === i + 1);
      if (!o) continue;
      const sms = m.channel === "sms";
      // Buttons become links waiting for their destination (the strategist sets each one's URL)
      const known = new Map(m.links.map((l) => [l.label.toLowerCase(), l]));
      const links = sms ? m.links : o.buttons.slice(0, 3).map((b) => known.get(b.toLowerCase()) ?? { label: b.slice(0, 60), url: "", box: null });
      await admin
        .from("email_messages")
        .update({ subject: sms ? null : o.subject.slice(0, 200), preheader: sms ? null : o.preheader.slice(0, 250), body: o.body.slice(0, 8000), links, updated_at: new Date().toISOString() })
        .eq("id", m.id);
    }
    await admin.from("email_tickets").update({ copy_status: "ready" }).eq("id", ticketId);
    await logEvent(admin, { ticketId, clientId, kind: "copy", actorName: "Kaizen AI", body: note ? `Rewrote the copy: ${note}` : `Wrote the copy for ${todo.length} ${todo.length === 1 ? "message" : "messages"}.` });
  } catch (e) {
    await admin.from("email_tickets").update({ copy_status: "failed" }).eq("id", ticketId);
    await logEvent(admin, { ticketId, clientId, kind: "copy", actorName: "Kaizen AI", body: `Couldn't write the copy: ${e instanceof Error ? e.message : "the AI had a problem"}` });
  }
}

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["ready", "minor", "fix"] },
    headline: { type: "string" },
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["fix", "watch", "good"] },
          note: { type: "string" },
          box: { anyOf: [{ type: "null" }, { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } }, required: ["x", "y", "w", "h"], additionalProperties: false }] },
        },
        required: ["severity", "note", "box"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "headline", "notes"],
  additionalProperties: false,
};

const REVIEW_SYSTEM = `You are a senior email designer at Kaizen Marketing reviewing an email design before the strategist and the client see it. You get the design (the whole email as one image or PDF), the approved copy and the client's brand rules.
Check: the copy on the design matches the approved copy word for word (subject and preview text aren't on the design); spelling; the brand's colours, fonts and logo; that it reads on a phone (text size, tap targets for buttons at least 44px tall, one column below the fold); a clear first screen with the offer and one main button; enough contrast; image-heavy sections that would break when images are off; footer and unsubscribe space.
Write notes the designer can act on, each pinned where it applies: box is the area as percentages of the image (x and y the top-left corner, w and h the size, 0 to 100), or null for the whole email. fix: must change before the client sees it; watch: worth a look; good: what works (one or two). verdict: ready, minor (only watch notes) or fix. headline: one plain sentence. No em dashes. Refer to people by role.`;

/** The AI looks at a message's design and pins its notes on it (on upload, and before the strategist's review) */
export async function reviewEmailDesign(admin: Admin, messageId: string) {
  const { data: m } = await admin.from("email_messages").select(`${MSG_COLS}, client_id`).eq("id", messageId).maybeSingle();
  if (!m?.design_path) return;
  const msg = toMessage(m);
  const clientId = m.client_id as string;
  const ticketId = m.ticket_id as string;
  await admin.from("email_messages").update({ ai_review_status: "running" }).eq("id", messageId);
  try {
    const { askJson } = await import("@/lib/ai");
    const { emailBrief } = await import("@/lib/email-ops/chat");
    const { data: file, error } = await admin.storage.from(DESIGN_BUCKET).download(msg.designPath!);
    if (error || !file) throw new Error("Couldn't read the design file.");
    const data = Buffer.from(await file.arrayBuffer()).toString("base64");
    const mime = (msg.designMime ?? file.type ?? "image/png").toLowerCase();
    const isPdf = mime.includes("pdf");
    const imageType = (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime) ? mime : "image/png") as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    const ctx = await emailBrief(admin, clientId);
    const out = await askJson<AiReview>({
      agent: "email_design_brief",
      label: "email board design review",
      clientId,
      system: REVIEW_SYSTEM,
      schema: REVIEW_SCHEMA,
      maxTokens: 6000,
      images: isPdf ? [] : [{ mediaType: imageType, data }],
      pdfs: isPdf ? [{ data, title: msg.name }] : [],
      prompt: `Client: ${ctx.name}.\n\n${ctx.text.slice(0, 12000)}\n\n<approved_copy email="${msg.name.replace(/"/g, "'")}">\nSubject: ${msg.subject ?? ""}\nPreview text: ${msg.preheader ?? ""}\n${msg.body ?? ""}\nButtons: ${msg.links.map((l) => l.label).join(", ") || "(none)"}\n</approved_copy>\n\nReview the design.`,
    });
    const notes = out.notes.slice(0, 12).map((n) => ({ severity: n.severity, note: n.note.slice(0, 600), box: n.box ? clampBox(n.box) : null }));
    await admin.from("email_messages").update({ ai_review: { verdict: out.verdict, headline: out.headline.slice(0, 300), notes }, ai_review_status: "done" }).eq("id", messageId);
    // The notes as pinned comments on this version (the earlier AI notes on this message are put away)
    await admin.from("email_comments").update({ resolved_at: new Date().toISOString() }).eq("message_id", messageId).eq("author_kind", "ai").is("resolved_at", null);
    const pins = notes.filter((n) => n.severity !== "good");
    if (pins.length)
      await admin.from("email_comments").insert(pins.map((n) => ({ ticket_id: ticketId, message_id: messageId, client_id: clientId, author_kind: "ai", author_name: "Kaizen AI", body: n.note, box: n.box, design_version: msg.designVersion, severity: n.severity, route: "design", routed_by: "ai" })));
    await logEvent(admin, { ticketId, clientId, kind: "review", actorName: "Kaizen AI", body: `${msg.name}: ${out.headline}`, data: { verdict: out.verdict, messageId } });
  } catch (e) {
    await admin.from("email_messages").update({ ai_review_status: "failed" }).eq("id", messageId);
    console.error("[email board] design review", messageId, e instanceof Error ? e.message : e);
  }
}

const clampBox = (b: { x: number; y: number; w: number; h: number }) => {
  const c = (n: number) => Math.max(0, Math.min(100, Number(n) || 0));
  return { x: c(b.x), y: c(b.y), w: Math.max(1, c(b.w)), h: Math.max(1, c(b.h)) };
};

const ROUTE_SCHEMA = {
  type: "object",
  properties: { routes: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, route: { type: "string", enum: ["copy", "design"] } }, required: ["n", "route"], additionalProperties: false } } },
  required: ["routes"],
  additionalProperties: false,
};

/**
 * Each open client comment on a ticket goes to copy (the strategist) or design (the designer): the AI reads them,
 * and the plain rule decides when the AI can't. The team can change any of them in the ticket.
 */
export async function routeClientComments(admin: Admin, ticketId: string) {
  const { data: t } = await admin.from("email_tickets").select("client_id").eq("id", ticketId).maybeSingle();
  if (!t) return;
  const clientId = t.client_id as string;
  const { data: rows } = await admin.from("email_comments").select("id, body, message_id, route, email_messages(channel, name)").eq("ticket_id", ticketId).eq("author_kind", "client").is("resolved_at", null).is("route", null);
  const list = (rows ?? []) as unknown as { id: string; body: string; message_id: string | null; email_messages: { channel: MessageChannel; name: string } | null }[];
  if (!list.length) return;
  let ai: Map<number, Route> = new Map();
  try {
    const { askJson } = await import("@/lib/ai");
    const out = await askJson<{ routes: { n: number; route: Route }[] }>({
      agent: "email_desk",
      label: "email board comment routing",
      clientId,
      system: "You sort a client's comments on email drafts. copy: about the words (subject line, preview text, headline, wording, offer, dates, prices, codes, tone, spelling). design: about how it looks (images, colours, fonts, logo, layout, spacing, buttons' look, sizes, mobile view). A text message comment is always copy. When a comment is about both, pick the one with more work in it.",
      schema: ROUTE_SCHEMA,
      maxTokens: 2000,
      prompt: list.map((c, i) => `${i + 1}. [${c.email_messages?.channel === "sms" ? "text message" : "email"} "${c.email_messages?.name ?? "the ticket"}"] ${c.body.slice(0, 800)}`).join("\n"),
    });
    ai = new Map(out.routes.map((r) => [r.n, r.route]));
  } catch {
    // The rule below decides
  }
  const seats = await seatsOf(admin, clientId);
  for (const [i, c] of list.entries()) {
    const channel = c.email_messages?.channel ?? "email";
    const fromAi = ai.get(i + 1);
    const route: Route = channel === "sms" ? "copy" : (fromAi ?? routeFallback(c.body, channel));
    const to = ownerFor("revisions", seats, [route]);
    await admin.from("email_comments").update({ route, routed_by: fromAi ? "ai" : "rule", routed_to: to }).eq("id", c.id);
  }
  // The ticket goes to whoever has the most to do: the designer when any change is a design one
  const { data: all } = await admin.from("email_comments").select("route").eq("ticket_id", ticketId).eq("author_kind", "client").is("resolved_at", null);
  const routes = [...new Set((all ?? []).map((r) => r.route as Route | null).filter((r): r is Route => Boolean(r)))];
  const owner = ownerFor("revisions", seats, routes);
  const { data: now } = await admin.from("email_tickets").select("stage, assignee_id").eq("id", ticketId).maybeSingle();
  if (now?.stage === "revisions" && owner && owner !== now.assignee_id) await admin.from("email_tickets").update({ assignee_id: owner }).eq("id", ticketId);
  await logEvent(admin, { ticketId, clientId, kind: "route", actorName: "Kaizen AI", body: `Sorted ${list.length} client ${list.length === 1 ? "comment" : "comments"}: ${routes.join(" and ") || "none"}.` });
}

// ─── The client hears ────────────────────────────────────────────────────────

/** A short note to the client that emails wait on them: their Slack channel and their portal contacts (every switch on) */
export async function tellClientEmails(admin: Admin, ticketId: string) {
  const { canReach, outreachOn } = await import("@/lib/approval-notices");
  const { data: t } = await admin.from("email_tickets").select("id, number, title, client_id, clients(id, name, slug, portal_live, client_notifications, client_type, slack_channel_id, archived_at)").eq("id", ticketId).maybeSingle();
  const c = t?.clients as unknown as { id: string; name: string; slug: string; portal_live: boolean; client_notifications: boolean; client_type: string | null; slack_channel_id: string | null; archived_at: string | null } | null;
  if (!t || !c) return { sent: [] as string[] };
  if (!canReach(c, await outreachOn(admin))) {
    await logEvent(admin, { ticketId, clientId: c.id, kind: "notice", actorName: "Kaizen", body: "Not sent to the client: their portal or notifications are off, or client outreach is on hold." });
    return { sent: [] };
  }
  const { portalUrl } = await import("@/lib/site");
  const { postAsApp } = await import("@/lib/slack-user");
  const { clientRecipients, logClientEmail } = await import("@/lib/client-emails");
  const { sendEmail } = await import("@/lib/email");
  const { emailHtml, emailText } = await import("@/lib/email-layout");
  const { isWhiteLabel } = await import("@/lib/reports/white-label");
  const whiteLabel = isWhiteLabel(c.client_type);
  const url = `${portalUrl()}/c/${c.slug}/emails`;
  const { count } = await admin.from("email_messages").select("id", { count: "exact", head: true }).eq("ticket_id", ticketId).eq("client_status", "pending");
  const n = count ?? 1;
  const what = `${n} ${n === 1 ? "email" : "emails"}`;
  const sent: string[] = [];
  if (c.slack_channel_id) {
    const r = await postAsApp({ channel: c.slack_channel_id, text: `${what} for "${t.title}" ${n === 1 ? "is" : "are"} ready for your review: ${url}` });
    if (r.ok) sent.push("slack");
  }
  const to = await clientRecipients(admin, c.id).catch(() => []);
  const sentTo: string[] = [];
  let first: { subject: string; html: string; text: string } | null = null;
  for (const x of to) {
    const parts = { preheader: `Approve or comment right on the design`, kicker: whiteLabel ? undefined : c.name, title: `${what} ready for your review`, hello: x.first ? `Hi ${x.first},` : "Hi there,", lines: [`"${t.title}" is ready for you to look over. Approve each one, or tap anywhere on a design to say what to change.`], cta: { label: "Review the emails", url }, whiteLabel };
    const mail = { subject: `Ready for your review: ${t.title}`, html: emailHtml(parts), text: emailText(parts) };
    first ??= mail;
    const r = await sendEmail({ to: x.email, ...mail, ...(whiteLabel ? { fromName: "Email review" } : {}) });
    if (r.ok) sentTo.push(x.email);
  }
  if (sentTo.length && first) {
    sent.push("email");
    await logClientEmail(admin, { clientId: c.id, kind: "review", ...first, to: sentTo }).catch(() => undefined);
  }
  await logEvent(admin, { ticketId, clientId: c.id, kind: "notice", actorName: "Kaizen", body: sent.length ? `The client was told on ${sent.join(" and ")}.` : "No Slack channel and no portal contact to tell.", data: { channels: sent } });
  return { sent };
}

/** The line a ticket shows in someone's day: what it is and where it sits */
export const ticketLine = (t: Pick<EmailTicket, "number" | "title" | "stage">) => `${handle(t.number)} ${t.title} · ${emailStageInfo(t.stage).label}`;
