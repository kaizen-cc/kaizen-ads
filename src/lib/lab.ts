import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, researchWeb } from "@/lib/ai";
import { allWinners } from "@/lib/industry";
import { industryLabel } from "@/lib/industries";

// The Ads Lab: a round table of AI seats thinking with execs and leads, a library of material, and tests run on
// chosen clients. Results are read from the KPI tracker (same numbers the team trusts), and a win becomes a
// learning in the memory of every client it fits.

import { SEATS, type Metric, type Seat } from "@/lib/lab-seats";
export { METRIC_LABEL, SEATS, type Metric, type Seat } from "@/lib/lab-seats";

export type ProposedTest = {
  title: string;
  hypothesis: string;
  change: string;
  metric: Metric;
  success: string;
  targetLift: number;
  clientIds: string[];
  duplicateOf: string | null; // a test already proposed, running or finished
  duplicateWhy: string;
};

export type ClientNumbers = { spend: number; results: number; cpr: number | null };

type KpiRow = { client_id: string; windows: unknown };

/** Each client's numbers over a window, from KPI tracker rows (accounts with several targets are added up). */
export function numbersFrom(rows: KpiRow[], ids: string[], window: "d3" | "d7" | "d14" | "d30" = "d14") {
  const out: Record<string, ClientNumbers> = {};
  const want = new Set(ids);
  for (const r of rows) {
    if (!want.has(r.client_id)) continue;
    const w = (r.windows as Record<string, { spend?: number; results?: number }> | null)?.[window];
    const o = (out[r.client_id] ??= { spend: 0, results: 0, cpr: null });
    o.spend += Number(w?.spend ?? 0);
    o.results += Number(w?.results ?? 0);
  }
  for (const o of Object.values(out)) {
    o.spend = Math.round(o.spend * 100) / 100;
    o.cpr = o.results ? Math.round((o.spend / o.results) * 100) / 100 : null;
  }
  return out;
}

export async function clientNumbers(db: SupabaseClient, ids: string[], window: "d3" | "d7" | "d14" | "d30" = "d14") {
  if (!ids.length) return {};
  const { data } = await db.from("kpi_snapshots").select("client_id, windows").in("client_id", ids);
  return numbersFrom((data ?? []) as KpiRow[], ids, window);
}

/** The window that best covers the time since a test started. */
export const windowSince = (startedAt: string | null): "d3" | "d7" | "d14" | "d30" => {
  const days = startedAt ? (Date.now() - Date.parse(startedAt)) / 86_400_000 : 14;
  return days <= 4 ? "d3" : days <= 9 ? "d7" : days <= 20 ? "d14" : "d30";
};

/** Change in cost per result: negative is better (cheaper). */
export const cprChange = (before?: ClientNumbers | null, now?: ClientNumbers | null) =>
  before?.cpr && now?.cpr ? Math.round((now.cpr / before.cpr - 1) * 1000) / 10 : null;

// ─── The round table ────────────────────────────────────────────────────────

const TABLE_SYSTEM = `You are the round table in Kaizen Marketing's Ads Lab: Kaizen's six agents, who think together with the agency's execs and leads about paid social creative for Meta ads. Kaizen runs ads for many small and mid-size businesses.
The seats:
${Object.entries(SEATS)
  .map(([k, s]) => `- ${k} (${s.name}): ${s.does}`)
  .join("\n")}

How you work:
- Answer the last message as a conversation between the seats. Only the seats with something real to add speak (usually 2 to 4), short and direct, building on or pushing back on each other. Disagree when it's warranted. No filler, no repeating each other, no emojis.
- Ground everything in the library material, the winners across the accounts, and the lab's test history. Say when something is a hunch.
- When an idea is ready to test, propose it as a test: a clear hypothesis, exactly what the creative does differently (one change, so the result can be read), the metric, what counts as a win, the target lift, and which clients fit (from the client list; pick ones with enough spend and the right industry, 2 to 5 usually).
- Before proposing a test, check the lab's tests. If the same or a very close test is proposed, running, or already finished, don't propose it again: set duplicateOf to that test's number and say what's different if anything, or point to its result.
- Learnings from finished tests are facts. A test that flopped is information: when asked to iterate, say why it likely flopped and propose the next test (not the same one).
- Never name one client to another; inside the lab, client names are fine.
- The six seats are fixed. Never suggest creating a new agent, seat or role: what the Lab learns makes these six better.`;

