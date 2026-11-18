import type { NextItem } from "@/lib/next-for-me";
import { cleanItems, type CheckItem } from "./ask-rules";
import { firstNameOf } from "./core";
import { askItem, dayWord, type AskRow } from "./next-items";

// Follow-ups from the agents, gathered so a call is a checklist and a client is one card, never fifteen rows. Plain
// functions (no database), tested on their own:
//  - creation: the follow-ups of one call become ONE reminder per client (a tickable checklist), the ones about no
//    client ONE general reminder;
//  - display: open reminders and tasks gather by client (across calls the same day), the general ones by call.

const TZ = "America/New_York";
const dayOf = (x: Date) => x.toLocaleDateString("en-CA", { timeZone: TZ });
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const plural = (n: number) => (n === 1 ? "1 follow-up" : `${n} follow-ups`);
/** The detail every call follow-up used to carry: said once on the card now, never on each row */
const BOILERPLATE = /^A follow-up from your call with /i;

// ─── Creation ───

export type CallFollowUp = { what: string; due: string | null; clientId: string | null; client: string | null };
export type FollowUpReminder = { clientId: string | null; title: string; checklist: CheckItem[]; due: string | null };

/** One reminder per client (and one general) from the follow-ups of a single call; a lone follow-up keeps its own title */
export function followUpReminders(followUps: CallFollowUp[]): FollowUpReminder[] {
  const by = new Map<string, CallFollowUp[]>();
  for (const f of followUps) by.set(f.clientId ?? "general", [...(by.get(f.clientId ?? "general") ?? []), f]);
  return [...by.values()].map((list) => {
    const checklist = cleanItems(list.map((f) => f.what));
    const dues = list.map((f) => f.due).filter((d): d is string => Boolean(d)).sort();
    const name = list[0].client;
    const title = checklist.length === 1 ? checklist[0].text : `${name ? `${name}: ` : ""}${plural(checklist.length)} from your call`;
    return { clientId: list[0].clientId, title, checklist: checklist.length === 1 ? [] : checklist, due: dues[0] ?? null };
  });
}

// ─── Display ───

export type AskGroupItem = { askId: string; index: number | null; text: string; done: boolean; note?: string };
export type AskGroup = {
  client: { id?: string; name: string; slug: string } | null;
  items: AskGroupItem[];
  askIds: string[];
  /** Where it came from, said once: "From your call with Hedwig, 3:49 PM" */
  source: string;
  transcriptCallId?: string;
};

export const groupProgress = (items: { done: boolean }[]) => ({ done: items.filter((i) => i.done).length, total: items.length });

export type AskRowIn = AskRow & { roleKey?: string | null };

/** Open reminders and tasks gathered: by client and day (and who asked), the ones about no client by call */
export function gatherAsks(rows: AskRowIn[], me: string, now = new Date()): { rows: AskRowIn[]; bucket: "now" | "coming" }[] {
  const today = dayOf(now);
  const by = new Map<string, { rows: AskRowIn[]; bucket: "now" | "coming" }>();
  for (const a of rows) {
    const bucket = !a.due_on || a.due_on <= today ? "now" : "coming";
    const who = a.asked_by === me ? "me" : a.asked_by;
    const where = a.client ? `${a.client.slug}|${dayOf(new Date(a.created_at))}` : `general|${a.call_id ?? dayOf(new Date(a.created_at))}`;
    const key = [bucket, who, a.kind, where].join("|");
    const g = by.get(key);
    if (g) g.rows.push(a);
    else by.set(key, { rows: [a], bucket });
  }
  return [...by.values()];
}

function sourceOf(rows: AskRowIn[], me: string, now: Date, assistantName: string | null): string {
  const first = rows[0];
  const day = dayWord(first.created_at, now);
  const at = `${day === "today" ? "" : `${day}, `}${timeOf(first.created_at)}`;
  const calls = new Set(rows.map((r) => r.call_id).filter(Boolean));
  const agent = first.roleKey === "assistant" ? (assistantName ?? "your assistant") : first.roleLabel ? `the ${first.roleLabel}` : "your assistant";
  if (first.asked_by === me) {
    if (calls.size > 1) return `From your calls with ${agent}, ${day === "today" ? "today" : day}`;
    if (calls.size === 1) return `From your call with ${agent}, ${at}`;
    return `Your reminders${first.roleLabel ? ` via the ${first.roleLabel}` : ""}, ${at}`;
  }
  return `From ${firstNameOf(first.askerName)}${first.roleLabel ? ` via the ${first.roleLabel}` : ""}, ${at}`;
}

