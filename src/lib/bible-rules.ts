import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";

// The Brand Bible's rules log. A Bible's dos and don'ts aren't written from one comment: every standing preference
// the client voices (in creative and copy feedback, Slack, email or a call) is logged with when and where, and it
// becomes a rule only once it has come up about three times, or at once when they say it sternly ("never use AI images
// of our food"). When they later open the door ("let's test single items"), the rule is lifted. One-off context (what
// a launch-day offer must match) and our own ideas or test hypotheses are never logged: those belong in a brief.

export type BibleRule = { key: string; rule: string; polarity: "do" | "dont"; status: "logged" | "rule" | "lifted"; count: number; stern: boolean; mentions: { at: string; source: string; quote: string }[]; lifted_note: string | null };

/** Times a preference has to come up before it's a rule (sooner when the client is stern about it) */
export const RULE_AFTER = 3;

const SCHEMA = {
  type: "object",
  properties: {
    mentions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          rule: { type: "string" },
          polarity: { type: "string", enum: ["do", "dont"] },
          stern: { type: "boolean" },
          lifts: { type: "boolean" },
          quote: { type: "string" },
          source: { type: "string" },
          at: { type: "string" },
        },
        required: ["key", "rule", "polarity", "stern", "lifts", "quote", "source", "at"],
        additionalProperties: false,
      },
    },
  },
  required: ["mentions"],
  additionalProperties: false,
};

/** What the client said since the last pass: creative and copy feedback, plan reactions, Slack and email, calls */
async function statementsSince(admin: SupabaseClient, clientId: string, since: string) {
  const [{ data: comments }, { data: items }, { data: calls }, { data: plan }] = await Promise.all([
    admin.from("review_comments").select("body, created_at, author_name").eq("client_id", clientId).not("author_contact_id", "is", null).gt("created_at", since).order("created_at").limit(120),
    admin.from("context_items").select("source, occurred_at, author, body").eq("client_id", clientId).in("source", ["slack_external", "gmail"]).gt("occurred_at", since).order("occurred_at").limit(200),
    admin.from("call_mentions").select("summary, client_calls!inner(title, occurred_at)").eq("client_id", clientId).gt("client_calls.occurred_at", since).limit(40),
    admin.from("client_presentations").select("reactions, updated_at").eq("client_id", clientId).gt("updated_at", since).maybeSingle(),
  ]);
  const lines: string[] = [];
  for (const c of comments ?? []) lines.push(`- ${String(c.created_at).slice(0, 10)} · creative/copy feedback · ${c.author_name ?? "Client"}: "${String(c.body).replace(/\s+/g, " ").slice(0, 500)}"`);
  for (const i of items ?? []) lines.push(`- ${String(i.occurred_at).slice(0, 10)} · ${i.source === "gmail" ? "email" : "Slack"}${i.author ? ` · ${i.author}` : ""}: ${String(i.body ?? "").replace(/\s+/g, " ").slice(0, 500)}`);
  for (const m of calls ?? []) {
    const call = m.client_calls as unknown as { title: string; occurred_at: string } | null;
    const s = m.summary as { clientSaid?: string[]; decisions?: string[] } | null;
    const said = [...(s?.clientSaid ?? []), ...(s?.decisions ?? [])];
    if (said.length) lines.push(`- ${String(call?.occurred_at ?? "").slice(0, 10)} · call "${call?.title ?? ""}": ${said.join("; ").slice(0, 900)}`);
  }
  const r = (plan?.reactions ?? null) as { sections?: Record<string, { verdict: string; note?: string; at?: string }> } | null;
  for (const [k, v] of Object.entries(r?.sections ?? {})) if (v?.note) lines.push(`- ${String(v.at ?? plan?.updated_at).slice(0, 10)} · their plan review (${k}): "${v.note.slice(0, 500)}"`);
  // Our copy check flagged something and the copywriter or a lead rebutted it, citing what the client allowed
  const { data: rebuttals } = await admin.from("copy_rule_overrides").select("rule, quote, reason, created_at").eq("client_id", clientId).eq("kind", "rebut").gt("created_at", since).limit(30);
  for (const x of rebuttals ?? []) lines.push(`- ${String(x.created_at).slice(0, 10)} · team rebuttal citing the client · the copy check flagged "${x.quote ?? ""}" under the rule "${x.rule}"; the team says: "${String(x.reason).slice(0, 400)}"`);
  return lines.join("\n").slice(0, 40000);
}

