// Kaizen OS as an extension of Asana, the pure part (tests/asana-live.test.ts): the task shapes, the order tasks are
// shown in, quick due dates, and the comment each change leaves in Asana naming who made it from the OS.

export type LiveTask = { gid: string; name: string; due: string | null; project: string | null; section: string | null; client: string | null; clientSlug: string | null; url: string; /** Their own My tasks section ("Recently assigned"), apart from the project's */ mySection?: string | null };

export type FieldValue = { gid: string; name: string; kind: "enum" | "text" | "number" | "date" | "other"; options: { gid: string; name: string }[]; value: string | number | null; display: string | null };

export type TaskDetail = {
  gid: string;
  name: string;
  notes: string;
  due: string | null;
  start: string | null;
  completed: boolean;
  url: string;
  assignee: { name: string | null; email: string | null } | null;
  project: string | null;
  section: { gid: string; name: string } | null;
  sections: { gid: string; name: string }[];
  fields: FieldValue[];
  subtasks: { gid: string; name: string; completed: boolean }[];
  comments: { gid: string; text: string; at: string; by: string | null }[];
  attachments: { gid: string; name: string; url: string | null }[];
  /** Who assigned it to whoever has it now (Asana's last "assigned" story) */
  assignedBy?: string | null;
};

export type AsanaPatch = {
  name?: string;
  notes?: string;
  due?: string | null;
  /** A due date with its time (an ISO instant), Asana's due_at; null clears the due date */
  dueAt?: string | null;
  start?: string | null;
  completed?: boolean;
  /** An Asana user gid or email */
  assignee?: string | null;
  assigneeName?: string;
  /** Custom fields by gid: an enum option gid, text, a number, or { date } */
  fields?: Record<string, string | number | null | { date: string | null }>;
  /** Move to this section (gid) */
  section?: string;
  sectionName?: string;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (s: unknown): boolean => typeof s === "string" && DAY.test(s);

/** Overdue first, then due soonest, then undated */
export function sortTasks<T extends { due: string | null; name: string }>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => (a.due ?? "9999-12-31").localeCompare(b.due ?? "9999-12-31") || a.name.localeCompare(b.name));
}

/** "today" / "tomorrow" / "friday" / a date, as YYYY-MM-DD in New York */
export function quickDue(word: string, now = new Date()): string | null {
  const w = word.trim().toLowerCase();
  if (isDay(w)) return w;
  const today = new Date(`${now.toLocaleDateString("en-CA", { timeZone: "America/New_York" })}T12:00:00Z`);
  const plus = (n: number) => new Date(today.getTime() + n * 86_400_000).toISOString().slice(0, 10);
  if (w === "today") return plus(0);
  if (w === "tomorrow") return plus(1);
  if (w === "next week") return plus(7);
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const i = days.findIndex((d) => w === d || w === d.slice(0, 3) || w === `next ${d}` || w === `this ${d}`);
  if (i >= 0) {
    const ahead = (i - today.getUTCDay() + 7) % 7 || 7;
    return plus(w.startsWith("next ") && ahead < 7 ? ahead + 7 : ahead);
  }
  return null;
}

const nice = (d: string | null | undefined) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "no date");

/** The Asana comment a change leaves, naming who made it from the OS (the token is shared), or null when nothing changed */
export function changeNote(p: AsanaPatch, before: Pick<TaskDetail, "due" | "start" | "name" | "section" | "completed"> | null, who: string): string | null {
  const bits: string[] = [];
  if (p.due !== undefined && p.due !== before?.due) bits.push(`Due date moved to ${nice(p.due)}`);
  if (p.start !== undefined && p.start !== before?.start) bits.push(`Start date set to ${nice(p.start)}`);
  if (p.name !== undefined && p.name !== before?.name) bits.push("Renamed");
  if (p.notes !== undefined) bits.push("Description edited");
  if (p.completed !== undefined && p.completed !== before?.completed) bits.push(p.completed ? "Marked complete" : "Reopened");
  if (p.assignee !== undefined) bits.push(`Reassigned${p.assigneeName ? ` to ${p.assigneeName}` : ""}`);
  if (p.sectionName && p.sectionName !== before?.section?.name) bits.push(`Moved to ${p.sectionName}`);
  if (p.fields && Object.keys(p.fields).length) bits.push(`${Object.keys(p.fields).length === 1 ? "A field" : "Fields"} updated`);
  return bits.length ? `${bits.join("; ")} by ${who} via Kaizen OS` : null;
}

/** "Overdue", "Today", "Tomorrow", "Nov 24", "No date" */
export function dueLabel(due: string | null, today: string): { text: string; late: boolean } {
  if (!due) return { text: "No date", late: false };
  if (due < today) return { text: `Overdue · ${nice(due)}`, late: true };
  if (due === today) return { text: "Today", late: false };
  const t = new Date(`${today}T12:00:00Z`);
  if (due === new Date(t.getTime() + 86_400_000).toISOString().slice(0, 10)) return { text: "Tomorrow", late: false };
  return { text: nice(due), late: false };
}
