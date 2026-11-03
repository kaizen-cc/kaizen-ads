import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// What the Brand Bible found wrong on the client's website and in our own numbers, sorted for who it's for:
// - for the client: problems on their site (every product shows sold out, two shipping prices) as suggestions, when
//   their website isn't ours to fix. They go out only when the app may reach the client (the client_outreach hold);
//   otherwise the team sends them with one click.
// - for the team: anything we should fix or watch (their site, when it's in our scope; metrics, tracking, numbers
//   that disagree across sources), as an alert.
// Each names the exact page it was found on, and both feed audits and creative as context.

export type WebsiteIssue = { id: string; issue: string; pageUrl: string | null; audience: "client" | "team"; status: "open" | "sent" | "fixed" | "dismissed"; foundAt: string; sentAt: string | null };

const S = { type: "string" };
const SCHEMA = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: { type: "object", properties: { issue: S, page_url: S, kind: { type: "string", enum: ["website", "internal"] } }, required: ["issue", "page_url", "kind"], additionalProperties: false },
    },
  },
  required: ["issues"],
  additionalProperties: false,
};

const keyOf = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);

/**
 * Reads the Bible's notes for the team (and its page list) into issues, each with the page it's on and who it's for.
 * Runs once per Bible version (and again when the Bible is rebuilt).
 */
export async function readIssues(admin: SupabaseClient, clientId: string) {
  const [{ data: b }, { data: c }] = await Promise.all([
    admin.from("client_brand_bibles").select("markdown, team_notes, generated_at").eq("client_id", clientId).maybeSingle(),
    admin.from("clients").select("name, website, services, services_extra, services_removed").eq("id", clientId).single(),
  ]);
  if (!b?.markdown || !c) return 0;
  const notes = ((b.team_notes ?? []) as string[]).filter(Boolean);
  const now = new Date().toISOString();
  if (!notes.length) {
    await admin.from("client_brand_bibles").update({ issues_read_at: now }).eq("client_id", clientId);
    return 0;
  }
  const { servicesOf } = await import("@/lib/services");
  const ourSite = servicesOf(c).includes("web-design");
  // The pages the Bible lists, so each issue can name the exact one
  const { bibleLinks } = await import("@/lib/bible-links");
  const pages = bibleLinks(b.markdown as string, (c.website as string | null) ?? null).slice(0, 40);
  const { askJson } = await import("@/lib/ai");
  const out = await askJson<{ issues: { issue: string; page_url: string; kind: "website" | "internal" }[] }>({
    agent: "brandbible",
    label: `website issues ${c.name}`,
    override: { model: "haiku", effort: "low" },
    bare: true,
    system: `From a client's Brand Bible notes for the team, list the real problems found, one per item.
- kind "website": something wrong or confusing on the client's website or store (sold out everywhere, prices or shipping that disagree, a broken or dead page, a missing gift card page, slow or broken checkout).
- kind "internal": anything about our own work or data (ad metrics left out, KPI or pacing issues, tracking, numbers that disagree across sources).
- issue: one plain sentence, specific, as a suggestion would read.
- page_url: the exact page it was seen on, from the page list or the note itself (a full https URL), or "" when it's site-wide or not a page.
Skip notes that aren't problems (reminders, context). Never invent.`,
    prompt: `<website>${c.website ?? "unknown"}</website>\n<pages>\n${pages.map((p) => `${p.label ?? ""} ${p.url}`).join("\n") || "none listed"}\n</pages>\n<notes_for_the_team>\n${notes.map((n) => `- ${n}`).join("\n")}\n</notes_for_the_team>`,
    schema: SCHEMA,
    maxTokens: 2000,
  });
  const rows = out.issues
    .filter((i) => i.issue.trim())
    .slice(0, 20)
    .map((i) => ({
      client_id: clientId,
      key: keyOf(i.issue),
      issue: i.issue.trim().slice(0, 600),
      page_url: /^https?:\/\//i.test(i.page_url) ? i.page_url.slice(0, 500) : null,
      // Their website is theirs to fix unless it's in our scope: then it's ours, so it's the team's
      audience: i.kind === "website" && !ourSite ? "client" : "team",
    }));
  if (rows.length) await admin.from("website_issues").upsert(rows, { onConflict: "client_id,key", ignoreDuplicates: true });
  await admin.from("client_brand_bibles").update({ issues_read_at: now }).eq("client_id", clientId);
  // The team's alerts, and the client's suggestions when the app may reach them: only for a Bible just written (the
  // first read of the older Bibles files their issues quietly, shown on each Bible, instead of a wave of alerts)
  if (!b.generated_at || Date.now() - Date.parse(b.generated_at as string) > 3 * 86_400_000) return rows.length;
  const team = rows.filter((r) => r.audience === "team");
  if (team.length) await alertTeam(admin, clientId, team.map((r) => r.issue));
  const { autoOutreach } = await import("@/lib/client-outreach");
  if (rows.some((r) => r.audience === "client") && (await autoOutreach(admin, clientId))) await sendSuggestions(admin, clientId, null);
  return rows.length;
}

