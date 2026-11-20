import "server-only";
import { clientNamed } from "@/lib/client-named";
import type { Staff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { REVIEW_LINES, REVIEW_LINE_LABEL, type ReviewLine } from "@/lib/line-review/core";
import { str, type AiTool } from "./types";

// The weekly account review as tools, for the assistant (voice and text) and every Kaizen AI agent (registered in
// src/lib/kaizen-ai/extensions.ts). Only the line heads and the execs run reviews; the rules (internal channel only,
// posted as the person, no fees or Stripe, no departed teammates, verified status) live in src/lib/line-review/act.ts.
//   weekly_reviews        this week's reviews (a head their line, execs every line and the rollup, worst first)
//   run_weekly_review     draft or refresh one client's review now ("run the review for X")
//   send_weekly_review    approve and send one: posted as the person to the client's internal channel (ask first)
//   skip_weekly_review    skip one for this week (ask first)
// Each opens on the Weekly reviews page: open_screen place 'weekly reviews' (or 'weekly reviews meta' / 'google' /
// 'email' / 'social' / 'rollup').

const NOT_YOURS = { ok: false as const, error: "Weekly reviews are run by the line heads (Meta, Google, Email, Organic Social) and the execs." };
const asLine = (v: unknown): ReviewLine | null => {
  const s = String(v ?? "").toLowerCase();
  if (s.includes("tiktok") || s.includes("meta") || s === "facebook") return "meta";
  return (REVIEW_LINES as readonly string[]).includes(s) ? (s as ReviewLine) : null;
};

async function mine(user: Staff) {
  const { myLines } = await import("@/lib/line-review/act");
  return myLines(user);
}

async function findCard(user: Staff, input: Record<string, unknown>) {
  const { loadReviews } = await import("@/lib/line-review/act");
  const lines = await mine(user);
  const id = str(input.id);
  const { cards } = await loadReviews(await createClient(), { client: id ? null : str(input.client) });
  const want = asLine(input.line);
  const hits = cards.filter((c) => (id ? c.id === id : true) && lines.includes(c.line) && (!want || c.line === want));
  if (hits.length === 1) return { card: hits[0] } as const;
  if (!hits.length) return { error: id ? "That review isn't one you can see." : `No review this week for ${str(input.client) ?? "that client"}${want ? ` on ${REVIEW_LINE_LABEL[want]}` : ""}. Run it first with run_weekly_review.` } as const;
  return { error: `More than one review matches: ${hits.map((c) => `${c.client} (${REVIEW_LINE_LABEL[c.line]}, id ${c.id})`).join("; ")}. Say which.` } as const;
}

const list: AiTool = {
  name: "weekly_reviews",
  description:
    "This week's weekly account reviews (drafted Monday morning for each line head: Meta + TikTok, Google, Email, Organic Social): per client and line, what to do today, scope vs delivered, budget pace, account changes (us vs the client, changes without the client's sign-off), open commitments, results vs target with a confidence tag (certain / likely / guessing), health (days since our last update, retention risk, onboarding blockers), and the drafted internal Slack message. A head gets their line; execs every line plus the rollup worst first. line and client narrow it; status: draft (default), sent, skipped or all. Each review has its id for send_weekly_review / skip_weekly_review. To show it, open_screen place 'weekly reviews' (or 'weekly reviews rollup' / 'meta' / 'google' / 'email' / 'social').",
  input_schema: { type: "object", properties: { line: { type: "string", enum: [...REVIEW_LINES] }, client: { type: "string" }, status: { type: "string", enum: ["draft", "sent", "skipped", "all"] }, with_message: { type: "boolean" } }, additionalProperties: false },
  run: async (user, input) => {
    const lines = await mine(user);
    if (!lines.length) return NOT_YOURS;
    const { loadReviews, rollup } = await import("@/lib/line-review/act");
    const want = asLine(input.line);
    const status = str(input.status) ?? "draft";
    const { week, cards } = await loadReviews(await createClient(), { line: want, client: str(input.client) });
    const shown = cards.filter((c) => lines.includes(c.line) && (status === "all" || c.status === status));
    return {
      ok: true,
      week,
      page: want ? `/reviews?tab=${want}` : user.isExec ? "/reviews" : `/reviews?tab=${lines[0]}`,
      count: shown.length,
      ...(user.isExec && !want ? { rollup: rollup(shown).slice(0, 25).map((r) => ({ client: r.client, retentionRisk: r.atRisk, risk: r.risk, lines: r.lines.map((l) => ({ id: l.id, line: l.line, status: l.status })) })) } : {}),
      reviews: shown.slice(0, 30).map((c) => ({
        id: c.id,
        client: c.client,
        line: REVIEW_LINE_LABEL[c.line],
        status: c.status,
        risk: c.risk,
        today: c.review?.todos ?? [],
        retentionRisk: c.review?.health?.atRisk ?? null,
        clientChannelDaysQuiet: c.review?.health?.clientSilent ?? null,
        commitments: (c.review?.commitments ?? []).slice(0, 5),
        unapprovedChanges: c.review?.changes?.unapproved ?? [],
        clientPauses: c.review?.changes?.clientPauses ?? [],
        budget: (c.review?.budget ?? []).map((b) => ({ platform: b.platform, spent: Math.round(b.spent), budget: b.budget, projected: Math.round(b.projected), over: b.over, confidence: b.confidence })),
        results: c.review?.results ?? [],
        orders: c.review?.conversions ?? null,
        ...(input.with_message === true ? { message: c.message } : {}),
      })),
    };
  },
};

const runOne: AiTool = {
  name: "run_weekly_review",
  description: "Draft (or refresh with the latest numbers) one client's weekly account review now: 'run the review for X'. line: meta (Meta + TikTok), google, email or social; a head's own line by default; execs may leave it out for every line the client buys. It respects the client's services (no review on a line they don't buy) and skips archived or inactive clients. Then weekly_reviews shows it.",
  input_schema: { type: "object", properties: { client: { type: "string" }, line: { type: "string", enum: [...REVIEW_LINES] } }, required: ["client"], additionalProperties: false },
  run: async (user, input) => {
    const lines = await mine(user);
    if (!lines.length) return NOT_YOURS;
    if (user.viewAs) return { ok: false, error: `You're viewing as ${user.viewAs.label}: exit to make changes.` };
    const name = str(input.client);
    if (!name) return { ok: false, error: "Which client?" };
    let c: { id: string; name: string };
    try {
      c = await clientNamed(await createClient(), name);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : `No client called ${name}.` };
    }
    const line = asLine(input.line) ?? (user.isExec ? null : lines[0]);
    if (line && !lines.includes(line)) return { ok: false, error: `The ${REVIEW_LINE_LABEL[line]} review is that line's head's.` };
    const { runOneReview } = await import("@/lib/line-review/build");
    const r = await runOneReview(createAdminClient(), c.id, line);
    return r.ok ? { ok: true, client: c.name, lines: r.lines.map((l) => REVIEW_LINE_LABEL[l]), page: `/reviews?tab=${r.lines[0]}&client=${encodeURIComponent(c.name)}` } : r;
  },
};

