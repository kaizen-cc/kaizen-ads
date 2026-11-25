import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import type { Staff } from "@/lib/auth";
import { canAccessReport } from "./access";
import { openWithHere } from "./slack-text";
import { forClient, isWhiteLabel } from "./white-label";

// The assistant edits a report's client message where it lives: "add an intro line", "add these coming-up points". The
// whole message comes back with only what was asked changed, is saved on the report (a built report's on its bundle),
// and the open studio shows it at once (the assistant sends a "report-message" page event with it).

const SYSTEM = `You edit the client message of a marketing agency's report: the Slack post, which is also the body of the email. Make exactly the change asked and keep everything else word for word: the greeting, the order, the numbers, the voice and the formatting. Never invent a number, a result or a plan that isn't in the message or the ask. Slack formatting only: *bold*, _italic_, ~strikethrough~, <https://link|words>, "• " bullets, line breaks; no # headings. Keep "<!here>" at the start when it's there. changed: one short sentence on what you changed.`;

export async function editReportMessage(admin: SupabaseClient, db: SupabaseClient, me: Staff, reportId: string, ask: string): Promise<{ ok: true; message: string; changed: string; bundleId: string | null } | { ok: false; error: string }> {
  const { data: r } = await admin.from("reports").select("id, owner_id, client_id, platform, kind, status, message, bundle_id, kpi_targets(id, client_id, platform, owner_id), clients(client_type)").eq("id", reportId).maybeSingle();
  if (!r || !(await canAccessReport(db, me, r as unknown as { owner_id: string | null; client_id: string; platform: string; kpi_targets?: unknown }))) return { ok: false, error: "That report isn't one you can edit." };
  if (r.status === "posted") return { ok: false, error: "It's already gone to the client. Reopen it from the report to change it." };
  if (r.status === "queued" || r.status === "drafting") return { ok: false, error: "It's still being written. Try again in a moment." };
  // A built report's message lives on its bundle (one post for every service)
  const bundleId = r.kind === "built" && r.bundle_id ? (r.bundle_id as string) : null;
  const current = bundleId ? (((await admin.from("report_bundles").select("message").eq("id", bundleId).maybeSingle()).data?.message as string | null) ?? "") : ((r.message as string | null) ?? "");
  if (!current.trim()) return { ok: false, error: "There's no message yet: it's written once the report is." };
  const whiteLabel = isWhiteLabel((r.clients as unknown as { client_type?: string | null } | null)?.client_type);
  const out = await askJson<{ message: string; changed: string }>({
    agent: "reporter",
    label: "edit report message",
    clientId: r.client_id as string,
    override: { model: "sonnet", effort: "low" },
    system: SYSTEM,
    schema: { type: "object", properties: { message: { type: "string" }, changed: { type: "string" } }, required: ["message", "changed"], additionalProperties: false },
    maxTokens: 4000,
    prompt: `<message>\n${current}\n</message>\n\nThe change: ${ask}\n\nReturn the whole message with the change made.`,
  });
  let message = out.message.trim();
  if (!message) return { ok: false, error: "The rewrite came back empty; the message is unchanged." };
  if (whiteLabel) message = forClient(message, true);
  if (current.trimStart().startsWith("<!here>")) message = openWithHere(message);
  const now = new Date().toISOString();
  const { error } = bundleId ? await admin.from("report_bundles").update({ message, message_approved_at: null, message_approved_by: null }).eq("id", bundleId).neq("status", "sent") : await admin.from("reports").update({ message, updated_at: now }).eq("id", reportId).neq("status", "posted");
  if (error) return { ok: false, error: "It couldn't be saved. Try again." };
  return { ok: true, message, changed: out.changed.trim().slice(0, 300), bundleId };
}
