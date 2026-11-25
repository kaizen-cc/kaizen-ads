import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { DONE_MEANS, guard, type Evidence, type Verdict } from "@/lib/done-check-core";
import { isPeopleMatter } from "@/lib/people-matters";

// The general done-check (the owner, Nov 20 2026): every open item on anyone's Today or Overview that a message can
// settle (tracking not set up, watchdog flags, tracking requests and tasks sent between people, onboarding blockers,
// creatives stuck on the Asana board, Asana tasks) is read against what was said about its client after it opened (the
// client's internal and external Slack, Gmail with their contacts, call and Gemini meeting notes) and classified done,
// moving or nothing by one cheap model, the same way promises are followed (src/lib/message-promises.ts). Done closes
// it for everyone and writes the real state back to its source, with the quote kept as evidence and a one-tap Reopen.
// Precision first: the guardrails in ./done-check-core.ts.

type Admin = SupabaseClient;
export type Checkable = { key: string; kind: string; clientId: string; ownerId: string | null; title: string; client: string; since: string; meta?: Record<string, unknown> };

const DAY = 86_400_000;
const todayNY = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** Everything open that a message could settle, across every role */
export async function openCheckables(admin: Admin): Promise<Checkable[]> {
  const out: Checkable[] = [];
  const { data: clients } = await admin.from("clients").select("id, name, created_at").is("archived_at", null).limit(3000);
  const nameOf = new Map((clients ?? []).map((c) => [c.id as string, c.name as string]));
  const createdOf = new Map((clients ?? []).map((c) => [c.id as string, c.created_at as string]));
  const { data: tracker } = await admin.from("profiles").select("id").eq("is_active", true).eq("role", "tracking_specialist").limit(1);
  const trackerId = (tracker?.[0]?.id as string | undefined) ?? null;
  // Tracking not set up (the Tracking tab and their day)
  const { trackingHealth } = await import("@/lib/tracking-health");
  for (const r of await trackingHealth(admin).catch(() => [])) {
    if (r.health.status === "not_set_up" || r.health.why.some((w) => w.startsWith("Tracking not set up"))) out.push({
        key: `notrack:${r.clientId}`,
        kind: "notrack",
        clientId: r.clientId,
        ownerId: trackerId,
        title: "Tracking not set up",
        client: r.client,
        // A state, not an event: the client's whole history counts (from when they joined, at least 180 days back)
        since: new Date(Math.min(Date.parse(createdOf.get(r.clientId) ?? new Date().toISOString()), Date.now() - 180 * DAY)).toISOString(),
      });
  }
  const [{ data: flags }, { data: asks }, { data: tasks }] = await Promise.all([
    admin.from("watch_flags").select("id, kind, client_id, title, opened_at").is("resolved_at", null).not("client_id", "is", null).limit(800),
    admin.from("agent_asks").select("id, client_id, owner_id, asked_by, title, created_at, source_ref").eq("status", "open").not("client_id", "is", null).limit(2000),
    admin.from("asana_tasks").select("gid, name, client_id, profile_id, stage, due_on, asana_created_at, moves").eq("open", true).not("client_id", "is", null).not("profile_id", "is", null).limit(1500),
  ]);
  for (const f of flags ?? []) out.push({ key: `dog:${f.id}`, kind: "dog", clientId: f.client_id as string, ownerId: null, title: f.title as string, client: nameOf.get(f.client_id as string) ?? "Client", since: f.opened_at as string, meta: { flagKind: f.kind } });
  // Every open item, every role (owner, Nov 24 2026): meeting and call tasks, routine items, reminders on a client
  // Read from where it started, not when the item was made (Nov 25 2026: a Slack ask filed 11 hours after the owner had
  // already replied "I've just given you access" in its thread stayed open): the message or call it came from
  const origin = await originsOf(admin, (asks ?? []).map((a) => String(a.source_ref ?? "")));
  for (const a of asks ?? []) {
    const from = origin.get(String(a.source_ref ?? ""));
    const since = from && from < String(a.created_at) ? from : (a.created_at as string);
    out.push({ key: `ask:${a.id}`, kind: "ask", clientId: a.client_id as string, ownerId: a.owner_id as string, title: a.title as string, client: nameOf.get(a.client_id as string) ?? "Client", since });
  }
  for (const t of tasks ?? []) {
    const stage = String(t.stage ?? "");
    const kind = stage === "copy" ? "stuck_copy" : stage === "client_review" ? "stuck_client" : "asana";
    out.push({ key: kind === "asana" ? `mine:asana:${t.gid}` : `stuck:${t.gid}`, kind, clientId: t.client_id as string, ownerId: t.profile_id as string, title: t.name as string, client: nameOf.get(t.client_id as string) ?? "Client", since: (t.asana_created_at as string) ?? new Date(Date.now() - 14 * DAY).toISOString(), meta: { gid: t.gid } });
  }
  // Onboarding blockers (intake, call, assets)
  const { data: onboarding } = await admin.from("clients").select("id, name, created_at, reonboarded_at").is("archived_at", null).eq("status", "onboarding");
  if (onboarding?.length) {
    const { onboardingBlockers } = await import("@/lib/support-day-core");
    const ids = onboarding.map((c) => c.id as string);
    const [{ data: forms }, { data: calls }, { data: ob }, { data: assets }] = await Promise.all([
      admin.from("client_intake_forms").select("client_id, submitted_at").in("client_id", ids),
      admin.from("client_calls").select("client_id, occurred_at").in("client_id", ids).limit(2000),
      admin.from("client_onboarding").select("client_id, call_checked_at, call_prep").in("client_id", ids),
      admin.from("client_assets").select("client_id, created_at").in("client_id", ids).order("created_at", { ascending: false }).limit(5000),
    ]);
    for (const c of onboarding) {
      const start = (c.reonboarded_at ?? c.created_at) as string;
      const o = (ob ?? []).find((x) => x.client_id === c.id);
      for (const b of onboardingBlockers({ start, today: todayNY(), intakeAt: ((forms ?? []).find((f) => f.client_id === c.id && f.submitted_at)?.submitted_at as string | undefined) ?? null, callBooked: (calls ?? []).some((x) => x.client_id === c.id && String(x.occurred_at) >= start) || Boolean(o?.call_checked_at || o?.call_prep), lastAssetAt: ((assets ?? []).find((a) => a.client_id === c.id && String(a.created_at) >= start)?.created_at as string | undefined) ?? null, quietDays: 7 }))
        out.push({ key: `onboard:${c.id}:${b.kind}`, kind: `onboard_${b.kind}`, clientId: c.id as string, ownerId: null, title: b.title, client: c.name as string, since: start });
    }
  }
  return out;
}

