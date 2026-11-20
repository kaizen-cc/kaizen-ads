import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { AiPaused, askJson } from "@/lib/ai";
import { flagGuidelineGap, notifyGuidelines } from "@/lib/bible-governance";
import { backfillOrder, extractHexColors, GUIDELINE_MARK, googleLinksIn, GUIDELINES_SECTION, hasGuidelines, isGuidelineFile, latestGuidelineFiles, mentionsGuideline, mergeHexColors, renderGuidelines, saysNotShared, type GuidelineRead, type Marker } from "@/lib/brand-guidelines-core";

// Brand guidelines into the Brand Bible, as soon as they're shared. Every hour (bible_upkeep) what came in since the
// last pass is checked for a guideline, logo, colors or fonts: Drive files in the client's folder, Slack and email
// messages, call notes (Gemini and Fireflies) and the intake form's brand question. A client with something new has
// it all read (the guideline files themselves opened from Drive), and the colors, fonts, logos and rules found, each
// with its source, go to the Head of Creative as a Bible change to approve. Nothing goes live in the Bible until it's
// approved (src/lib/bible-governance.ts writes it in). A Bible that says the guideline isn't shared while one was is
// flagged on the proposal. The first pass reaches back four months, so guidelines already shared are picked up.

const CURSOR = "brand_guidelines";
/** The Drive file names that can be a brand guideline (a PostgREST or-filter) */
const GUIDE_TITLES = "title.ilike.%brand%,title.ilike.%guide%,title.ilike.%style%,title.ilike.%logo%,title.ilike.%font%,title.ilike.%palette%,title.ilike.%identity%,title.ilike.%kit%";
const FIRST_DAYS = 120;
const SOURCES = ["drive", "slack_external", "slack_internal", "gmail", "call"];
const day = (iso: string) => String(iso).slice(0, 10);
const today = () => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(new Date());

const str = { type: "string" };
const SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    colors: { type: "array", items: { type: "object", properties: { name: str, hex: str, use: str, source: str }, required: ["name", "hex", "use", "source"], additionalProperties: false } },
    fonts: { type: "array", items: { type: "object", properties: { name: str, use: str, source: str }, required: ["name", "use", "source"], additionalProperties: false } },
    logos: { type: "array", items: { type: "object", properties: { name: str, link: str, use: str, source: str }, required: ["name", "link", "use", "source"], additionalProperties: false } },
    rules: { type: "array", items: { type: "object", properties: { rule: str, source: str }, required: ["rule", "source"], additionalProperties: false } },
  },
  required: ["found", "colors", "fonts", "logos", "rules"],
  additionalProperties: false,
};

const SYSTEM = `You read what a client of Kaizen Marketing (a paid ads and creative agency) shared about their brand guidelines, so the creative team follows them. Use only what's in the material; never invent a color, font or rule.
found: true when the material holds real guideline content (colors, fonts, logos or rules), false when it only mentions guidelines without giving any.
colors: each brand color with its name, hex code (as given; "" when only a name was given), what it's for (primary, accent, background, text) and source.
fonts: each typeface with what it's for (headlines, body) and source.
logos: each logo file or variant with its link when there is one and when to use it.
rules: the client's visual and brand rules (logo clear space, what never to do with the logo, color combinations, imagery, tone words from the guide). Short, one rule each.
source: where it came from, short, with the date: "Drive: Brand Guidelines doc, Sep 30", "Slack, Oct 6: updated brand kit colors", "Call, Oct 2", "Intake form".
When two sources disagree, the newest wins (a Slack update after the guide changes the color); keep only the current value and name the newer source.`;

type Signal = { key: string; at: string; label: string; text: string; url: string | null; file: boolean; title?: string | null };

