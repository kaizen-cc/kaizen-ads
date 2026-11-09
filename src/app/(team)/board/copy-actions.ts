"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { AiUnavailable, askJson, clientContext, contextBlock, COPY_CHAT_SCHEMA, COPY_CHAT_SYSTEM, type CopyLesson, type CopyViolation } from "@/lib/ai";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { can } from "@/lib/chat-permissions";
import { adsHash, blockers, isDismissed, type Ad, type Dismissed } from "@/lib/copy";
import { draftCopy, learnFromCopy, storeCopyCheck } from "@/lib/copy-draft";
import { onReachedClient } from "@/lib/client-revision";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type CopySet = {
  id: string;
  status: "drafting" | "review" | "approved" | "failed";
  ads: Ad[];
  aiAds: Ad[];
  notes: string | null;
  error: string | null;
  version: number;
  approvedBy: string | null;
  approvedAt: string | null;
  updatedAt: string;
  reusedFrom: string | null;
  progress: { written?: number; total?: number; label?: string };
  clientNotes: string | null; // the client's copy notes this revision answers
  changes: { ad: number; what: string }[] | null;
  scope: "amend" | "rewrite" | null;
  clientStatus: { status: "approved" | "changes" | null; note?: string | null }[]; // per ad; approved = locked
  /** The check against what the client told us, for the exact words it read (hash); null until it has run */
  check: { violations: CopyViolation[]; hash: string; at: string } | null;
  /** Flags the copywriter or a lead rebutted for this copy (by rule and quote), with why */
  dismissed: Dismissed[];
  /** Carousels: each carousel's card headlines and descriptions, by design */
  cards: Record<string, { headline: string; description: string }[]>;
};
export type CopyState = { set: CopySet | null; reusable: { id: string; title: string; approvedAt: string | null; ads: Ad[] } | null };

const toSet = (s: Record<string, unknown>): CopySet => ({
  id: s.id as string,
  status: s.status as CopySet["status"],
  ads: (s.ads ?? []) as Ad[],
  aiAds: (s.ai_ads ?? []) as Ad[],
  notes: (s.notes as string | null) ?? null,
  error: (s.error as string | null) ?? null,
  version: s.version as number,
  approvedBy: (s.profiles as { full_name: string } | null)?.full_name ?? null,
  approvedAt: (s.approved_at as string | null) ?? null,
  updatedAt: s.updated_at as string,
  reusedFrom: (s.reused_from as string | null) ?? null,
  progress: (s.progress ?? {}) as CopySet["progress"],
  clientNotes: (s.client_notes as string | null) ?? null,
  changes: (s.changes as CopySet["changes"]) ?? null,
  scope: (s.scope as CopySet["scope"]) ?? null,
  clientStatus: (s.client_status ?? []) as CopySet["clientStatus"],
  check: s.checked_hash ? { violations: (s.violations ?? []) as CopyViolation[], hash: s.checked_hash as string, at: s.checked_at as string } : null,
  dismissed: (s.dismissed ?? []) as Dismissed[],
  cards: (s.cards ?? {}) as CopySet["cards"],
});

