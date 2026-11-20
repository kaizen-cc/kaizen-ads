import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { cvrDrop, TRACKING_FLAG_KINDS, trackingSteps, type TrackingCheck } from "@/lib/tracking-core";

// The Tracking Engineer: the expert resource for Kaizen's tracking specialist (and anyone else who asks). It reads a
// client's actual setup and numbers (the account's conversion event and its 3 to 90 day windows, audit findings about
// tracking, open watchdog flags like spend with zero results, lost integrations or a site down, the weekly line
// review's platform-vs-store orders, the store and CRM connections), and answers with numbered steps: what to check
// or fix, where, what good looks like and who does it. Proactively: a client with a tracking flag or a sudden
// conversion-rate drop gets a check, and the tracking specialists get it as a notice in Kaizen OS (never Slack).

type Admin = SupabaseClient;
const DAY = 86_400_000;

export type TrackingContext = { client: { id: string; name: string; slug: string; website: string | null; industry: string | null }; text: string; signals: string[] };

/** Everything the agent should see about one client's tracking, as text for the prompt plus the short signals list */
export async function trackingContext(admin: Admin, clientId: string): Promise<TrackingContext | null> {
  const { data: c } = await admin.from("clients").select("id, name, slug, website, industry, industry_detail").eq("id", clientId).maybeSingle();
  if (!c) return null;
  const [{ data: targets }, { data: flags }, { data: audits }, { data: reviews }, { data: integrations }] = await Promise.all([
    admin.from("kpi_targets").select("id, platform, conversion, target, label").eq("client_id", clientId).eq("active", true),
    admin.from("watch_flags").select("kind, title, body, severity, opened_at").eq("client_id", clientId).is("resolved_at", null).in("kind", [...TRACKING_FLAG_KINDS]).order("opened_at", { ascending: false }).limit(12),
    admin.from("account_audits").select("target_id, created_at, result").eq("client_id", clientId).eq("status", "done").order("created_at", { ascending: false }).limit(4),
    admin.from("line_reviews").select("line, week_start, message").eq("client_id", clientId).order("week_start", { ascending: false }).limit(4),
    admin.from("client_integrations").select("kind, label, status, last_synced_at, last_error").eq("client_id", clientId),
  ]);
  const ids = (targets ?? []).map((t) => t.id as string);
  const { data: snaps } = ids.length ? await admin.from("kpi_snapshots").select("target_id, windows, status, data_through").in("target_id", ids) : { data: [] };
  const signals: string[] = [];
  const lines: string[] = [`Client: ${c.name}${c.industry_detail ? ` (${c.industry_detail})` : c.industry ? ` (${c.industry})` : ""}. Website: ${c.website ?? "unknown"}.`];
  for (const t of targets ?? []) {
    const s = (snaps ?? []).find((x) => x.target_id === t.id);
    const w = (s?.windows ?? {}) as Record<string, { spend?: number; results?: number; value?: number }>;
    const win = ["d3", "d7", "d14", "d30", "d90"].filter((k) => w[k]).map((k) => `${k}: $${Math.round(w[k].spend ?? 0)} spend, ${w[k].results ?? 0} results${w[k].value ? `, value ${w[k].value}` : ""}`).join("; ");
    lines.push(`Ad account (${t.platform}${t.label ? `, ${t.label}` : ""}): optimizes/reports on "${t.conversion ?? "unknown"}", target ${t.target ?? "?"}, status ${s?.status ?? "?"}, data through ${s?.data_through ?? "?"}. ${win}`);
    const drop = cvrDrop(w);
    if (drop) signals.push(`${t.platform}: ${drop}`);
  }
  for (const f of flags ?? []) {
    lines.push(`Open watchdog flag (${f.severity}, since ${String(f.opened_at).slice(0, 10)}): ${f.title}. ${f.body ?? ""}`);
    signals.push(String(f.title));
  }
  for (const a of audits ?? []) {
    const tr = ((a.result ?? {}) as { tracking?: unknown }).tracking;
    const notes = Array.isArray(tr) ? tr.map(String) : typeof tr === "string" ? [tr] : [];
    if (notes.length) lines.push(`Audit ${String(a.created_at).slice(0, 10)}, tracking findings:\n- ${notes.slice(0, 6).join("\n- ")}`);
  }
  for (const r of reviews ?? []) {
    const orders = String(r.message ?? "").split("\n").filter((l) => /orders|conversions|tracking|pixel|store/i.test(l)).slice(0, 4);
    if (orders.length) lines.push(`Weekly ${r.line} review (${r.week_start}): ${orders.join(" ")}`);
  }
  if ((integrations ?? []).length)
    lines.push(`Store/CRM connections: ${(integrations ?? []).map((i) => `${i.label ?? i.kind} (${i.status ?? "?"}${i.last_synced_at ? `, synced ${String(i.last_synced_at).slice(0, 10)}` : ", never synced"}${i.last_error ? `, error: ${String(i.last_error).slice(0, 100)}` : ""})`).join("; ")}`);
  else lines.push("Store/CRM connections: none connected in Kaizen OS (so there's no backend number to compare against yet).");
  return { client: { id: c.id as string, name: c.name as string, slug: c.slug as string, website: (c.website as string | null) ?? null, industry: (c.industry_detail as string | null) ?? (c.industry as string | null) ?? null }, text: lines.join("\n"), signals };
}

