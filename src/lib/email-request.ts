import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toEmailAllotment, type EmailAllotment, type EmailAllotmentRow } from "@/lib/email-allotment-core";
import type { Me } from "@/lib/copy-docs/server";

// The email request, on the server: what each client's allotment stands at, what to suggest when starting one (the
// client's own ideas, what worked for similar brands in their industry, the flows they're missing, copy already drafted
// from their SOW), the Email Strategist's plan for the emails, and the Copywriter's whole copy document from that plan.
// The copy then lives in its copy document (edits, comments, approval into the client's Drive under Email Marketing,
// and the one batched Asana request: src/lib/copy-docs/server.ts and src/lib/deliverables/server.ts).

type Db = SupabaseClient;

/** Every client's email allotment this cycle (read through the person's own session) */
export async function emailAllotments(db: Db, clientIds?: string[]): Promise<Record<string, EmailAllotment>> {
  let q = db.from("client_email_allotment").select("*");
  if (clientIds?.length) q = q.in("client_id", clientIds);
  const { data } = await q;
  const out: Record<string, EmailAllotment> = {};
  for (const r of (data ?? []) as EmailAllotmentRow[]) out[r.client_id] = toEmailAllotment(r);
  return out;
}

// ─── Starting points ─────────────────────────────────────────────────────────

export type EmailKind = "campaign" | "flow" | "sms" | "sms_flow";
export type Start = {
  key: string;
  source: "client" | "similar" | "starter" | "sow";
  kind: EmailKind;
  title: string;
  idea: string;
  why: string | null;
  sendOn: string | null;
  subjects: string[];
  /** The email_suggestions row it came from */
  suggestionId: string | null;
};

const STARTERS: { kind: EmailKind; title: string; idea: string; why: string; match: RegExp }[] = [
  { kind: "flow", title: "Welcome series", idea: "New subscribers get the brand story, the best sellers and a first-order reason to buy, over three to four emails.", why: "Usually the best earning flow per recipient", match: /welcome/i },
  { kind: "flow", title: "Abandoned checkout", idea: "People who started checkout and didn't finish get a reminder, then proof, then a nudge.", why: "Recovers revenue already in the cart", match: /checkout|abandon(ed)?\s*cart/i },
  { kind: "flow", title: "Browse abandonment", idea: "People who looked at a product and left see it again with reasons to buy.", why: "Catches intent before it fades", match: /browse/i },
  { kind: "flow", title: "Post-purchase", idea: "Thanks, how to get the most from the product, a review ask, then the next thing to buy.", why: "Builds the second order", match: /post.?purchase|thank|after (purchase|order)/i },
  { kind: "flow", title: "Winback", idea: "Customers who haven't bought in a while get a reason to come back, with a stronger offer at the end.", why: "Wakes up lapsed buyers", match: /win.?back|lapsed|re.?engag/i },
  { kind: "flow", title: "Sunset unengaged", idea: "Subscribers who stopped opening get a last chance to stay, then leave the list, so deliverability holds.", why: "Protects the inbox placement of every send", match: /sunset|unengaged/i },
];

/** What a client's industry is called, for "Worked for similar <industry> brands" */
export async function industryOf(admin: Db, clientId: string) {
  const { data } = await admin.from("clients").select("industry, industry_detail").eq("id", clientId).maybeSingle();
  return { industry: (data?.industry as string | null) ?? null, detail: (data?.industry_detail as string | null) ?? null };
}

/**
 * What worked for similar brands: the best campaigns of other email clients in the same industry (the same sub-category
 * first) over the last six months, by revenue per recipient (click rate when there's no revenue). No client names:
 * a pattern to borrow, not their campaign.
 */
