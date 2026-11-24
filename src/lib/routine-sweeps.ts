import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { nyClock, type RecapLine, type RoutineReport } from "@/lib/routines-core";
import { coverageGaps, dueOf, matchPerson, tagged, type Person as Teammate } from "@/lib/routine-sweeps-core";
import { blockedForPeople, PEOPLE_RULE } from "@/lib/people-matters";

// The call debrief sweep and the delegation tracker (owner, Nov 24 2026; docs/kyle-scheduled-runs.md #1 and #5).
// Debrief: the calls the person was on (Gemini and Fireflies, already read and matched to clients by the calls step,
// whose team commitments the promise routing already sends), read for the person's OWN action items and for sales
// calls (into Sales › Prospects), plus a coverage check of their calendar. Delegation: every ask they made of a
// teammate in Slack today becomes an item that teammate owns. Both only through the dedupe against reality; neither
// ever posts, emails or reacts anywhere, nor states a client's fee.

type Admin = SupabaseClient;
type Me = { id: string; full_name: string; email: string; role: string; is_exec: boolean; is_lead: boolean };
const DAY = 86_400_000;

const ITEMS_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["client", "internal", "vendor", "sales", "unclear"] },
    my_items: {
      type: "array",
      items: { type: "object", properties: { title: { type: "string" }, due: { type: ["string", "null"] }, why: { type: "string" }, soon: { type: "boolean" }, personnel: { type: "boolean", description: "True when it's about a person on the team (performance, conduct, pay, hiring or firing, health, personal life)" } }, required: ["title", "due", "why", "soon", "personnel"], additionalProperties: false },
    },
    urgent: { type: ["string", "null"], description: "Only something that can't wait for the next recap: a client giving notice or churning, an angry or escalating client, a billing dispute, a launch or deliverable broken or blocked today, a hot prospect asking for something today. The action to take, in one sentence." },
    sales: {
      type: ["object", "null"],
      properties: {
        business: { type: "string" },
        contact: { type: ["string", "null"] },
        email: { type: ["string", "null"] },
        phone: { type: ["string", "null"] },
        website: { type: ["string", "null"] },
        no_show: { type: "boolean" },
        snapshot: { type: "string" },
        overview: { type: "array", items: { type: "string" } },
        services: { type: "array", items: { type: "object", properties: { service: { type: "string" }, state: { type: "string", enum: ["requested", "pitched", "not discussed"] } }, required: ["service", "state"], additionalProperties: false } },
        budget: { type: "string" },
        timeline: { type: "string" },
        decision_maker: { type: "string" },
        objections: { type: "array", items: { type: "string" } },
        pricing: { type: "string" },
        next_steps: { type: "array", items: { type: "string" } },
        fit: { type: "string", enum: ["high", "medium", "low"] },
        fit_tag: { type: "string", enum: ["certain", "likely", "guessing"] },
      },
      required: ["business", "contact", "email", "phone", "website", "no_show", "snapshot", "overview", "services", "budget", "timeline", "decision_maker", "objections", "pricing", "next_steps", "fit", "fit_tag"],
      additionalProperties: false,
    },
  },
  required: ["type", "my_items", "urgent", "sales"],
  additionalProperties: false,
};

type CallRead = { type: string; my_items: { title: string; due: string | null; why: string; soon: boolean; personnel: boolean }[]; urgent: string | null; sales: null | Record<string, unknown> & { business: string; contact: string | null; no_show: boolean; snapshot: string; overview: string[]; services: { service: string; state: string }[]; next_steps: string[]; objections: string[]; fit: string; fit_tag: string } };

const SERVICES = "Meta, Google, TikTok, Email/SMS (Klaviyo), CRM build/automation, Website/landing pages, CRO/tracking, SEO/AEO, Organic social, Creative production, Claude AI instance/MCP integration";

