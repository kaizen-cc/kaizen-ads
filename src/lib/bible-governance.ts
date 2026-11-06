import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { conversionFor } from "@/lib/kpi/conversions";
import { applyAvatarChange, avatarKey, avatarsOf, mentionsAvatar, type AvatarKind, type AvatarResults, type ProposedAvatar } from "@/lib/bible-avatars";

// Who may change a client's Brand Bible, and the way everyone else changes it: a proposal the approvers decide.
// - Edit (the review chat, answering open questions straight in, rebuilding): execs, leads (the Head of Creative among
//   them) and the client's account manager (their coordinator). Everyone else reads it.
// - Approve proposals (avatars added, changed or retired; answers from people who can't edit): execs, the Head of
//   Creative and the client's account manager.
// Enforced here and in the database (private.can_edit_bible on client_brand_bibles updates).

type Admin = SupabaseClient;

async function isAccountManager(admin: Admin, profileId: string, clientId: string) {
  const { data } = await admin.from("client_assignments").select("profile_id").eq("client_id", clientId).eq("profile_id", profileId).eq("role", "coordinator").limit(1).maybeSingle();
  return Boolean(data);
}

/** Execs, leads and the client's account manager edit the Bible; everyone else reads it and proposes */
export async function canEditBible(admin: Admin, me: Staff, clientId: string) {
  if (me.isExec || me.isLead) return true;
  return isAccountManager(admin, me.id, clientId);
}

/** Execs, the Head of Creative and the client's account manager decide proposals */
export async function canApproveBible(admin: Admin, me: Staff, clientId: string) {
  if (me.isExec || me.role === "head_of_creative") return true;
  return isAccountManager(admin, me.id, clientId);
}

/** Everyone who decides this client's proposals */
export async function approverIds(admin: Admin, clientId: string) {
  const [{ data: heads }, { data: ams }] = await Promise.all([
    admin.from("profiles").select("id, is_exec, role").eq("is_active", true).or("is_exec.eq.true,role.eq.head_of_creative"),
    admin.from("client_assignments").select("profile_id").eq("client_id", clientId).eq("role", "coordinator"),
  ]);
  return [...new Set([...(heads ?? []).map((h) => h.id as string), ...(ams ?? []).map((a) => a.profile_id as string)])];
}

export type BibleChange = {
  id: string;
  kind: AvatarKind | "question_answer";
  avatar: string | null;
  proposed: ProposedAvatar | null;
  questionId: string | null;
  answer: string | null;
  reason: string;
  evidence: string;
  status: "pending" | "approved" | "rejected";
  proposedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
  createdAt: string;
};

const toChange = (r: Record<string, unknown>): BibleChange => ({
  id: r.id as string,
  kind: r.kind as BibleChange["kind"],
  avatar: (r.avatar as string | null) ?? null,
  proposed: (r.proposed as ProposedAvatar | null) ?? null,
  questionId: (r.question_id as string | null) ?? null,
  answer: (r.answer as string | null) ?? null,
  reason: (r.reason as string) ?? "",
  evidence: (r.evidence as string) ?? "",
  status: r.status as BibleChange["status"],
  proposedBy: (r.proposed_by_name as string | null) ?? null,
  decidedBy: (r.decided_by_name as string | null) ?? null,
  decidedAt: (r.decided_at as string | null) ?? null,
  note: (r.decision_note as string | null) ?? null,
  createdAt: r.created_at as string,
});

/** The client's proposals, newest first (pending, then the record of decisions) */
export async function loadChanges(db: SupabaseClient, clientId: string): Promise<BibleChange[]> {
  const { data } = await db.from("bible_changes").select("*").eq("client_id", clientId).order("created_at", { ascending: false }).limit(80);
  return (data ?? []).map(toChange);
}

const day = () => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(new Date());