/** The lines of a gathered set: a checklist's items, or a plain reminder or task as one line */
function itemsOf(rows: AskRowIn[]): AskGroupItem[] {
  const out: AskGroupItem[] = [];
  for (const r of rows) {
    const list = cleanItems(r.checklist);
    if (list.length) list.forEach((c, i) => out.push({ askId: r.id, index: i, text: c.text, done: c.done }));
    else out.push({ askId: r.id, index: null, text: r.title, done: false, note: r.detail && !BOILERPLATE.test(r.detail) ? r.detail : undefined });
  }
  return out;
}

/**
 * The Overview's rows for reminders and tasks from the agents: one compact card per client (a call's follow-ups
 * ticked off inside it), a lone plain reminder as the ordinary row. Due today or earlier (or undated) is for now.
 */
export function askRowsFor(rows: AskRowIn[], me: string, now = new Date(), assistantName: string | null = null): { item: NextItem; bucket: "now" | "coming" }[] {
  const today = dayOf(now);
  return gatherAsks(rows, me, now).map(({ rows: rs, bucket }) => {
    const items = itemsOf(rs);
    if (rs.length === 1 && items.length <= 1) {
      const one = askItem(rs[0], me, now);
      // The boilerplate said on every row used to be the whole "why": say where it came from once instead
      if (rs[0].detail && BOILERPLATE.test(rs[0].detail)) one.item.why = sourceOf(rs, me, now, assistantName);
      return one;
    }
    const client = rs[0].client;
    const mine = rs[0].asked_by === me;
    const late = rs.some((r) => r.due_on && r.due_on < today);
    const dues = rs.map((r) => r.due_on).filter((d): d is string => Boolean(d)).sort();
    const due = dues[0] ? new Date(`${dues[0]}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ }) : null;
    const callId = rs.find((r) => r.with_transcript && r.call_id)?.call_id ?? undefined;
    const source = sourceOf(rs, me, now, assistantName);
    const label = client?.name ?? (mine ? "General" : "From the team");
    const group: AskGroup = { client, items, askIds: rs.map((r) => r.id), source, transcriptCallId: callId ?? undefined };
    const item: NextItem = {
      id: `askg-${rs[0].id}`,
      kind: "ask",
      tone: late ? "bad" : rs.some((r) => r.kind === "task") ? "warn" : "brand",
      client: label,
      title: `${plural(items.length)}${mine && rs.some((r) => r.call_id) ? " from your call" : ""}`,
      why: source,
      when: due ? (late ? `Was due ${due}` : `Due ${due}`) : null,
      href: client ? `/clients/${client.slug}` : "/pipeline#next",
      action: client ? "Open client" : "Open",
      askGroup: group,
    };
    return { item, bucket };
  });
}

/** The same gathered follow-ups as lines for the assistant's rundown: one per client, ids it can clear together */
export function askRundown(rows: AskRowIn[], me: string, now = new Date(), assistantName: string | null = null): { id: string; kind: "reminder" | "task"; client: string; title: string; why: string; due: string | null; tier: "high" | "normal" }[] {
  const today = dayOf(now);
  return gatherAsks(rows, me, now).map(({ rows: rs }) => {
    const items = itemsOf(rs).filter((i) => !i.done);
    const label = rs[0].client?.name ?? "";
    const late = rs.some((r) => r.due_on && r.due_on < today);
    const dues = rs.map((r) => r.due_on).filter((d): d is string => Boolean(d)).sort();
    const many = items.length > 1;
    return {
      id: many ? `ag-${rs.map((r) => r.id).join(",")}` : `a-${rs[0].id}`,
      kind: rs[0].kind,
      client: label,
      title: many ? `${label ? `${label}: ` : ""}${plural(items.length)}` : (items[0]?.text ?? rs[0].title),
      why: many ? `${items.map((i) => i.text).join("; ")} (${sourceOf(rs, me, now, assistantName)})` : (rs[0].detail && !BOILERPLATE.test(rs[0].detail) ? rs[0].detail : sourceOf(rs, me, now, assistantName)),
      due: dues[0] ?? null,
      tier: late ? ("high" as const) : ("normal" as const),
    };
  });
}
