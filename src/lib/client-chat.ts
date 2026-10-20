import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, getAgent, researchWeb } from "@/lib/ai";
import { routeMessage } from "@/lib/ai-router";
import { marketBlock } from "@/lib/market";
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

/**
 * One message in the person's thread about this client; the answer is saved with it. Sorted first: a quick question
 * gets a fast answer, a big one the full model, the market and, when it needs current outside facts, a web search.
 */
export async function askAboutClient(admin: SupabaseClient, clientId: string, profileId: string, question: string, goDeep = false) {
  const q = question.trim().slice(0, 3000);
  const ceiling = await getAgent("strategist");
  const [brief, audits, chat, route] = await Promise.all([accountBrief(admin, clientId, null), auditsText(admin, clientId), loadClientChat(admin, clientId, profileId), routeMessage(q, ceiling, goDeep)]);
  // A deep question reads the client's market too, and the web when it needs what's happening now
  let extra = "";
  if (route.level === "deep") {
    const { data: c } = await admin.from("clients").select("name, industry, industry_detail").eq("id", clientId).single();
    const market = await marketBlock(admin, clientId, c?.industry ?? null, 10).catch(() => "");
    const research = route.research
      ? await researchWeb({
          agent: "strategist",
          label: "client chat research",
          system: "You research current, verifiable facts for a paid social agency strategist: market trends, what competitors are doing, consumer behaviour, platform changes. Search, read, and return concise notes with the source of each point. No speculation.",
          prompt: `Client: ${c?.name} (${c?.industry_detail ?? c?.industry ?? "industry unknown"}).\nThe question: ${q}\nFind what's true right now that bears on it.`,
          maxSearches: 5,
          maxFetches: 6,
        }).catch(() => "")
      : "";
    extra = [market, research ? `<web_research>\n${research.slice(0, 20000)}\n</web_research>` : ""].filter(Boolean).join("\n\n");
  }
  const out = await askJson<{ answer: string }>({
    agent: "strategist",
    label: `client chat (${route.level})`,
    system: SYSTEM + (route.level === "deep" ? "\nThis is a big question: think it through, use the market and research you're given (say where a point comes from), and give a clear recommendation with the reasoning; up to 12 sentences or a short structured list." : route.level === "quick" ? "\nThis is a quick question: answer it directly in 1 to 3 sentences." : ""),
    schema: { type: "object", properties: { answer: S }, required: ["answer"], additionalProperties: false },
    maxTokens: route.level === "deep" ? 16000 : 8000,
    override: { model: route.model, effort: route.effort },
    prompt: `${brief.text}\n\n${audits}${extra ? `\n\n${extra}` : ""}\n\n<conversation>\n${chat
      .slice(-14)
      .map((t) => `${t.role === "user" ? "Teammate" : "You"}: ${t.text}`)
      .join("\n")}\n</conversation>\n\nYour teammate says: ${q}`,
  });
  const now = new Date().toISOString();
  const next: ChatTurn[] = [...chat, { role: "user" as const, text: q, at: now }, { role: "assistant" as const, text: out.answer, at: now, level: route.level, researched: Boolean(extra.includes("<web_research>")) }].slice(-60);
  await admin.from("client_chats").upsert({ client_id: clientId, profile_id: profileId, turns: next, updated_at: now });
  return next;
}