/** When each item's source happened: a Slack message (deleg:<context item>), a call (routine:call:<call>) */
async function originsOf(admin: Admin, refs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const { originIds } = await import("@/lib/done-check-core");
  const { ctx, calls } = originIds(refs);
  for (let i = 0; i < ctx.length; i += 200) {
    const { data } = await admin.from("context_items").select("id, occurred_at").in("id", ctx.slice(i, i + 200));
    for (const r of data ?? []) for (const ref of refs) if (ref.startsWith(`deleg:${r.id}:`)) out.set(ref, String(r.occurred_at));
  }
  for (let i = 0; i < calls.length; i += 200) {
    const { data } = await admin.from("client_calls").select("id, occurred_at").in("id", calls.slice(i, i + 200));
    for (const r of data ?? []) for (const ref of refs) if (ref.startsWith(`routine:call:${r.id}:`)) out.set(ref, String(r.occurred_at));
  }
  return out;
}

/** Words a message about tracking uses, for filtering in the query (ilike) */
const TRACKING_LIKE = ["tracking", "tracked", "pixel", "capi", "conversion api", "conversions api", "gtm", "tag manager", "ga4", "google analytics", "conversion", "purchase event", "thank you page", "thank-you page", "events firing"];

/**
 * What was said about a client after `since`: their Slack (ours and theirs), Gmail, call and Gemini notes. A tracking
 * item reads only the messages about tracking (filtered in the query, so a busy client's older confirmation isn't lost
 * under newer chatter), across its whole window; anything else reads the last 60 days, the messages about its subject
 * first, then the newest.
 */
