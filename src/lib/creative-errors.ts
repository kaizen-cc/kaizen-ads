import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import type { HistoryEvent, TaskComment } from "@/lib/asana";
import { spansOf, type Span } from "@/lib/production";

// Real errors each maker made, for the Creative KPIs: every piece of feedback on their work (comments in internal
// review and from the client on the Board, AI review notes a person confirmed by resolving them, and comments on the
// Asana task) is gathered once, then sorted by a small AI pass into an objective error (a typo, a missing button, the
// wrong size, logo, offer or link, a required element left out) or a preference ("let's try it bigger"). Only errors
// count against them; the quotes are kept so a lead can see exactly what happened.

export type ErrorItem = { id: string; quote: string; type: string | null; at: string; round: "internal" | "client" | null; author: string | null; client: string | null; ticket: number | null; task: string | null; url: string | null };

const DAYS = 120;
const MAKER_COLS = ["make", "client_revision"];
const COPY_COLS = ["copy", "copy_review"];

type Person = { id: string; full_name: string; role: string };
const personFor = (people: Person[], name: string | null) => (name ? people.find((p) => p.full_name.toLowerCase().startsWith(name.toLowerCase()) || name.toLowerCase().startsWith(p.full_name.toLowerCase())) : undefined);

/** Who the work belonged to when a comment came in: the copywriter on copy columns, the maker otherwise */
function ownerAt(spans: Span[], at: string) {
  const now = spans.find((s) => s.from <= at && (!s.to || s.to > at));
  const copy = now && COPY_COLS.includes(now.col);
  const before = spans.filter((s) => s.from <= at && s.holder && (copy ? s.col === "copy" : MAKER_COLS.includes(s.col) || (s.col === "brief" && s.next != null && s.next !== "brief")));
  return { holder: before.at(-1)?.holder ?? null, round: now && ["client", "client_revision"].includes(now.col) ? ("client" as const) : ("internal" as const) };
}