const TABLE_SCHEMA = {
  type: "object",
  properties: {
    threadTitle: { type: "string" },
    replies: {
      type: "array",
      items: { type: "object", properties: { seat: { type: "string", enum: Object.keys(SEATS) }, body: { type: "string" } }, required: ["seat", "body"], additionalProperties: false },
    },
    tests: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          hypothesis: { type: "string" },
          change: { type: "string" },
          metric: { type: "string", enum: ["cpr", "results", "ctr", "roas"] },
          success: { type: "string" },
          targetLiftPercent: { type: "integer" },
          clients: { type: "array", items: { type: "integer" } },
          duplicateOf: { type: "integer" },
          duplicateWhy: { type: "string" },
        },
        required: ["title", "hypothesis", "change", "metric", "success", "targetLiftPercent", "clients", "duplicateOf", "duplicateWhy"],
        additionalProperties: false,
      },
    },
  },
  required: ["threadTitle", "replies", "tests"],
  additionalProperties: false,
};

type TableOut = {
  threadTitle: string;
  replies: { seat: Seat; body: string }[];
  tests: { title: string; hypothesis: string; change: string; metric: Metric; success: string; targetLiftPercent: number; clients: number[]; duplicateOf: number; duplicateWhy: string }[];
};

/** Everything the table reads: library, clients, winners and the lab's tests (numbered so the AI can point at them). */
async function tableContext(admin: SupabaseClient) {
  const [{ data: sources }, { data: clients }, { data: tests }, { data: snaps }, winners] = await Promise.all([
    admin.from("lab_sources").select("kind, title, url, body, summary, created_at").eq("status", "ready").order("created_at", { ascending: false }).limit(40),
    admin.from("clients").select("id, name, industry, industry_detail").neq("status", "offboarded").order("name"),
    admin.from("lab_tests").select("id, title, hypothesis, change, metric, status, client_ids, verdict_note, learning, created_at").neq("status", "dropped").order("created_at", { ascending: false }).limit(60),
    admin.from("kpi_snapshots").select("client_id, windows"),
    allWinners(admin),
  ]);
  const spend30 = new Map<string, number>();
  for (const s of snaps ?? []) spend30.set(s.client_id, (spend30.get(s.client_id) ?? 0) + Number((s.windows as { d30?: { spend?: number } } | null)?.d30?.spend ?? 0));
  const list = (clients ?? []).filter((c) => (spend30.get(c.id) ?? 0) > 0);
  const nameOf = new Map((clients ?? []).map((c) => [c.id, c.name]));
  const testList = tests ?? [];

  // The library: newest first, whole text while it fits, then the takeaways only
  let budget = 60_000;
  const library = (sources ?? []).map((s) => {
    const text = s.body.length <= budget ? s.body : "";
    budget -= text.length;
    return `<source kind="${s.kind}" title="${s.title.replace(/"/g, "'")}"${s.url ? ` url="${s.url}"` : ""}>\n${s.summary ? `Takeaways: ${s.summary}\n` : ""}${text}\n</source>`;
  });

  const block = `<library>
${library.length ? library.join("\n") : "Nothing in the library yet."}
</library>

<clients>
Number · name · industry · spend in the last 30 days
${list.map((c, i) => `${i + 1} · ${c.name} · ${c.industry_detail ?? industryLabel(c.industry ?? "") ?? "industry not set"} · $${Math.round(spend30.get(c.id) ?? 0).toLocaleString("en-US")}`).join("\n")}
</clients>

<winners_across_accounts>
${winners
  .slice(0, 15)
  .map((w) => `- ${w.client} (${w.detail ?? "?"}): "${w.headline ?? w.name}"${w.text ? ` · ${w.text.slice(0, 160)}` : ""} · ${w.ratio}x the account's usual cost per ${w.result ?? "result"}`)
  .join("\n") || "None yet."}
