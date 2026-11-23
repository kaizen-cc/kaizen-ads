import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasLine } from "@/lib/service-gate";
import { weekStartOf } from "@/lib/line-review/core";
import { emailBadWeek, stepinWorthy, nextStatus, perExec, severityOf, suggestStep, trendOf, type CardStatus, type Reason } from "./core";

// The executives' step-ins, built Monday morning and refreshed every morning after (cron ?step=stepins). One living
// card per client in exec_stepins: opened when the account needs an exec, kept current through the week, closed as
// recovered when it no longer does (or handled by an exec), reopened if it slides again. Read only on everything else.

const DAY = 86_400_000;
const LIVE = ["active", "onboarding"];
const nyDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
/** "Jorgi (Head of Email)": a first name with its role, the same way everywhere */
function personLabel(p: { full_name: string; role: string } | null, fallback: string): string {
  if (!p) return fallback;
  const first = p.full_name.trim().split(/\s+/)[0] || p.full_name;
  return `${first} (${roleName(p.role)})`;
}
let roleName: (r: string) => string = (r) => r;
/** Who owes what, to whom: "Kyle (Head of Meta) owes a reply to Zach Osness" */
function owesLine(owner: string, what: string, kind: string | null): string {
  const w = what.replace(/^(?:a |the )?reply to /i, "a reply to ");
  return kind === "owed" ? `${owner} owes ${w}` : kind === "said" ? `${owner} promised ${what.replace(/^you said:?\s*/i, "")}` : `${owner}: ${what}`;
}

const PLATFORM: Record<string, string> = { meta: "Meta", google: "Google", tiktok: "TikTok" };
const money = (n: number) => `$${n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2)}`;

export type StepinCard = {
  client: { id: string; name: string; slug: string };
  kpis: { platform: string; label: string | null; value: number | null; target: number | null; roas: boolean; worse: number | null; trend: "better" | "worse" | "flat" | null; stat: string | null }[];
  team: { done: string[]; notDone: string[]; lastUpdateDays: number | null };
  owners: { name: string; role: string }[];
  step: string;
  reviews: { line: string; id: string }[];
};

type Cand = { clientId: string; reasons: Reason[] };

