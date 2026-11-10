import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addBusinessDays, assetGate, driveLinks, type LinkCheck } from "@/lib/brief-assets";
import { withDetectedFacts, openFacts } from "@/lib/brief-facts";
import { summarizeGate, type GateKey, type GateSummary, type Override, type ReviewStamp } from "@/lib/brief-gate";
import { loadAiRule } from "@/lib/ai-content-rule";
import { lintBrief } from "@/lib/brief-lint";
import { parseBrief, type BriefSpec } from "@/lib/brief-spec";

// The ready check on the server: the brief read into its spec, the client-only facts still open, the contradictions
// (code rules), the asset gate with the Drive links actually opened and the client's catalogue counted, and any lead
// override or review stamp for this exact brief. Used by the brief's check panel and the PDF; the send (tickets and
// Asana) uses conflictsNow, since only a contradiction can hold a brief. Every row it reads was written by src/app/(team)/brief-review-actions.ts.

export type BriefInput = {
  clientId: string;
  title: string;
  brief: string;
  sizes: string[];
  formats: string[];
  refs: string[];
  /** A ticket's due date; a draft's is its turnaround from today */
  due?: string | null;
  priority?: string | null;
};

/** The brief as it is (text and sizes): a review or an override holds only for exactly this */
export function briefHash(brief: string, sizes: string[]) {
  const norm = brief.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  return createHash("sha1").update(JSON.stringify([norm, [...sizes].map((s) => s.replace(":", "x")).sort()])).digest("hex").slice(0, 32);
}

const TURNAROUND: Record<string, number> = { image: 2, video: 4, carousel: 2 };
/** When a draft would be due if it's sent today (the Board's turnaround, halved for urgent) */
export function draftDue(formats: string[], priority: string | null | undefined, now = new Date()) {
  const days = Math.max(0, ...formats.map((f) => TURNAROUND[f] ?? 2));
  return addBusinessDays(now, priority === "urgent" ? Math.max(1, Math.floor(days / 2)) : days);
}

const driveId = (url: string) => url.match(/\/d\/([\w-]{20,})/)?.[1] ?? url.match(/\/folders\/([\w-]{20,})/)?.[1] ?? url.match(/[?&]id=([\w-]{20,})/)?.[1] ?? null;

/** Whether each Drive link opens for Kaizen's Drive (metadata only). Unknown (Drive not connected) counts as open. */
export async function checkDriveLinks(urls: string[]): Promise<LinkCheck[]> {
  if (!urls.length) return [];
  let token: string | null = null;
  try {
    const { driveToken } = await import("@/lib/context/google");
    token = await driveToken();
  } catch {
    token = null;
  }
  return Promise.all(
    urls.slice(0, 8).map(async (url): Promise<LinkCheck> => {
      const id = driveId(url);
      if (!id) return { url, ok: false, note: "This isn't a link to a Drive file or folder." };
      if (!token) return { url, ok: true, note: null };
      try {
        const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?${new URLSearchParams({ supportsAllDrives: "true", fields: "id,trashed" })}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000), cache: "no-store" });
        if (r.status === 404 || r.status === 403) return { url, ok: false, note: "Kaizen's Drive can't open it (not shared with the agency, or deleted)." };
        if (!r.ok) return { url, ok: true, note: null };
        const f = (await r.json()) as { trashed?: boolean };
        return f.trashed ? { url, ok: false, note: "It's in the Drive trash." } : { url, ok: true, note: null };
      } catch {
        return { url, ok: true, note: null };
      }
    }),
  );
}

const SIG = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 3 && !["with", "that", "this", "from", "your", "most", "more", "what"].includes(w));

/** The client's Drive catalogue: its video and image counts, and how many files look like this concept's */
async function driveOf(admin: SupabaseClient, clientId: string, title: string) {
  const { data } = await admin.from("client_assets").select("name, kind, folder").eq("client_id", clientId).limit(3000);
  const rows = data ?? [];
  const words = SIG(title);
  const matching = words.length < 2 ? 0 : rows.filter((r) => {
    const w = new Set(SIG(`${r.folder ?? ""} ${r.name ?? ""}`));
    return words.filter((x) => w.has(x)).length >= 2;
  }).length;
  return { videos: rows.filter((r) => r.kind === "video").length, images: rows.filter((r) => r.kind === "image").length, matching };
}