/** Everything the client shared that mentions a guideline, logo, colors or fonts, newest first */
async function signalsFor(admin: SupabaseClient, clientId: string): Promise<Signal[]> {
  const since = new Date(Date.now() - 365 * 86_400_000).toISOString();
  const [{ data: recent }, { data: guideFiles }, { data: calls }, { data: intake }, { data: logos }] = await Promise.all([
    admin.from("context_items").select("id, source, occurred_at, author, title, body, url, meta").eq("client_id", clientId).in("source", SOURCES).gt("occurred_at", since).order("occurred_at", { ascending: false }).limit(1500),
    // The guideline files by their names, however old and however much came after them (a busy client's Drive pushed
    // its September brand guide out of the newest 1,500 items)
    admin.from("context_items").select("id, source, occurred_at, author, title, body, url, meta").eq("client_id", clientId).eq("source", "drive").or(GUIDE_TITLES).order("occurred_at", { ascending: false }).limit(200),
    admin.from("client_calls").select("id, source, title, occurred_at, url, notes").eq("client_id", clientId).gt("occurred_at", since).order("occurred_at", { ascending: false }).limit(60),
    admin.from("client_intakes").select("id, received_at, answers").eq("client_id", clientId).order("received_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("client_assets").select("file_id, name, url, created_at").eq("client_id", clientId).ilike("name", "%logo%").order("created_at", { ascending: false }).limit(12),
  ]);
  const out: Signal[] = [];
  const ids = new Set<string>();
  const items = [...(guideFiles ?? []), ...(recent ?? [])].filter((i) => !ids.has(i.id as string) && Boolean(ids.add(i.id as string)));
  for (const i of items) {
    const file = i.source === "drive";
    if (file ? !isGuidelineFile(i.title) && !mentionsGuideline(i.body) : !mentionsGuideline(`${i.title ?? ""} ${i.body ?? ""}`)) continue;
    const where = file ? "Drive file" : i.source === "gmail" ? "Email" : i.source === "call" ? "Call" : i.source === "slack_internal" ? "Slack (internal)" : "Slack (with client)";
    out.push({ key: `item:${i.id}`, at: i.occurred_at as string, label: `${where}, ${day(i.occurred_at as string)}${i.author ? ` · ${i.author}` : ""}${i.title ? ` · "${i.title}"` : ""}`, text: String(i.body ?? "").slice(0, file ? 12_000 : 3000), url: (i.url as string | null) ?? null, file, title: i.title as string | null });
  }
  for (const c of calls ?? []) {
    const notes = String(c.notes ?? "");
    if (!mentionsGuideline(notes)) continue;
    // The parts of the call that talk about it, not the whole transcript
    const parts = notes.split(/\n+/).filter((l) => mentionsGuideline(l)).slice(0, 20).join("\n");
    out.push({ key: `call:${c.id}`, at: c.occurred_at as string, label: `Call (${c.source === "fireflies" ? "Fireflies" : "Gemini notes"}), ${day(c.occurred_at as string)} · "${c.title}"`, text: parts.slice(0, 3000), url: (c.url as string | null) ?? null, file: false });
  }
  const answers = (intake?.answers ?? []) as { q?: string; a?: unknown }[];
  const guide = Array.isArray(answers) ? answers.find((x) => /brand guide|guideline/i.test(String(x.q ?? ""))) : null;
  if (intake && guide && String(guide.a ?? "").trim()) out.push({ key: `intake:${intake.id}`, at: intake.received_at as string, label: `Intake form, ${day(intake.received_at as string)}`, text: `${guide.q}: ${String(guide.a).slice(0, 3000)}`, url: null, file: false });
  for (const l of logos ?? []) out.push({ key: `asset:${l.file_id}`, at: (l.created_at as string) ?? since, label: `Logo file in Drive, ${day((l.created_at as string) ?? since)} · "${l.name}"`, text: "", url: (l.url as string | null) ?? null, file: false });
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** The guideline files themselves, opened from Drive (a doc, slides, a PDF): the files in the folder and links in messages */
async function readFiles(signals: Signal[]) {
  const user = process.env.GOOGLE_DRIVE_USER;
  if (!user) return [];
  const { readGoogleFile } = await import("@/lib/assistant/read-file");
  const links = [...new Set([...signals.filter((s) => s.file && s.url).map((s) => s.url!), ...signals.flatMap((s) => googleLinksIn(s.text))])].slice(0, 4);
  const out: { title: string; url: string; text: string }[] = [];
  for (const url of links) {
    const r = await readGoogleFile(user, url).catch(() => null);
    if (r?.ok && r.text.trim()) out.push({ title: r.title, url: r.url, text: r.text.slice(0, 30_000) });
  }
  return out;
}

/**
 * Reads one client's guideline signals and, when they hold something, puts it to the Head of Creative as a Bible
 * change. The same signals are never proposed twice; a newer read replaces a proposal still waiting.
 */
export async function ingestGuidelines(admin: SupabaseClient, clientId: string): Promise<"proposed" | "none" | "same" | "no_bible" | "not_ready"> {
  const signals = await signalsFor(admin, clientId);
  if (!signals.length) return "none";
  const fingerprint = createHash("sha1").update(signals.map((s) => s.key).sort().join("|")).digest("hex").slice(0, 16);
  const [{ data: bible }, { data: client }, { data: seen }] = await Promise.all([
    admin.from("client_brand_bibles").select("markdown").eq("client_id", clientId).maybeSingle(),
    admin.from("clients").select("name").eq("id", clientId).maybeSingle(),
    admin.from("bible_changes").select("id").eq("client_id", clientId).eq("kind", "question_answer").contains("proposed", { ...GUIDELINE_MARK, fingerprint }).limit(1).maybeSingle(),
  ]);
  // Every guideline file found is one of the client's documents (once each), whether or not it's been proposed before
  await registerDocs(admin, clientId, signals);
  if (seen) return "same";
  if (!bible?.markdown || !client) return "no_bible";
  const files = await readFiles(signals);
  await registerDocs(admin, clientId, files.map((f) => ({ key: f.url, at: new Date().toISOString(), label: "", text: f.text, url: f.url, file: true, title: f.title })));
  const { splitBible } = await import("@/lib/bible-sections");
  const current = splitBible(bible.markdown as string).find((s) => s.title.toLowerCase() === GUIDELINES_SECTION.toLowerCase());
  const asked = await askJson<GuidelineRead>({
    agent: "brandbible",
    clientId,
    label: `brand guidelines ${client.name}`,
    system: SYSTEM,
    schema: SCHEMA,
    maxTokens: 6000,
    prompt: `Client: ${client.name}. Today is ${today()}.
${files.map((f) => `\n<guideline_file title="${f.title.replace(/"/g, "'")}" link="${f.url}">\n${f.text}\n</guideline_file>`).join("\n")}

<what_they_shared note="messages, call notes, the intake form and files about their brand, newest first">
${signals.map((s) => `- ${s.label}${s.url ? ` (${s.url})` : ""}${s.text ? `: ${s.text.replace(/\s+/g, " ").slice(0, s.file ? 6000 : 1500)}` : ""}`).join("\n").slice(0, 40_000)}
</what_they_shared>
${current ? `\n<in_the_bible_now>\n${current.body.slice(0, 6000)}\n</in_the_bible_now>\nKeep what's there and still holds; add or update from the material.` : ""}`,
  });
  // Hex codes written in the files and messages are never missed: any the read left out are added with their source
  const hexes = [
    ...files.flatMap((f) => extractHexColors(f.text, `Drive: ${f.title}`)),
    ...signals.filter((s) => s.text).flatMap((s) => extractHexColors(s.text, s.label.replace(/ · [^·]*$/, "").slice(0, 80))),
  ];
  const read = mergeHexColors(asked, hexes);
  const gap = saysNotShared(bible.markdown as string);
  if (!hasGuidelines(read)) {
    // A guideline file is there but nothing could be read from it: the Bible still shouldn't say none was shared
    if (gap && signals.some((s) => s.file && isGuidelineFile(s.title))) await flagGuidelineGap(admin, clientId, `${clientId}:${fingerprint}`, "A brand guideline file is in the client's Drive (see their Documents tab), but nothing could be read from it. Open it and add the colors, fonts and logos to the Bible.");
    return "none";
  }
  const sources = [...new Set([...files.map((f) => `${f.title}: ${f.url}`), ...signals.slice(0, 12).map((s) => `${s.label}${s.url ? `: ${s.url}` : ""}`)])];
  const reason = `${gap ? "Flag: the Bible says the brand guideline isn't shared, but the client shared one. " : ""}Read from ${sources.length} place${sources.length === 1 ? "" : "s"} the client shared their brand: ${read.colors.length} colors, ${read.fonts.length} fonts, ${read.logos.length} logos, ${read.rules.length} rules. Approve to write them into the Bible's ${GUIDELINES_SECTION} section.`;
  const { data: row, error } = await admin
    .from("bible_changes")
    .insert({ client_id: clientId, kind: "question_answer", answer: renderGuidelines(read, today()), proposed: { ...GUIDELINE_MARK, fingerprint, gap }, reason, evidence: sources.join("\n").slice(0, 4000), proposed_by_name: "Kaizen AI" })
    .select("id")
    .single();
  // Not saved (the database refused it): the next pass tries again
  if (error || !row) return "not_ready";
  // An older read still waiting is replaced by this one
  await admin
    .from("bible_changes")
    .update({ status: "rejected", decided_at: new Date().toISOString(), decided_by_name: "Kaizen AI", decision_note: "Replaced by a newer read of the guidelines" })
    .eq("client_id", clientId)
    .eq("kind", "question_answer")
    .contains("proposed", GUIDELINE_MARK)
    .eq("status", "pending")
    .neq("id", row.id);
  await notifyGuidelines(admin, clientId, row.id as string, gap, reason);
  return "proposed";
}

/** Each guideline file lands in the client's Documents tab as a link to its source, once (matched on the link) */
async function registerDocs(admin: SupabaseClient, clientId: string, signals: Signal[]) {
  const files = signals.filter((s) => s.file && s.url && /^https?:\/\//.test(s.url) && isGuidelineFile(s.title));
  if (!files.length) return 0;
  const { data: have } = await admin.from("client_documents").select("url").eq("client_id", clientId).eq("kind", "link").not("url", "is", null).limit(1000);
  const known = new Set((have ?? []).map((d) => String(d.url)));
  const rows = [];
  for (const f of files) {
    if (known.has(f.url!)) continue;
    known.add(f.url!);
    rows.push({
      client_id: clientId,
      kind: "link",
      name: String(f.title ?? "Brand guidelines").slice(0, 200),
      url: f.url,
      title: String(f.title ?? "Brand guidelines").slice(0, 200),
      summary: `Brand guideline file found in the client's Drive. Read into the Brand Bible's ${GUIDELINES_SECTION} section for the Head of Creative to approve.`,
      text: f.text ? f.text.slice(0, 30_000) : null,
      status: "ready",
      via: "page",
    });
  }
  if (!rows.length) return 0;
  const { error } = await admin.from("client_documents").insert(rows);
  return error ? 0 : rows.length;
}

/**
 * The back-fill: every client not archived, read once for guidelines already in the context we sync (not only what's new
 * since the hourly pass), a few per run inside the time budget. A marker per client (sync_state, one batched read) holds
 * the newest guideline file it covered, so a client is read once and again only when a newer guideline file shows up.
 */
async function backfill(admin: SupabaseClient, deadline: number, perRun = 6) {
  const [{ data: clients }, { data: files }, { data: marks }] = await Promise.all([
    admin.from("clients").select("id").is("archived_at", null).in("status", ["onboarding", "active", "paused"]).limit(2000),
    admin.from("context_items").select("client_id, title, url, occurred_at").eq("source", "drive").or(GUIDE_TITLES).order("occurred_at", { ascending: false }).limit(5000),
    admin.from("sync_state").select("source, cursor_at, last_run_at").like("source", `${CURSOR}:%`).limit(3000),
  ]);
  const latest = latestGuidelineFiles((files ?? []) as { client_id: string; title: string | null; url: string | null; occurred_at: string }[]);
  const markers: Marker[] = (marks ?? []).map((m) => ({ clientId: String(m.source).slice(CURSOR.length + 1), doneAt: String(m.last_run_at ?? ""), filesAt: m.cursor_at ? String(m.cursor_at) : null }));
  const todo = backfillOrder((clients ?? []).map((c) => c.id as string), markers, latest);
  const out: Record<string, number> = { owed: todo.length };
  let n = 0;
  for (const id of todo) {
    if (n >= perRun || Date.now() > deadline) break;
    try {
      const r = await ingestGuidelines(admin, id);
      out[r] = (out[r] ?? 0) + 1;
      // not_ready (the database refused it) is tried again next run; everything else is done for this client
      if (r === "not_ready") continue;
      n++;
      await admin.from("sync_state").upsert({ source: `${CURSOR}:${id}`, cursor_at: latest.get(id) ?? null, last_run_at: new Date().toISOString(), last_result: { result: r } });
    } catch (e) {
      if (e instanceof AiPaused) break;
      out.failed = (out.failed ?? 0) + 1;
      console.error("[guidelines backfill]", id, e instanceof Error ? e.message : e);
    }
  }
  out.done = n;
  return out;
}

/**
 * One client, now (an exec asked, or the assistant on their behalf): their guidelines read into the Documents tab and
 * proposed for the Bible, and their back-fill marked done so the hourly pass doesn't read them again.
 */
export async function guidelinesForClient(admin: SupabaseClient, clientId: string) {
  const r = await ingestGuidelines(admin, clientId);
  if (r !== "not_ready") {
    const { data: files } = await admin.from("context_items").select("client_id, title, url, occurred_at").eq("client_id", clientId).eq("source", "drive").or(GUIDE_TITLES).order("occurred_at", { ascending: false }).limit(200);
    const latest = latestGuidelineFiles((files ?? []) as { client_id: string; title: string | null; url: string | null; occurred_at: string }[]);
    await admin.from("sync_state").upsert({ source: `${CURSOR}:${clientId}`, cursor_at: latest.get(clientId) ?? null, last_run_at: new Date().toISOString(), last_result: { result: r } });
  }
  return { result: r };
}

/** The hourly pass: clients with something new about their brand since the last one, read and proposed */
export async function keepGuidelines(admin: SupabaseClient, budgetMs = 240_000) {
  const deadline = Date.now() + budgetMs;
  const started = new Date();
  const { data: st } = await admin.from("sync_state").select("cursor_at").eq("source", CURSOR).maybeSingle();
  const since = st?.cursor_at ? String(st.cursor_at) : new Date(Date.now() - FIRST_DAYS * 86_400_000).toISOString();
  const [{ data: items }, { data: calls }, { data: intakes }, { data: logos }] = await Promise.all([
    admin.from("context_items").select("client_id, source, title, body").in("source", SOURCES).gt("created_at", since).limit(5000),
    admin.from("client_calls").select("client_id, notes").not("client_id", "is", null).gt("created_at", since).limit(500),
    admin.from("client_intakes").select("client_id").not("client_id", "is", null).gt("received_at", since).limit(200),
    admin.from("client_assets").select("client_id").ilike("name", "%logo%").gt("seen_at", since).limit(500),
  ]);
  const due = new Set<string>();
  for (const i of items ?? []) if (i.source === "drive" ? isGuidelineFile(i.title) || mentionsGuideline(i.body) : mentionsGuideline(`${i.title ?? ""} ${i.body ?? ""}`)) due.add(i.client_id as string);
  for (const c of calls ?? []) if (mentionsGuideline(c.notes as string | null)) due.add(c.client_id as string);
  for (const x of [...(intakes ?? []), ...(logos ?? [])]) due.add(x.client_id as string);
  const out: Record<string, number> = { clients: due.size };
  let finished = true;
  for (const id of due) {
    if (Date.now() > deadline) {
      finished = false;
      break;
    }
    try {
      const r = await ingestGuidelines(admin, id);
      out[r] = (out[r] ?? 0) + 1;
      if (r === "not_ready") finished = false;
    } catch (e) {
      if (e instanceof AiPaused) {
        finished = false;
        break;
      }
      out.failed = (out.failed ?? 0) + 1;
      console.error("[guidelines]", id, e instanceof Error ? e.message : e);
    }
  }
  // Only moves on once every client due was read (a stopped pass reads them again; the fingerprint skips repeats)
  await admin.from("sync_state").upsert({ source: CURSOR, ...(finished ? { cursor_at: started.toISOString() } : {}), last_run_at: new Date().toISOString(), last_result: out });
  // Whatever time is left reads clients the hourly pass never reached (the back-fill), a few at a time until every client has been read once
  const back = await backfill(admin, deadline).catch((e) => ({ failed: 1, error: String(e) }));
  return { ...out, backfill: back };
}