/** The call debrief sweep: the person's calls in the last two days, read once each */
export async function debrief(admin: Admin, me: Me): Promise<RoutineReport> {
  const today = nyClock(new Date()).date;
  const since = new Date(Date.now() - 2 * DAY).toISOString();
  const email = me.email.toLowerCase();
  const [{ data: calls }, { data: before }] = await Promise.all([
    admin.from("client_calls").select("id, title, occurred_at, attendees, host, url, summary, notes, client_id, status, clients(name)").gte("occurred_at", since).order("occurred_at").limit(80),
    admin.from("routine_runs").select("report").eq("profile_id", me.id).eq("kind", "debrief").gte("started_at", new Date(Date.now() - 4 * DAY).toISOString()).limit(40),
  ]);
  const processed = new Set(((before ?? []) as { report: { processed?: string[] } | null }[]).flatMap((r) => r.report?.processed ?? []));
  const mine = (calls ?? []).filter((c) => String(c.host ?? "").toLowerCase() === email || ((c.attendees as string[] | null) ?? []).some((a) => String(a).toLowerCase() === email));
  const fresh = mine.filter((c) => !processed.has(c.id as string) && String(c.notes ?? c.summary ?? "").trim().length > 80).slice(0, 8);
  const { loadReality, createItemIfNew } = await import("@/lib/reality-check");
  const found = await loadReality(admin, { clientIds: fresh.map((c) => (c.client_id as string | null) ?? null), ownerIds: [me.id] }).catch(() => []);
  const created: RecapLine[] = [];
  const handled: RecapLine[] = [];
  const sales: RecapLine[] = [];
  const callLines: RecapLine[] = [];
  const urgent: string[] = [];
  let salesMade = 0;
  for (const c of fresh) {
    const client = (c.clients as unknown as { name: string } | null)?.name ?? null;
    const notes = String(c.notes ?? c.summary ?? "").slice(0, 14_000);
    let read: CallRead;
    try {
      read = await askJson<CallRead>({
        agent: "calls",
        label: "routine debrief call",
        clientId: (c.client_id as string | null) ?? null,
        override: { model: "sonnet", effort: "low" },
        maxTokens: 3500,
        system: `You read one call's notes for a ${me.role.replace(/_/g, " ")} at Kaizen, a paid ads, creative, email and social agency (the person is "${me.full_name.split(" ")[0]}"; Gemini notes may use first names or nicknames). type: client (a Kaizen client), internal (only Kaizen people), vendor (a vendor, ad-platform rep, accountant, recruiter or candidate, referral partner), sales (a prospect: anyone else external${client ? "; this call is matched to a client, so it isn't sales" : ""}), unclear.
my_items: ONLY things this person themselves must do (they said "I'll…", someone asked them specifically, a decision only they can make: pricing, fees, scope, hiring, approvals, churn/retention; or a teammate is blocked on them). Skip brainstorming, FYIs, things done on the call, and work for other teammates (the team's commitments are already routed). Verb-first titles, at most 6; merge related ones. due: a date said (YYYY-MM-DD) else null. soon: true when it's about a client, revenue or churn or someone is blocked. why: one line with the numbers that make it matter.
sales (only for type sales, else null): business, contact, email, phone, website when known (else null); no_show; snapshot (one line); overview (5-8 bullets: the business, current marketing and spend, the problem in their words, numbers, what Kaizen recommended, how it ended); services: each of ${SERVICES} as requested / pitched / not discussed; budget, timeline, decision_maker ("unknown" when not said); objections; pricing exactly as said ("not discussed" when not); next_steps both sides; fit high/medium/low with a certainty tag. Never contact anyone.
${PEOPLE_RULE} Mark any such item personnel: true; it is never filed.`,
        schema: ITEMS_SCHEMA,
        prompt: `Call: ${c.title} (${String(c.occurred_at).slice(0, 16)})${client ? ` with ${client}` : ""}\nAttendees: ${((c.attendees as string[] | null) ?? []).join(", ")}\n\n${notes}`,
      });
    } catch {
      continue;
    }
    callLines.push({ text: `${c.title}${client ? ` (${client})` : ""}: ${read.type}${read.my_items.length ? `, ${read.my_items.length} for you` : ""}`, href: (c.url as string | null) ?? null, tag: null });
    if (read.urgent) urgent.push(read.urgent);
    for (const [n, it] of read.my_items.slice(0, 6).entries()) {
      // People matters never become an item (owner, Nov 24 2026)
      if (blockedForPeople({ text: `${it.title}\n${it.why}`, personnel: it.personnel })) continue;
      const r = await createItemIfNew(
        admin,
        { owner_id: me.id, client_id: (c.client_id as string | null) ?? null, title: tagged("Call", today, it.title), detail: `${it.why}\nFrom the call "${c.title}"${c.url ? `: ${c.url}` : ""}\n(Created by Kaizen OS from the call notes.)`, due_on: dueOf(today, it.due, it.soon, 1, 3), source_ref: `routine:call:${c.id}:${n}`, urgent: it.soon },
        found,
      );
      if (r.state === "new" && r.id) created.push({ text: tagged("Call", today, it.title), href: "/pipeline", tag: null });
      else if (r.match) handled.push({ text: r.state === "done" ? `Already done: ${r.match.title}` : `Already in motion${r.match.owner ? ` (${r.match.owner} is on it)` : ""}: ${r.match.title}`, href: r.match.href, tag: null });
    }
    if (read.type === "sales" && read.sales && salesMade < 5) {
      const s = read.sales;
      const line = await saveSalesCall(admin, me, { ...s, callId: c.id as string, link: (c.url as string | null) ?? null, title: c.title as string, today });
      if (line) {
        sales.push(line);
        salesMade++;
      }
    }
  }
  // Calls with notes still processing aren't marked read: the next sweep takes them
  const meetings = await (await import("@/lib/routines")).meetingsBetween(me.email, since, new Date().toISOString());
  const gaps = meetings ? coverageGaps(meetings, mine.map((c) => ({ at: c.occurred_at as string }))) : [];
  const sections = [
    { title: "Calls read", lines: callLines },
    { title: "Sales calls", lines: sales },
    { title: "New items for you", lines: created },
    { title: "Already handled", lines: handled },
    { title: "Coverage gaps", lines: gaps.map((g) => ({ text: `${g.title} (${new Date(g.start).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" })}): no notes from Gemini or Fireflies`, href: null, tag: null })) },
  ].filter((s) => s.lines.length);
  const headline = urgent[0] ?? (fresh.length ? `${fresh.length} call${fresh.length === 1 ? "" : "s"} read: ${created.length} new item${created.length === 1 ? "" : "s"} for you${sales.length ? `, ${sales.length} sales call${sales.length === 1 ? "" : "s"} in Sales` : ""}.` : "No new client calls, sales calls or client comms since the last sweep.");
  return { headline, sections, urgent: urgent.length > 0, failedSources: meetings ? [] : ["Google Calendar (for the coverage check)"], processed: fresh.map((c) => c.id as string) };
}

