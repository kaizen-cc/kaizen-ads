import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import type { EmailHistory, EmailTaskComment } from "@/lib/asana-email";
import { designerAt, phaseOfColumn, stintsOf, writerAt, type Phase, type Piece } from "@/lib/email-kpis-core";
import { isEmailRole } from "@/lib/roles";
import { matchPerson, parseVerdicts } from "@/lib/team-kpis-core";

// Real errors on the email team's work, for the Email Team KPIs: every comment on an email task (the Asana email
// board's, while the team moves over, and the Email Board's own team and client comments) is kept once, credited to
// whoever had the work at that moment (the designer through design, review and the client; the builder through build
// and send; the strategist on copy), then sorted by a small, cheap AI pass into an objective error ("you did this
// wrong", "this is broken", the wrong link, image or price) or not. Each comment is read once: the verdict is kept.

export type EmailErrorItem = { id: string; quote: string; type: string | null; at: string; area: "design" | "build" | "copy"; author: string | null; client: string | null; ticket: number | null; task: string | null; url: string | null };

const DAYS = 120;
const BUILD_STAGES: Phase[] = ["ready_for_build", "ready_to_send", "live", "done"];
type Person = { id: string; full_name: string; role: string };

/** Who owned the work a comment is about, at that moment, and which part of it */
function ownerAt(p: Piece, at: string): { id: string | null; area: "design" | "build" | "copy" } {
  const now = p.stints.find((s) => s.from <= at && (!s.to || s.to > at)) ?? p.stints.at(-1);
  if (now?.stage === "copy_review") return { id: writerAt(p, at), area: "copy" };
  if (now && BUILD_STAGES.includes(now.stage)) {
    const built = p.stints.filter((s) => s.stage === "ready_for_build" && s.from <= at).at(-1);
    if (built?.holder) return { id: built.holder, area: "build" };
  }
  return { id: designerAt(p, at), area: "design" };
}

