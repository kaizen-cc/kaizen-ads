import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { changeKey } from "@/lib/account-changes";

// Everything done on an account in a report's period, from every place it shows up: changes in the ad account (its
// change history, and changes applied from Kaizen Ads), the sprint's moves, audits, creative made and in production,
// what was said on calls, in Slack and email, and docs written. The report turns it into "what we did, what we're
// doing and why, what's next", so the client sees the work behind the numbers.

type Target = { id: string; client_id: string; platform: string; ad_account_id: string | null };

const day = (iso: string) => String(iso).slice(0, 10);
const clip = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export async function workDone(admin: SupabaseClient, t: Target, start: string, end: string) {
  const from = `${start}T00:00:00-05:00`;
  const to = `${end}T23:59:59-05:00`;
  const account = t.ad_account_id ? changeKey(t.platform, String(t.ad_account_id)) : null;
  const [changes, applied, sprint, audits, made, making, talk, promises] = await Promise.all([
    account ? admin.from("ad_account_changes").select("at, who, what, object").eq("ad_account_id", account).gte("at", from).lte("at", to).order("at").limit(200) : Promise.resolve({ data: [] }),
    admin.from("ad_changes").select("title, ops, applied_at, status").eq("target_id", t.id).in("status", ["applied", "partial"]).gte("applied_at", from).lte("applied_at", to),
    admin.from("optimization_sprints").select("id, status, started_at, sprint_actions(title, status, when, why, note, done_at)").eq("target_id", t.id).order("started_at", { ascending: false }).limit(2),
    admin.from("account_audits").select("created_at, result").eq("target_id", t.id).eq("status", "ready").gte("created_at", from).lte("created_at", to),
    admin.from("asana_tasks").select("name, format, section, completed_at, platform").eq("client_id", t.client_id).gte("completed_at", from).lte("completed_at", to).limit(60),
    admin.from("asana_tasks").select("name, format, section, platform").eq("client_id", t.client_id).eq("open", true).limit(60),
    admin.from("context_items").select("source, occurred_at, author, title, body").eq("client_id", t.client_id).in("source", ["call", "slack_external", "slack_internal", "gmail", "docs"]).gte("occurred_at", from).lte("occurred_at", to).order("occurred_at").limit(120),
    admin.from("call_commitments").select("what, status, due_at").eq("client_id", t.client_id).in("status", ["open", "briefed"]).limit(15),
  ]);

  const platformWord = t.platform === "google" ? "Google" : "Meta";
  const sprintNow = (sprint.data ?? [])[0] as { status: string; sprint_actions: { title: string; status: string; when: string | null; why: string | null; note: string | null; done_at: string | null }[] } | undefined;
  const moves = sprintNow?.sprint_actions ?? [];
  const doneMoves = moves.filter((m) => m.status === "done" && m.done_at && m.done_at >= from && m.done_at <= to);
  const openMoves = moves.filter((m) => m.status === "todo" || m.status === "doing");
  const onPlatform = (p: string | null) => !p || new RegExp(platformWord, "i").test(p);

  // The account's own change log, grouped (twenty budget edits read as one line, not twenty)
  const grouped = new Map<string, { n: number; objects: Set<string>; first: string; last: string }>();
  for (const c of (changes.data ?? []) as { at: string; who: string | null; what: string; object: string | null }[]) {
    const g = grouped.get(c.what) ?? { n: 0, objects: new Set<string>(), first: c.at, last: c.at };
    g.n++;
    if (c.object) g.objects.add(c.object);
    g.last = c.at;
    grouped.set(c.what, g);
  }

  const lines = [
    `<changes_in_the_${platformWord.toLowerCase()}_account count="${(changes.data ?? []).length}">`,
    ...[...grouped.entries()].map(([what, g]) => `- ${what} ×${g.n}${g.objects.size ? ` (${[...g.objects].slice(0, 5).join("; ")}${g.objects.size > 5 ? "…" : ""})` : ""}, ${day(g.first)}${g.first !== g.last ? ` to ${day(g.last)}` : ""}`),
    `</changes_in_the_${platformWord.toLowerCase()}_account>`,
    `<changes_applied_from_kaizen_ads>`,
    ...((applied.data ?? []) as { title: string; applied_at: string }[]).map((a) => `- ${day(a.applied_at)}: ${a.title}`),
    `</changes_applied_from_kaizen_ads>`,
    `<optimization_sprint>`,
    ...doneMoves.map((m) => `- DONE ${day(m.done_at!)}: ${m.title}${m.note ? ` (${clip(m.note, 160)})` : ""}`),
    ...openMoves.map((m) => `- ${m.status === "doing" ? "IN PROGRESS" : "NEXT"}${m.when ? ` (${m.when.replace("_", " ")})` : ""}: ${m.title}${m.why ? `. Why: ${clip(m.why, 200)}` : ""}`),
    `</optimization_sprint>`,
    ...((audits.data ?? []) as { created_at: string; result: { verdict?: { headline?: string } } | null }[]).map((a) => `<audit date="${day(a.created_at)}">${a.result?.verdict?.headline ?? ""}</audit>`),
    `<creative_delivered>`,
    ...((made.data ?? []) as { name: string; completed_at: string; platform: string | null }[]).filter((x) => onPlatform(x.platform)).map((x) => `- ${day(x.completed_at)}: ${clip(x.name, 120)}`),
    `</creative_delivered>`,
    `<creative_in_production>`,
    ...((making.data ?? []) as { name: string; section: string | null; platform: string | null }[]).filter((x) => onPlatform(x.platform)).map((x) => `- ${clip(x.name, 120)} (${x.section ?? "in progress"})`),
    `</creative_in_production>`,
    `<promises_in_motion>`,
    ...((promises.data ?? []) as { what: string; status: string; due_at: string }[]).map((p) => `- ${p.what} (${p.status}, due ${day(p.due_at)})`),
    `</promises_in_motion>`,
    `<said_this_period>`,
    ...((talk.data ?? []) as { source: string; occurred_at: string; author: string | null; title: string | null; body: string | null }[]).map(
      (i) => `- ${day(i.occurred_at)} [${i.source === "slack_external" ? "client channel" : i.source === "slack_internal" ? "internal Slack" : i.source}${i.author ? `, ${i.author}` : ""}] ${clip(i.title, 80)}${i.title ? ": " : ""}${clip(i.body, 400)}`,
    ),
    `</said_this_period>`,
  ];
  return {
    text: lines.join("\n"),
    counts: {
      accountChanges: (changes.data ?? []).length,
      applied: (applied.data ?? []).length,
      sprintDone: doneMoves.length,
      sprintOpen: openMoves.length,
      creativeDelivered: ((made.data ?? []) as { platform: string | null }[]).filter((x) => onPlatform(x.platform)).length,
      creativeInProduction: ((making.data ?? []) as { platform: string | null }[]).filter((x) => onPlatform(x.platform)).length,
      audits: (audits.data ?? []).length,
    },
  };
}

/** How this buyer writes to clients: their recent recaps in client channels (this client's first), as examples. */
export async function voiceOf(admin: SupabaseClient, buyerName: string | null, clientId: string) {
  if (!buyerName) return "";
  const first = buyerName.split(" ")[0];
  const { data } = await admin
    .from("context_items")
    .select("client_id, occurred_at, body")
    .eq("source", "slack_external")
    .ilike("author", `${first}%`)
    .order("occurred_at", { ascending: false })
    .limit(60);
  const long = (data ?? []).filter((m) => (m.body ?? "").length > 350);
  const picked = [...long.filter((m) => m.client_id === clientId).slice(0, 2), ...long.filter((m) => m.client_id !== clientId).slice(0, 2)].slice(0, 3);
  if (!picked.length) return "";
  return `<how_${first.toLowerCase()}_writes_to_clients>\n${picked.map((m) => `<example date="${day(m.occurred_at)}">\n${(m.body ?? "").slice(0, 2500)}\n</example>`).join("\n")}\n</how_${first.toLowerCase()}_writes_to_clients>`;
}