const CHECK = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "likely_causes", "steps"],
  properties: {
    summary: { type: "string" },
    likely_causes: { type: "array", items: { type: "string" } },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["do", "where", "good", "who"],
        properties: { do: { type: "string" }, where: { type: "string" }, good: { type: "string" }, who: { type: "string", enum: ["tracking specialist", "media buyer", "client's developer", "client"] } },
      },
    },
  },
};

/** The Tracking Engineer's read of one client: what's likely wrong and numbered steps to check or fix it */
export async function checkTracking(admin: Admin, clientId: string, opts: { question?: string | null; trigger?: string | null; by?: string | null } = {}): Promise<{ ok: true; check: TrackingCheck; id: string | null } | { ok: false; error: string }> {
  const ctx = await trackingContext(admin, clientId);
  if (!ctx) return { ok: false, error: "No such client." };
  const out = await askJson<{ summary: string; likely_causes: string[]; steps: { do: string; where: string; good: string; who: string }[] }>({
    agent: "tracking_audit",
    label: "tracking check",
    clientId,
    schema: CHECK,
    maxTokens: 6000,
    system: `You are Kaizen's Tracking Engineer. Read this client's tracking setup and numbers and say what to check or fix, as numbered steps the tracking specialist can follow today.
- summary: two or three sentences: is tracking healthy, and the one thing that matters most.
- likely_causes: the most likely explanations for what the numbers and flags show, most likely first (at most 4). Say what evidence points to each.
- steps: at most 8, in the order to do them. Each: do (one concrete action), where (the exact place: Events Manager › Test Events, GTM Preview, Shopify › Settings › Customer events, Google Ads › Goals › Conversions › Diagnostics, GHL › Workflows…), good (what a healthy result looks like), who (tracking specialist, media buyer, client's developer, or client).
Base everything on the context given; when something isn't known (no store connected, no audit), make finding it out a step instead of guessing. Kaizen's roles, never people's names.`,
    prompt: `${opts.trigger ? `<why_now>${opts.trigger}</why_now>\n` : ""}${opts.question ? `<question>${opts.question}</question>\n` : ""}<client_tracking>\n${ctx.text}\n</client_tracking>`,
  });
  const check = trackingSteps(out, ctx);
  const { data } = await admin.from("tracking_checks").insert({ client_id: clientId, trigger: opts.trigger ?? (opts.question ? "asked" : "manual"), question: opts.question ?? null, result: check, created_by: opts.by ?? null }).select("id").maybeSingle();
  return { ok: true, check, id: (data?.id as string | undefined) ?? null };
}