</winners_across_accounts>

<lab_tests>
${testList.length ? testList.map((t, i) => `#${i + 1} [${t.status}] ${t.title} · ${t.hypothesis} · change: ${t.change} · clients: ${(t.client_ids as string[]).map((id) => nameOf.get(id) ?? "?").join(", ") || "none yet"}${t.verdict_note ? ` · verdict: ${t.verdict_note}` : ""}${t.learning ? ` · learning: ${t.learning}` : ""}`).join("\n") : "No tests yet."}
</lab_tests>`;
  return { block, clients: list, tests: testList };
}

/** The table's system: each seat speaks from its agent's core, the same one it works from everywhere in the app. */
async function tableSystem(admin: SupabaseClient) {
  const { data } = await admin.from("ai_roles").select("key, core");
  const cores = Object.entries(SEATS)
    .map(([k, s]) => {
      const core = (data ?? []).find((r) => r.key === s.role)?.core;
      return core ? `<seat key="${k}" name="${s.name}">\n${core}\n</seat>` : "";
    })
    .filter(Boolean)
    .join("\n");
  return cores ? `${TABLE_SYSTEM}\n\nEach seat's core, how that agent thinks everywhere in the app:\n${cores}` : TABLE_SYSTEM;
}

/** The table answers the conversation so far: replies from the seats, and any tests they propose. */
export async function roundTable(admin: SupabaseClient, threadId: string) {
  const [{ data: msgs }, ctx] = await Promise.all([admin.from("lab_messages").select("role, agent, body, created_at").eq("thread_id", threadId).order("created_at").limit(60), tableContext(admin)]);
  const convo = (msgs ?? []).map((m) => (m.role === "user" ? `Exec/lead: ${m.body}` : `${SEATS[m.agent as Seat]?.name ?? "Table"}: ${m.body}`)).join("\n\n");
  const out = await askJson<TableOut>({
    agent: "lab",
    label: "lab round table",
    system: await tableSystem(admin),
    schema: TABLE_SCHEMA,
    prompt: `${ctx.block}

<conversation>
${convo}
</conversation>

Reply to the last message. threadTitle: a short title for this conversation (under 50 characters). tests: only tests ready to run, otherwise empty; clients are numbers from the client list; duplicateOf is a lab test number (#), or 0 if it's new; targetLiftPercent e.g. 15 for 15% better.`,
  });
  const tests: ProposedTest[] = out.tests.map((t) => ({
    title: t.title,
    hypothesis: t.hypothesis,
    change: t.change,
    metric: t.metric,
    success: t.success,
    targetLift: Math.max(0, Math.min(200, t.targetLiftPercent)) / 100,
    clientIds: t.clients.map((n) => ctx.clients[n - 1]?.id).filter(Boolean) as string[],
    duplicateOf: t.duplicateOf > 0 ? (ctx.tests[t.duplicateOf - 1]?.id ?? null) : null,
    duplicateWhy: t.duplicateWhy,
  }));
  const replies = out.replies.filter((r) => r.body.trim());
  const rows = (replies.length ? replies : [{ seat: "strategist" as Seat, body: "Nothing to add yet. Say more?" }]).map((r, i, all) => ({
    thread_id: threadId,
    role: "agent",
    agent: r.seat,
    body: r.body.trim(),
    data: i === all.length - 1 && tests.length ? { tests } : null,
  }));
  await admin.from("lab_messages").insert(rows);
  const { data: thread } = await admin.from("lab_threads").select("title").eq("id", threadId).single();
  await admin
    .from("lab_threads")
    .update({ updated_at: new Date().toISOString(), ...(thread?.title === "New conversation" && out.threadTitle ? { title: out.threadTitle.slice(0, 80) } : {}) })
    .eq("id", threadId);
}

