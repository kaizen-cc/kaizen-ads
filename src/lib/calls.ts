import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { googleConfigured, gmailMailboxes, googleDriveToken } from "@/lib/context/google";
import { compact, getCursor, saveItems, setCursor, trimBody } from "@/lib/context/shared";

// Calls: meeting notes from Gemini (Google Meet saves "Notes by Gemini" docs in the organizer's Drive) and Fireflies
// (its API, with FIREFLIES_API_KEY). Each call is matched to its client, read by the AI (what the client said, what
// was decided, what was promised), and added to the client's context, so briefings and every agent know about it.
// Promises are watched: a creative idea or offer from a call with nothing in motion two business days later gets a
// brief written from the call, on Home for the client's buyer, leads and execs.

type NewCall = { source: "gemini" | "fireflies"; external_id: string; title: string; occurred_at: string; attendees: string[]; host: string | null; url: string | null; notes: string };

// ─── Collect ────────────────────────────────────────────────────────────────

/** "Notes by Gemini" docs in everyone's Drive, created since the last run. */
async function collectGemini(since: Date, deadline: number): Promise<NewCall[]> {
  if (!googleConfigured()) return [];
  const out: NewCall[] = [];
  for (const mailbox of await gmailMailboxes()) {
    if (Date.now() > deadline) break;
    try {
      const token = await googleDriveToken(mailbox);
      const q = `name contains 'Notes by Gemini' and mimeType = 'application/vnd.google-apps.document' and 'me' in owners and createdTime > '${since.toISOString()}' and trashed = false`;
      const res = await fetch(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, fields: "files(id,name,createdTime,webViewLink)", pageSize: "50" })}`, {
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) continue;
      const { files = [] } = (await res.json()) as { files?: { id: string; name: string; createdTime: string; webViewLink?: string }[] };
      for (const f of files) {
        const text = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=text/plain`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" })
          .then((r) => (r.ok ? r.text() : ""))
          .catch(() => "");
        if (!text.trim()) continue;
        // "Weekly sync with Nectr - 2026/10/14 10:00 EDT - Notes by Gemini"
        const title = f.name.replace(/\s*-\s*Notes by Gemini\s*$/i, "").replace(/\s*-\s*\d{4}\/\d{2}\/\d{2}.*$/, "").trim() || f.name;
        // Attendees: the "Invited" line Gemini writes, plus any emails in the doc
        const invited = text.match(/Invited\s*\n?([^\n]+)/i)?.[1] ?? "";
        const emails = [...new Set((text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []).map((e) => e.toLowerCase()))];
        out.push({
          source: "gemini",
          external_id: f.id,
          title,
          occurred_at: f.createdTime,
          attendees: [...emails, ...invited.split(/,\s*/).map((n) => n.trim()).filter(Boolean)].slice(0, 40),
          host: mailbox,
          url: f.webViewLink ?? null,
          notes: text.slice(0, 60_000),
        });
      }
    } catch {
      // One mailbox failing (no Drive, delegation lag) doesn't stop the others
    }
  }
  return out;
}