/** The ticket's copy set, and an approved set for the same angle that could be reused instead of re-asking. */
export async function ticketCopy(requestId: string): Promise<CopyState> {
  await requireStaff();
  const supabase = await createClient();
  const [{ data: set }, { data: r }] = await Promise.all([
    supabase.from("copy_sets").select("*, profiles!copy_sets_approved_by_fkey(full_name)").eq("request_id", requestId).maybeSingle(),
    supabase.from("requests").select("client_id, angle_id").eq("id", requestId).maybeSingle(),
  ]);
  let reusable: CopyState["reusable"] = null;
  if (r?.angle_id && set?.status !== "approved") {
    const { data: other } = await supabase
      .from("copy_sets")
      .select("id, ads, approved_at, requests(title)")
      .eq("client_id", r.client_id)
      .eq("angle_id", r.angle_id)
      .eq("status", "approved")
      .neq("request_id", requestId)
      .order("approved_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (other) reusable = { id: other.id, title: (other.requests as unknown as { title: string } | null)?.title ?? "Another ticket", approvedAt: other.approved_at, ads: other.ads as Ad[] };
  }
  return { set: set ? toSet(set) : null, reusable };
}

/** Write (or rewrite with a note from copy review) the copy set. It runs in the background; ticketCopy shows its progress. */
export async function redraftCopy(requestId: string, note?: string): Promise<{ ok: true; state: CopyState } | { ok: false; error: string }> {
  const me = await requireStaff();
  // Writing copy: the copywriter, the heads, the buyers and the executives (src/lib/chat-permissions.ts)
  const writes = can(me, "copy");
  if (!writes.ok) return { ok: false, error: writes.reason };
  const supabase = await createClient();
  const { data: visible } = await supabase.from("requests").select("id, client_id, angle_id").eq("id", requestId).maybeSingle();
  if (!visible) return { ok: false, error: "Ticket not found." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const admin = createAdminClient();
  await admin
    .from("copy_sets")
    .upsert(
      { request_id: requestId, client_id: visible.client_id, angle_id: visible.angle_id, status: "drafting", error: null, progress: { written: 0, total: 5, label: note?.trim() ? "Reading your notes" : "Reading the brief, the creative and the client's voice" }, updated_at: new Date().toISOString() },
      { onConflict: "request_id" },
    );
  after(async () => {
    try {
      await draftCopy(admin, requestId, me.id, note);
    } catch (e) {
      console.error("[copy] redraft failed:", e instanceof AiUnavailable ? e.message : e);
    }
  });
  return { ok: true, state: await ticketCopy(requestId) };
}

/** Copy review's edits, saved as they type. Ads the client approved stay exactly as approved. */
export async function saveCopy(setId: string, ads: Ad[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  const supabase = await createClient();
  const { data: current } = await supabase.from("copy_sets").select("ads, client_status").eq("id", setId).maybeSingle();
  const status = (current?.client_status ?? []) as { status: string | null }[];
  ads = ads.map((a, i) => (status[i]?.status === "approved" && (current?.ads as Ad[] | undefined)?.[i] ? (current!.ads as Ad[])[i] : a));
  const { error } = await supabase.from("copy_sets").update({ ads: ads.slice(0, 5), updated_by: me.id, updated_at: new Date().toISOString() }).eq("id", setId).neq("status", "approved");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * The check against what the client told us, for these exact words: kept with the copy, so the studio, the ticket and
 * approving all show the same thing. Runs when the studio opens and again after edits; returns the kept result when the
 * words haven't changed since.
 */
export async function checkCopy(setId: string, ads: Ad[]): Promise<{ ok: true; violations: CopyViolation[]; hash: string } | { ok: false; error: string }> {
  await requireStaff();
  const supabase = await createClient();
  const { data: s } = await supabase.from("copy_sets").select("request_id, client_id, violations, checked_hash, status").eq("id", setId).maybeSingle();
  if (!s) return { ok: false, error: "Copy not found." };
  const hash = adsHash(ads);
  if (s.checked_hash === hash) return { ok: true, violations: (s.violations ?? []) as CopyViolation[], hash };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  try {
    const violations = await storeCopyCheck(createAdminClient(), s.request_id, s.client_id, ads);
    return { ok: true, violations, hash };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "The check didn't run." };
  }
}

/**
 * The copywriter (or a lead) says a flag reads the client's rule too strictly ("the client approved 'fresh, never frozen'
 * on the Oct 12 call"): set aside for this copy, logged on the ticket, kept as a learning the copy check, the copywriter
 * and the client's rules log read; the head of creative and the leads hear about it.
 */
export async function rebutFlag(setId: string, flag: { rule: string; quote: string; field: string }, reason: string): Promise<{ ok: true; dismissed: Dismissed[] } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!(isExecOrLead(me) || me.isCopywriter)) return { ok: false, error: "Only the copywriter or a lead can rebut a flag." };
  const why = reason.trim().slice(0, 600);
  if (why.length < 4) return { ok: false, error: "Say why it's fine, e.g. what the client allowed and when." };
  const supabase = await createClient();
  const { data: s } = await supabase.from("copy_sets").select("id, request_id, client_id, dismissed, requests(number, title), clients(name)").eq("id", setId).maybeSingle();
  if (!s || !adminConfigured()) return { ok: false, error: "Copy not found." };
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const dismissed = [...((s.dismissed ?? []) as Dismissed[]).filter((d) => !(d.rule === flag.rule && d.quote === flag.quote)), { rule: flag.rule, quote: flag.quote, reason: why, by: me.fullName, at: now }];
  await admin.from("copy_sets").update({ dismissed }).eq("id", setId);
  const { data: saved } = await admin
    .from("copy_rule_overrides")
    .insert({ client_id: s.client_id, request_id: s.request_id, set_id: setId, kind: "rebut", rule: flag.rule.slice(0, 400), quote: flag.quote.slice(0, 400), field: flag.field, reason: why, created_by: me.id })
    .select("id")
    .single();
  // A conditional learning for the copy check (the rule was read too strictly, and when), classified after the answer
  if (saved?.id)
    after(async () => {
      const { recordLearning } = await import("@/lib/learnings");
      await recordLearning(admin, { table: "copy_rule_overrides", id: saved.id as string, clientId: s.client_id as string, text: `Rule read too strictly: "${flag.rule}" on "${flag.quote}" · why: ${why}` });
    });
  const { data: req } = await admin.from("requests").select("stage").eq("id", s.request_id).maybeSingle();
  await admin.from("request_events").insert({ request_id: s.request_id, kind: "copy", from_stage: req?.stage ?? null, to_stage: req?.stage ?? null, actor_id: me.id, body: why, data: { action: "rebutted_flag", rule: flag.rule, quote: flag.quote } });
  // Not silent: a client rule may be loosening
  const t = s.requests as unknown as { number: number; title: string } | null;
  const { data: heads } = await admin.from("profiles").select("id").eq("is_active", true).or("is_lead.eq.true,role.eq.head_of_creative");
  const ids = (heads ?? []).map((h) => h.id as string).filter((id) => id !== me.id);
  if (ids.length)
    await admin.from("notifications").upsert(
      ids.map((id) => ({
        profile_id: id,
        kind: "ticket",
        title: `${(s.clients as unknown as { name: string } | null)?.name ?? "A client"}: a client rule was rebutted on #${t?.number ?? ""}`,
        body: `${me.fullName} says the copy check read "${flag.rule}" too strictly on "${flag.quote}": ${why}`.slice(0, 600),
        href: `/board?t=${t?.number ?? ""}&copy=1`,
        client_id: s.client_id,
        key: `copy-rebut:${setId}:${flag.rule}:${flag.quote}`.slice(0, 300),
        priority: "normal",
        actor_id: me.id,
      })),
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  revalidatePath("/board");
  return { ok: true, dismissed };
}

/**
 * Approve: saves the final edits and moves the ticket to Ready for client. Being a little off the length standard doesn't
 * stop it; missing copy does, and so does anything that goes against what the client told us (the check kept with the
 * copy, or run now if the words changed), unless the copywriter rebutted it. An exec or lead can force it past the
 * flags with a reason: logged, the media buyer told, and kept as a learning for later checks.
 */
export async function approveCopy(setId: string, ads: Ad[], force?: { reason: string }): Promise<{ ok: true } | { ok: false; error: string; violations?: CopyViolation[] }> {
  const me = await requireStaff();
  const missing = blockers(ads);
  if (missing.length) return { ok: false, error: missing[0] };
  if (force && !isExecOrLead(me)) return { ok: false, error: "Only execs and leads can force approve." };
  if (force && force.reason.trim().length < 4) return { ok: false, error: "Say why it's fine to approve it anyway." };
  const saved = await saveCopy(setId, ads);
  if (!saved.ok) return saved;
  const supabase = await createClient();
  const { data: owner } = await supabase.from("copy_sets").select("client_id, request_id, violations, checked_hash, dismissed").eq("id", setId).maybeSingle();
  let open: CopyViolation[] = [];
  if (owner && adminConfigured()) {
    try {
      const kept = owner.checked_hash === adsHash(ads) ? ((owner.violations ?? []) as CopyViolation[]) : await storeCopyCheck(createAdminClient(), owner.request_id, owner.client_id, ads);
      open = kept.filter((v) => !isDismissed(v, (owner.dismissed ?? []) as Dismissed[]));
      if (open.length && !force) return { ok: false, error: "This goes against what the client told us. Fix it before it's approved.", violations: open };
    } catch (e) {
      // If the check itself can't run, it doesn't hold the copy hostage
      console.error("[copy] client check failed:", e instanceof Error ? e.message : e);
    }
  }
  if (force && open.length && owner && adminConfigured()) {
    const admin = createAdminClient();
    const why = force.reason.trim().slice(0, 600);
    const { data: saved } = await admin
      .from("copy_rule_overrides")
      .insert(open.map((v) => ({ client_id: owner.client_id, request_id: owner.request_id, set_id: setId, kind: "force", rule: v.rule.slice(0, 400), quote: v.quote.slice(0, 400), field: v.field, reason: why, created_by: me.id })))
      .select("id, rule, quote");
    // Each flag approved past becomes a conditional learning for the copy check, classified after the answer
    after(async () => {
      const { recordLearning } = await import("@/lib/learnings");
      for (const o of saved ?? []) await recordLearning(admin, { table: "copy_rule_overrides", id: o.id as string, clientId: owner.client_id as string, text: `Rule read too strictly (approved past it by an exec or lead): "${o.rule}" on "${o.quote}" · why: ${why}` });
    });
    const { data: req } = await admin.from("requests").select("stage, number, title").eq("id", owner.request_id).maybeSingle();
    await admin.from("request_events").insert({ request_id: owner.request_id, kind: "copy", from_stage: req?.stage ?? null, to_stage: req?.stage ?? null, actor_id: me.id, body: why, data: { action: "force_approved", flags: open.map((v) => ({ ad: v.ad, rule: v.rule, quote: v.quote })) } });
    const { data: buyers } = await admin.from("client_assignments").select("profile_id").eq("client_id", owner.client_id).in("role", ["meta_buyer", "google_buyer", "tiktok_buyer"]);
    const ids = [...new Set((buyers ?? []).map((b) => b.profile_id as string))].filter((id) => id !== me.id);
    if (ids.length)
      await admin.from("notifications").upsert(
        ids.map((id) => ({
          profile_id: id,
          kind: "ticket",
          title: `#${req?.number ?? ""} copy approved over ${open.length} flagged client rule${open.length === 1 ? "" : "s"}`,
          body: `${me.fullName}: ${why} · Flagged: ${open.map((v) => `Ad ${v.ad} "${v.quote}" (${v.rule})`).join("; ")}`.slice(0, 900),
          href: `/board?t=${req?.number ?? ""}&copy=1`,
          client_id: owner.client_id,
          key: `copy-force:${setId}:${Date.now()}`,
          priority: "normal",
          actor_id: me.id,
        })),
        { onConflict: "profile_id,key", ignoreDuplicates: true },
      );
  }
  const { error } = await supabase.rpc("approve_copy", { p_set: setId });
  if (!error && adminConfigured()) {
    const { data: set } = await supabase.from("copy_sets").select("request_id").eq("id", setId).maybeSingle();
    const { data: now } = set ? await supabase.from("requests").select("stage").eq("id", set.request_id).maybeSingle() : { data: null };
    if (set)
      after(async () => {
        const admin = createAdminClient();
        try {
          await learnFromCopy(admin, set.request_id, me.id);
        } catch (e) {
          console.error("[copy] learning from edits failed:", e instanceof Error ? e.message : e);
        }
        // Approved copy goes straight to the client's portal
        if (now?.stage === "client_review") await onReachedClient(admin, set.request_id);
      });
  }
  revalidatePath("/board");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Approved copy is locked; this opens it again for edits (the copywriter, a lead or an exec). The ticket stays where it
 * is, ads the client already approved stay locked, and approving it again saves the new version.
 */
export async function reopenCopy(setId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!(isExecOrLead(me) || me.isCopywriter)) return { ok: false, error: "Only the copywriter or a lead can reopen approved copy." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const supabase = await createClient();
  // Only someone who can see the ticket gets this far
  const { data: set } = await supabase.from("copy_sets").select("id, request_id, status").eq("id", setId).maybeSingle();
  if (!set) return { ok: false, error: "Copy not found." };
  if (set.status !== "approved") return { ok: true };
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const { error } = await admin.from("copy_sets").update({ status: "review", approved_by: null, approved_at: null, updated_by: me.id, updated_at: now }).eq("id", setId);
  if (error) return { ok: false, error: error.message };
  const { data: req } = await admin.from("requests").select("stage").eq("id", set.request_id).maybeSingle();
  await admin.from("request_events").insert({ request_id: set.request_id, kind: "copy", from_stage: req?.stage ?? null, to_stage: req?.stage ?? null, actor_id: me.id, data: { action: "reopened" } });
  revalidatePath("/board");
  return { ok: true };
}

/** Copy was already approved for this angle on another ticket: reuse it instead of asking again. */
export async function reuseCopy(requestId: string, fromSetId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  const supabase = await createClient();
  const [{ data: from }, { data: r }] = await Promise.all([
    supabase.from("copy_sets").select("ads, client_id, angle_id, status").eq("id", fromSetId).maybeSingle(),
    supabase.from("requests").select("id, client_id, angle_id").eq("id", requestId).maybeSingle(),
  ]);
  if (!from || !r || from.status !== "approved" || from.client_id !== r.client_id) return { ok: false, error: "That copy can't be reused here." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const { data: set, error } = await createAdminClient()
    .from("copy_sets")
    .upsert(
      { request_id: requestId, client_id: r.client_id, angle_id: r.angle_id, status: "review", ads: from.ads, ai_ads: from.ads, reused_from: fromSetId, notes: "Reused the copy already approved for this angle.", updated_by: me.id, updated_at: new Date().toISOString() },
      { onConflict: "request_id" },
    )
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  const { error: approveError } = await supabase.rpc("approve_copy", { p_set: set.id });
  revalidatePath("/board");
  return approveError ? { ok: false, error: approveError.message } : { ok: true };
}

// ─── Chat with the Copywriter ───────────────────────────────────────────────

export type ChatMessage = { role: "user" | "assistant"; text: string; by: string | null; at: string; rewrote?: boolean; lessons?: CopyLesson[] };

export async function copyChat(requestId: string): Promise<ChatMessage[]> {
  await requireStaff();
  const supabase = await createClient();
  const { data } = await supabase.from("copy_chats").select("messages").eq("request_id", requestId).maybeSingle();
  return (data?.messages ?? []) as ChatMessage[];
}

/**
 * Copy review talks to the agent that wrote the copy. It answers, rewrites the whole set when that's what's asked (in the
 * background, with progress), and keeps any rule meant for this client from now on as client memory.
 */
export async function chatWithCopywriter(requestId: string, text: string): Promise<{ ok: true; messages: ChatMessage[]; rewriting: boolean } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!text.trim()) return { ok: false, error: "Write something first." };
  const supabase = await createClient();
  const { data: r } = await supabase.from("board_requests").select("id, number, client_id, angle_id, title, brief, angle_name").eq("id", requestId).maybeSingle();
  if (!r) return { ok: false, error: "Ticket not found." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const admin = createAdminClient();
  const [{ data: set }, history, ctx] = await Promise.all([
    admin.from("copy_sets").select("ads, notes, status").eq("request_id", requestId).maybeSingle(),
    copyChat(requestId),
    clientContext(admin, r.client_id, { fresh: true }),
  ]);
  const ads = (set?.ads ?? []) as Ad[];
  const now = new Date().toISOString();
  const mine: ChatMessage = { role: "user", text: text.trim().slice(0, 4000), by: me.fullName, at: now };

  let out: { reply: string; rewrite: boolean; instructions: string; lessons: CopyLesson[] };
  try {
    out = await askJson({
      agent: "copy",
      label: `copy chat #${r.number}`,
      clientId: r.client_id,
      system: COPY_CHAT_SYSTEM,
      schema: COPY_CHAT_SCHEMA,
      prompt: `${ctx ? contextBlock(ctx, undefined, { allotment: false }) : "<client>the client</client>"}

<ticket>
#${r.number} · ${r.title} · angle: ${r.angle_name ?? "not set"}
Brief:
${r.brief ?? "(no brief)"}
</ticket>

<the_copy_you_wrote>
${ads.map((a, i) => `Ad ${i + 1} [${a.kind} · ${a.formula}]\nPrimary text: ${a.primaryText}\nHeadline: ${a.headline}\nLink description: ${a.linkDescription}\nCTA: ${a.cta}`).join("\n\n") || "(no copy yet)"}
</the_copy_you_wrote>

<conversation>
${[...history.slice(-12), mine].map((m) => `${m.role === "user" ? (m.by ?? "Copy review") : "You"}: ${m.text}`).join("\n")}
</conversation>

Answer the last message.`,
    });
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "The Copywriter didn't answer." };
  }

  const lessons = (out.lessons ?? []).filter((l) => l.body.trim()).slice(0, 3);
  if (lessons.length) await admin.from("client_memory").insert(lessons.map((l) => ({ client_id: r.client_id, kind: l.kind, body: l.body.trim().slice(0, 1000), source: "copy", created_by: me.id })));
  const reply: ChatMessage = { role: "assistant", text: out.reply, by: null, at: new Date().toISOString(), rewrote: out.rewrite, lessons };
  const messages = [...history, mine, reply].slice(-60);
  await admin.from("copy_chats").upsert({ request_id: requestId, client_id: r.client_id, messages, updated_at: new Date().toISOString() }, { onConflict: "request_id" });

  if (out.rewrite && set?.status !== "approved") {
    const instructions = out.instructions?.trim() || text.trim();
    const res = await redraftCopy(requestId, instructions);
    if (!res.ok) return { ok: true, messages, rewriting: false };
  }
  return { ok: true, messages, rewriting: out.rewrite && set?.status !== "approved" };
}

/** Where the ad sends people. Set on the request; copy review can fix it here. */
export async function setLandingUrl(requestId: string, url: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireStaff();
  const clean = url.trim();
  if (clean && !/^https?:\/\/\S+\.\S+/i.test(clean)) return { ok: false, error: "Enter a full link, starting with https://" };
  const supabase = await createClient();
  const { data: visible } = await supabase.from("requests").select("id").eq("id", requestId).maybeSingle();
  if (!visible || !adminConfigured()) return { ok: false, error: "Ticket not found." };
  const { error } = await createAdminClient().from("requests").update({ landing_url: clean || null }).eq("id", requestId);
  revalidatePath("/board");
  return error ? { ok: false, error: error.message } : { ok: true };
}

// ─── Carousel cards (src/lib/carousel-cards.ts) ─────────────────────────────

export type CarouselView = { designs: { id: string; position: number; name: string; thumbs: (string | null)[] }[]; cards: Record<string, { headline: string; description: string }[]> };

/** The ticket's carousels with a picture of each card, and each card's headline and description. */
export async function carouselCards(requestId: string): Promise<CarouselView | null> {
  await requireStaff();
  const db = await createClient();
  const { data: visible } = await db.from("requests").select("id").eq("id", requestId).maybeSingle();
  if (!visible || !adminConfigured()) return null;
  const admin = createAdminClient();
  const { carouselDesigns } = await import("@/lib/carousel-cards");
  const [designs, { data: set }] = await Promise.all([carouselDesigns(admin, requestId), admin.from("copy_sets").select("cards").eq("request_id", requestId).maybeSingle()]);
  const out: CarouselView["designs"] = [];
  for (const d of designs) {
    const paths = d.cards.map((f) => f.thumb_path).filter((x): x is string => Boolean(x));
    const { data: signed } = paths.length ? await admin.storage.from("creative").createSignedUrls(paths, 3600) : { data: [] };
    const url = new Map((signed ?? []).map((x) => [x.path, x.signedUrl]));
    out.push({ id: d.id, position: d.position, name: d.name, thumbs: d.cards.map((f) => (f.thumb_path ? (url.get(f.thumb_path) ?? null) : null)) });
  }
  return { designs: out, cards: (set?.cards ?? {}) as CarouselView["cards"] };
}

/** Saves one carousel's card headlines and descriptions (copy review's edits). */
export async function saveCards(requestId: string, designId: string, cards: { headline: string; description: string }[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  const db = await createClient();
  const { data: set } = await db.from("copy_sets").select("id, cards").eq("request_id", requestId).maybeSingle();
  if (!set) return { ok: false, error: "No copy set yet." };
  const next = { ...((set.cards ?? {}) as Record<string, unknown>), [designId]: cards.map((c) => ({ headline: c.headline.trim().slice(0, 60), description: c.description.trim().slice(0, 40) })) };
  const { error } = await db.from("copy_sets").update({ cards: next, updated_by: me.id, updated_at: new Date().toISOString() }).eq("id", set.id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Has the Copywriter (re)write the card headlines: every carousel on the ticket, or one. */
export async function writeCards(requestId: string, designId?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireStaff();
  const db = await createClient();
  const { data: visible } = await db.from("requests").select("id").eq("id", requestId).maybeSingle();
  if (!visible || !adminConfigured()) return { ok: false, error: "Not found." };
  try {
    await (await import("@/lib/carousel-cards")).draftCards(createAdminClient(), requestId, designId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "The Copywriter couldn't write them just now." };
  }
}