/** New feedback since the last read, saved unsorted (each kept once by its source) */
export async function collectFeedback(admin: SupabaseClient) {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const [{ data: people }, { data: comments }, { data: tasks }] = await Promise.all([
    admin.from("profiles").select("id, full_name, role").eq("is_active", true),
    admin
      .from("review_comments")
      .select("id, body, round, author_id, author_contact_id, author_name, ai_review_id, severity, resolved_at, disagreed_at, created_at, requests!inner(number, title, client_id, creative_id, assignee_id)")
      .gte("created_at", since)
      .limit(3000),
    admin.from("asana_tasks").select("gid, name, url, client_id, asana_created_at, section, assignee_name, history, comments").gte("asana_modified_at", since).not("history_read_at", "is", null).limit(2000),
  ]);
  const team = (people ?? []) as Person[];
  const rows: Record<string, unknown>[] = [];
  for (const c of comments ?? []) {
    const r = c.requests as unknown as { number: number; title: string; client_id: string; creative_id: string | null; assignee_id: string | null };
    const maker = r.creative_id ?? r.assignee_id;
    if (!maker || !String(c.body ?? "").trim()) continue;
    // The AI's notes count once a person confirmed them (resolved, not disagreed with); a maker's note to themself never
    const ai = Boolean(c.ai_review_id);
    if (ai && (!c.resolved_at || c.disagreed_at || c.severity !== "fix")) continue;
    if (c.author_id === maker) continue;
    rows.push({ source: "review", source_key: `review:${c.id}`, profile_id: maker, client_id: r.client_id, request_number: r.number, task_title: r.title, round: c.round === "client" || c.author_contact_id ? "client" : "internal", author: ai ? "AI review (confirmed)" : (c.author_name ?? null), quote: String(c.body).slice(0, 1500), at: c.created_at });
  }
  for (const t of tasks ?? []) {
    const list = (t.comments ?? []) as TaskComment[];
    if (!list.length) continue;
    const spans = spansOf((t.asana_created_at as string) ?? new Date().toISOString(), (t.history ?? []) as HistoryEvent[], t.section as string | null, t.assignee_name as string | null);
    list.forEach((m, i) => {
      const { holder, round } = ownerAt(spans, m.at);
      const owner = personFor(team, holder);
      if (!owner || !["graphic_designer", "video_editor", "copywriter"].includes(owner.role)) return;
      if (m.by && personFor(team, m.by)?.id === owner.id) return; // their own update, not feedback
      rows.push({ source: "asana", source_key: `asana:${t.gid}:${m.at}:${i}`, profile_id: owner.id, client_id: t.client_id, asana_gid: t.gid, asana_url: t.url, task_title: t.name, round, author: m.by, quote: m.text.slice(0, 1500), at: m.at });
    });
  }
  let added = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const { data } = await admin.from("creative_feedback").upsert(rows.slice(i, i + 200), { onConflict: "source_key", ignoreDuplicates: true }).select("id");
    added += data?.length ?? 0;
  }
  return added;
}

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { i: { type: "integer" }, verdict: { type: "string", enum: ["error", "preference", "unclear"] }, type: { type: "string" } },
        required: ["i", "verdict", "type"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

/** Sorts unsorted feedback: an objective error (and which kind) or a preference. A batch per call, a few calls a run. */
export async function classifyFeedback(admin: SupabaseClient, max = 90) {
  const { data } = await admin.from("creative_feedback").select("id, quote, round").is("classified_at", null).order("at", { ascending: false }).limit(max);
  let done = 0;
  for (let i = 0; i < (data ?? []).length; i += 30) {
    const batch = (data ?? []).slice(i, i + 30);
    const out = await askJson<{ items: { i: number; verdict: "error" | "preference" | "unclear"; type: string }[] }>({
      agent: "creativereview",
      label: "creative error check ",
      bare: true,
      override: { model: "haiku", effort: "low" },
      maxTokens: 3000,
      system: `You sort feedback on ads a designer, video editor or copywriter made. "error": an objective mistake anyone would agree is wrong and that the maker should have caught: a spelling or grammar mistake, a missing or wrong button or call to action, the wrong size or crop, the wrong or missing logo, a wrong price, offer, date or phone number, a broken or wrong link, a required element from the brief left out, text cut off or unreadable, the wrong product shown, a policy violation. "preference": a change of taste or direction (make it bigger, try another color, a different angle, more energy, swap the photo, the client changed their mind), or new information the maker couldn't have known. "unclear": neither can be told (a thank-you, a status update, a question). type: for an error, a short label like "Spelling", "Missing CTA", "Wrong size", "Wrong logo", "Wrong offer", "Broken link", "Missing element", "Text cut off", "Policy"; for anything else, "".`,
      prompt: batch.map((b, k) => `[${k}] (${b.round ?? "internal"} feedback) ${String(b.quote).replace(/\s+/g, " ").slice(0, 600)}`).join("\n"),
      schema: SCHEMA,
    });
    const now = new Date().toISOString();
    for (const it of out.items) {
      const row = batch[it.i];
      if (!row) continue;
      await admin.from("creative_feedback").update({ verdict: it.verdict, error_type: it.verdict === "error" ? it.type.slice(0, 40) || "Error" : null, classified_at: now }).eq("id", row.id);
      done++;
    }
  }
  return done;
}

/** Hourly: new feedback gathered, then sorted */
export async function keepCreativeErrors(admin: SupabaseClient) {
  const added = await collectFeedback(admin);
  const sorted = await classifyFeedback(admin).catch((e) => String(e));
  return { added, sorted };
}

/** Each person's errors since a date, newest first, with what was said */
export async function loadErrors(db: SupabaseClient, sinceIso: string) {
  const { data } = await db
    .from("creative_feedback")
    .select("id, profile_id, quote, error_type, at, round, author, request_number, task_title, asana_url, clients(name)")
    .eq("verdict", "error")
    .gte("at", sinceIso)
    .order("at", { ascending: false })
    .limit(1500);
  const byPerson = new Map<string, ErrorItem[]>();
  for (const r of data ?? []) {
    if (!r.profile_id) continue;
    const list = byPerson.get(r.profile_id as string) ?? [];
    list.push({ id: r.id as string, quote: r.quote as string, type: (r.error_type as string | null) ?? null, at: r.at as string, round: (r.round as "internal" | "client" | null) ?? null, author: (r.author as string | null) ?? null, client: (r.clients as unknown as { name: string } | null)?.name ?? null, ticket: (r.request_number as number | null) ?? null, task: (r.task_title as string | null) ?? null, url: (r.asana_url as string | null) ?? null });
    byPerson.set(r.profile_id as string, list);
  }
  const { count: unsorted } = await db.from("creative_feedback").select("id", { count: "exact", head: true }).is("classified_at", null);
  return { byPerson, unsorted: unsorted ?? 0 };
}