async function similarWinners(admin: Db, clientId: string): Promise<Start[]> {
  const me = await industryOf(admin, clientId);
  if (!me.industry && !me.detail) return [];
  const { data: peers } = await admin.from("clients").select("id, industry, industry_detail").neq("id", clientId).is("archived_at", null).or([me.industry ? `industry.eq.${JSON.stringify(me.industry)}` : "", me.detail ? `industry_detail.eq.${JSON.stringify(me.detail)}` : ""].filter(Boolean).join(","));
  const ids = (peers ?? []).map((p) => p.id as string);
  if (!ids.length) return [];
  const same = new Set((peers ?? []).filter((p) => me.detail && p.industry_detail === me.detail).map((p) => p.id as string));
  const since = new Date(Date.now() - 180 * 86_400_000).toISOString();
  const { data: camps } = await admin.from("klaviyo_campaigns").select("client_id, name, subject, preview_text, channel, recipients, delivered, clicks_unique, revenue, send_time").in("client_id", ids.slice(0, 60)).gte("send_time", since).gte("recipients", 300).limit(2000);
  const scored = (camps ?? [])
    .map((c) => {
      const rec = Number(c.recipients) || 0;
      const rpr = rec ? (Number(c.revenue) || 0) / rec : 0;
      const ctr = Number(c.delivered) ? (Number(c.clicks_unique) || 0) / Number(c.delivered) : 0;
      return { c, rpr, ctr, near: same.has(c.client_id as string) ? 1 : 0 };
    })
    .filter((x) => x.rpr > 0 || x.ctr > 0.01)
    .sort((a, b) => b.near - a.near || b.rpr - a.rpr || b.ctr - a.ctr);
  const seen = new Set<string>();
  const out: Start[] = [];
  for (const x of scored) {
    const subject = String(x.c.subject ?? x.c.name ?? "").trim();
    const k = subject.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!subject || seen.has(k)) continue;
    seen.add(k);
    const sms = /sms/i.test(String(x.c.channel ?? ""));
    const numbers = [x.rpr > 0 ? `$${x.rpr.toFixed(2)} per recipient` : null, x.ctr > 0 ? `${(x.ctr * 100).toFixed(1)}% clicked` : null].filter(Boolean).join(" · ");
    out.push({
      key: `similar-${out.length}`,
      source: "similar",
      kind: sms ? "sms" : "campaign",
      title: subject.slice(0, 120),
      idea: `A ${sms ? "text" : "campaign"} on the pattern that worked for a similar ${me.detail ?? me.industry} brand: "${subject.slice(0, 160)}"${x.c.preview_text ? ` (preview: "${String(x.c.preview_text).slice(0, 140)}")` : ""}. Make it this client's own: their products, offer and voice.`,
      why: `${x.near ? "Same sub-category" : "Same industry"} · ${numbers}`,
      sendOn: null,
      subjects: [],
      suggestionId: null,
    });
    if (out.length >= 6) break;
  }
  return out;
}

export type StartData = {
  ideas: Start[];
  /** Copy already in progress for this client (drafted from the SOW, or a request started earlier) */
  drafts: { id: string; title: string; kind: string; emails: number; fromSow: boolean; month: string | null; updatedAt: string }[];
  industry: string | null;
  /** This month's scope from the SOW, if there is one */
  scope: { label: string | null; campaigns: number; flows: number; notes: string | null } | null;
};

/** What to start from for one client: their own ideas, what worked for similar brands, the flows they're missing */
export async function emailStartData(admin: Db, db: Db, clientId: string): Promise<StartData> {
  const [own, similar, flows, drafts, ind, scope] = await Promise.all([
    db.from("email_suggestions").select("id, title, idea, why, send_on, subjects").eq("client_id", clientId).eq("status", "new").order("send_on", { ascending: true, nullsFirst: false }).limit(8),
    similarWinners(admin, clientId).catch(() => [] as Start[]),
    admin.from("klaviyo_flows").select("name, status").eq("client_id", clientId).limit(200),
    db.from("copy_docs").select("id, title, kind, content, origin, updated_at, status").eq("client_id", clientId).eq("status", "draft").in("kind", ["campaign", "flow", "sms"]).gte("updated_at", new Date(Date.now() - 60 * 86_400_000).toISOString()).order("updated_at", { ascending: false }).limit(8),
    industryOf(admin, clientId),
    admin.from("client_email_allotment").select("scope_label, cap_source, period_start").eq("client_id", clientId).maybeSingle(),
  ]);
  const have = (flows.data ?? []).filter((f) => !/draft|archived/i.test(String(f.status ?? ""))).map((f) => String(f.name ?? ""));
  const missing = STARTERS.filter((s) => !have.some((n) => s.match.test(n)));
  let month: StartData["scope"] = null;
  if (scope.data?.cap_source === "sow" && scope.data.period_start) {
    const m = `${String(scope.data.period_start).slice(0, 7)}-01`;
    const { data: s } = await admin.from("email_scope_months").select("label, campaigns, flows, notes").eq("client_id", clientId).eq("month", m).maybeSingle();
    if (s) month = { label: (s.label as string | null) ?? null, campaigns: Number(s.campaigns) || 0, flows: Number(s.flows) || 0, notes: (s.notes as string | null) ?? null };
  }
  return {
    ideas: [
      ...(own.data ?? []).map((s): Start => ({ key: `own-${s.id}`, source: "client", kind: "campaign", title: s.title as string, idea: s.idea as string, why: (s.why as string | null) ?? null, sendOn: (s.send_on as string | null) ?? null, subjects: ((s.subjects ?? []) as string[]).slice(0, 3), suggestionId: s.id as string })),
      ...similar,
      ...missing.map((s, i): Start => ({ key: `starter-${i}`, source: "starter", kind: s.kind, title: s.title, idea: s.idea, why: have.length ? `${s.why}. Not live in their account yet` : s.why, sendOn: null, subjects: [], suggestionId: null })),
    ],
    drafts: (drafts.data ?? []).map((d) => {
      const o = (d.origin ?? {}) as { kind?: string; month?: string };
      return { id: d.id as string, title: d.title as string, kind: d.kind as string, emails: ((d.content as { emails?: unknown[] } | null)?.emails ?? []).length, fromSow: o.kind === "sow", month: o.month ?? null, updatedAt: d.updated_at as string };
    }),
    industry: ind.detail ?? ind.industry,
    scope: month,
  };
}

