import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import type { AuditResult } from "@/lib/audit";
import { accountBrief, type ChatTurn } from "@/lib/handoff";

// The AI on each client page: anyone who can see the client asks it about the account, strategizes with it, bounces
// ideas off it or asks for a summary. It reads what the handoff reads (the client context, the last 45 days, what's
// open) plus the latest account audit on each KPI. Each person has their own thread per client.

const S = { type: "string" };

const SYSTEM = `You are Kaizen Marketing's account strategist, talking with a teammate on one client's internal page. They may ask a question about the account, want to strategize, think out loud with you, or want a summary. Use only what you're given (the client context, the last 45 days, what's open, the latest account audits); when something isn't there, say so plainly and say where to look or who to ask (by role: the media buyer, the copywriter, the client).
Be a sharp colleague: direct, specific (offers, audiences, numbers, dates), with an opinion when they're strategizing, and say why. When they're brainstorming, build on their idea, say what could go wrong, and suggest the next concrete step. Say where a fact comes from when it matters ("the client said on the Oct 9 call", "the last audit"). Refer to teammates by role, never by name; the client's own contacts by name is fine.
Keep it short: 1 to 8 sentences or a short list, longer only for a summary they asked for. Plain text, no markdown (no asterisks or headings); start list lines with "- ". No emojis.
If they ask you to run an audit, say they can start one with the "Run an audit" button above the chat (it's the same audit as on the KPI board and shows in both places).`;

/** The latest finished audit on each of the client's KPIs, as text the strategist reads. */
async function auditsText(admin: SupabaseClient, clientId: string) {
  const { data: targets } = await admin.from("kpi_targets").select("id, platform, label").eq("client_id", clientId).eq("active", true);
  if (!targets?.length) return "";
  const { data: audits } = await admin
    .from("account_audits")
    .select("target_id, created_at, result")
    .in("target_id", targets.map((t) => t.id))
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(10);
  const seen = new Set<string>();
  const blocks = (audits ?? []).flatMap((a) => {
    if (seen.has(a.target_id)) return [];
    seen.add(a.target_id);
    const t = targets.find((x) => x.id === a.target_id);
    const r = a.result as AuditResult | null;
    if (!r?.verdict) return [];
    return [
      `<audit platform="${t?.platform}"${t?.label ? ` label="${t.label}"` : ""} ran="${String(a.created_at).slice(0, 10)}">`,
      `Verdict: ${r.verdict.headline}. ${r.verdict.summary}`,
      `Diagnosis: ${r.diagnosis}`,
      ...(r.actions ?? []).slice(0, 10).map((x) => `- Action (${x.when}, ${x.owner}): ${x.title}. ${x.why}`),
      ...(r.watchouts ?? []).slice(0, 5).map((x) => `- Watch out: ${x.title}. ${x.why}`),
      `</audit>`,
    ];
  });
  return blocks.length ? `<latest_audits>\n${blocks.join("\n")}\n</latest_audits>` : "";
}

export async function loadClientChat(db: SupabaseClient, clientId: string, profileId: string): Promise<ChatTurn[]> {
  const { data } = await db.from("client_chats").select("turns").eq("client_id", clientId).eq("profile_id", profileId).maybeSingle();
  return ((data?.turns ?? []) as ChatTurn[]).slice(-40);
}

/** One message in the person's thread about this client; the answer is saved with it. */
export async function askAboutClient(admin: SupabaseClient, clientId: string, profileId: string, question: string) {
  const q = question.trim().slice(0, 3000);
  const [brief, audits, chat] = await Promise.all([accountBrief(admin, clientId, null), auditsText(admin, clientId), loadClientChat(admin, clientId, profileId)]);
  const out = await askJson<{ answer: string }>({
    agent: "strategist",
    label: "client chat",
    system: SYSTEM,
    schema: { type: "object", properties: { answer: S }, required: ["answer"], additionalProperties: false },
    maxTokens: 8000,
    prompt: `${brief.text}\n\n${audits}\n\n<conversation>\n${chat
      .slice(-14)
      .map((t) => `${t.role === "user" ? "Teammate" : "You"}: ${t.text}`)
      .join("\n")}\n</conversation>\n\nYour teammate says: ${q}`,
  });
  const now = new Date().toISOString();
  const next: ChatTurn[] = [...chat, { role: "user" as const, text: q, at: now }, { role: "assistant" as const, text: out.answer, at: now }].slice(-60);
  await admin.from("client_chats").upsert({ client_id: clientId, profile_id: profileId, turns: next, updated_at: now });
  return next;
}