/** A sales call into Sales › Prospects: the existing prospect gets the call's notes, else one new prospect */
async function saveSalesCall(admin: Admin, me: Me, s: CallRead["sales"] & { callId: string; link: string | null; title: string; today: string }): Promise<RecapLine | null> {
  if (!s) return null;
  const { sameBusiness } = await import("@/lib/sales-core");
  const { data: open } = await admin.from("prospects").select("id, name, website").not("status", "in", "(won,lost)").limit(500);
  const hit = (open ?? []).find((p) => sameBusiness({ name: p.name as string, website: (p.website as string | null) ?? null }, { name: s.business, website: (s.website as string | null) ?? null }));
  const body = [
    s.link ? `Notes: ${s.link}` : "",
    s.snapshot,
    s.overview.map((o) => `- ${o}`).join("\n"),
    `Services: ${s.services.map((x) => `${x.service}: ${x.state}`).join("; ")}`,
    `Budget: ${s.budget} · Timeline: ${s.timeline} · Decision-maker: ${s.decision_maker}`,
    s.objections.length ? `Objections: ${s.objections.join("; ")}` : "",
    `Pricing discussed: ${s.pricing}`,
    s.next_steps.length ? `Next steps: ${s.next_steps.join("; ")}` : "",
    `Fit: ${s.fit} [${s.fit_tag}]`,
    "(Created by Kaizen OS from the sales call notes.)",
  ]
    .filter(Boolean)
    .join("\n\n");
  const title = tagged("Sales", s.today, `${s.business}${s.contact ? ` — ${s.contact}` : ""}`);
  let id = hit?.id as string | undefined;
  if (!id) {
    const contacts = [{ name: s.contact, email: s.email, phone: s.phone }].filter((c) => c.name || c.email || c.phone);
    const { data } = await admin.from("prospects").insert({ name: s.business.slice(0, 200), website: (s.website as string | null) ?? null, status: s.no_show ? "contacted" : "talking", owner_id: me.id, source: "call", notes: s.snapshot.slice(0, 1000), contacts, created_by: me.id }).select("id").single();
    id = data?.id as string | undefined;
  }
  if (!id) return null;
  const { data: dup } = await admin.from("prospect_notes").select("id").eq("prospect_id", id).ilike("body", `%${s.callId}%`).limit(1);
  if (!dup?.length) await admin.from("prospect_notes").insert({ prospect_id: id, kind: "call_review", title, body: `${body}\n[call ${s.callId}]`, created_by: me.id });
  return { text: `${s.business}: ${s.snapshot} (fit ${s.fit})${hit ? " · added to the existing prospect" : ""}`, href: `/sales/${id}`, tag: s.fit_tag as RecapLine["tag"] };
}