async function alertTeam(admin: SupabaseClient, clientId: string, issues: string[]) {
  const [{ data: c }, { data: buyers }, { data: leads }] = await Promise.all([
    admin.from("clients").select("name, slug").eq("id", clientId).single(),
    admin.from("client_assignments").select("profile_id").eq("client_id", clientId).in("role", ["meta_buyer", "google_buyer"]),
    admin.from("profiles").select("id").eq("is_active", true).eq("is_lead", true),
  ]);
  if (!c) return;
  const ids = [...new Set([...(buyers ?? []).map((b) => b.profile_id as string), ...(leads ?? []).map((l) => l.id as string)])];
  if (!ids.length) return;
  await admin.from("notifications").upsert(
    ids.map((id) => ({
      profile_id: id,
      kind: "client",
      title: `${c.name}: ${issues.length} thing${issues.length === 1 ? "" : "s"} to fix or watch`.slice(0, 200),
      body: issues.join(" · ").slice(0, 1000),
      href: `/clients/${c.slug}/brand-bible?s=issues`,
      client_id: clientId,
      key: `site-issues:${clientId}:${keyOf(issues.join(" ")).slice(0, 60)}`,
      priority: "normal",
    })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
}

/** The client's suggestions (every open one for them), by email to their contacts, kept with their other emails */
export async function sendSuggestions(admin: SupabaseClient, clientId: string, by: string | null) {
  const [{ data: c }, { data: open }] = await Promise.all([
    admin.from("clients").select("name").eq("id", clientId).single(),
    admin.from("website_issues").select("id, issue, page_url").eq("client_id", clientId).eq("audience", "client").eq("status", "open"),
  ]);
  if (!c || !open?.length) return { ok: false as const, error: "Nothing to send." };
  const { clientRecipients, logClientEmail } = await import("@/lib/client-emails");
  const { emailHtml, emailText } = await import("@/lib/email-layout");
  const { sendEmail } = await import("@/lib/email");
  const to = await clientRecipients(admin, clientId);
  if (!to.length) return { ok: false as const, error: "They have no contacts to send it to." };
  const subject = `${c.name}: a few things we noticed on your website`;
  const parts = (first: string | null) => ({
    preheader: "Quick fixes that help your ads turn into sales",
    kicker: "From your Kaizen team",
    title: "A few things we noticed on your site",
    highlight: "noticed",
    hello: first ? `Hi ${first},` : "Hi,",
    lines: ["While going through your site for your ads, we spotted a few things worth a look. Each one can cost sales from the people our ads send you:"],
    bullets: open.map((i) => `${i.issue}${i.page_url ? ` (${i.page_url})` : ""}`),
    note: "Reply to this email if you'd like a hand with any of them.",
  });
  for (const r of to) await sendEmail({ to: r.email, subject, html: emailHtml(parts(r.first)), text: emailText(parts(r.first)) }).catch(() => null);
  await logClientEmail(admin, { clientId, kind: "website-suggestions", subject, html: emailHtml(parts(to[0].first)), text: emailText(parts(to[0].first)), to: to.map((r) => r.email), by, manual: Boolean(by) });
  const now = new Date().toISOString();
  await admin.from("website_issues").update({ status: "sent", sent_at: now, sent_by: by }).in("id", open.map((i) => i.id as string));
  return { ok: true as const, sent: to.map((r) => r.email) };
}

export async function loadIssues(admin: SupabaseClient, clientId: string): Promise<WebsiteIssue[]> {
  const { data } = await admin.from("website_issues").select("*").eq("client_id", clientId).neq("status", "dismissed").order("found_at", { ascending: false }).limit(40);
  return (data ?? []).map((r) => ({ id: r.id, issue: r.issue, pageUrl: r.page_url, audience: r.audience, status: r.status, foundAt: r.found_at, sentAt: r.sent_at }));
}

/** For every agent that reads the client (audits, briefs, creative): what's wrong on the site and in our numbers */
export async function issuesBlock(db: SupabaseClient, clientId: string) {
  const [{ data: issues }, { data: links }] = await Promise.all([
    db.from("website_issues").select("issue, page_url, audience, status").eq("client_id", clientId).in("status", ["open", "sent"]).limit(20),
    db.from("bible_links").select("url, label, ok, change_note, changed_at").eq("client_id", clientId).or("ok.eq.false,change_note.not.is.null").order("changed_at", { ascending: false, nullsFirst: false }).limit(10),
  ]);
  const lines = [
    ...(issues ?? []).map((i) => `- ${i.audience === "client" ? "On their site (a suggestion for the client)" : "For us"}: ${i.issue}${i.page_url ? ` [${i.page_url}]` : ""}${i.status === "sent" ? " (sent to the client)" : ""}`),
    ...(links ?? []).map((l) => `- Page ${l.ok === false ? "gone or broken" : "changed"}: ${l.change_note ?? ""} [${l.url}]${l.changed_at ? ` (${String(l.changed_at).slice(0, 10)})` : ""}`),
  ];
  return lines.length ? `<website_and_data_issues note="found by the Brand Bible and the page checks; don't send traffic to a broken page, and use what changed (a new offer)">\n${lines.join("\n")}\n</website_and_data_issues>` : "";
}

/** Hourly: Bibles written or rebuilt since their issues were last read */
export async function keepIssues(admin: SupabaseClient, max = 3) {
  const { data } = await admin.from("client_brand_bibles").select("client_id, generated_at, issues_read_at").not("markdown", "is", null).not("generated_at", "is", null).limit(1000);
  const due = (data ?? []).filter((b) => !b.issues_read_at || Date.parse(b.issues_read_at as string) < Date.parse(b.generated_at as string)).slice(0, max);
  const out: Record<string, number | string> = {};
  for (const b of due) out[b.client_id as string] = await readIssues(admin, b.client_id as string).catch((e) => (e instanceof Error ? e.message : "failed"));
  return out;
}