// ─── The library ────────────────────────────────────────────────────────────

const READ_SCHEMA = { type: "object", properties: { title: { type: "string" }, summary: { type: "string" } }, required: ["title", "summary"], additionalProperties: false };

/** Reads what was added: a link or video is fetched and noted, text gets its takeaways. */
export async function readSource(admin: SupabaseClient, id: string) {
  const { data: s } = await admin.from("lab_sources").select("id, kind, title, url, body").eq("id", id).single();
  if (!s) return;
  try {
    let body = s.body;
    if (s.url && !body.trim()) {
      body = await researchWeb({
        agent: "lab",
        label: "lab source",
        system: "You read material for a paid social agency's creative lab and write it down faithfully: what it says, the specific tactics, examples, numbers and quotes worth keeping. Plain text, no preamble.",
        prompt: `Read this ${s.kind === "video" ? "video (its page, description and transcript or captions if they can be found; otherwise the best write-ups of it)" : "page"} and write down everything useful for making better Meta ad creative, up to about 1,500 words: ${s.url}`,
        maxSearches: 4,
        maxFetches: 6,
      });
    }
    const out = await askJson<{ title: string; summary: string }>({
      agent: "briefing",
      label: "lab source takeaways",
      system: "You pull the takeaways for ad creative out of material a paid social agency is studying.",
      schema: READ_SCHEMA,
      prompt: `<material kind="${s.kind}" title="${s.title}">\n${body.slice(0, 80_000)}\n</material>\n\ntitle: a short, specific title (keep the given one if it's good). summary: the 3 to 6 takeaways most useful for Meta ad creative, as short lines starting with "- ".`,
    });
    await admin.from("lab_sources").update({ body: body.slice(0, 200_000), title: out.title.slice(0, 120) || s.title, summary: out.summary, status: "ready" }).eq("id", id);
  } catch (e) {
    await admin.from("lab_sources").update({ status: "failed", summary: e instanceof Error ? e.message.slice(0, 200) : "Couldn't read it" }).eq("id", id);
  }
}

// ─── Deploying a learning ───────────────────────────────────────────────────

const DEPLOY_SCHEMA = {
  type: "object",
  properties: {
    learning: { type: "string" },
    clients: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, why: { type: "string" } }, required: ["n", "why"], additionalProperties: false } },
  },
  required: ["learning", "clients"],
  additionalProperties: false,
};

/** For a test that won: the learning in a sentence or two, and the clients it fits. */
export async function proposeDeploy(admin: SupabaseClient, testId: string) {
  const [{ data: t }, ctx] = await Promise.all([admin.from("lab_tests").select("title, hypothesis, change, verdict_note, client_ids, result, baseline").eq("id", testId).single(), tableContext(admin)]);
  if (!t) throw new Error("Test not found");
  const out = await askJson<{ learning: string; clients: { n: number; why: string }[] }>({
    agent: "lab",
    label: "lab deploy",
    system: await tableSystem(admin),
    schema: DEPLOY_SCHEMA,
    prompt: `${ctx.block}

<winning_test>
${t.title}
Hypothesis: ${t.hypothesis}
Change: ${t.change}
Verdict: ${t.verdict_note ?? ""}
Before: ${JSON.stringify(t.baseline)}
After: ${JSON.stringify(t.result)}
</winning_test>

learning: what we now know, written as a rule a designer or copywriter can follow for a client (one or two sentences, specific, starting with the situation it applies to). clients: the clients from the list it clearly fits beyond those already in the test (same or close industry, similar offer or audience), with one short line of why. Fewer and right beats many.`,
  });
  const tested = new Set(t.client_ids as string[]);
  return {
    learning: out.learning,
    clients: out.clients.map((c) => ({ id: ctx.clients[c.n - 1]?.id, why: c.why })).filter((c): c is { id: string; why: string } => Boolean(c.id) && !tested.has(c.id!)),
  };
}
