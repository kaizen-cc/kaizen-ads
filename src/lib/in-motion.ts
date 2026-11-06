import type { SupabaseClient } from "@supabase/supabase-js";
import { stageInfo, type Stage } from "@/lib/stages";

// What's already in motion for a client: tickets on the board and Asana-mirrored tasks (not moved to a ticket) that
// aren't delivered yet (requested, in production, in review, copy, with the client, client changes). Every brief writer
// reads it (src/lib/ai.ts contextBlock), and the quick preview names the ones that touch the brief, so nobody is told
// "there's no request for this offer" while the board has a task for it ("Already in motion: #123 Holiday promo (in
// production)"). Shapes and pure helpers are shared with the browser.

export type MotionItem = {
  /** R<number> for a ticket, A<gid> for an Asana task: how the AI names the ones that match */
  key: string;
  source: "board" | "asana";
  number: number | null;
  title: string;
  stage: string;
  stageLabel: string;
  format: string | null;
  /** The brief or the task's notes, short */
  brief: string;
  href: string | null;
  avatar: string | null;
  angle: string | null;
  createdAt: string | null;
};

const OPEN_STAGES: Stage[] = ["requested", "in_production", "internal_review", "copy", "copy_review", "ready_for_client", "client_review", "client_revision"];
const ASANA_STAGE: Record<string, string> = { requested: "briefed", ready_for_launch: "ready to launch" };

const short = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const labelOf = (stage: string | null, asana = false) => {
  if (!stage) return asana ? "open in Asana" : "open";
  if (asana && ASANA_STAGE[stage]) return ASANA_STAGE[stage];
  try {
    return stageInfo(stage as Stage).label.toLowerCase();
  } catch {
    return stage.replace(/_/g, " ");
  }
};

/** "#123 Holiday promo (in production)", or "Asana: Holiday promo (with client)" */
export const motionLine = (m: Pick<MotionItem, "source" | "number" | "title" | "stageLabel">) => `${m.source === "board" && m.number ? `#${m.number}` : "Asana:"} ${m.title} (${m.stageLabel})`;

/** The client's open tickets and Asana tasks, newest first (read with whatever access the caller has) */
export async function loadInMotion(db: SupabaseClient, clientId: string, limit = 40): Promise<MotionItem[]> {
  const [{ data: tickets }, { data: tasks }] = await Promise.all([
    db
      .from("board_requests")
      .select("number, title, format, stage, brief, angle_name, avatar, created_at")
      .eq("client_id", clientId)
      .in("stage", OPEN_STAGES)
      .order("created_at", { ascending: false })
      .limit(limit),
    db
      .from("asana_tasks")
      .select("gid, name, notes, stage, section, format, url, asana_created_at")
      .eq("client_id", clientId)
      .eq("open", true)
      .is("request_id", null)
      .order("asana_created_at", { ascending: false })
      .limit(limit),
  ]);
  const board: MotionItem[] = (tickets ?? []).map((r) => ({
    key: `R${r.number}`,
    source: "board",
    number: r.number as number,
    title: short(r.title as string, 140) || "Untitled",
    stage: r.stage as string,
    stageLabel: labelOf(r.stage as string),
    format: (r.format as string | null) ?? null,
    brief: short(r.brief as string | null, 500),
    href: `/board?t=${r.number}`,
    avatar: (r.avatar as string | null) ?? null,
    angle: (r.angle_name as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
  }));
  const asana: MotionItem[] = (tasks ?? [])
    .filter((t) => !t.stage || OPEN_STAGES.includes(t.stage as Stage))
    .map((t) => ({
      key: `A${t.gid}`,
      source: "asana",
      number: null,
      // The form's task names lead with "Meta Ads - Need a new creative - Client - Format - Title": the title is what matters
      title: short(String(t.name ?? "").replace(/^(URGENT:\s*)?Meta Ads - Need a new creative - /i, ""), 160) || "Untitled task",
      stage: (t.stage as string | null) ?? "requested",
      stageLabel: labelOf((t.stage as string | null) ?? null, true),
      format: (t.format as string | null) ?? null,
      brief: short(t.notes as string | null, 500),
      href: (t.url as string | null) ?? null,
      avatar: null,
      angle: null,
      createdAt: (t.asana_created_at as string | null) ?? null,
    }));
  return [...board, ...asana];
}

/** For every brief writer: what's in motion, with the rule to say so instead of claiming nothing exists */
export function motionBlock(items: MotionItem[]) {
  const lines = items.slice(0, 30).map((m) => `- [${m.key}] ${motionLine(m)}${m.format ? ` · ${m.format}` : ""}${m.avatar ? ` · avatar: ${m.avatar}` : ""}${m.angle ? ` · angle: ${m.angle}` : ""}${m.brief ? `\n  ${m.brief.slice(0, 300)}` : ""}`);
  return `<already_in_motion>
Work for this client already on the board or in Asana and not delivered yet (requested, in production, in review, with the client). Read it before you say anything about what exists: never claim there's no request for an offer, product, promo or moment when something here covers it. When something here covers or overlaps what you're asked, say so plainly ("Already in motion: #123 Holiday promo (in production)"), and build only what it doesn't cover (or nothing).
${lines.length ? lines.join("\n") : "Nothing in motion right now."}
</already_in_motion>`;
}

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3));

/** The items that read like the brief (shared words in the title and brief), best first: a fallback when no AI picked them */
export function motionMatches(items: MotionItem[], text: string, max = 3) {
  const mine = words(text);
  if (!mine.size) return [];
  return items
    .map((m) => {
      const theirs = words(`${m.title} ${m.brief}`);
      let n = 0;
      for (const w of mine) if (theirs.has(w)) n++;
      const titleHits = [...words(m.title)].filter((w) => mine.has(w)).length;
      return { m, score: n / Math.max(1, Math.min(mine.size, theirs.size)), titleHits };
    })
    .filter((x) => x.titleHits >= 1 && x.score >= 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.m);
}