export async function runStepins(admin: SupabaseClient, now = new Date()) {
  const { roleLabel: rl } = await import("@/lib/roles");
  roleName = (r) => rl(r as Parameters<typeof rl>[0]);
  const today = nyDay(now);
  const week = weekStartOf(today);
  const [{ liveFires, accountsForExecs }, { data: clients }] = await Promise.all([import("@/lib/exec-focus/server"), admin.from("clients").select("id, name, slug, services, services_extra, services_removed, strategy_only").is("archived_at", null).in("status", LIVE)]);
  const live = new Map(((clients ?? []) as { id: string; name: string; slug: string; services: string[] | null; services_extra: string[] | null; services_removed: string[] | null; strategy_only: string[] | null }[]).map((c) => [c.id, c]));
  const cands = new Map<string, Cand>();
  const add = (clientId: string | null, r: Reason) => {
    if (!clientId || !live.has(clientId)) return;
    const c = cands.get(clientId) ?? { clientId, reasons: [] };
    if (!c.reasons.some((x) => x.kind === r.kind && x.title === r.title)) c.reasons.push(r);
    cands.set(clientId, c);
  };

  // 1. Fires: every exec, company-wide
  const fires = await liveFires(admin, now).catch(() => []);
  for (const f of fires) add(f.clientId, { kind: "fire", line: null, title: `On fire: ${f.why}`, detail: String(f.body ?? "").slice(0, 300), since: f.at ?? null });

  // 2. Ad accounts 50%+ off for over 7 days, nothing person-driven in motion
  const reach = await accountsForExecs(admin, now).catch(() => new Map<string, { worse: number; days: number }>());
  const reachIds = [...reach.keys()];
  const [{ data: reachTargets }, { data: allTargets }, { data: snaps }] = await Promise.all([
    reachIds.length ? admin.from("kpi_targets").select("id, client_id, platform, label, conversion, target").in("id", reachIds) : Promise.resolve({ data: [] }),
    admin.from("kpi_targets").select("id, client_id, platform, label, conversion, target").eq("active", true).not("target", "is", null),
    admin.from("kpi_snapshots").select("target_id, windows, status"),
  ]);
  const snapBy = new Map(((snaps ?? []) as { target_id: string; windows: Record<string, { value?: number | null }> | null; status: string | null }[]).map((s) => [s.target_id, s]));
  const roasOf = (conv: string | null) => conv === "roas" || conv === "tiktok_roas";
  const statOf = (t: { conversion: string | null; target: number | null }, v: number | null | undefined) => (v == null || t.target == null ? null : roasOf(t.conversion) ? `ROAS ${Number(v).toFixed(2)}x vs ${Number(t.target).toFixed(2)}x` : `${money(Number(v))} per result vs ${money(Number(t.target))}`);
  for (const t of (reachTargets ?? []) as { id: string; client_id: string; platform: string; label: string | null; conversion: string | null; target: number | null }[]) {
    const r = reach.get(t.id)!;
    const v = snapBy.get(t.id)?.windows?.d7?.value ?? null;
    add(t.client_id, { kind: "account", line: t.platform, title: `${PLATFORM[t.platform] ?? t.platform} ${Math.round(r.worse * 100)}% off target for ${r.days} days, nothing in motion`, detail: `${t.label ? `${t.label}: ` : ""}no sprint acted on this week, no audit by a person, no plan worked on in 2 weeks.`, stat: statOf(t, v), since: new Date(now.getTime() - r.days * DAY).toISOString() });
  }

  // 3. Email in the bad band all week, nothing moving
  const emailIds = [...live.values()].filter((c) => hasLine(c, "email") && !(c.strategy_only ?? []).includes("email-marketing")).map((c) => c.id);
  if (emailIds.length) {
    const [{ data: scores }, { data: sprints }, { data: audits }, { data: acts }] = await Promise.all([
      admin.from("email_score_days").select("client_id, day, score").in("client_id", emailIds).gte("day", new Date(now.getTime() - 9 * DAY).toISOString().slice(0, 10)).limit(5000),
      admin.from("email_sprints").select("id, client_id, started_at").eq("status", "active").in("client_id", emailIds),
      admin.from("email_audits").select("client_id, created_at, auto").in("client_id", emailIds).gte("created_at", new Date(now.getTime() - 14 * DAY).toISOString()),
      admin.from("email_sprint_actions").select("sprint_id").not("done_by", "is", null).gte("done_at", new Date(now.getTime() - 7 * DAY).toISOString()).limit(2000),
    ]);
    const acted = new Set((acts ?? []).map((a) => a.sprint_id as string));
    const moving = new Set([
      ...(sprints ?? []).filter((s) => acted.has(s.id as string) || (s.started_at && Date.parse(s.started_at as string) >= now.getTime() - 7 * DAY)).map((s) => s.client_id as string),
      ...(audits ?? []).filter((a) => !a.auto).map((a) => a.client_id as string),
    ]);
    for (const id of emailIds) {
      if (moving.has(id)) continue;
      const bad = emailBadWeek(((scores ?? []) as { client_id: string; day: string; score: number }[]).filter((s) => s.client_id === id).map((s) => ({ day: s.day, score: Number(s.score) })), today);
      if (bad) add(id, { kind: "email", line: "email", title: `Email score in the red all week (${Math.round(bad.score)})`, detail: "No email sprint acted on this week and no audit by a person in 2 weeks.", stat: `Score ${Math.round(bad.score)} / 100`, since: null });
    }
  }

  // 4. Items that climbed past the lead (rung 3), one reason per client
  const { data: rung3 } = await admin
    .from("ladder_nudges")
    .select("item_key, kind, client_id, line, what, since, owner:profiles!ladder_nudges_owner_id_fkey(full_name, role), lead:profiles!ladder_nudges_lead_id_fkey(full_name, role)")
    .not("exec_at", "is", null)
    .is("taken_by", null)
    .in("status", ["open", "sent"])
    .not("client_id", "is", null)
    .limit(1000);
  const byClient = new Map<string, { line: string | null; what: string[]; owner: string; lead: string; since: string; kind: string | null }[]>();
  type R3 = { item_key: string; kind: string | null; client_id: string; line: string | null; what: string; since: string; owner: { full_name: string; role: string } | null; lead: { full_name: string; role: string } | null };
  const worthy = stepinWorthy(((rung3 ?? []) as unknown as R3[]).map((r) => ({ ...r, itemKey: r.item_key, clientId: r.client_id })));
  for (const r of worthy)
    byClient.set(r.client_id, [...(byClient.get(r.client_id) ?? []), { line: r.line, what: [r.what], owner: personLabel(r.owner, "the owner"), lead: personLabel(r.lead, "the lead"), since: r.since, kind: r.kind }]);
  for (const [clientId, rows] of byClient) {
    const lines = [...new Set(rows.map((r) => r.line))];
    for (const line of lines) {
      const mine = rows.filter((r) => r.line === line);
      add(clientId, { kind: "escalated", line, title: `${mine.length} item${mine.length === 1 ? "" : "s"} stuck past ${mine[0].lead}`, detail: mine.slice(0, 3).map((m) => owesLine(m.owner, m.what[0], m.kind)).join("; ").slice(0, 300), since: mine.map((m) => m.since).sort()[0] ?? null });
    }
  }

  // ─── The cards: numbers vs target, what the team has and hasn't done, who owns it ─────
  const ids = [...cands.keys()];
  const [{ data: seats }, { data: people }, { data: reviews }, { data: existing }] = await Promise.all([
    ids.length ? admin.from("client_assignments").select("client_id, profile_id, role, is_primary").in("client_id", ids) : Promise.resolve({ data: [] }),
    admin.from("profiles").select("id, full_name, role, is_active, is_exec, exec_focus"),
    ids.length ? admin.from("line_reviews").select("id, client_id, line, review").eq("week_start", week).in("client_id", ids) : Promise.resolve({ data: [] }),
    admin.from("exec_stepins").select("id, client_id, status, handled_at, reasons"),
  ]);
  const pById = new Map(((people ?? []) as { id: string; full_name: string; role: string; is_active: boolean }[]).map((p) => [p.id, p]));
  const { roleLabel } = await import("@/lib/roles");
  const curBy = new Map(((existing ?? []) as { id: string; client_id: string; status: CardStatus; handled_at: string | null; reasons: Reason[] | null }[]).map((e) => [e.client_id, e]));
  const at = now.toISOString();
  let opened = 0;
  let reopened = 0;
  let closed = 0;
  const kept: { reasons: Reason[] }[] = [];
  for (const cand of cands.values()) {
    const c = live.get(cand.clientId)!;
    const owners = ((seats ?? []) as { client_id: string; profile_id: string; role: string; is_primary: boolean | null }[])
      .filter((s) => s.client_id === c.id && ["meta_buyer", "google_buyer", "tiktok_buyer", "email_strategist", "social_manager"].includes(s.role))
      .sort((a, b) => Number(b.is_primary) - Number(a.is_primary))
      .map((s) => pById.get(s.profile_id))
      .filter((p): p is { id: string; full_name: string; role: string; is_active: boolean } => Boolean(p?.is_active))
      .map((p) => ({ name: p.full_name, role: roleLabel(p.role as Parameters<typeof roleLabel>[0]) }));
    const uniqOwners = owners.filter((o, i) => owners.findIndex((x) => x.name === o.name) === i).slice(0, 4);
    const kpis = ((allTargets ?? []) as { id: string; client_id: string; platform: string; label: string | null; conversion: string | null; target: number | null }[])
      .filter((t) => t.client_id === c.id)
      .map((t) => {
        const w = snapBy.get(t.id)?.windows ?? {};
        const v = w.d7?.value ?? null;
        const roas = roasOf(t.conversion);
        const worse = v == null || t.target == null || !(Number(t.target) > 0) ? null : roas ? (Number(t.target) - v) / Number(t.target) : (v - Number(t.target)) / Number(t.target);
        return { platform: PLATFORM[t.platform] ?? t.platform, label: t.label, value: v, target: t.target == null ? null : Number(t.target), roas, worse, trend: trendOf({ d7: v, d30: w.d30?.value ?? null, roas }), stat: statOf(t, v) };
      })
      .slice(0, 4);
    const revs = ((reviews ?? []) as { id: string; client_id: string; line: string; review: { scope?: { delivered?: { text: string }[]; promised?: { text: string }[] }; commitments?: { text: string }[]; health?: { clientSilent?: number | null } } }[]).filter((r) => r.client_id === c.id);
    const done = revs.flatMap((r) => (r.review.scope?.delivered ?? []).map((d) => d.text)).filter((t) => !/^0 |No .* linked|: \$0$/.test(t)).slice(0, 4);
    const notDone = revs.flatMap((r) => [...(r.review.commitments ?? []), ...(r.review.scope?.promised ?? [])].map((d) => d.text)).slice(0, 4);
    const silent = revs.map((r) => r.review.health?.clientSilent).filter((x): x is number => x != null);
    const card: StepinCard = {
      client: { id: c.id, name: c.name, slug: c.slug },
      kpis,
      team: { done, notDone, lastUpdateDays: silent.length ? Math.min(...silent) : null },
      owners: uniqOwners,
      step: suggestStep(cand.reasons, uniqOwners[0]?.name.split(" ")[0] ?? null),
      reviews: revs.map((r) => ({ line: r.line, id: r.id })),
    };
    const cur = curBy.get(c.id) ?? null;
    const fire = cand.reasons.some((r) => r.kind === "fire");
    const ns = nextStatus(cur ? { status: cur.status, handledAt: cur.handled_at, hadFire: (cur.reasons ?? []).some((r) => r.kind === "fire") } : null, { qualifies: true, fire, now })!;
    const lines = [...new Set(cand.reasons.map((r) => r.line).filter((l): l is string => Boolean(l)))];
    const row = { client_id: c.id, status: ns.status, reasons: cand.reasons, card, lines, fire, severity: severityOf(cand.reasons), week_start: week, last_seen_at: at, updated_at: at };
    if (!cur) {
      await admin.from("exec_stepins").insert({ ...row, opened_at: at });
      opened++;
    } else await admin.from("exec_stepins").update({ ...row, ...(ns.reopened ? { reopened_at: at, handled_at: null, handled_by: null, handled_note: null, closed_at: null } : {}) }).eq("id", cur.id);
    if (ns.reopened) reopened++;
    if (ns.status === "open") kept.push({ reasons: cand.reasons });
  }
  // What no longer needs an exec closes as recovered
  for (const cur of curBy.values()) {
    if (cands.has(cur.client_id) || cur.status !== "open") continue;
    await admin.from("exec_stepins").update({ status: "recovered", closed_at: at, updated_at: at }).eq("id", cur.id);
    closed++;
  }
  const execs = ((people ?? []) as { full_name: string; is_active: boolean; is_exec: boolean | null; role: string; exec_focus: string[] | null }[]).filter((p) => p.is_active && (p.is_exec || p.role === "executive")).map((p) => ({ name: p.full_name, focus: p.exec_focus ?? [] }));
  return { week, open: kept.length, opened, reopened, closed, perExec: perExec(kept, execs) };
}