const send: AiTool = {
  name: "send_weekly_review",
  description:
    "Approve and send one weekly review: its internal message is posted AS THE PERSON in the client's INTERNAL Slack channel (never a client channel). Refused if it mentions Kaizen's fees, retainer, invoices or Stripe, tags someone who left, calls a live client cancelled or churned, or the client is archived or inactive. id from weekly_reviews (or client + line). message: the edited text, if they changed it. Read the message back and ask first.",
  input_schema: { type: "object", properties: { id: { type: "string" }, client: { type: "string" }, line: { type: "string", enum: [...REVIEW_LINES] }, message: { type: "string" } }, additionalProperties: false },
  run: async (user, input) => {
    if (!(await mine(user)).length) return NOT_YOURS;
    const f = await findCard(user, input);
    if ("error" in f) return { ok: false, error: f.error };
    const { sendReview } = await import("@/lib/line-review/act");
    return sendReview(createAdminClient(), user, f.card.id, str(input.message));
  },
};

const skip: AiTool = {
  name: "skip_weekly_review",
  description: "Skip one weekly review for this week (nothing posted), with an optional reason. id from weekly_reviews (or client + line). Ask first.",
  input_schema: { type: "object", properties: { id: { type: "string" }, client: { type: "string" }, line: { type: "string", enum: [...REVIEW_LINES] }, reason: { type: "string" } }, additionalProperties: false },
  run: async (user, input) => {
    if (!(await mine(user)).length) return NOT_YOURS;
    const f = await findCard(user, input);
    if ("error" in f) return { ok: false, error: f.error };
    const { skipReview } = await import("@/lib/line-review/act");
    return skipReview(createAdminClient(), user, f.card.id, str(input.reason) ?? "");
  },
};

export const tools: AiTool[] = [list, runOne, send, skip];