async function evidenceFor(admin: Admin, clientId: string, since: string, about: RegExp | null, tracking: boolean): Promise<Evidence[]> {
  const sel = "source, occurred_at, author, title, body, url";
  let rows: { source: string; occurred_at: string; author: string | null; title: string | null; body: string | null; url: string | null }[];
  if (tracking) {
    const or = TRACKING_LIKE.map((w) => `body.ilike.%${w}%`).join(",");
    const { data } = await admin.from("context_items").select(sel).eq("client_id", clientId).in("source", ["slack_internal", "slack_external", "gmail", "call"]).gte("occurred_at", since).or(or).order("occurred_at", { ascending: false }).limit(30);
    rows = (data ?? []) as typeof rows;
  } else {
    const from = new Date(Math.max(Date.parse(since), Date.now() - 60 * DAY)).toISOString();
    const { data } = await admin.from("context_items").select(sel).eq("client_id", clientId).in("source", ["slack_internal", "slack_external", "gmail", "call"]).gte("occurred_at", from).order("occurred_at", { ascending: false }).limit(200);
    const all = (data ?? []) as typeof rows;
    rows = about ? [...all.filter((d) => about.test(`${d.title ?? ""} ${d.body ?? ""}`)), ...all.filter((d) => !about.test(`${d.title ?? ""} ${d.body ?? ""}`))].slice(0, 30) : all.slice(0, 30);
  }
  let n = 0;
  return rows.map((d) => ({ n: ++n, at: d.occurred_at, source: d.source, author: d.author ?? null, text: `${d.title ? `${d.title}: ` : ""}${String(d.body ?? "")}`.replace(/\s+/g, " ").slice(0, 700), url: d.url ?? null }));
}

/** The Tracking Specialist's names (full and first), to mark their own messages in the evidence */
let trackerNames: { at: number; names: string[] } | null = null;
async function trackingNames(admin: Admin): Promise<string[]> {
  if (trackerNames && Date.now() - trackerNames.at < 600_000) return trackerNames.names;
  const { data } = await admin.from("profiles").select("full_name, display_name, email").eq("is_active", true).eq("role", "tracking_specialist");
  const names = (data ?? []).flatMap((p) => [p.full_name, p.display_name, p.email, String(p.full_name ?? "").split(" ")[0]].filter((x): x is string => Boolean(x && String(x).length > 2)).map((x) => String(x).toLowerCase()));
  trackerNames = { at: Date.now(), names };
  return names;
}

const SCHEMA = {
  type: "object",
  properties: { state: { type: "string", enum: ["done", "moving", "nothing"] }, quote: { type: "string" }, evidence: { type: ["integer", "null"] }, sure: { type: "boolean" } },
  required: ["state", "quote", "evidence", "sure"],
  additionalProperties: false,
};