/** Fireflies transcripts since the last run (summary, action items and the transcript itself). */
async function collectFireflies(since: Date): Promise<NewCall[]> {
  const key = process.env.FIREFLIES_API_KEY;
  if (!key) return [];
  const query = `query($from: DateTime) { transcripts(fromDate: $from, limit: 50) { id title date organizer_email participants transcript_url summary { overview action_items shorthand_bullet } sentences { speaker_name text } } }`;
  const res = await fetch("https://api.fireflies.ai/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, variables: { from: since.toISOString() } }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Fireflies: ${res.status} ${(await res.text()).slice(0, 200)}`);
  type T = { id: string; title: string; date: number; organizer_email?: string; participants?: string[]; transcript_url?: string; summary?: { overview?: string; action_items?: string; shorthand_bullet?: string }; sentences?: { speaker_name?: string; text: string }[] };
  const { data, errors } = (await res.json()) as { data?: { transcripts?: T[] }; errors?: { message: string }[] };
  if (errors?.length) throw new Error(`Fireflies: ${errors[0].message}`);
  return (data?.transcripts ?? []).map((t) => ({
    source: "fireflies" as const,
    external_id: t.id,
    title: t.title || "Call",
    occurred_at: new Date(t.date).toISOString(),
    attendees: (t.participants ?? []).map((p) => p.toLowerCase()),
    host: t.organizer_email ?? null,
    url: t.transcript_url ?? null,
    notes: [
      t.summary?.overview && `Overview:\n${t.summary.overview}`,
      t.summary?.action_items && `Action items:\n${t.summary.action_items}`,
      t.summary?.shorthand_bullet && `Notes:\n${t.summary.shorthand_bullet}`,
      t.sentences?.length && `Transcript:\n${t.sentences.map((s) => `${s.speaker_name ?? "Speaker"}: ${s.text}`).join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 60_000),
  }));
}

// ─── Match and read ─────────────────────────────────────────────────────────

/** The client a call was with, when it's plain: a client contact among the attendees, or one client's name. */
function matchCall(call: NewCall, clients: { id: string; name: string }[], contacts: Map<string, string>) {
  for (const a of call.attendees) if (contacts.has(a)) return contacts.get(a)!;
  const text = compact(`${call.title} ${call.notes.slice(0, 1500)}`);
  const byName = clients.filter((c) => compact(c.name).length >= 4 && text.includes(compact(c.name)));
  return byName.length === 1 ? byName[0].id : null;
}

export type CallSummary = { summary: string; clientSaid: string[]; decisions: string[]; commitments: { kind: "creative" | "copy" | "offer" | "launch" | "strategy" | "other"; what: string; why: string; dueDays: number }[] };

const READ_SCHEMA = {
  type: "object",
  properties: {
    internal: { type: "boolean" },
    overview: { type: "string" },
    clients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          client: { type: "integer" },
          summary: { type: "string" },
          clientSaid: { type: "array", items: { type: "string" } },
          decisions: { type: "array", items: { type: "string" } },
          commitments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["creative", "copy", "offer", "launch", "strategy", "other"] },
                what: { type: "string" },
                why: { type: "string" },
                dueDays: { type: "integer" },
              },
              required: ["kind", "what", "why", "dueDays"],
              additionalProperties: false,
            },
          },
        },
        required: ["client", "summary", "clientSaid", "decisions", "commitments"],
        additionalProperties: false,
      },
    },
  },
  required: ["internal", "overview", "clients"],
  additionalProperties: false,
};

const READ_SYSTEM = `You read the notes of a call at Kaizen, a paid social agency, and pull out everything that matters for each client discussed. It may be a call with a client, or an internal team meeting where several clients come up. Use only what's in the notes; don't invent.
internal: true if it's an internal Kaizen meeting (no client on the call). overview: two or three sentences on the call as a whole.
clients: one entry for every client from the list who is discussed in any meaningful way (performance, creative, offers, problems, plans, feedback, budget, mood). client: their number. summary: what was said about them, 2 to 4 sentences. clientSaid: what the client asked for, liked, disliked or told us (on an internal call: what the team reported the client said), short lines. decisions: what was agreed about them.
commitments: everything Kaizen said it would do or explore for that client. kind: "creative" (an ad, design, video or creative idea to make), "copy", "offer" (an offer or promotion to run), "launch" (launch or change campaigns), "strategy", or "other". what: specific enough to brief ("A reel of the new brunch menu with the bottomless mimosa offer"). why: one line of context. dueDays: business days until it should be in motion (a date mentioned, else 2).`;

/**
 * The AI's read of a call, per client discussed: each gets their own summary and promises, and it joins that
 * client's context (the briefing and every agent read it).
 */
async function readCall(admin: SupabaseClient, id: string, clients: { id: string; name: string }[]) {
  const { data: call } = await admin.from("client_calls").select("id, client_id, title, occurred_at, notes, url, source, host").eq("id", id).single();
  if (!call) return;
  const main = clients.find((c) => c.id === call.client_id);
  const out = await askJson<{ internal: boolean; overview: string; clients: (CallSummary & { client: number })[] }>({
    agent: "calls",
    label: "read a call",
    system: READ_SYSTEM,
    schema: READ_SCHEMA,
    prompt: `Clients (number · name):\n${clients.map((c, i) => `${i + 1} · ${c.name}`).join("\n")}\n\nCall: "${call.title}" on ${call.occurred_at.slice(0, 10)}${main ? `\nThis looks like a call with ${main.name}.` : ""}\n\n<notes>\n${call.notes}\n</notes>`,
  });
  const mentions = out.clients.map((m) => ({ ...m, clientId: clients[m.client - 1]?.id })).filter((m): m is typeof m & { clientId: string } => Boolean(m.clientId));
  const unique = [...new Map(mentions.map((m) => [m.clientId, m])).values()];
  await admin
    .from("client_calls")
    .update({
      summary: { summary: out.overview, clientSaid: [], decisions: [], commitments: [] },
      status: out.internal || !call.client_id ? "internal" : "read",
      // A call that turned out to be with one client is theirs
      client_id: call.client_id ?? (!out.internal && unique.length === 1 ? unique[0].clientId : null),
      error: null,
    })
    .eq("id", id);
  // Older calls (a backfill) are context and promises to see, not briefs written today
  const recent = Date.now() - Date.parse(call.occurred_at) < 10 * 86_400_000;
  for (const m of unique) {
    const summary: CallSummary = { summary: m.summary, clientSaid: m.clientSaid, decisions: m.decisions, commitments: m.commitments };
    await admin.from("call_mentions").upsert({ call_id: id, client_id: m.clientId, summary }, { onConflict: "call_id,client_id" });
    for (const c of m.commitments.slice(0, 12)) {
      const { data: due } = await admin.rpc("add_business_days", { p_ts: call.occurred_at, p_days: Math.max(1, Math.min(20, c.dueDays || 2)) });
      await admin.from("call_commitments").insert({
        call_id: id,
        client_id: m.clientId,
        kind: c.kind,
        what: c.what.slice(0, 600),
        why: c.why.slice(0, 400),
        due_at: due ?? call.occurred_at,
        // Not auto-briefed: still shown on the client page and in the request form
        ...(recent ? {} : { checked_at: new Date().toISOString() }),
      });
    }
    await saveItems(admin, [
      {
        client_id: m.clientId,
        source: "call",
        external_id: `${call.source}:${id}:${m.clientId}`,
        thread_id: null,
        occurred_at: call.occurred_at,
        author: call.host,
        title: `${out.internal ? "Internal: " : ""}${call.title}`,
        body: trimBody(
          [m.summary, m.clientSaid.length && `Client said: ${m.clientSaid.join("; ")}`, m.decisions.length && `Decided: ${m.decisions.join("; ")}`, m.commitments.length && `We committed to: ${m.commitments.map((c) => c.what).join("; ")}`]
            .filter(Boolean)
            .join("\n"),
          4000,
        ),
        url: call.url,
        meta: { call_id: id, source: call.source, internal: out.internal },
      },
    ]);
  }
}

/**
 * Every 30 minutes: new calls in, matched and read. Returns what happened, for the sync log.
 */
export async function collectCalls(admin: SupabaseClient, budgetMs = 500_000) {
  const deadline = Date.now() + budgetMs;
  const since = await getCursor(admin, "calls", 45);
  const started = new Date();
  const errors: string[] = [];
  const found: NewCall[] = [];
  found.push(...(await collectGemini(since, deadline).catch((e) => (errors.push(`Gemini: ${e instanceof Error ? e.message : e}`), []))));
  found.push(...(await collectFireflies(since).catch((e) => (errors.push(e instanceof Error ? e.message : String(e)), []))));

  const [{ data: clients }, { data: links }] = await Promise.all([
    admin.from("clients").select("id, name").is("archived_at", null).neq("status", "offboarded"),
    admin.from("contact_clients").select("client_id, contacts(email)"),
  ]);
  const contacts = new Map<string, string>();
  for (const l of links ?? []) {
    const email = (l.contacts as unknown as { email: string } | null)?.email?.toLowerCase();
    if (email && !contacts.has(email)) contacts.set(email, l.client_id);
  }

  // Save everything found first (quick), so a run that runs out of time loses nothing
  let saved = 0;
  for (const call of found) {
    const { data: exists } = await admin.from("client_calls").select("id").eq("source", call.source).eq("external_id", call.external_id).maybeSingle();
    if (exists) continue;
    const { error } = await admin.from("client_calls").insert({ ...call, client_id: matchCall(call, clients ?? [], contacts), status: "new" });
    if (!error) saved++;
  }
  // Then read as many as time allows, oldest first; the rest wait for the next run.
  // Every call is read, internal ones too: a team meeting can carry context for several clients.
  const { data: waiting } = await admin.from("client_calls").select("id").eq("status", "new").order("occurred_at").limit(60);
  let read = 0;
  for (const w of waiting ?? []) {
    if (Date.now() > deadline) break;
    try {
      await readCall(admin, w.id, clients ?? []);
      read++;
    } catch (e) {
      await admin.from("client_calls").update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }).eq("id", w.id);
    }
  }
  const watched = await watchCommitments(admin).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  await setCursor(admin, "calls", started, { found: found.length, saved, read, waiting: Math.max(0, (waiting ?? []).length - read), errors, watched });
  return { found: found.length, saved, read, errors, watched };
}

// ─── Watch what was promised ───────────────────────────────────────────────

const COVER_SCHEMA = {
  type: "object",
  properties: { covered: { type: "array", items: { type: "object", properties: { commitment: { type: "integer" }, tickets: { type: "array", items: { type: "integer" } } }, required: ["commitment", "tickets"], additionalProperties: false } } },
  required: ["covered"],
  additionalProperties: false,
};

/**
 * Commitments past their due date: if a request since the call covers it, it's in motion; if not, and it's something
 * to make (creative, copy, an offer), a brief is written from the call for the team to push into production.
 */
export async function watchCommitments(admin: SupabaseClient, max = 12) {
  const { data: due } = await admin
    .from("call_commitments")
    .select("id, client_id, kind, what, why, due_at, call_id, client_calls(title, occurred_at, summary)")
    .eq("status", "open")
    .is("checked_at", null)
    .lte("due_at", new Date().toISOString())
    .order("due_at")
    .limit(max);
  if (!due?.length) return { checked: 0, inMotion: 0, briefed: 0 };
  let inMotion = 0;
  let briefed = 0;
  const byClient = new Map<string, typeof due>();
  for (const c of due) byClient.set(c.client_id, [...(byClient.get(c.client_id) ?? []), c]);
  for (const [clientId, list] of byClient) {
    const since = list.reduce((m, c) => (((c.client_calls as unknown as { occurred_at: string }).occurred_at < m ? (c.client_calls as unknown as { occurred_at: string }).occurred_at : m)), new Date().toISOString());
    const { data: requests } = await admin.from("requests").select("number, title, brief, created_at").eq("client_id", clientId).gte("created_at", since).is("deleted_at", null).limit(30);
    const covered = new Map<string, number[]>();
    if (requests?.length) {
      const out = await askJson<{ covered: { commitment: number; tickets: number[] }[] }>({
        agent: "calls",
        label: "commitments covered",
        system: "You check whether promises made on a client call have been turned into creative requests since. A request covers a promise when it makes substantially the same thing.",
        schema: COVER_SCHEMA,
        prompt: `Promises:\n${list.map((c, i) => `${i + 1}. ${c.what}`).join("\n")}\n\nRequests made since the call:\n${requests.map((r) => `#${r.number} "${r.title}": ${(r.brief ?? "").replace(/\s+/g, " ").slice(0, 300)}`).join("\n")}\n\ncovered: each promise number that a request covers, with the ticket numbers. Leave out promises nothing covers.`,
      });
      for (const c of out.covered) if (list[c.commitment - 1]) covered.set(list[c.commitment - 1].id, c.tickets);
    }
    for (const c of list) {
      const now = new Date().toISOString();
      if (covered.has(c.id)) {
        await admin.from("call_commitments").update({ status: "in_motion", request_numbers: covered.get(c.id), checked_at: now }).eq("id", c.id);
        inMotion++;
        continue;
      }
      if (!["creative", "copy", "offer"].includes(c.kind)) {
        // Not something to make: noted on the client page, not briefed
        await admin.from("call_commitments").update({ checked_at: now }).eq("id", c.id);
        continue;
      }
      try {
        await briefPromise(admin, c.id);
        briefed++;
      } catch (e) {
        console.error("[calls] couldn't brief a commitment:", e instanceof Error ? e.message : e);
      }
    }
  }
  return { checked: due.length, inMotion, briefed };
}

/**
 * Writes the brief for one promise from a call (or returns the one already written), from what was said about that
 * client on the call. Used by the watcher and by the request form.
 */
export async function briefPromise(admin: SupabaseClient, commitmentId: string) {
  const { data: c } = await admin
    .from("call_commitments")
    .select("id, client_id, kind, what, why, suggestion_id, call_id, client_calls(title, occurred_at)")
    .eq("id", commitmentId)
    .single();
  if (!c) throw new Error("Promise not found");
  if (c.suggestion_id) {
    const { data: open } = await admin.from("creative_suggestions").select("id").eq("id", c.suggestion_id).eq("status", "open").maybeSingle();
    if (open) return open.id as string;
  }
  const { data: mention } = await admin.from("call_mentions").select("summary").eq("call_id", c.call_id).eq("client_id", c.client_id).maybeSingle();
  const call = c.client_calls as unknown as { title: string; occurred_at: string };
  const { suggestFromCall } = await import("@/lib/suggestions");
  const id = await suggestFromCall(admin, c.client_id, { id: c.id, what: c.what, why: c.why ?? "", kind: c.kind }, { ...call, summary: (mention?.summary as CallSummary | null) ?? null });
  await admin.from("call_commitments").update({ status: "briefed", suggestion_id: id, checked_at: new Date().toISOString() }).eq("id", c.id);
  return id;
}