/** Who chases the client for what's missing: their coordinator, by name */
async function chaserOf(admin: SupabaseClient, clientId: string) {
  const { data } = await admin.from("client_assignments").select("role, profiles(full_name)").eq("client_id", clientId).eq("role", "coordinator").limit(1);
  const name = ((data?.[0]?.profiles as unknown as { full_name?: string } | null)?.full_name ?? "").trim();
  return name ? `${name} (coordinator)` : null;
}

/** The latest review stamp and lead override for this exact brief */
export async function stampAndOverride(admin: SupabaseClient, clientId: string, hash: string): Promise<{ stamp: ReviewStamp | null; override: Override | null }> {
  const { data } = await admin
    .from("brief_corrections")
    .select("kind, gates, reason, created_at, profiles(full_name)")
    .eq("client_id", clientId)
    .eq("brief_hash", hash)
    .in("kind", ["review", "override"])
    .is("undone_at", null)
    .order("created_at", { ascending: false })
    .limit(10);
  const rows = data ?? [];
  const name = (r: (typeof rows)[number]) => ((r.profiles as unknown as { full_name?: string } | null)?.full_name ?? "Someone on the team").trim();
  const rv = rows.find((r) => r.kind === "review");
  const ov = rows.filter((r) => r.kind === "override");
  return {
    stamp: rv ? { by: name(rv), at: rv.created_at as string } : null,
    // Every gate any override of this brief let through, with the latest reason
    override: ov.length ? { gates: [...new Set(ov.flatMap((r) => (r.gates ?? []) as GateKey[]))], reason: (ov[0].reason as string | null) ?? "", by: name(ov[0]), at: ov[0].created_at as string } : null,
  };
}

export type BriefCheck = GateSummary & { spec: BriefSpec; structured: boolean; hash: string; due: string | null };

/**
 * The send's check, quick: only what can hold a brief (its contradictions, by the code rules) and any lead override of
 * this exact brief. Facts to confirm and assets still to come never hold it, so no Drive reads here: a send never waits.
 */
export async function conflictsNow(admin: SupabaseClient, i: Pick<BriefInput, "clientId" | "title" | "brief" | "sizes" | "formats">): Promise<GateSummary & { hash: string }> {
  const hash = briefHash(i.brief, i.sizes);
  const [{ data: client }, so, ai] = await Promise.all([admin.from("clients").select("name").eq("id", i.clientId).maybeSingle(), stampAndOverride(admin, i.clientId, hash), loadAiRule(admin, i.clientId)]);
  const lint = lintBrief({ text: i.brief, title: i.title, sizes: i.sizes, formats: i.formats, client: (client?.name as string | null) ?? null, noAiRule: ai.rule });
  return { ...summarizeGate({ openFacts: [], lint, assets: null, override: so.override, stamp: so.stamp }), hash };
}

/** A lead sends a held brief on from Ready to send in one click: their override of its contradictions, logged */
export async function recordSendAnyway(admin: SupabaseClient, i: { clientId: string; profileId: string; hash: string; formats: string[] }) {
  await admin.from("brief_corrections").insert({ client_id: i.clientId, profile_id: i.profileId, kind: "override", gates: ["conflicts"], reason: "Sent anyway from Ready to send", brief_hash: i.hash, format: i.formats.join(",") || null });
}

/** The whole ready check for one brief (no AI: the code rules; the AI pass is asked for separately) */
export async function checkBriefNow(admin: SupabaseClient, i: BriefInput): Promise<BriefCheck> {
  const parsed = parseBrief(i.brief);
  const spec = withDetectedFacts(parsed.spec, i.title);
  const hash = briefHash(i.brief, i.sizes);
  const due = i.due ? new Date(i.due) : draftDue(i.formats, i.priority);
  const [{ data: client }, links, drive, chaser, so, ai] = await Promise.all([
    admin.from("clients").select("name").eq("id", i.clientId).maybeSingle(),
    checkDriveLinks([...new Set([...driveLinks(i.brief), ...i.refs.flatMap(driveLinks)])]),
    driveOf(admin, i.clientId, i.title),
    chaserOf(admin, i.clientId),
    stampAndOverride(admin, i.clientId, hash),
    loadAiRule(admin, i.clientId),
  ]);
  const lint = lintBrief({ text: i.brief, title: i.title, sizes: i.sizes, formats: i.formats, client: (client?.name as string | null) ?? null, noAiRule: ai.rule });
  const assets = assetGate({ assets: spec.assets, links, formats: i.formats, drive, due, today: new Date(), chaser });
  const g = summarizeGate({ openFacts: openFacts(spec), lint, assets, override: so.override, stamp: so.stamp });
  return { ...g, spec, structured: parsed.structured, hash, due: due ? due.toISOString() : null };
}