/**
 * One pass of the log for a client: reads what they said since the last pass, logs each standing preference against
 * the ones already logged, and promotes, keeps or lifts. Returns how many mentions were logged.
 */
export async function logClientRules(admin: SupabaseClient, clientId: string) {
  const [{ data: b }, { data: existing }, { data: c }] = await Promise.all([
    admin.from("client_brand_bibles").select("rules_logged_at").eq("client_id", clientId).maybeSingle(),
    admin.from("client_bible_rules").select("key, rule, polarity, status, count, stern, mentions, lifted_note").eq("client_id", clientId),
    admin.from("clients").select("name, created_at").eq("id", clientId).single(),
  ]);
  if (!c) return 0;
  // First pass: the last year of history
  const since = (b?.rules_logged_at as string | null) ?? new Date(Date.now() - 365 * 86_400_000).toISOString();
  const now = new Date().toISOString();
  const said = await statementsSince(admin, clientId, since);
  const mark = () => admin.from("client_brand_bibles").update({ rules_logged_at: now }).eq("client_id", clientId);
  if (!said) {
    await mark();
    return 0;
  }
  const rules = (existing ?? []) as BibleRule[];
  const out = await askJson<{ mentions: { key: string; rule: string; polarity: "do" | "dont"; stern: boolean; lifts: boolean; quote: string; source: string; at: string }[] }>({
    agent: "brandbible",
    label: `bible rules log ${c.name}`,
    bare: true,
    maxTokens: 4000,
    override: { model: "sonnet", effort: "low" },
    schema: SCHEMA,
    system: `You keep the dos-and-don'ts log of a client's Brand Bible. From what the client said, log every STANDING preference about their brand: what to show or never show, words and claims, the look, products to feature or avoid, AI content, offers they will or won't run, tone. Each is one mention.
- Reuse an existing key when it's the same preference (even reworded); otherwise make a short snake_case key.
- rule: the preference as a plain rule ("Never use AI-generated images of the food").
- stern: true only when they were emphatic (never, always, under no circumstances, must, absolutely not).
- lifts: true when they're opening the door on an existing rule ("let's test single items after all"): use that rule's key.
- quote: their words, short. source: where (creative feedback, Slack, email, call title, plan review). at: the date (YYYY-MM-DD).
Never log: one-off logistics or launch-day details ("the offer must match the landing page on launch day"), a single campaign's settings, our team's ideas, test hypotheses or performance opinions ("a protein angle would crush"), or anything said by our own team. The one exception: a "team rebuttal citing the client" reports what the client allowed (e.g. "the client approved 'fresh, never frozen' on the Oct 12 call"): treat it as the client opening the door on that rule (lifts true, its key) when it names what they allowed. When nothing qualifies, return no mentions.`,
    prompt: `<logged_preferences>\n${rules.map((r) => `- ${r.key} (${r.polarity}, ${r.status}, ${r.count}x): ${r.rule}`).join("\n") || "None yet."}\n</logged_preferences>\n\n<what_the_client_said since="${since.slice(0, 10)}">\n${said}\n</what_the_client_said>`,
  });
  const byKey = new Map(rules.map((r) => [r.key, { ...r }]));
  for (const m of out.mentions) {
    const key = m.key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 60);
    if (!key) continue;
    const cur = byKey.get(key);
    const mention = { at: m.at.slice(0, 10), source: m.source.slice(0, 120), quote: m.quote.slice(0, 300) };
    if (m.lifts) {
      if (cur) byKey.set(key, { ...cur, status: "lifted", lifted_note: `${mention.at} · ${mention.source}: "${mention.quote}"`, mentions: [...cur.mentions, mention].slice(-12) });
      continue;
    }
    // The same day and source counts once
    const seen = cur?.mentions.some((x) => x.at === mention.at && x.source === mention.source);
    const count = (cur?.count ?? 0) + (seen ? 0 : 1);
    const stern = Boolean(cur?.stern || m.stern);
    // Said again after it was lifted: back in the log, counted afresh
    const status: BibleRule["status"] = stern || count >= RULE_AFTER ? "rule" : "logged";
    byKey.set(key, { key, rule: m.rule.slice(0, 300), polarity: m.polarity, count, stern, status: cur?.status === "lifted" && !stern ? "logged" : status, mentions: [...(cur?.mentions ?? []), ...(seen ? [] : [mention])].slice(-12), lifted_note: cur?.status === "lifted" && !stern ? null : (cur?.lifted_note ?? null) });
  }
  const rows = [...byKey.values()].filter((r) => out.mentions.some((m) => m.key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 60) === r.key));
  if (rows.length) await admin.from("client_bible_rules").upsert(rows.map((r) => ({ client_id: clientId, ...r, updated_at: now })), { onConflict: "client_id,key" });
  await mark();
  return out.mentions.length;
}