/** One item, read against its client's messages since it opened */
export async function classify(admin: Admin, item: Checkable): Promise<{ verdict: Verdict; ev: Evidence | null } | null> {
  const { subjectOf, STATE_KINDS } = await import("@/lib/done-check-core");
  const isState = STATE_KINDS.has(item.kind);
  const tracking = item.kind === "notrack" || (item.kind === "dog" && /track|pixel|capi|conversion|ga4|gtm/i.test(item.title));
  const evidence = await evidenceFor(admin, item.clientId, item.since, subjectOf(item.kind, item.title), tracking);
  const trackers = tracking ? await trackingNames(admin) : [];
  const byTracker = (a: string | null) => Boolean(a && trackers.some((t) => a.toLowerCase().includes(t)));
  if (!evidence.length) return { verdict: { state: "nothing", quote: "", evidence: null, sure: true }, ev: null };
  const means = DONE_MEANS[item.kind] ?? "it's done";
  try {
    const out = await askJson<Verdict>({
      agent: "calls",
      label: "done check",
      bare: true,
      clientId: item.clientId,
      override: { model: "haiku", effort: "low" },
      maxTokens: 600,
      system:
        `You check whether a piece of work is finished, from what the team and the client said afterwards. done: a message says plainly that it IS finished now ("tracking is set up and verified", "Tracking fixed", "tracking is ready", "the pixel is now working", "tracking is working fine", "tracking is not broken, we tested it and it's ok", "CAPI is live", "sent the report", "got the intake", "assets are uploaded"), about this client and this thing. moving: someone is on it, or it's partly there, planned, or said with any doubt. nothing: no sign. When unsure, never say done: say moving.${isState ? " This is a state, so the LATEST relevant message wins: if the newest message about it says it's fixed, set up, working or tested ok, it's done; if a newer message says it's broken again, it's moving. Messages marked (Tracking Specialist) are from the person who owns tracking: their word that it's fixed or working counts strongly." : ""} quote: the exact words from ONE message that show it, copied as written (empty for nothing). evidence: that message's number. sure: true only when the quote leaves no doubt.`,
      schema: SCHEMA,
      prompt: `Client: ${item.client}\nThe work: ${item.title}\nDone means: ${means}\nOpened: ${item.since.slice(0, 10)}\n\nWhat was said since (newest first):\n${evidence.map((e) => `${e.n}. [${e.at.slice(0, 10)} · ${e.source}${e.author ? ` · ${e.author}${byTracker(e.author) ? " (Tracking Specialist)" : ""}` : ""}] ${e.text}`).join("\n")}`,
    });
    const g = guard(out, evidence, item.since, { latestWins: isState });
    const { mayAutoClose } = await import("@/lib/done-check-core");
    const v = g.state === "done" && !mayAutoClose(item.title) ? { ...g, state: "moving" as const } : g;
    // Tracking is a state with plain words for "it's working", so a fixed rule decides it, not the model: the newest plain
    // confirmation (no plan, condition or negation) closes it unless something later says it broke, and a model's "done"
    // that the rule doesn't find stays moving (src/lib/done-check-core.ts stateConfirmed)
    if (tracking) {
      const { stateConfirmed } = await import("@/lib/done-check-core");
      const hit = stateConfirmed(evidence);
      if (hit) return { verdict: { state: "done", quote: hit.quote, evidence: hit.ev.n, sure: true }, ev: hit.ev };
      if (v.state === "done") return { verdict: { ...v, state: "moving" }, ev: null };
    }
    return { verdict: v, ev: v.evidence != null ? (evidence.find((e) => e.n === v.evidence) ?? null) : null };
  } catch (e) {
    console.error("[done-check]", item.key, e instanceof Error ? e.message : e);
    return null;
  }
}

/** Writes "done" back to where the item lives; returns what to restore on a reopen */
async function writeBack(admin: Admin, item: Checkable, note: string, at: string): Promise<Record<string, unknown> | null> {
  if (item.kind === "notrack") {
    const { data } = await admin.from("client_onboarding").select("tracking").eq("client_id", item.clientId).maybeSingle();
    const prev = (data?.tracking as Record<string, unknown> | null) ?? null;
    await admin.from("client_onboarding").upsert({ client_id: item.clientId, tracking: { ...(prev ?? {}), status: "done", at, by: "Kaizen OS (closed automatically)", note }, updated_at: at }, { onConflict: "client_id" });
    return { tracking: prev };
  }
  if (item.kind === "dog") {
    await admin.from("watch_flags").update({ resolved_at: at, resolution: note.slice(0, 500) }).eq("id", item.key.slice(4)).is("resolved_at", null);
    return { flag: true };
  }
  if (item.kind === "ask") {
    await admin.from("agent_asks").update({ status: "done", done_at: at }).eq("id", item.key.slice(4)).eq("status", "open");
    return { ask: true };
  }
  if (item.kind === "asana" && item.meta?.gid) {
    const gid = String(item.meta.gid);
    const { asanaConfigured, asanaUpdate, asanaWrite } = await import("@/lib/asana");
    if (asanaConfigured()) {
      await asanaUpdate(`/tasks/${gid}`, { completed: true });
      await asanaWrite(`/tasks/${gid}/stories`, { text: `${note} Completed by Kaizen OS; reopen it in Kaizen OS or here if that's wrong.` }).catch(() => null);
    }
    await admin.from("asana_tasks").update({ open: false, completed_at: at }).eq("gid", gid);
    return { asana: gid };
  }
  // Onboarding blockers and stuck creatives: closed off everyone's day (done_checks), the source left as it is
  return {};
}

/** One pass: the items due a check (new, ingested-for, or not checked for an hour), oldest first, within a budget */
export type CheckResult = { key: string; kind: string; client: string; title: string; state: "done" | "moving" | "nothing"; quote: string; source: string | null; link: string | null; at: string | null };

