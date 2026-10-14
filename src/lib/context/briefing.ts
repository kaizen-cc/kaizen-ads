import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AGENCY_SYSTEM,
  DIGEST_SCHEMA,
  SUGGESTIONS_SCHEMA,
  SUGGEST_FIELDS,
  askJson,
  clientContext,
  cleanSuggestions,
  contextBlock,
  type Digest,
  type Suggestions,
} from "@/lib/ai";

// Folds what's new in Slack, Gmail and Drive into each client's briefing, and makes the request
// suggestions ahead of time. Clients with nothing new since the last run are skipped.

const LABEL: Record<string, string> = { slack_internal: "Slack (internal)", slack_external: "Slack (with client)", gmail: "Email", drive: "Drive file" };

type Item = { source: string; occurred_at: string; author: string | null; title: string | null; body: string | null; url: string | null; meta: { folder?: string } };

export async function refreshBriefing(admin: SupabaseClient, clientId: string, force = false) {
  const { data: prev } = await admin.from("client_briefings").select("updated_through, generated_at").eq("client_id", clientId).maybeSingle();
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  // "New" means arrived since the last briefing, not dated since: a mailbox read later can bring older emails
  const lastRun = force || !prev ? null : prev.generated_at;
  const since = prev?.updated_through ?? monthAgo;

  let messages = admin
    .from("context_items")
    .select("source, occurred_at, author, title, body, url, meta")
    .eq("client_id", clientId)
    .neq("source", "drive") // Drive files are listed on their own below, so hundreds of photos don't crowd out emails
    .gt("occurred_at", monthAgo)
    .order("occurred_at", { ascending: false })
    .limit(150);
  if (lastRun) messages = messages.gt("created_at", lastRun);
  let newFiles = admin.from("context_items").select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("source", "drive");
  if (lastRun) newFiles = newFiles.gt("created_at", lastRun);

  const [{ data: fresh }, { count: fileCount }, { count: newRequests }, { count: newMemory }, { data: driveFiles }, { data: refs }] = await Promise.all([
    messages,
    newFiles,
    admin.from("requests").select("id", { count: "exact", head: true }).eq("client_id", clientId).gt("created_at", lastRun ?? monthAgo),
    admin.from("client_memory").select("id", { count: "exact", head: true }).eq("client_id", clientId).gt("created_at", lastRun ?? monthAgo),
    admin
      .from("context_items")
      .select("external_id, title, url, occurred_at, meta")
      .eq("client_id", clientId)
      .eq("source", "drive")
      .gt("occurred_at", new Date(Date.now() - 30 * 86_400_000).toISOString())
      .order("occurred_at", { ascending: false })
      .limit(60),
    admin.from("requests").select("brief, refs").eq("client_id", clientId).gt("created_at", new Date(Date.now() - 60 * 86_400_000).toISOString()),
  ]);
  const items = (fresh ?? []) as Item[];
  if (lastRun && items.length === 0 && !fileCount && !newRequests && !newMemory) return { skipped: true };

  const ctx = await clientContext(admin, clientId);
  if (!ctx) return { skipped: true };

  // A Drive file counts as used once a request links to it
  const used = (refs ?? []).map((r) => `${r.brief ?? ""} ${(r.refs ?? []).join(" ")}`).join(" ");
  const unused = (driveFiles ?? []).filter((f) => !used.includes(f.external_id));

  const activity = items
    .slice()
    .reverse()
    .map(
      (i) =>
        `- ${i.occurred_at.slice(0, 16).replace("T", " ")} · ${LABEL[i.source] ?? i.source}${i.author ? ` · ${i.author}` : ""}${i.title ? ` · "${i.title}"` : ""}${
          i.meta?.folder ? ` · in ${i.meta.folder}` : ""
        }${i.body ? `\n  ${i.body.replace(/\s+/g, " ").slice(0, 1200)}` : ""}`,
    )
    .join("\n");

  const result = await askJson<{ digest: Digest; suggestions: Suggestions }>({
    label: `briefing ${ctx.name}`,
    system: AGENCY_SYSTEM,
    effort: "medium",
    schema: { type: "object", properties: { digest: DIGEST_SCHEMA, suggestions: SUGGESTIONS_SCHEMA }, required: ["digest", "suggestions"], additionalProperties: false },
    prompt: `${contextBlock(ctx)}

<new_messages>
${activity || "Nothing new in Slack or email."}
</new_messages>

<drive_files_last_30_days_not_used_in_a_request>
${unused.map((f) => `- ${f.title} (${f.occurred_at.slice(0, 10)})${(f.meta as { folder?: string })?.folder ? ` in ${(f.meta as { folder?: string }).folder}` : ""} ${f.url}`).join("\n") || "None."}
</drive_files_last_30_days_not_used_in_a_request>

Update this client's briefing for the creative team. Keep what still holds from the existing briefing (if any), fold in the new activity, and drop anything that's been resolved or contradicted. Treat what the client says in Slack or email as the strongest signal; internal Slack is the team's read on it. Only state what the sources support.
digest:
- summary: 2 to 3 sentences on where things stand with this client's creative right now.
- direction: the current campaign direction in one or two sentences (offers, seasons, launches, focus), or empty if unknown.
- asks: open requests or changes the client or team asked for, short.
- avoid: things the client said not to do or that went badly, short. Include client memory "avoid" items that still apply.
- works: what the client likes or what performed well, short.
- newAssets: Drive files from the list above worth using in creative, with a short note on what each is good for. Skip duplicates and working files.
- openQuestions: things to clarify with the client before the next request, if any.

suggestions: suggestions for the next creative request, with nothing filled in yet.
${SUGGEST_FIELDS}`,
  });

  const counts = { slack: 0, gmail: 0, drive: fileCount ?? 0 };
  for (const i of items) {
    if (i.source.startsWith("slack")) counts.slack++;
    else if (i.source === "gmail") counts.gmail++;
  }
  const { error } = await admin.from("client_briefings").upsert({
    client_id: clientId,
    digest: result.digest,
    suggestions: cleanSuggestions(result.suggestions),
    sources: counts,
    updated_through: items[0]?.occurred_at && items[0].occurred_at > since ? items[0].occurred_at : since,
    generated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Saving briefing: ${error.message}`);
  return { skipped: false, ...counts };
}
