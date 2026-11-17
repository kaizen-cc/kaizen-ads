// The email account's change history, worked out from what the provider's API shows. Klaviyo has no public audit log,
// so this is the closest honest signal: each campaign, flow, flow step, template, list, segment and form carries when it
// was created and last updated, and its status. Comparing one read with the last says what happened in between: a
// campaign created, edited, scheduled or sent, a flow switched live, an email in a flow edited, a form published.
// Several edits between two reads show as one (the latest time), and nothing says who made them. Pure, so it is
// tested without the network or the database.

export type ChangeObject = "campaign" | "flow" | "flow_step" | "template" | "list" | "segment" | "form";
export type ChangeKind = "created" | "edited" | "scheduled" | "sent" | "status" | "published" | "removed";

/** One thing in the account as a read saw it */
export type ObjectSnap = {
  type: ChangeObject;
  id: string;
  name: string;
  status: string | null;
  created: string | null;
  updated: string | null;
  /** Campaigns: when it went out (or is set to) */
  sentAt?: string | null;
  scheduledAt?: string | null;
  /** Flow steps: the flow they sit in, and what kind of step (an email, an SMS, a delay) */
  parent?: string | null;
  step?: string | null;
};

export type ChangeEvent = {
  type: ChangeObject;
  objectId: string;
  name: string;
  kind: ChangeKind;
  /** "draft to live", or the day a campaign is scheduled for */
  detail: string | null;
  /** Flow steps: the flow they sit in and the kind of step */
  parent?: string | null;
  step?: string | null;
  at: string;
  /** False for what happens by itself once set up (a scheduled campaign going out) */
  manual: boolean;
  /** One event per change, however often the same read sees it */
  key: string;
};

/** What the last read left behind: each object's status, to compare the next read with */
export type ChangeState = { at: string; status: Record<string, string> };

const MIN = 60_000;
const lower = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const t = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const isSent = (status: string | null) => /^(sent|sending)/.test(lower(status));
const isScheduled = (status: string | null) => lower(status) === "scheduled";
const stateKey = (o: Pick<ObjectSnap, "type" | "id">) => `${o.type}:${o.id}`;
/** The most statuses kept between reads (the oldest campaigns go first) */
const MAX_STATE = 3000;

/**
 * The events between the last read (`prev`, null on the first) and this one. `since` is how far back created and
 * edited times count (the last read, with some overlap; a month on the first read). `complete` names the kinds whose
 * listing is whole (every flow, not only the recently updated campaigns): one of those missing from this read was
 * removed or archived.
 */
export function diffChanges(objects: ObjectSnap[], prev: ChangeState | null, opts: { since: string; now: string; complete?: ChangeObject[] }): { events: ChangeEvent[]; state: ChangeState } {
  const since = t(opts.since);
  const now = t(opts.now);
  const inWindow = (iso: string | null | undefined) => {
    const x = t(iso);
    return Number.isFinite(x) && x >= since && x <= now + 5 * MIN;
  };
  const events: ChangeEvent[] = [];
  const add = (o: ObjectSnap, kind: ChangeKind, at: string, detail: string | null, keyTail: string, manual = true) =>
    events.push({ type: o.type, objectId: o.id, name: o.name, kind, detail, at, manual, key: `${o.type}:${o.id}:${kind}${keyTail ? `:${keyTail}` : ""}`, ...(o.type === "flow_step" ? { parent: o.parent ?? null, step: o.step ?? null } : {}) });

  for (const o of objects) {
    const was = prev?.status[stateKey(o)];
    const created = t(o.created);
    const updated = t(o.updated);
    if (inWindow(o.created)) add(o, "created", o.created!, null, "");

    // A status that moved since the last read (only known from the second read on)
    let statusEvent = false;
    if (was !== undefined && lower(was) !== lower(o.status) && o.status) {
      const at = inWindow(o.updated) ? o.updated! : opts.now;
      if (o.type === "campaign") {
        // Going out is the "sent" event below; being scheduled is its own
        if (isScheduled(o.status)) {
          add(o, "scheduled", at, o.scheduledAt ?? o.sentAt ?? null, o.scheduledAt ?? o.sentAt ?? at);
          statusEvent = true;
        } else if (!isSent(o.status)) {
          add(o, "status", at, `${lower(was)} to ${lower(o.status)}`, `${lower(o.status)}:${at}`);
          statusEvent = true;
        }
      } else if (o.type === "form" && lower(o.status) === "live") {
        add(o, "published", at, null, at);
        statusEvent = true;
      } else {
        add(o, "status", at, `${lower(was)} to ${lower(o.status)}`, `${lower(o.status)}:${at}`);
        statusEvent = true;
      }
    } else if (was === undefined && o.type === "campaign" && isScheduled(o.status) && inWindow(o.updated)) {
      // First sight of a scheduled campaign: scheduling is what bumped its updated time
      add(o, "scheduled", o.updated!, o.scheduledAt ?? o.sentAt ?? null, o.scheduledAt ?? o.sentAt ?? o.updated!);
      statusEvent = true;
    }

    // An edit: updated after it was created (not the creation itself), and not what a status change or a send bumped
    if (!statusEvent && inWindow(o.updated) && (!Number.isFinite(created) || updated - created > 5 * MIN)) {
      const sent = t(o.sentAt);
      const bySend = o.type === "campaign" && isSent(o.status) && Number.isFinite(sent) && updated >= sent - 30 * MIN;
      if (!bySend) add(o, "edited", o.updated!, null, o.updated!);
    }

    // A campaign going out: it happens by itself once scheduled, so it is not counted as someone working
    if (o.type === "campaign" && isSent(o.status) && inWindow(o.sentAt)) add(o, "sent", o.sentAt!, null, "", false);
  }

  // Gone from a whole listing: removed or archived since the last read
  const seen = new Set(objects.map(stateKey));
  const complete = new Set(opts.complete ?? []);
  if (prev) {
    for (const k of Object.keys(prev.status)) {
      const [type, ...rest] = k.split(":");
      if (!complete.has(type as ChangeObject) || seen.has(k)) continue;
      const id = rest.join(":");
      events.push({ type: type as ChangeObject, objectId: id, name: prev.status[`name:${k}`] ?? id, kind: "removed", detail: null, at: opts.now, manual: true, key: `${k}:removed` });
    }
  }

  // The state carried forward: this read's statuses over the last read's (a partial listing keeps the ones it didn't see)
  const status: Record<string, string> = {};
  for (const [k, v] of Object.entries(prev?.status ?? {})) {
    const type = k.startsWith("name:") ? k.slice(5).split(":")[0] : k.split(":")[0];
    const base = k.startsWith("name:") ? k.slice(5) : k;
    if (complete.has(type as ChangeObject) && !seen.has(base)) continue;
    status[k] = v;
  }
  for (const o of objects) {
    if (o.status == null) continue;
    status[stateKey(o)] = o.status;
    if (complete.has(o.type)) status[`name:${stateKey(o)}`] = o.name;
  }
  const keys = Object.keys(status);
  if (keys.length > MAX_STATE) for (const k of keys.slice(0, keys.length - MAX_STATE)) delete status[k];

  events.sort((a, b) => b.at.localeCompare(a.at));
  return { events: dedupe(events), state: { at: opts.now, status } };
}