export async function runDoneChecks(admin: Admin, opts: { budget?: number; onlyKeys?: string[]; clientIds?: string[]; force?: boolean; staleHours?: number } = {}): Promise<{ checked: number; closed: number; moving: number; byKind: Record<string, number>; examples: { key: string; note: string }[]; results: CheckResult[] }> {
  const { closedNote } = await import("@/lib/done-check-core");
  let items = await openCheckables(admin);
  if (opts.onlyKeys) items = items.filter((i) => opts.onlyKeys!.includes(i.key));
  if (opts.clientIds) items = items.filter((i) => opts.clientIds!.includes(i.clientId));
  const { data: rows } = await admin.from("done_checks").select("key, checked_at, closed_at, reopened_at, due").in("key", items.map((i) => i.key).slice(0, 3000));
  const by = new Map((rows ?? []).map((r) => [r.key as string, r]));
  const hourAgo = Date.now() - (opts.staleHours ?? 1) * 3_600_000;
  // Priority: tracking first (the owner's ask), then never checked, then due after new messages, then the oldest check
  const order = (i: Checkable) => (i.kind === "notrack" ? 0 : i.kind === "dog" ? 1 : 2);
  const due = items
    .filter((i) => {
      const r = by.get(i.key);
      if (r?.closed_at && !r.reopened_at) return false;
      // Asked for now (someone's assistant): no waiting for the hourly turn
      return opts.force || !r || r.due || !r.checked_at || Date.parse(r.checked_at as string) < hourAgo;
    })
    .sort((a, b) => order(a) - order(b) || String(by.get(a.key)?.checked_at ?? "").localeCompare(String(by.get(b.key)?.checked_at ?? "")))
    .slice(0, opts.budget ?? 60);
  const tally = { checked: 0, closed: 0, moving: 0, byKind: {} as Record<string, number>, examples: [] as { key: string; note: string }[], results: [] as CheckResult[] };
  // Read four at a time (each is one small model call)
  const results = new Map<string, Awaited<ReturnType<typeof classify>>>();
  for (let i = 0; i < due.length; i += 4) {
    const chunk = due.slice(i, i + 4);
    const got = await Promise.all(
      chunk.map((item) => {
        const r = by.get(item.key);
        // After a reopen, only what was said since the reopen counts
        const since = r?.reopened_at && Date.parse(r.reopened_at as string) > Date.parse(item.since) ? (r.reopened_at as string) : item.since;
        return classify(admin, { ...item, since });
      }),
    );
    chunk.forEach((item, n) => results.set(item.key, got[n]));
  }
  for (const item of due) {
    const res = results.get(item.key);
    if (!res) continue;
    tally.checked++;
    const now = new Date().toISOString();
    tally.results.push({ key: item.key, kind: item.kind, client: item.client, title: item.title, state: res.verdict.state === "done" && !res.ev ? "moving" : res.verdict.state, quote: res.verdict.quote, source: res.ev?.source ?? null, link: res.ev?.url ?? null, at: res.ev?.at ?? null });
    const base = { key: item.key, kind: item.kind, client_id: item.clientId, owner_id: item.ownerId, title: item.title.slice(0, 300), client_name: item.client, state: res.verdict.state, quote: (isPeopleMatter(res.verdict.quote) ? "" : res.verdict.quote).slice(0, 1000), source: res.ev?.source ?? null, link: res.ev?.url ?? null, said_at: res.ev?.at ?? null, checked_at: now, due: false };
    if (res.verdict.state === "done" && res.ev) {
      const note = closedNote(res.verdict.quote, res.ev.source, res.ev.at);
      const prev = await writeBack(admin, item, note, now).catch((e) => {
        console.error("[done-check] write-back", item.key, e instanceof Error ? e.message : e);
        return null;
      });
      if (prev === null) continue;
      await admin.from("done_checks").upsert({ ...base, closed_at: now, reopened_at: null, prev }, { onConflict: "key" });
      tally.closed++;
      tally.byKind[item.kind] = (tally.byKind[item.kind] ?? 0) + 1;
      if (tally.examples.length < 8) tally.examples.push({ key: `${item.client}: ${item.title}`, note });
    } else {
      if (res.verdict.state === "moving") tally.moving++;
      await admin.from("done_checks").upsert(base, { onConflict: "key" });
    }
  }
  if (tally.closed) await (await import("@/lib/item-state")).reviewsChanged().catch(() => null);
  return tally;
}