async function notify(admin: Admin, clientId: string, ids: string[], n: { title: string; body: string; key: string; critical?: boolean; q?: string }) {
  if (!ids.length) return;
  const { data: c } = await admin.from("clients").select("name, slug").eq("id", clientId).single();
  if (!c) return;
  await admin.from("notifications").upsert(
    ids.map((id) => ({
      profile_id: id,
      kind: "client",
      title: `${c.name}: ${n.title}`.slice(0, 200),
      body: n.body.slice(0, 1000),
      href: `/clients/${c.slug}/brand-bible?${n.q ?? "changes=1"}`,
      client_id: clientId,
      key: n.key,
      priority: n.critical ? "critical" : "normal",
    })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
}

export type Proposal =
  | { kind: "avatar_add"; proposed: ProposedAvatar; reason: string; evidence: string }
  | { kind: "avatar_change"; avatar: string; proposed: ProposedAvatar; reason: string; evidence: string }
  | { kind: "avatar_retire"; avatar: string; reason: string; evidence: string }
  | { kind: "question_answer"; questionId: string; answer: string; reason?: string; evidence?: string };

const KIND_WORDS: Record<BibleChange["kind"], string> = {
  avatar_add: "add an avatar",
  avatar_change: "change an avatar",
  avatar_retire: "retire an avatar",
  question_answer: "answer an open question",
};

/** Anyone who works on the client proposes; it goes to the approvers as a notification */
export async function propose(admin: Admin, me: Staff, clientId: string, p: Proposal): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const clip = (s: string | undefined, n: number) => (s ?? "").trim().slice(0, n);
  const reason = clip(p.reason, 2000);
  const evidence = clip(p.evidence, 4000);
  if (p.kind !== "question_answer" && !reason) return { ok: false, error: "Say why: the approvers decide from the reason and the evidence." };
  const { data: b } = await admin.from("client_brand_bibles").select("markdown").eq("client_id", clientId).maybeSingle();
  if (!b?.markdown) return { ok: false, error: "There's no Brand Bible yet." };
  const current = avatarsOf(b.markdown as string).filter((a) => !a.retired);
  let avatar: string | null = null;
  let proposed: ProposedAvatar | null = null;
  if (p.kind === "avatar_change" || p.kind === "avatar_retire") {
    const hit = current.find((a) => avatarKey(a.name) === avatarKey(p.avatar));
    if (!hit) return { ok: false, error: "That avatar isn't in the Bible anymore." };
    avatar = hit.name;
  }
  if (p.kind === "avatar_add" || p.kind === "avatar_change") {
    const name = clip(p.proposed.name, 120);
    const body = clip(p.proposed.body, 6000);
    if (!name) return { ok: false, error: "Give the avatar a name." };
    if (!body) return { ok: false, error: "Describe who they are: what they want, what stops them, what makes them act." };
    if (p.kind === "avatar_add" && current.some((a) => avatarKey(a.name) === avatarKey(name))) return { ok: false, error: `"${name}" is already an avatar: propose a change to it instead.` };
    proposed = { name, body, tier: ["Proven", "Likely", "Hypothesis"].includes(p.proposed.tier) ? p.proposed.tier : "Hypothesis" };
  }
  let questionId: string | null = null;
  let answer: string | null = null;
  if (p.kind === "question_answer") {
    const { data: q } = await admin.from("bible_questions").select("id, stage").eq("id", p.questionId).eq("client_id", clientId).maybeSingle();
    if (!q || q.stage === "answered") return { ok: false, error: "That question isn't open anymore." };
    answer = clip(p.answer, 6000);
    if (!answer) return { ok: false, error: "Write an answer first." };
    questionId = q.id as string;
  }
  // One open proposal per avatar at a time, so the approvers don't decide two versions of the same thing
  if (avatar) {
    const { data: open } = await admin.from("bible_changes").select("id").eq("client_id", clientId).eq("status", "pending").eq("avatar", avatar).limit(1).maybeSingle();
    if (open) return { ok: false, error: `There's already a proposal waiting on ${avatar}.` };
  }
  const { data: row, error } = await admin
    .from("bible_changes")
    .insert({ client_id: clientId, kind: p.kind, avatar, proposed, question_id: questionId, answer, reason, evidence, proposed_by: me.id, proposed_by_name: me.fullName })
    .select("id")
    .single();
  if (error || !row) return { ok: false, error: error?.message ?? "Couldn't save it." };
  const who = (await approverIds(admin, clientId)).filter((id) => id !== me.id);
  const what = p.kind === "avatar_add" ? `add "${proposed!.name}"` : p.kind === "avatar_change" ? `change "${avatar}"` : p.kind === "avatar_retire" ? `retire "${avatar}"` : "answer an open question";
  await notify(admin, clientId, who, {
    title: `a Brand Bible change to approve`,
    body: `${me.fullName} proposes to ${what}.${reason ? ` Why: ${reason.slice(0, 300)}` : ""}`,
    key: `bible-change:${row.id}`,
    q: `change=${row.id}`,
  });
  return { ok: true, id: row.id as string };
}

/**
 * An approver decides. Approved: applied to the Bible (avatars) or folded in as the answer (questions), logged in the
 * change log. Rejected: kept with why. Either way the proposer hears.
 */
export async function decide(admin: Admin, me: Staff, clientId: string, id: string, approve: boolean, note: string): Promise<{ ok: true; applied: boolean } | { ok: false; error: string }> {
  if (!(await canApproveBible(admin, me, clientId))) return { ok: false, error: "Only execs, the Head of Creative and the client's account manager approve Bible changes." };
  const { data: r } = await admin.from("bible_changes").select("*").eq("id", id).eq("client_id", clientId).maybeSingle();
  if (!r) return { ok: false, error: "That proposal isn't there." };
  if (r.status !== "pending") return { ok: false, error: `It was already ${r.status}.` };
  const c = toChange(r);
  const why = note.trim().slice(0, 1000);
  if (!approve && !why) return { ok: false, error: "Say why it's rejected, so the proposer knows." };
  const today = day();
  let applied = false;
  if (approve) {
    if (c.kind === "question_answer") {
      if (!c.questionId || !c.answer) return { ok: false, error: "The question is gone." };
      const { discussQuestion } = await import("@/lib/bible-questions");
      const out = await discussQuestion(admin, clientId, c.questionId, { text: c.answer, by: `${c.proposedBy ?? "Team"} (approved by ${me.fullName})`, via: "team" });
      if (!out.ok) return { ok: false, error: out.error };
      applied = out.answered;
    } else {
      const { data: b } = await admin.from("client_brand_bibles").select("markdown").eq("client_id", clientId).maybeSingle();
      if (!b?.markdown) return { ok: false, error: "There's no Brand Bible yet." };
      const next = applyAvatarChange(b.markdown as string, { kind: c.kind, avatar: c.avatar, proposed: c.proposed, reason: c.reason }, today);
      if (!next) return { ok: false, error: "That avatar isn't in the Bible anymore: reject it with a note." };
      const { logChange } = await import("@/lib/bible-sections");
      const name = c.proposed?.name ?? c.avatar ?? "";
      const line = `${today}: ${c.kind === "avatar_add" ? `Avatar added: ${name}` : c.kind === "avatar_change" ? `Avatar changed: ${c.avatar}${c.proposed && avatarKey(c.proposed.name) !== avatarKey(c.avatar ?? "") ? ` (now ${c.proposed.name})` : ""}, the old profile kept as retired` : `Avatar retired: ${c.avatar}`} (proposed by ${c.proposedBy ?? "the team"}, approved by ${me.fullName})`;
      const { error } = await admin.from("client_brand_bibles").update({ markdown: logChange(next, line) }).eq("client_id", clientId);
      if (error) return { ok: false, error: error.message };
      applied = true;
    }
  }
  await admin
    .from("bible_changes")
    .update({ status: approve ? "approved" : "rejected", decided_by: me.id, decided_by_name: me.fullName, decided_at: new Date().toISOString(), decision_note: why || null })
    .eq("id", id);
  // The approvers' notices for it are done with
  await admin.from("notifications").update({ read_at: new Date().toISOString() }).eq("key", `bible-change:${id}`).is("read_at", null);
  if (r.proposed_by && r.proposed_by !== me.id)
    await notify(admin, clientId, [r.proposed_by as string], {
      title: `your Bible proposal was ${approve ? "approved" : "rejected"}`,
      body: `${me.fullName} ${approve ? "approved" : "rejected"} your proposal to ${KIND_WORDS[c.kind]}${c.avatar ? ` (${c.avatar})` : c.proposed ? ` (${c.proposed.name})` : ""}.${why ? ` ${why}` : ""}`,
      key: `bible-change-decided:${id}`,
      q: `change=${id}`,
    });
  return { ok: true, applied };
}

/**
 * How the ads made for each avatar did, from the client playbook (every ad, its totals and verdict against the KPI).
 * An ad counts for an avatar when the playbook tagged it with that avatar or angle, or its ticket names the avatar (its
 * avatar field once requests carry one, its angle or its audience).
 */
export async function avatarResults(admin: Admin, clientId: string, avatars: string[]): Promise<Record<string, AvatarResults>> {
  if (!avatars.length) return {};
  const [{ data: ads }, { data: kpi }] = await Promise.all([
    admin.from("client_ledger").select("key, detail, spend, results, revenue, verdict, result_label, target").eq("client_id", clientId).eq("kind", "creative").limit(5000),
    admin.from("kpi_targets").select("conversion, target").eq("client_id", clientId).eq("platform", "meta").eq("active", true).limit(1).maybeSingle(),
  ]);
  if (!ads?.length) return {};
  const tickets = [...new Set(ads.map((a) => Number((a.detail as { ticket?: number }).ticket)).filter((n) => n > 0))];
  // The tickets the ads came from, read whole so an avatar field added to requests is picked up without a change here
  const { data: reqs } = tickets.length ? await admin.from("requests").select("*, angles(name)").eq("client_id", clientId).in("number", tickets) : { data: [] };
  const words = new Map<number, string[]>();
  for (const q of (reqs ?? []) as Record<string, unknown>[]) {
    const own = Object.entries(q)
      .filter(([k, v]) => /avatar/i.test(k) && typeof v === "string")
      .map(([, v]) => v as string);
    words.set(q.number as number, [...own, (q.angles as { name?: string } | null)?.name ?? "", (q.audience as string | null) ?? ""].filter(Boolean));
  }
  const roas = kpi ? Boolean(conversionFor(String(kpi.conversion)).roas) : false;
  const out: Record<string, AvatarResults> = {};
  for (const name of avatars) {
    const mine = ads.filter((a) => {
      const d = a.detail as { avatar?: string; angle?: string; ticket?: number };
      return mentionsAvatar(name, d.avatar) || mentionsAvatar(name, d.angle) || (words.get(Number(d.ticket)) ?? []).some((w) => mentionsAvatar(name, w));
    });
    if (!mine.length) continue;
    out[name] = {
      ads: mine.length,
      spend: mine.reduce((n, a) => n + Number(a.spend || 0), 0),
      results: mine.reduce((n, a) => n + Number(a.results || 0), 0),
      revenue: mine.reduce((n, a) => n + Number(a.revenue || 0), 0),
      winners: mine.filter((a) => a.verdict === "winner").length,
      losers: mine.filter((a) => a.verdict === "loser").length,
      resultLabel: (mine.find((a) => a.result_label)?.result_label as string | undefined) ?? "results",
      roas,
      target: kpi?.target != null ? Number(kpi.target) : ((mine.find((a) => a.target != null)?.target as number | undefined) ?? null),
    };
  }
  return out;
}
