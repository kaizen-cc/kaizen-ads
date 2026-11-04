import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// The client's whole story in one document: made when a client is offboarded (and whenever someone asks), so the work
// is never lost and a client who comes back is picked up where we left off. It holds "where we left off" (written by
// the strategist from everything we know), the full Brand Bible with its change log, what their ads proved, the
// go-to-market strategies, the playbook of everything they ran, the answered Bible questions and what we found on
// their site. Coming back, the summary goes into the client's memory so every agent starts from it.

const day = () => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(new Date());

export async function makeExport(admin: SupabaseClient, clientId: string, reason: "offboarding" | "on demand", by: string | null) {
  const { clientContext, contextBlock, askJson } = await import("@/lib/ai");
  const [{ data: c }, { data: b }, ctx, { data: answered }, { issuesBlock }] = await Promise.all([
    admin.from("clients").select("name, website, industry, services, services_extra, services_removed, created_at, archive_reason").eq("id", clientId).single(),
    admin.from("client_brand_bibles").select("markdown, version, learnings, generated_at").eq("client_id", clientId).maybeSingle(),
    clientContext(admin, clientId),
    admin.from("bible_questions").select("question, answer, answered_by, answered_via, answered_at").eq("client_id", clientId).eq("stage", "answered").not("answer", "is", null).order("answered_at"),
    import("@/lib/website-issues"),
  ]);
  if (!c) return null;
  const { servicesOf } = await import("@/lib/services");
  const services = servicesOf(c);
  const learnings = ((b?.learnings ?? []) as { at: string; kind: string; text: string }[]).slice(-60);
  const issues = await issuesBlock(admin, clientId).catch(() => "");

  // Where we left off, in the strategist's words: the account, what worked and why, what didn't, what was next
  let summary = "";
  if (ctx) {
    const out = await askJson<{ summary: string }>({
      agent: "strategist",
      label: `client export ${c.name}`,
      clientId,
      override: { model: "sonnet", effort: "low" },
      system: `You write the handoff for a client the agency is ${reason === "offboarding" ? "parting with" : "documenting"}: "where we left off", for whoever picks the account up again, possibly years from now. Plain words, specific, under 400 words:
- the business and its goal, in a line;
- what we ran and where the account stands (the numbers that matter, against target);
- what proved to work and why (only what held up and was profitable), and the big things that didn't;
- what was in motion or planned next;
- anything a newcomer must know (the client's hard rules, how they like to work).
Never invent; say what's unknown.`,
      prompt: contextBlock(ctx),
      schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
      maxTokens: 3000,
    }).catch(() => null);
    summary = out?.summary?.trim() ?? "";
  }

  const parts = [
    `# ${c.name}: the account, packaged`,
    `${reason === "offboarding" ? "Made when they were offboarded" : "Made on request"}, ${day()}. Client since ${String(c.created_at).slice(0, 10)}. Services: ${services.join(", ") || "none on file"}.${c.website ? ` Website: ${c.website}.` : ""}${reason === "offboarding" && c.archive_reason ? ` ${c.archive_reason}` : ""}`,
    summary && `## Where we left off\n\n${summary}`,
    learnings.length ? `## What their ads proved\n\n${learnings.map((l) => `- ${l.at} ${l.kind === "avoid" ? "Didn't work" : "Worked"}: ${l.text}`).join("\n")}` : "",
    b?.markdown ? `## The Brand Bible (${b.version ?? ""})\n\n${String(b.markdown).replace(/^#\s+/gm, "### ").replace(/^##\s+/gm, "### ")}` : "",
    ctx?.gtm ? `## Go-to-market strategies\n\n${ctx.gtm}` : "",
    ctx?.playbook ? `## Everything they ran (the playbook)\n\n${ctx.playbook}` : "",
    answered?.length ? `## Questions answered for the Bible\n\n${answered.map((q) => `- ${q.question}\n  ${q.answer} (${q.answered_via === "client" ? "the client" : (q.answered_by ?? "the team")}, ${String(q.answered_at).slice(0, 10)})`).join("\n")}` : "",
    issues ? `## Website and data issues found\n\n${issues.replace(/<\/?website_and_data_issues[^>]*>/g, "").trim()}` : "",
  ].filter(Boolean);
  const markdown = parts.join("\n\n");
  const { data: row } = await admin.from("client_exports").insert({ client_id: clientId, reason, markdown, made_by: by }).select("id").single();
  return row ? { id: row.id as string, markdown, summary } : null;
}

/** Back in Kaizen Ads after being archived: the last package's "where we left off" goes into their memory */
export async function restoreExport(admin: SupabaseClient, clientId: string) {
  const { data: last } = await admin.from("client_exports").select("id, markdown, created_at").eq("client_id", clientId).is("restored_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!last) return false;
  const left = String(last.markdown).match(/## Where we left off\n\n([\s\S]*?)(?:\n## |$)/)?.[1]?.trim();
  if (left)
    await admin.from("client_memory").insert({ client_id: clientId, kind: "note", source: "team", dated: String(last.created_at).slice(0, 10), body: `Where we left off when they left (${String(last.created_at).slice(0, 10)}): ${left}`.slice(0, 1000) });
  await admin.from("client_exports").update({ restored_at: new Date().toISOString() }).eq("id", last.id);
  return true;
}