function dedupe(events: ChangeEvent[]): ChangeEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => (seen.has(e.key) ? false : (seen.add(e.key), true)));
}

const NOUN: Record<ChangeObject, string> = { campaign: "Campaign", flow: "Flow", flow_step: "Step", template: "Template", list: "List", segment: "Segment", form: "Form" };
const STEP: Record<string, string> = { send_email: "Email", send_sms: "SMS", time_delay: "Delay", conditional_split: "Split", trigger_split: "Split", ab_test: "A/B test", update_profile: "Profile update", send_webhook: "Webhook", send_push_notification: "Push" };
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

/** What kind of step a flow step is, in a word */
export const stepWord = (step: string | null | undefined) => STEP[lower(step)] ?? "Step";

/** One change in plain words: 'Flow "Welcome" set live (was draft)', 'Email in "Abandoned cart" edited' */
export function changeText(e: Pick<ChangeEvent, "type" | "name" | "kind" | "detail" | "parent" | "step">): string {
  const name = `"${e.name}"`;
  if (e.type === "flow_step") {
    const what = `${stepWord(e.step)} in ${e.parent ? `"${e.parent}"` : "a flow"}`;
    if (e.kind === "status") return `${what} set ${(e.detail ?? "").split(" to ")[1] ?? "to a new status"}`;
    return `${what} ${e.kind === "created" ? "added" : e.kind === "removed" ? "removed" : "edited"}`;
  }
  const noun = NOUN[e.type];
  switch (e.kind) {
    case "created":
      return `${noun} ${name} created`;
    case "edited":
      return `${noun} ${name} edited`;
    case "scheduled":
      return `${noun} ${name} scheduled${e.detail && Number.isFinite(Date.parse(e.detail)) ? ` for ${day(e.detail)}` : ""}`;
    case "sent":
      return `${noun} ${name} sent`;
    case "published":
      return `${noun} ${name} published`;
    case "removed":
      return `${noun} ${name} removed or archived`;
    case "status": {
      const [from, to] = (e.detail ?? "").split(" to ");
      if (e.type === "flow" && to) return `${noun} ${name} set ${to}${from ? ` (was ${from})` : ""}`;
      return `${noun} ${name} ${to ? `now ${to}${from ? ` (was ${from})` : ""}` : "status changed"}`;
    }
  }
}

/** The latest change someone made (a send going out by itself doesn't count) */
export function lastManual<T extends Pick<ChangeEvent, "manual" | "at">>(events: T[]): T | null {
  return events.filter((e) => e.manual).sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
}

/** "5h", "3 days": how long ago, from a clock given (so it is testable) */
export function agoShort(iso: string, now = Date.now()): string {
  const h = Math.max(0, Math.round((now - Date.parse(iso)) / 3_600_000));
  return h < 1 ? "under an hour" : h < 48 ? `${h}h` : `${Math.round(h / 24)} days`;
}

/** The changes as lines for an AI prompt, newest first: '- 2026-11-14 15:02 Flow "Welcome" set live (was draft)' */
export function changeLines(events: Pick<ChangeEvent, "type" | "name" | "kind" | "detail" | "parent" | "step" | "at" | "manual">[], max = 40): string[] {
  return [...events]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, max)
    .map((e) => `- ${e.at.slice(0, 16).replace("T", " ")} ${changeText(e)}${e.manual ? "" : " (went out by itself, as scheduled)"}`);
}

/** How many days in the window had at least one change someone made: a plain "is anyone working in it" number */
export function activeDays(events: Pick<ChangeEvent, "manual" | "at">[], fromIso: string): number {
  return new Set(events.filter((e) => e.manual && e.at >= fromIso).map((e) => new Date(e.at).toLocaleDateString("en-CA", { timeZone: "America/New_York" }))).size;
}