/** New messages came in for these clients: their items are due a check on the next pass */
export async function markClientsDue(admin: Admin, clientIds: string[]) {
  const ids = [...new Set(clientIds.filter(Boolean))];
  if (!ids.length) return;
  await admin.from("done_checks").update({ due: true }).in("client_id", ids.slice(0, 500)).is("closed_at", null);
}

/** Reopen: the item comes back for everyone and its source goes back to how it was */
export async function reopen(admin: Admin, key: string, by: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: r } = await admin.from("done_checks").select("key, kind, client_id, prev, closed_at, reopened_at").eq("key", key).maybeSingle();
  if (!r?.closed_at || r.reopened_at) return { ok: false, error: "That wasn't closed automatically (or it's already reopened)." };
  const prev = (r.prev ?? {}) as Record<string, unknown>;
  const now = new Date().toISOString();
  if (r.kind === "notrack") await admin.from("client_onboarding").update({ tracking: prev.tracking ?? {}, updated_at: now }).eq("client_id", r.client_id);
  if (r.kind === "dog") await admin.from("watch_flags").update({ resolved_at: null, resolution: null }).eq("id", String(r.key).slice(4));
  if (r.kind === "ask") await admin.from("agent_asks").update({ status: "open", done_at: null }).eq("id", String(r.key).slice(4));
  if (r.kind === "asana" && prev.asana) {
    const { asanaConfigured, asanaUpdate } = await import("@/lib/asana");
    const { asanaAsPerson, hasMyAsana } = await import("@/lib/asana-user");
    if (asanaConfigured() && !(await hasMyAsana(admin, by))) {
      const { ASANA_CONNECT_SAY } = await import("@/lib/asana-connect");
      return { ok: false, error: ASANA_CONNECT_SAY };
    }
    if (asanaConfigured()) await asanaAsPerson(admin, by, () => asanaUpdate(`/tasks/${String(prev.asana)}`, { completed: false })).catch(() => null);
    await admin.from("asana_tasks").update({ open: true, completed_at: null }).eq("gid", String(prev.asana));
  }
  await admin.from("done_checks").update({ reopened_at: now, reopened_by: by, state: "moving" }).eq("key", key);
  await (await import("@/lib/item-state")).reviewsChanged().catch(() => null);
  return { ok: true };
}

export type AutoClosed = { key: string; kind: string; client: string | null; title: string; quote: string; source: string | null; link: string | null; saidAt: string | null; closedAt: string };

/** What closed itself lately that this person would have seen (their own, their role's, or everything for execs) */
export async function recentAutoClosed(db: SupabaseClient, me: { id: string; role: string; isExec: boolean }, days = 3): Promise<AutoClosed[]> {
  let q = db.from("done_checks").select("key, kind, client_name, title, quote, source, link, said_at, closed_at").not("closed_at", "is", null).is("reopened_at", null).gte("closed_at", new Date(Date.now() - days * DAY).toISOString()).order("closed_at", { ascending: false }).limit(30);
  if (!me.isExec) q = me.role === "tracking_specialist" ? q.or(`owner_id.eq.${me.id},kind.in.(notrack,dog)`) : q.eq("owner_id", me.id);
  const { data } = await q;
  return (data ?? []).map((r) => ({ key: r.key as string, kind: r.kind as string, client: (r.client_name as string | null) ?? null, title: r.title as string, quote: r.quote as string, source: (r.source as string | null) ?? null, link: (r.link as string | null) ?? null, saidAt: (r.said_at as string | null) ?? null, closedAt: r.closed_at as string }));
}

/** Keys closed automatically and not reopened, of these */
export async function closedKeys(db: SupabaseClient, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const { data } = await db.from("done_checks").select("key").in("key", keys.slice(0, 1000)).not("closed_at", "is", null).is("reopened_at", null);
  return new Set((data ?? []).map((r) => r.key as string));
}