const ASKS_SCHEMA = {
  type: "object",
  properties: {
    asks: {
      type: "array",
      items: {
        type: "object",
        properties: { n: { type: "integer" }, owner: { type: ["string", "null"], description: "The teammate's name as written; null when it's a group ask with no single owner" }, scope: { type: "string" }, client: { type: ["string", "null"] }, due: { type: ["string", "null"] }, soon: { type: "boolean" }, done: { type: "string", description: "What done looks like, one line" }, personnel: { type: "boolean", description: "True when it's about a person on the team (performance, conduct, pay, hiring or firing, health, personal life)" }, about: { type: "array", items: { type: "string" }, description: "Teammates the message is about (not who it's to)" } },
        required: ["n", "owner", "scope", "client", "due", "soon", "done", "personnel", "about"],
        additionalProperties: false,
      },
    },
  },
  required: ["asks"],
  additionalProperties: false,
};

/** The delegation tracker: every ask the person made of a teammate in Slack today becomes an item that teammate owns */
export async function delegation(admin: Admin, me: Me): Promise<RoutineReport> {
  const today = nyClock(new Date()).date;
  const start = new Date(`${today}T05:00:00Z`).toISOString();
  const [{ data: msgs }, { data: people }, { data: clients }] = await Promise.all([
    admin.from("context_items").select("id, client_id, occurred_at, author, title, body, url").eq("source", "slack_internal").eq("author", me.full_name).gte("occurred_at", start).order("occurred_at").limit(80),
    admin.from("profiles").select("id, full_name, email").eq("is_active", true),
    admin.from("clients").select("id, name").is("archived_at", null).limit(800),
  ]);
  const team: Teammate[] = (people ?? []).filter((p) => p.id !== me.id).map((p) => ({ id: p.id as string, name: p.full_name as string, email: p.email as string }));
  const list = (msgs ?? []).filter((m) => String(m.body ?? "").trim().length > 8);
  const failed = ["Slack DMs and group DMs (read only when they allow it in Connections; internal channels were read)"];
  if (!list.length) return { headline: "No asks of teammates in Slack today.", sections: [], failedSources: failed };
  const out = await askJson<{ asks: { n: number; owner: string | null; scope: string; client: string | null; due: string | null; soon: boolean; done: string; personnel: boolean; about: string[] }[] }>({
    agent: "calls",
    label: "routine delegation tracker",
    override: { model: "sonnet", effort: "low" },
    maxTokens: 3000,
    system: `You read Slack messages one person at Kaizen wrote today and pick out the asks they made of a specific teammate: "can you…", "please…", "@Name build…", "need X by Friday", a request in a reply. Skip FYIs, questions that only want a chat answer, brainstorming, anything to clients or outside people, things already marked done, and asks of themselves. owner: the teammate's name as written (an @mention or the name addressed), or null for a group ask with no single owner. scope: verb-first, what to do. client: the client it's about, if any. due: a date they said (YYYY-MM-DD) else null. soon: true when it's about a client, revenue or churn, or someone is blocked. done: what finished looks like. Several asks for the same thing to the same person are one ask. ${PEOPLE_RULE} Mark any such ask personnel: true and list who it's about. Teammates: ${team.map((t) => t.name).join(", ")}.`,
    schema: ASKS_SCHEMA,
    prompt: list.map((m, i) => `${i + 1}. [${String(m.occurred_at).slice(11, 16)}${m.title ? ` · ${m.title}` : ""}] ${String(m.body ?? "").replace(/\s+/g, " ").slice(0, 900)}`).join("\n"),
  });
  const { loadReality, createItemIfNew } = await import("@/lib/reality-check");
  const found = await loadReality(admin, { clientIds: list.map((m) => (m.client_id as string | null) ?? null), ownerIds: team.map((t) => t.id) }).catch(() => []);
  const created: RecapLine[] = [];
  const existing: RecapLine[] = [];
  const unclear: RecapLine[] = [];
  const nomatch: RecapLine[] = [];
  for (const a of (out.asks ?? []).slice(0, 15)) {
    const m = list[a.n - 1];
    if (!m) continue;
    if (!a.owner) {
      unclear.push({ text: a.scope, href: (m.url as string | null) ?? null, tag: null });
      continue;
    }
    // People matters, or an ask whose owner is the person it's about, are never filed (owner, Nov 24 2026)
    if (blockedForPeople({ text: `${a.scope}\n${String(m.body ?? "")}`, personnel: a.personnel, ownerName: a.owner, about: a.about })) continue;
    const who = matchPerson(a.owner, team);
    if (!who) {
      nomatch.push({ text: `${a.owner}: ${a.scope}`, href: (m.url as string | null) ?? null, tag: null });
      continue;
    }
    const clientId = (m.client_id as string | null) ?? (a.client ? ((clients ?? []).find((c) => String(c.name).toLowerCase() === a.client!.toLowerCase())?.id as string | undefined) ?? null : null);
    const r = await createItemIfNew(
      admin,
      {
        owner_id: who.id,
        asked_by: me.id,
        client_id: clientId,
        title: tagged("Slack", today, `${who.name.split(" ")[0]} · ${a.scope}`),
        detail: `${me.full_name.split(" ")[0]} asked: "${String(m.body ?? "").replace(/\s+/g, " ").slice(0, 700)}"\n${m.url ? `${m.url}\n` : ""}Done means: ${a.done}\n(Created by Kaizen OS from ${me.full_name.split(" ")[0]}'s Slack message.)`,
        due_on: dueOf(today, a.due, a.soon, 1, 3),
        source_ref: `deleg:${m.id}:${who.id}`,
      },
      found,
    );
    const line = `${who.name} · ${a.scope}`;
    if (r.state === "new" && r.id) created.push({ text: line, href: "/pipeline", tag: null });
    else existing.push({ text: r.match ? `${line} (${r.state === "done" ? "already done" : `already in motion${r.match.owner ? `, ${r.match.owner}` : ""}`}: ${r.match.title})` : line, href: r.match?.href ?? null, tag: null });
  }
  const sections = [
    { title: "Created", lines: created },
    { title: "Added to existing", lines: existing },
    { title: "Unclear owner", lines: unclear },
    { title: "Couldn't match", lines: nomatch },
  ].filter((s) => s.lines.length);
  return { headline: created.length ? `${created.length} ask${created.length === 1 ? "" : "s"} from Slack today now ${created.length === 1 ? "is an item its owner has" : "are items their owners have"}.` : "Nothing new to track from today's Slack asks.", sections, failedSources: failed };
}
