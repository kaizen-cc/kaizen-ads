import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// A Brand Bible ready for the creative team's review. When one finishes writing, the Head of Creative and the client's
// designer and editor are told, tagged with whether the client's marketing intake form was in (the creative team never
// chases the form itself; the account manager does). Each person marks it reviewed for themselves. A busy day (the
// mass rebuild) becomes one digest per person instead of a bell full of Bibles; every Bible still lists in Next for me.

/** More than this many Bibles for one person within a day: one digest instead */
export const DIGEST_AFTER = 3;

export type BuildReason = "new" | "intake" | "monthly" | "manual";

/** The intake tag, as the team reads it */
export function intakeTag(fromIntake: boolean) {
  return fromIntake ? "Built from the intake form" : "Built without the intake form: from calls, emails and research";
}

/** "v1.2" or "1.2" as "1.2", for "· v1.2" */
const bare = (v: string) => v.replace(/^v/i, "");

export function readyTitle(client: string, version: string) {
  return `Brand Bible ready for your review: ${client} · v${bare(version)}`;
}

export function digestTitle(n: number) {
  return `${n} Brand Bibles ready for your review`;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9$%]+/g, " ")
    .trim();

/**
 * What the team reads, as a hash: the "Read this first" page, the cover (statement, mission, vision, values, goal) and
 * the open questions, with case, punctuation and spacing left out. A rewrite that leaves all of it as it was is not a
 * material change.
 */
export function materialHash(b: { readThisFirst?: string | null; overview?: unknown; openQuestions?: { question?: string }[] | null }) {
  const o = (b.overview ?? {}) as Record<string, unknown>;
  const cover = ["statement", "mission", "vision", "values", "goal"].map((k) => norm(typeof o[k] === "string" ? (o[k] as string) : Array.isArray(o[k]) ? (o[k] as unknown[]).join(" ") : ""));
  const questions = (b.openQuestions ?? []).map((q) => norm(q.question ?? "")).sort();
  return createHash("sha256")
    .update(JSON.stringify([norm(b.readThisFirst ?? ""), cover, questions]))
    .digest("hex");
}

/**
 * Whether a finished write tells the creative team. A new Bible always does. A rewrite whose material hash is
 * unchanged never does. The automatic monthly refresh only does when it materially changed (and, with no hash from
 * before to compare, it doesn't: when unsure, only new versions are announced).
 */
export function shouldAnnounce(w: { isNew: boolean; reason: string | null; prevHash: string | null; hash: string }) {
  if (w.isNew) return true;
  if (w.prevHash && w.prevHash === w.hash) return false;
  if (w.reason === "monthly") return Boolean(w.prevHash);
  return true;
}

/** The Head of Creative(s), and whoever holds the client's designer or video editor seat (lead makers included) */
export async function bibleReviewers(admin: SupabaseClient, clientId: string): Promise<string[]> {
  const [{ data: heads }, { data: seats }] = await Promise.all([
    admin.from("profiles").select("id").eq("role", "head_of_creative").eq("is_active", true),
    admin.from("client_assignments").select("profile_id, profiles!inner(is_active)").eq("client_id", clientId).in("role", ["graphic_designer", "video_editor"]).eq("profiles.is_active", true),
  ]);
  return [...new Set([...(heads ?? []).map((p) => p.id as string), ...(seats ?? []).map((s) => s.profile_id as string)])];
}

/**
 * Tells each reviewer a Bible is ready. Up to DIGEST_AFTER a day each get their own notice; past that the day's notices
 * fold into one digest ("6 Brand Bibles ready for your review") that keeps its count current. Each Bible's own notice is
 * still recorded (cleared off the bell), so the count is right and nothing is lost.
 */