// ─── The strategist's plan ──────────────────────────────────────────────────

export type PlanItem = { name: string; angle: string; send: string; audience: string; offer: string };
export type Plan = { title: string; shortName: string; goal: string; audience: string; items: PlanItem[]; notes: string };

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    short_name: { type: "string", description: "Short name for the request title: December, Holiday Gifting, Welcome Series" },
    goal: { type: "string" },
    audience: { type: "string", description: "Who it goes to overall: the list or segments, with what's included and excluded" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Each campaign's topic, or the flow step's name" },
          angle: { type: "string", description: "What it says, in one line" },
          send: { type: "string", description: "A campaign's send day (YYYY-MM-DD or as said), a flow step's timing (Right away, 2 days later)" },
          audience: { type: "string", description: "This send's segment, when it differs" },
          offer: { type: "string" },
        },
        required: ["name", "angle", "send", "audience", "offer"],
        additionalProperties: false,
      },
    },
    notes: { type: "string", description: "Anything the copywriter must know: rules, what to confirm with the client, proof to use" },
  },
  required: ["title", "short_name", "goal", "audience", "items", "notes"],
  additionalProperties: false,
};

export const KIND_WORDS: Record<EmailKind, string> = { campaign: "email campaigns", flow: "an email flow", sms: "SMS campaigns", sms_flow: "an SMS flow" };

