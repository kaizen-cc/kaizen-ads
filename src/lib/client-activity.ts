import type { SupabaseClient } from "@supabase/supabase-js";

// What's been happening with a client, for every agent that talks or decides about them: tickets and where they
// stand, review comments (ours and the client's), approvals and copy changes, rule overrides and AI disagreements,
// the Bible's rules and answered questions, the execution plan and its tasks, ad account changes, replies we owe,
// promises from calls and the optimisation sprint. Newest first, dated, each part capped so the whole stays bounded.

const MAX_CHARS = 14000;
const day = (s: string | null | undefined) => (s ? s.slice(0, 10) : "");
const flat = (s: string | null | undefined, max = 240) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

type Q<T> = PromiseLike<{ data: T[] | null }>;
const rows = async <T>(q: Q<T>): Promise<T[]> => {
  try {
    return (await q).data ?? [];
  } catch {
    return [];
  }
};

/** The client's recent activity across the app, as one bounded block for the prompt ("" when there's nothing). */
export async function activityBlock(supabase: SupabaseClient, clientId: string): Promise<string> {
  type Req = { id: string; number: number | null; title: string; stage: string; stage_entered_at: string | null; stage_due_at: string | null; internal_rounds: number | null; client_rounds: number | null; created_at: string; launched_at: string | null };
  type Ev = { request_id: string; kind: string; from_stage: string | null; to_stage: string | null; body: string | null; data: Record<string, unknown> | null; created_at: string };
  type Com = { request_id: string | null; body: string; round: number | null; author_name: string | null; author_contact_id: string | null; severity: string | null; area: string | null; resolved_at: string | null; disagreed_at: string | null; disagree_reason: string | null; created_at: string };
  const [reqs, comments, overrides, disagreements, copySets, rules, questions, plan, tasks, changes, owed, promises, sprints] = await Promise.all([
    rows<Req>(
      supabase
        .from("board_requests")
        .select("id, number, title, stage, stage_entered_at, stage_due_at, internal_rounds, client_rounds, created_at, launched_at")
        .eq("client_id", clientId)
        .is("deleted_at", null)
        .or(`stage.neq.launched,launched_at.gte.${since(21).slice(0, 10)}`)
        .order("updated_at", { ascending: false })
        .limit(30),
    ),
    rows<Com>(
      supabase
        .from("review_comments")
        .select("request_id, body, round, author_name, author_contact_id, severity, area, resolved_at, disagreed_at, disagree_reason, created_at")
        .eq("client_id", clientId)
        .gte("created_at", since(45))
        .order("created_at", { ascending: false })
        .limit(30),
    ),
    rows<{ rule: string; quote: string | null; reason: string | null; kind: string | null; created_at: string }>(
      supabase.from("copy_rule_overrides").select("rule, quote, reason, kind, created_at").eq("client_id", clientId).order("created_at", { ascending: false }).limit(10),
    ),
    rows<{ area: string | null; note: string | null; reason: string | null; created_at: string }>(
      supabase.from("creative_review_disagreements").select("area, note, reason, created_at").eq("client_id", clientId).order("created_at", { ascending: false }).limit(10),
    ),
    rows<{ request_id: string; client_notes: string | null; client_status: { status?: string; note?: string | null }[] | null; changes: unknown; approved_at: string | null; updated_at: string }>(
      supabase.from("copy_sets").select("request_id, client_notes, client_status, changes, approved_at, updated_at").eq("client_id", clientId).gte("updated_at", since(45)).order("updated_at", { ascending: false }).limit(8),
    ),
    rows<{ rule: string; polarity: string | null; status: string; count: number | null; stern: boolean | null; lifted_note: string | null; updated_at: string }>(
      supabase.from("client_bible_rules").select("rule, polarity, status, count, stern, lifted_note, updated_at").eq("client_id", clientId).order("updated_at", { ascending: false }).limit(30),
    ),
    rows<{ question: string; category: string | null; stage: string | null; answer: unknown; answered_at: string | null; created_at: string }>(
      supabase.from("bible_questions").select("question, category, stage, answer, answered_at, created_at").eq("client_id", clientId).order("updated_at", { ascending: false }).limit(20),
    ),
    rows<{ status: string; markdown: string | null; signed_off_at: string | null; generated_at: string | null }>(
      supabase.from("client_execution_plans").select("status, markdown, signed_off_at, generated_at").eq("client_id", clientId).limit(1),
    ),
    rows<{ title: string; status: string; owner_role: string | null; due_on: string | null; platform: string | null }>(
      supabase.from("client_tasks").select("title, status, owner_role, due_on, platform").eq("client_id", clientId).not("status", "in", "(done,skipped)").order("position").limit(15),
    ),
    rows<{ title: string | null; status: string; request: string | null; platform: string | null; created_at: string; applied_at: string | null }>(
      supabase.from("ad_changes").select("title, status, request, platform, created_at, applied_at").eq("client_id", clientId).gte("created_at", since(30)).order("created_at", { ascending: false }).limit(10),
    ),
    rows<{ gist: string | null; subject: string | null; from_name: string | null; source: string; status: string; asked_at: string }>(
      supabase.from("owed_replies").select("gist, subject, from_name, source, status, asked_at").eq("client_id", clientId).in("status", ["watching", "nudged", "escalated"]).order("asked_at", { ascending: false }).limit(10),
    ),
    rows<{ what: string; kind: string | null; due_at: string | null; status: string; created_at: string }>(
      supabase.from("call_commitments").select("what, kind, due_at, status, created_at").eq("client_id", clientId).in("status", ["open", "in_motion", "briefed"]).order("created_at", { ascending: false }).limit(10),
    ),
    rows<{ id: string; started_at: string | null }>(supabase.from("optimization_sprints").select("id, started_at").eq("client_id", clientId).eq("status", "active").limit(2)),
  ]);

  const ids = reqs.map((r) => r.id);
  const [events, sprintActions] = await Promise.all([
    ids.length
      ? rows<Ev>(supabase.from("request_events").select("request_id, kind, from_stage, to_stage, body, data, created_at").in("request_id", ids).neq("kind", "upload").order("created_at", { ascending: false }).limit(60))
      : Promise.resolve([] as Ev[]),
    sprints.length
      ? rows<{ title: string; status: string; note: string | null; done_at: string | null }>(
          supabase.from("sprint_actions").select("title, status, note, done_at").in("sprint_id", sprints.map((s) => s.id)).order("sort_order").limit(12),
        )
      : Promise.resolve([]),
  ]);

  const byId = new Map(reqs.map((r) => [r.id, r]));
  const name = (id: string | null) => {
    const r = id ? byId.get(id) : null;
    return r ? `#${r.number ?? "?"} "${flat(r.title, 70)}"` : "a ticket";
  };
  const out: string[] = [];
  const section = (tag: string, note: string, lines: string[]) => {
    if (lines.length) out.push(`<${tag}>`, note, ...lines, `</${tag}>`);
  };

  // Open tickets with the latest thing that happened on each
  const last = new Map<string, Ev>();
  for (const e of events) if (!last.has(e.request_id)) last.set(e.request_id, e);
  const describeEvent = (e: Ev) => {
    const d = e.data ?? {};
    if (e.kind === "stage") return `moved ${e.from_stage ?? "?"} → ${e.to_stage ?? "?"}`;
    if (e.kind === "review") return `review: ${String(d.action ?? d.decision ?? "updated").replace(/_/g, " ")}${e.body ? ` (${flat(e.body, 120)})` : ""}`;
    if (e.kind === "copy") return `copy ${String(d.action ?? "updated")}`;
    return `${e.kind}${e.body ? `: ${flat(e.body, 140)}` : ""}`;
  };
  section(
    "tickets_now",
    "Tickets in progress (and ones launched in the last three weeks), newest activity first, with the latest thing that happened on each.",
    reqs.map((r) => {
      const e = last.get(r.id);
      return `- ${name(r.id)} · ${r.stage.replace(/_/g, " ")}${r.stage_due_at && r.stage !== "launched" ? ` · due ${day(r.stage_due_at)}` : ""}${r.client_rounds ? ` · ${r.client_rounds} client round${r.client_rounds === 1 ? "" : "s"}` : ""}${r.internal_rounds ? ` · ${r.internal_rounds} internal` : ""}${e ? ` · last: ${day(e.created_at)} ${describeEvent(e)}` : ""}`;
    }),
  );

  // What people said on the work: the client's own words first-class, ours too
  section(
    "review_comments",
    "Comments on the work in the last 45 days, newest first. [client] is the client's own feedback (a hard signal for what they want); [team] is our internal review. Resolved ones were dealt with.",
    comments.map(
      (c) =>
        `- ${day(c.created_at)} [${c.author_contact_id ? "client" : "team"}${c.author_name ? `: ${flat(c.author_name, 40)}` : ""}] on ${name(c.request_id)}${c.round ? ` (round ${c.round})` : ""}${c.area ? ` · ${c.area}` : ""}: ${flat(c.body, 260)}${c.resolved_at ? " (resolved)" : ""}${c.disagreed_at ? ` (the team disagreed${c.disagree_reason ? `: ${flat(c.disagree_reason, 160)}` : ""})` : ""}`,
    ),
  );

  // The client's approvals and change requests on copy
  section(
    "copy_feedback",
    "What the client did with the ad copy recently: approvals, per-ad notes and changes they asked for.",
    copySets
      .map((s) => {
        const st = Array.isArray(s.client_status) ? s.client_status : [];
        const approved = st.filter((x) => x?.status === "approved").length;
        const changes = st.filter((x) => x?.status && x.status !== "approved");
        const notes = st.map((x) => x?.note).filter(Boolean) as string[];
        const bits = [
          approved ? `${approved} approved` : "",
          changes.length ? `${changes.length} sent back` : "",
          s.client_notes ? `notes: ${flat(s.client_notes, 200)}` : "",
          notes.length ? `per ad: ${notes.slice(0, 3).map((n) => flat(n, 100)).join(" | ")}` : "",
        ].filter(Boolean);
        return bits.length ? `- ${day(s.updated_at)} on ${name(s.request_id)}: ${bits.join(" · ")}` : "";
      })
      .filter(Boolean),
  );

  section(
    "overrides_and_disagreements",
    "Where the team overrode a copy rule or disagreed with the AI review, and why. Don't flag these again for the same reason.",
    [
      ...overrides.map((o) => `- ${day(o.created_at)} copy rule ${o.kind === "rebut" ? "rebutted" : "overridden"}: "${flat(o.rule, 120)}"${o.quote ? ` on "${flat(o.quote, 80)}"` : ""}${o.reason ? ` because ${flat(o.reason, 160)}` : ""}`),
      ...disagreements.map((d) => `- ${day(d.created_at)} disagreed with the creative review${d.area ? ` (${d.area})` : ""}: ${flat(d.note, 120)}${d.reason ? ` because ${flat(d.reason, 160)}` : ""}`),
    ],
  );

  const live = rules.filter((r) => r.status === "rule");
  const logged = rules.filter((r) => r.status === "logged");
  const lifted = rules.filter((r) => r.status === "lifted");
  section(
    "bible_rules",
    "Rules the client's feedback turned into (hard), dos and don'ts logged once (lean on them), and rules that were lifted (no longer apply).",
    [
      ...live.map((r) => `- RULE ${r.polarity === "do" ? "DO" : "DON'T"}${r.stern ? " (stern)" : ""}: ${flat(r.rule, 200)}`),
      ...logged.slice(0, 12).map((r) => `- logged ${r.polarity === "do" ? "do" : "don't"} (${r.count ?? 1}×): ${flat(r.rule, 200)}`),
      ...lifted.slice(0, 5).map((r) => `- lifted ${day(r.updated_at)}: ${flat(r.rule, 140)}${r.lifted_note ? ` (${flat(r.lifted_note, 100)})` : ""}`),
    ],
  );

  const answer = (a: unknown) => (typeof a === "string" ? a : Array.isArray(a) ? a.join(", ") : a && typeof a === "object" ? JSON.stringify(a) : "");
  const answered = questions.filter((q) => q.answered_at);
  const open = questions.filter((q) => !q.answered_at);
  section(
    "open_questions",
    "Questions we asked about the client (Brand Bible): answered ones are facts from the source; open ones are still unknown, so don't assume.",
    [
      ...answered.slice(0, 12).map((q) => `- answered ${day(q.answered_at)} by ${q.stage === "media_buyer" ? "the media buyer" : "the client"}: ${flat(q.question, 140)} → ${flat(answer(q.answer), 200)}`),
      ...open.slice(0, 6).map((q) => `- still open: ${flat(q.question, 160)}`),
    ],
  );

  const p = plan[0];
  if (p)
    section("execution_plan", `The client's execution plan (${p.status}${p.signed_off_at ? `, signed off ${day(p.signed_off_at)}` : ", not signed off yet"}).`, [
      ...(p.markdown ? [flat(p.markdown, 2500)] : []),
      ...tasks.map((t) => `- task ${t.status}: ${flat(t.title, 140)}${t.owner_role ? ` · ${t.owner_role}` : ""}${t.due_on ? ` · due ${t.due_on}` : ""}`),
    ]);
  else
    section(
      "open_tasks",
      "The client's open setup and plan tasks.",
      tasks.map((t) => `- ${t.status}: ${flat(t.title, 140)}${t.owner_role ? ` · ${t.owner_role}` : ""}${t.due_on ? ` · due ${t.due_on}` : ""}`),
    );

  section(
    "ad_account_changes",
    "Changes planned or made in their ad accounts in the last 30 days.",
    changes.map((c) => `- ${day(c.created_at)} ${c.platform ?? ""} ${c.status}${c.applied_at ? ` (applied ${day(c.applied_at)})` : ""}: ${flat(c.title ?? c.request, 180)}`),
  );
  section("sprint", "The optimisation sprint running now: its actions and where they stand.", sprintActions.map((a) => `- ${a.status}: ${flat(a.title, 140)}${a.note ? ` (${flat(a.note, 100)})` : ""}`));
  section(
    "waiting_on_us",
    "Messages from the client we haven't answered yet. If what you write touches one, say so.",
    owed.map((o) => `- asked ${day(o.asked_at)} (${o.source}${o.from_name ? `, ${flat(o.from_name, 40)}` : ""}, ${o.status}): ${flat(o.gist ?? o.subject, 200)}`),
  );
  section(
    "promises",
    "What we promised the client on calls and haven't closed yet.",
    promises.map((c) => `- ${day(c.created_at)} (${c.status.replace(/_/g, " ")}${c.due_at ? `, due ${day(c.due_at)}` : ""}): ${flat(c.what, 200)}`),
  );

  if (!out.length) return "";
  let text = `<client_activity note="What's happening with this client in Kaizen Ads right now, newest first. It's newer than the Brand Bible and the briefing: where it differs, it wins.">\n${out.join("\n")}\n</client_activity>`;
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS - 40)}\n…(trimmed)\n</client_activity>`;
  return text;
}

// ─── Freshness ──────────────────────────────────────────────────────────────

const lastFresh = new Map<string, number>();

/**
 * Before a conversation about a client: read any Slack messages in their channels newer than what's saved, so the
 * answer sees what was said a minute ago. Never waits longer than `budgetMs` (whatever finished is kept, the rest is
 * picked up by the regular sync), at most once a minute per client, and does nothing when Slack isn't connected.
 * Review comments, approvals and the rest are read straight from the database by the context, so they're always current.
 */
export async function freshenClient(admin: SupabaseClient, clientId: string, budgetMs = 2000): Promise<void> {
  const now = Date.now();
  if (now - (lastFresh.get(clientId) ?? 0) < 60_000) return;
  lastFresh.set(clientId, now);
  const work = (async () => {
    const { slackConfigured, readChannel } = await import("@/lib/context/slack");
    if (!slackConfigured()) return;
    const { saveItems } = await import("@/lib/context/shared");
    const { data: c } = await admin.from("clients").select("slack_channel_id, internal_slack_channel_id").eq("id", clientId).maybeSingle();
    const channels = [
      { id: c?.slack_channel_id as string | null, source: "slack_external" as const },
      { id: c?.internal_slack_channel_id as string | null, source: "slack_internal" as const },
    ].filter((x): x is { id: string; source: "slack_external" | "slack_internal" } => Boolean(x.id));
    await Promise.all(
      channels.map(async (ch) => {
        // From the newest message already saved for this channel (a little overlap; saving is idempotent)
        const { data: latest } = await admin.from("context_items").select("occurred_at").eq("client_id", clientId).eq("source", ch.source).order("occurred_at", { ascending: false }).limit(1).maybeSingle();
        const from = new Date(Math.max(latest?.occurred_at ? new Date(latest.occurred_at).getTime() - 60_000 : 0, now - 3 * 86_400_000));
        const items = await readChannel(ch.id, from, clientId, ch.source);
        if (items.length) await saveItems(admin, items);
      }),
    );
  })().catch((e) => console.error("[freshen]", clientId, e instanceof Error ? e.message : e));
  await Promise.race([work, new Promise((r) => setTimeout(r, budgetMs))]);
}