export async function announceBible(admin: SupabaseClient, b: { clientId: string; client: string; slug: string; version: string; fromIntake: boolean }) {
  const people = await bibleReviewers(admin, b.clientId);
  if (!people.length) return { told: 0 };
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const key = `bible-review:${b.clientId}:${b.version}`;
  for (const id of people) {
    const { data: today } = await admin.from("notifications").select("id, key, title, cleared_at").eq("profile_id", id).like("key", "bible-review:%").gte("created_at", since).neq("key", key);
    const before = today ?? [];
    const digest = before.length + 1 > DIGEST_AFTER;
    const now = new Date().toISOString();
    await admin.from("notifications").upsert(
      {
        profile_id: id,
        kind: "bible",
        client_id: b.clientId,
        title: readyTitle(b.client, b.version),
        body: intakeTag(b.fromIntake),
        href: `/clients/${b.slug}/brand-bible`,
        key,
        priority: "normal",
        read_at: null,
        cleared_at: digest ? now : null,
      },
      { onConflict: "profile_id,key" },
    );
    if (!digest) continue;
    // The ones already on the bell fold into the digest
    const open = before.filter((n) => !n.cleared_at).map((n) => n.id as string);
    if (open.length) await admin.from("notifications").update({ cleared_at: now }).in("id", open);
    const names = [...before.map((n) => String(n.title).replace(/^Brand Bible ready for your review: /, "")), `${b.client} · v${bare(b.version)}`];
    const n = names.length;
    await admin.from("notifications").upsert(
      {
        profile_id: id,
        kind: "bible",
        title: digestTitle(n),
        body: `${names.slice(0, 5).join(", ")}${n > 5 ? ` and ${n - 5} more` : ""}. Each is in Next for me, with whether it was built from the intake form.`,
        href: "/next",
        key: `bible-digest:${day}`,
        priority: "normal",
        read_at: null,
        cleared_at: null,
      },
      { onConflict: "profile_id,key" },
    );
  }
  return { told: people.length };
}

export type BibleToReview = { clientId: string; client: string; slug: string; version: string; fromIntake: boolean; readyAt: string };

/**
 * The Bibles waiting on this person's review: every client's for the Head of Creative, the clients whose designer or
 * editor seat they hold for anyone else. A version they marked reviewed leaves the list.
 */
export async function loadBiblesToReview(db: SupabaseClient, me: { id: string; role: string }): Promise<BibleToReview[]> {
  let clientIds: string[] | null = null;
  if (me.role !== "head_of_creative") {
    const { data: seats } = await db.from("client_assignments").select("client_id").eq("profile_id", me.id).in("role", ["graphic_designer", "video_editor"]);
    clientIds = [...new Set((seats ?? []).map((s) => s.client_id as string))];
    if (!clientIds.length) return [];
  }
  let q = db
    .from("client_brand_bibles")
    .select("client_id, version, built_from_intake, ready_for_review_at, clients!inner(name, slug, archived_at)")
    .not("ready_for_review_at", "is", null)
    .not("markdown", "is", null)
    .is("build_stage", null)
    .is("clients.archived_at", null)
    .gte("ready_for_review_at", new Date(Date.now() - 60 * 86_400_000).toISOString())
    .order("ready_for_review_at", { ascending: false })
    .limit(200);
  if (clientIds) q = q.in("client_id", clientIds);
  const { data: rows } = await q;
  if (!rows?.length) return [];
  const { data: done } = await db.from("brand_bible_reviews").select("client_id, version").eq("profile_id", me.id).in("client_id", rows.map((r) => r.client_id as string));
  const seen = new Set((done ?? []).map((d) => `${d.client_id}:${d.version}`));
  return rows
    .filter((r) => !seen.has(`${r.client_id}:${r.version}`))
    .map((r) => {
      const c = r.clients as unknown as { name: string; slug: string };
      return { clientId: r.client_id as string, client: c.name, slug: c.slug, version: r.version as string, fromIntake: Boolean(r.built_from_intake), readyAt: r.ready_for_review_at as string };
    });
}