/** New comments since the last read, saved unsorted (each kept once by its source) */
export async function collectEmailFeedback(admin: SupabaseClient) {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const [{ data: people }, { data: tasks }, { data: comments }] = await Promise.all([
    admin.from("profiles").select("id, full_name, role").eq("is_active", true),
    admin.from("email_asana_tasks").select("gid, name, url, client_id, asana_created_at, section, assignee_name, profile_id, open, completed_at, history, comments").gte("asana_modified_at", since).not("history_read_at", "is", null).limit(2000),
    admin.from("email_comments").select("id, ticket_id, client_id, author_kind, author_id, author_name, body, route, routed_to, created_at, email_tickets(number, title, assignee_id)").in("author_kind", ["team", "client", "asana"]).gte("created_at", since).limit(3000),
  ]);
  const team = (people ?? []) as Person[];
  const who = (name: string | null | undefined) => matchPerson(name, team, (p) => isEmailRole(p.role))?.id ?? null;
  const rows: Record<string, unknown>[] = [];
  for (const t of tasks ?? []) {
    const list = (t.comments ?? []) as EmailTaskComment[];
    if (!list.length) continue;
    const history = ((t.history ?? []) as EmailHistory[]).slice().sort((a, b) => a.at.localeCompare(b.at));
    const moved = history.filter((h): h is Extract<EmailHistory, { kind: "moved" }> => h.kind === "moved");
    const moves = moved.map((h) => ({ at: h.at, to: phaseOfColumn(h.to) })).filter((m): m is { at: string; to: Phase } => m.to != null);
    const open = Boolean(t.open);
    const createdAt = (t.asana_created_at as string) ?? new Date().toISOString();
    const stints = stintsOf(createdAt, phaseOfColumn(moved[0]?.from ?? (t.section as string | null)) ?? "copy_review", moves, history.flatMap((h) => (h.kind === "assigned" ? [{ at: h.at, to: who(h.to) }] : [])), (t.profile_id as string | null) ?? who(t.assignee_name as string | null), open);
    const p = { stints, uploads: [], copyApproved: null } as unknown as Piece;
    list.forEach((m, i) => {
      if (!m.text?.trim()) return;
      const owner = ownerAt(p, m.at);
      if (!owner.id) return;
      // Their own update, not feedback
      if (m.by && who(m.by) === owner.id) return;
      rows.push({ source: "asana", source_key: `asana:${t.gid}:${m.at}:${i}`, profile_id: owner.id, client_id: t.client_id, asana_gid: t.gid, asana_url: t.url, task_title: t.name, area: owner.area, author: m.by, quote: m.text.slice(0, 1500), at: m.at });
    });
  }
  for (const c of comments ?? []) {
    const tk = c.email_tickets as unknown as { number: number; title: string; assignee_id: string | null } | null;
    const owner = (c.routed_to as string | null) ?? tk?.assignee_id ?? null;
    if (!owner || !String(c.body ?? "").trim() || c.author_id === owner) continue;
    rows.push({ source: "kaizen", source_key: `kaizen:${c.id}`, profile_id: owner, client_id: c.client_id, ticket_number: tk?.number ?? null, task_title: tk?.title ?? null, area: c.route === "copy" ? "copy" : "design", author: (c.author_name as string | null) ?? (c.author_kind === "client" ? "Client" : null), quote: String(c.body).slice(0, 1500), at: c.created_at });
  }
  let added = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const { data, error } = await admin.from("email_feedback").upsert(rows.slice(i, i + 200), { onConflict: "source_key", ignoreDuplicates: true }).select("id");
    if (error) throw new Error(`email feedback: ${error.message}`);
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

const SYSTEM = `You sort comments left on email work (a campaign or flow email an email designer designed, an email builder built in the email platform, or a strategist wrote copy for). "error": the comment points at a real mistake in the work as delivered, one anyone would agree is wrong: "you did this wrong", "this is broken", a wrong or broken link, the wrong image, product, price, date, discount or code, a typo, a missing or wrong button, a section left out that the brief asked for, the wrong client's branding, an image not loading, the wrong audience or send time set in the build, mobile layout broken. "preference": a change of taste or direction (make it bigger, try another color, swap the photo, the client changed their mind), or something the maker couldn't have known. "unclear": anything else (a thank-you, a status update, a question, an approval). type: for an error, a short label like "Wrong link", "Broken link", "Wrong image", "Wrong price", "Typo", "Missing CTA", "Missing section", "Broken layout", "Wrong send setup"; for anything else, "".`;

/** Sorts unsorted comments (a batch of 30 per call, a few calls a run), cheap model; each verdict is kept so a comment is read once */
export async function classifyEmailFeedback(admin: SupabaseClient, max = 120) {
  const { data } = await admin.from("email_feedback").select("id, quote, area").is("classified_at", null).order("at", { ascending: false }).limit(max);
  let done = 0;
  for (let i = 0; i < (data ?? []).length; i += 30) {
    const batch = (data ?? []).slice(i, i + 30);
    const out = await askJson<unknown>({
      agent: "creativereview",
      label: "email error check ",
      bare: true,
      override: { model: "haiku", effort: "low" },
      maxTokens: 3000,
      system: SYSTEM,
      prompt: batch.map((b, k) => `[${k}] (${b.area} work) ${String(b.quote).replace(/\s+/g, " ").slice(0, 600)}`).join("\n"),
      schema: SCHEMA,
    });
    const now = new Date().toISOString();
    for (const v of parseVerdicts(out, batch.length)) {
      await admin.from("email_feedback").update({ verdict: v.verdict, error_type: v.type, classified_at: now }).eq("id", batch[v.index].id);
      done++;
    }
  }
  return done;
}

/** Hourly: new comments gathered, then sorted */
export async function keepEmailErrors(admin: SupabaseClient) {
  const added = await collectEmailFeedback(admin);
  const sorted = await classifyEmailFeedback(admin).catch((e) => String(e));
  return { added, sorted };
}

/** Each person's errors since a date, newest first, with what was said (a table not there yet reads as none) */
export async function loadEmailErrors(db: SupabaseClient, sinceIso: string): Promise<{ byPerson: Map<string, EmailErrorItem[]>; unsorted: number }> {
  const { data, error } = await db
    .from("email_feedback")
    .select("id, profile_id, quote, error_type, at, area, author, ticket_number, task_title, asana_url, clients(name)")
    .eq("verdict", "error")
    .gte("at", sinceIso)
    .order("at", { ascending: false })
    .limit(1500);
  const byPerson = new Map<string, EmailErrorItem[]>();
  if (error) return { byPerson, unsorted: 0 };
  for (const r of data ?? []) {
    if (!r.profile_id) continue;
    const list = byPerson.get(r.profile_id as string) ?? [];
    list.push({ id: r.id as string, quote: r.quote as string, type: (r.error_type as string | null) ?? null, at: r.at as string, area: (r.area as EmailErrorItem["area"]) ?? "design", author: (r.author as string | null) ?? null, client: (r.clients as unknown as { name: string } | null)?.name ?? null, ticket: (r.ticket_number as number | null) ?? null, task: (r.task_title as string | null) ?? null, url: (r.asana_url as string | null) ?? null });
    byPerson.set(r.profile_id as string, list);
  }
  const { count } = await db.from("email_feedback").select("id", { count: "exact", head: true }).is("classified_at", null);
  return { byPerson, unsorted: count ?? 0 };
}