/** The log as the Bible's writer reads it: rules in force, preferences still being watched, and what was lifted */
export async function rulesBlock(admin: SupabaseClient, clientId: string) {
  const { data } = await admin.from("client_bible_rules").select("key, rule, polarity, status, count, stern, mentions, lifted_note").eq("client_id", clientId).order("count", { ascending: false });
  const rules = (data ?? []) as BibleRule[];
  if (!rules.length) return "";
  const last = (r: BibleRule) => r.mentions[r.mentions.length - 1];
  const line = (r: BibleRule) => `- ${r.polarity === "do" ? "DO" : "DON'T"}: ${r.rule} (${r.stern ? "said sternly" : `${r.count}x`}; last ${last(r)?.at ?? "?"} · ${last(r)?.source ?? "?"}: "${last(r)?.quote ?? ""}")`;
  const inForce = rules.filter((r) => r.status === "rule");
  const watching = rules.filter((r) => r.status === "logged");
  const lifted = rules.filter((r) => r.status === "lifted");
  return `<dos_and_donts_log note="the Do / Don't table is built from the rules in force, each with its source and date; preferences still being watched are context, not rules; lifted rules are out">
Rules in force:
${inForce.map(line).join("\n") || "None yet."}
Being watched (said fewer than ${RULE_AFTER} times):
${watching.map(line).join("\n") || "None."}
Lifted (the client opened the door):
${lifted.map((r) => `- ${r.rule} · lifted ${r.lifted_note ?? ""}`).join("\n") || "None."}
</dos_and_donts_log>`;
}

/** The clients' rule logs, oldest pass first, each at most every 3 days (and always right before its Bible is written) */
export async function keepRulesLogs(admin: SupabaseClient, max = 3) {
  const { data } = await admin
    .from("client_brand_bibles")
    .select("client_id, rules_logged_at, clients!inner(name, archived_at)")
    .not("markdown", "is", null)
    .is("clients.archived_at", null)
    .or(`rules_logged_at.is.null,rules_logged_at.lt.${new Date(Date.now() - 3 * 86_400_000).toISOString()}`)
    .order("rules_logged_at", { ascending: true, nullsFirst: true })
    .limit(max);
  const out: Record<string, number | string> = {};
  for (const r of data ?? []) {
    const name = (r.clients as unknown as { name: string } | null)?.name ?? (r.client_id as string);
    out[name] = await logClientRules(admin, r.client_id as string).catch((e) => (e instanceof Error ? e.message : "failed"));
  }
  return out;
}