/** The Email Strategist plans the request: one line per campaign (or flow step), who it goes to, when, the offer */
export async function planEmails(admin: Db, clientId: string, input: { kind: EmailKind; count: number; idea: string; month: string | null; priority: string }): Promise<Plan> {
  const [{ askJson }, { emailBrief }, { freshContext }, { lineOf }] = await Promise.all([import("@/lib/ai"), import("@/lib/email-ops/chat"), import("@/lib/deliverables/server"), import("@/lib/deliverables/lines")]);
  const [ctx, fresh] = await Promise.all([emailBrief(admin, clientId), freshContext(admin, lineOf("email")!, clientId).catch(() => null)]);
  const flow = input.kind === "flow" || input.kind === "sms_flow";
  const today = new Date().toISOString().slice(0, 10);
  const out = await askJson<{ title: string; short_name: string; goal: string; audience: string; items: PlanItem[]; notes: string }>({
    agent: "email_calendar",
    label: "email request plan",
    clientId,
    schema: PLAN_SCHEMA,
    maxTokens: 5000,
    system: `You are Kaizen Marketing's Email Strategist planning one email request with a teammate, before the copywriter writes it. Plan ${KIND_WORDS[input.kind]}${flow ? ` (one flow, ${input.count} messages: each item is a step of the flow, in order, with its timing)` : ` (${input.count} separate sends batched in one request: each item is one send, with its day)`}. Build it on what has worked for this client (subjects, send days, offers), their calendar and what they said lately, their KPI board (deliverability decides how wide each send goes), and the Scope of Work month when there is one. Fit the advice to their industry. Keep each item to one line. Roles, never names. No em dashes.`,
    prompt: [
      `Client: ${ctx.name}. Today: ${today}.${input.month ? ` For: ${input.month}.` : ""} Priority: ${input.priority}.`,
      ctx.text.slice(0, 16000),
      fresh ? `<fresh_context>\n${JSON.stringify(fresh).slice(0, 14000)}\n</fresh_context>` : "",
      `<request kind="${input.kind}" count="${input.count}">\n${input.idea.trim().slice(0, 3000) || "No idea given: suggest the best ones for this client right now."}\n</request>`,
      `Plan exactly ${input.count} ${flow ? "steps" : "sends"}.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  return {
    title: out.title.slice(0, 200),
    shortName: out.short_name.slice(0, 80),
    goal: out.goal.slice(0, 600),
    audience: out.audience.slice(0, 600),
    items: out.items.slice(0, Math.max(1, input.count)).map((i) => ({ name: i.name.slice(0, 120), angle: i.angle.slice(0, 400), send: i.send.slice(0, 80), audience: i.audience.slice(0, 300), offer: i.offer.slice(0, 200) })),
    notes: out.notes.slice(0, 2000),
  };
}

// ─── The copywriter's copy document ─────────────────────────────────────────

const WRITE_SYSTEM = `You are Kaizen Marketing's email copywriter, working with the Email Strategist. You write the whole copy document for one request from the plan you're given: every campaign in the batch, or every message of the flow, in order.
Each email: a subject under 55 characters, preview text that adds to the subject, the body as short sections written to be designed (a hero headline and line, then short sections), one button with its link (the client's website page when known), and design notes for the designer. Texts: body only (one section), under 160 characters, the brand name first, one {link}.
Keep the client's voice and rules (claims, discounts, words to avoid, imagery rules like real photos only). Roles, never names. No em dashes. No emojis unless the client's own emails use them.`;

/** The Copywriter writes the request's copy from the plan, as a new copy document (or the next version of one) */
export async function writeRequestCopy(admin: Db, db: Db, me: Me, input: { clientId: string; kind: EmailKind; plan: Plan; priority: string; month: string | null; from?: "request_form" | "sow"; docId?: string | null }) {
  const [{ askJson }, { emailBrief }, { COPY_SCHEMA }, { saveCopyDoc }] = await Promise.all([import("@/lib/ai"), import("@/lib/email-ops/chat"), import("@/lib/copy-docs/core"), import("@/lib/copy-docs/server")]);
  const ctx = await emailBrief(admin, input.clientId);
  const { data: c } = await admin.from("clients").select("website").eq("id", input.clientId).maybeSingle();
  const docKind = input.kind === "flow" || input.kind === "sms_flow" ? "flow" : input.kind === "sms" ? "sms" : "campaign";
  const p = input.plan;
  const out = await askJson<Record<string, unknown>>({
    agent: "email_copy",
    label: "email request copy",
    clientId: input.clientId,
    schema: COPY_SCHEMA,
    maxTokens: 16000,
    system: WRITE_SYSTEM,
    prompt: [
      `Client: ${ctx.name}.${c?.website ? ` Website: ${c.website}.` : ""}`,
      ctx.text.slice(0, 16000),
      `<plan kind="${docKind}"${input.kind === "sms_flow" ? ' channel="sms"' : ""}>`,
      `Title: ${p.title}\nShort name: ${p.shortName}\nGoal: ${p.goal}\nAudience: ${p.audience}`,
      p.items.map((i, n) => `${n + 1}. ${i.name}: ${i.angle}${i.send ? ` (send: ${i.send})` : ""}${i.audience ? ` (audience: ${i.audience})` : ""}${i.offer ? ` (offer: ${i.offer})` : ""}`).join("\n"),
      p.notes ? `Notes: ${p.notes}` : "",
      `</plan>`,
      `Write ${p.items.length} ${docKind === "flow" ? "messages" : docKind === "sms" ? "texts" : "emails"}, one per line of the plan, in order.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  const origin = { kind: input.from ?? "request_form", month: input.month, priority: input.priority, plan: p.items.map((i) => i.name), requestKind: input.kind };
  const doc = await saveCopyDoc(admin, db, me, { client: { id: input.clientId }, loose: { ...out, kind: docKind, title: out.title || p.title, short_name: out.short_name || p.shortName }, id: input.docId ?? null, why: input.docId ? "Written again from the plan" : null, origin });
  if (input.docId) await admin.from("copy_docs").update({ origin }).eq("id", doc.id);
  return doc;
}