/**
 * Proactive: clients with a tracking flag open or a sudden conversion-rate drop, not checked in a week, get a check;
 * the tracking specialists (or, with none, the Heads of Meta and Google) get it as a notice. A few clients a run.
 */
export async function trackingWatch(admin: Admin, { max = 3 }: { max?: number } = {}) {
  const since = new Date(Date.now() - 7 * DAY).toISOString();
  const [{ data: flags }, { data: recent }, { data: snaps }] = await Promise.all([
    admin.from("watch_flags").select("client_id, title").is("resolved_at", null).in("kind", [...TRACKING_FLAG_KINDS]).not("client_id", "is", null).limit(200),
    admin.from("tracking_checks").select("client_id").gte("created_at", since).limit(500),
    admin.from("kpi_snapshots").select("client_id, windows").not("client_id", "is", null).limit(1000),
  ]);
  const checked = new Set((recent ?? []).map((r) => r.client_id as string));
  const why = new Map<string, string>();
  for (const f of flags ?? []) if (!why.has(f.client_id as string)) why.set(f.client_id as string, `Watchdog: ${f.title}`);
  for (const s of snaps ?? []) {
    const d = cvrDrop((s.windows ?? {}) as Record<string, { spend?: number; results?: number }>);
    if (d && !why.has(s.client_id as string)) why.set(s.client_id as string, d);
  }
  const due = [...why.entries()].filter(([id]) => !checked.has(id)).slice(0, max);
  if (!due.length) return { checked: 0 };
  const { data: people } = await admin.from("profiles").select("id, role").eq("is_active", true).not("joined_at", "is", null).in("role", ["tracking_specialist", "head_of_meta", "head_of_google"]);
  const specialists = (people ?? []).filter((p) => p.role === "tracking_specialist").map((p) => p.id as string);
  const to = specialists.length ? specialists : (people ?? []).map((p) => p.id as string);
  let n = 0;
  for (const [clientId, trigger] of due) {
    const r = await checkTracking(admin, clientId, { trigger }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
    if (!r.ok) continue;
    n++;
    const week = new Date().toISOString().slice(0, 10);
    const { data: c } = await admin.from("clients").select("name, slug").eq("id", clientId).maybeSingle();
    if (to.length)
      await admin.from("notifications").upsert(
        to.map((pid) => ({
          profile_id: pid,
          kind: "agent",
          client_id: clientId,
          key: `tracking-check:${clientId}:${week}`,
          title: `Tracking check for ${c?.name ?? "a client"}: ${r.check.steps.length} step${r.check.steps.length === 1 ? "" : "s"}`,
          body: `${trigger}. ${r.check.summary}`.slice(0, 600),
          href: "/settings?tab=agents&role=tracking_engineer#talk",
          priority: "normal",
        })),
        { onConflict: "profile_id,key", ignoreDuplicates: true },
      );
  }
  return { checked: n };
}

/** The playbook into the agent's knowledge, once (a document per area; never overwritten after) */
export async function seedTrackingPlaybook(admin: Admin) {
  const { data: have } = await admin.from("knowledge_docs").select("name").eq("agent_key", "role:tracking_engineer").is("removed_at", null);
  const names = new Set((have ?? []).map((d) => d.name as string));
  const { TRACKING_PLAYBOOK } = await import("@/lib/tracking-playbook");
  const todo = TRACKING_PLAYBOOK.filter((d) => !names.has(d.name)).slice(0, 2);
  if (!todo.length) return { seeded: 0 };
  const { addKnowledgeText } = await import("@/lib/knowledge");
  for (const d of todo)
    await addKnowledgeText(admin, { scope: "agent", agentKey: "role:tracking_engineer" }, null, {
      name: d.name,
      title: d.title,
      summary: d.summary,
      keyPoints: d.keyPoints,
      url: d.sources[0] ?? null,
      text: `${d.text}\nSources: ${d.sources.join(" · ")}`,
      method: "playbook",
    });
  return { seeded: todo.length };
}
