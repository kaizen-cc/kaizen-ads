import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, type AgentKey } from "@/lib/ai";
import { emailSowToKDoc } from "./email-sow";
import { BLOCK_GUIDE, cleanKDoc, docText, dollarsIn, fileName, KDOC_SCHEMA, mayMake, pickTemplate, PRICE_TBD, TEMPLATES, type KDoc, type RatePrice, type TemplateKey } from "./templates";

// Makes a Kaizen document in Google (src/lib/kaizen-docs): picks the template from what was asked, reads what Kaizen
// OS knows (the client's package and services, Brand Bible, KPIs, intake, calls and messages: get_client_context's
// brief), the rate card, the email packages and prices confirmed in the conversation, has the line's agent fill the
// template's sections, guards every price, makes the Google Doc or Slides as the person in the right folder, exports
// a PDF for email attachments, and keeps it with the client's documents. One place for the assistant, Kaizen AI and
// the pages.

const BUCKET = "client-docs";

export type DocMe = { id: string; fullName: string; email: string; isExec: boolean; isLead: boolean; role: string };

export type MakeDocInput = {
  admin: SupabaseClient;
  me: DocMe;
  /** What the person asked for, in their words */
  ask: string;
  template?: TemplateKey | null;
  client?: { id: string; name: string } | null;
  /** A prospect (not a client yet) by name */
  prospect?: string | null;
  /** The assistant's notes: what it looked up, the person's answers, the content it drafted */
  brief: string;
  /** Prices the person confirmed in this conversation (relationship pricing) */
  confirmed?: readonly { label: string; amount: number; cadence: "one_time" | "month" }[];
  /** The service line it's about (email, meta, google, social, creative, web) */
  line?: string | null;
  title?: string | null;
  /** The Drive folder they named or linked in this conversation */
  folder?: string | null;
  /** Their yes to the folder said back (remembered, or Kaizen's default) */
  folderYes?: boolean;
};

export type MadeDoc =
  | { ok: true; id: string; template: TemplateKey; title: string; url: string; kind: "doc" | "slides"; place: string; folderUrl: string; saved: string; placeholders: string[]; pdf: string | null; footerSet: boolean; rateCardEmpty: boolean }
  | { ok: false; error: string; ask?: string }
  /** Where it goes in Drive isn't settled yet: say this to the person (asked before anything is written) */
  | { ok: false; where: Record<string, unknown> };

/** The rate card (empty until the executives fill it) and the email packages, as prices a document may quote */
export async function storedRates(admin: SupabaseClient): Promise<{ rates: RatePrice[]; rateCardEmpty: boolean; lines: string[] }> {
  const [{ data: card }, { data: email }] = await Promise.all([
    admin.from("rate_card").select("service, tier, label, cadence, amount, note").eq("active", true).order("service").order("sort_order"),
    admin.from("email_packages").select("label, kind, price_monthly").eq("active", true).order("sort_order"),
  ]);
  const rates: RatePrice[] = [
    ...(card ?? []).map((r) => ({ label: `${r.service}${r.tier ? ` ${r.tier}` : ""}: ${r.label}`, amount: Number(r.amount), cadence: r.cadence as "one_time" | "month", source: "rate_card" as const })),
    ...(email ?? []).filter((p) => p.price_monthly != null && Number(p.price_monthly) > 0).map((p) => ({ label: `Email ${p.label}${p.kind === "setup" ? " (setup)" : ""}`, amount: Number(p.price_monthly), cadence: "month" as const, source: "package" as const })),
  ];
  const lines = (card ?? []).map((r) => `- ${r.service}${r.tier ? ` / ${r.tier}` : ""}: ${r.label}, $${Number(r.amount).toLocaleString("en-US")} ${r.cadence === "month" ? "a month" : "one time"}${r.note ? ` (${r.note})` : ""}`);
  return { rates, rateCardEmpty: !(card ?? []).length, lines };
}

const AGENT_FOR: Record<string, AgentKey> = { email: "email_desk", social: "social_desk", google: "strategist", meta: "strategist", creative: "strategist", web: "strategist" };

function systemFor(t: TemplateKey, rateLines: string[], emailLines: string[]): string {
  const def = TEMPLATES[t];
  const sections = def.sections.length
    ? `SECTIONS (use these keys, in this order; a section marked optional only when it applies):\n${def.sections.map((s) => `- ${s.key}${s.optional ? " (optional)" : ""}: "${s.heading}". ${s.guide}`).join("\n")}`
    : `SECTIONS: choose 4 to 10 sections that fit what was asked (key: a short slug, heading: a clear title, lede: one or two sentences), each built from blocks.`;
  return `You write Kaizen Marketing Agency's client-facing documents: ${def.label}. ${def.purpose}
Kaizen's voice: a confident, warm partner. Plain words, short sentences, active voice, specific to the client's business and industry. No em dashes or en dashes (use commas or periods). Numbers as digits, ranges as "3 to 5". Kaizen roles, never team members' names (the client's people by name is fine). Kaizen's line: "Get 1% better every day."

${sections}

${BLOCK_GUIDE}

FACTS: use only what's given (the client's data, what the person said, the assistant's notes). Never invent a number. A fact you don't have is a bracketed placeholder: [Start Date], [Client Contact], [XX].

PRICES: quote only these (a total may add them up), or a price the person confirmed (listed as confirmed). Anything else is written as ${PRICE_TBD}, never guessed.
${rateLines.length ? `Kaizen's rate card:\n${rateLines.join("\n")}` : "Kaizen's rate card is empty: every Kaizen fee is " + PRICE_TBD + " unless confirmed."}
${emailLines.length ? `Email packages (monthly): ${emailLines.join(", ")}` : ""}
When confirmed prices differ from the rate card, it's relationship pricing: say "Relationship pricing, as discussed." in the investment section's lede.

title: the document's name ("Aesthetic Edge Relaunch & Growth Proposal", "Your New Website", "Email Marketing Engagement"). subtitle: one line on what it covers. kicker: ${t === "sow" ? '"Scope of Work | <engagement>"' : t === "quote" ? '"Web Development Proposal" or the kind of project' : '""'}. prepared_for: "<names>, <company>" or "[Client Contact], <company>".`;
}

/** Everything Kaizen OS knows about the client, for the writer */
async function clientFacts(admin: SupabaseClient, clientId: string): Promise<string> {
  const [{ clientBrief }, { clientPackage, packageBlock }] = await Promise.all([import("@/lib/kaizen-ai/tools"), import("@/lib/client-package")]);
  const [brief, pkg] = await Promise.all([clientBrief(admin, clientId).catch(() => ""), clientPackage(admin, clientId).catch(() => null)]);
  return [brief, pkg ? packageBlock(pkg) : ""].filter(Boolean).join("\n\n").slice(0, 60000);
}

/** Makes the document in Google, files it and keeps it */
export async function makeKaizenDoc(input: MakeDocInput): Promise<MadeDoc> {
  const { admin, me } = input;
  const template = input.template ?? pickTemplate(`${input.ask} ${input.title ?? ""}`);
  if (!template) return { ok: false, error: "Which kind of document is this?", ask: "Is this a sales proposal (a deck to pitch new work), a project quote (a one-time build like a website), a Scope of Work (a retainer, sprint or tier options), or another document or deck?" };
  if (!mayMake(template, me)) return { ok: false, error: `${TEMPLATES[template].label}s are made by the executives and the line heads. I can make it as a general Kaizen document instead.` };
  const client = input.client ?? null;
  const prospect = client ? null : (input.prospect?.trim() || null);
  const line = (input.line ?? "").toLowerCase();
  const dated = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "America/New_York" });

  // Where it goes in Drive, settled before the minute of writing: named, or said back for a yes (never a guess)
  const { docDestination } = await import("./destination");
  const where = await docDestination({ admin, me, template, client, prospect, folder: input.folder, confirmed: input.folderYes });
  if ("reply" in where) return { ok: false, where: where.reply };

  let doc: KDoc;
  if (template === "sow" && client && (line.startsWith("email") || line === "sms" || /\bemail|klaviyo|sms\b/i.test(input.ask)) ) {
    // An email SOW comes from the Email SOW Generator (Sprint Recap and Ongoing Management structure, email packages)
    const { writeEmailSow } = await import("@/lib/email-sow/server");
    const { sow } = await writeEmailSow({ admin, client, brief: `${input.ask}\n\n${input.brief}`, confirmed: (input.confirmed ?? []).map((c) => ({ label: c.label, amount: c.amount, cadence: c.cadence })) });
    doc = emailSowToKDoc(sow, `${me.fullName}, Kaizen Marketing Agency`);
  } else {
    const [{ rates, lines }, facts] = await Promise.all([storedRates(admin), client ? clientFacts(admin, client.id) : Promise.resolve("")]);
    const confirmed: RatePrice[] = (input.confirmed ?? []).map((c) => ({ ...c, source: "confirmed" }));
    const emailLines = rates.filter((r) => r.source === "package").map((r) => `${r.label.replace(/^Email /, "")} $${r.amount.toLocaleString("en-US")}`);
    const raw = await askJson<Record<string, unknown>>({
      agent: AGENT_FOR[line.split(/\W/)[0]] ?? "strategist",
      label: "kaizen doc",
      clientId: client?.id ?? null,
      system: systemFor(template, lines, emailLines),
      maxTokens: 24000,
      schema: KDOC_SCHEMA,
      prompt: [
        `Today: ${new Date().toISOString().slice(0, 10)}. ${client ? `Client: ${client.name}.` : prospect ? `Prospect (not a client yet): ${prospect}.` : "No client."} Prepared by ${me.fullName}, Kaizen Marketing Agency.`,
        `<what they asked>\n${input.ask.slice(0, 4000)}\n</what they asked>`,
        input.title ? `Title they gave: ${input.title}` : "",
        confirmed.length ? `<confirmed_prices>\n${confirmed.map((c) => `${c.label}: $${c.amount.toLocaleString("en-US")} ${c.cadence === "month" ? "a month" : "one time"}`).join("\n")}\n</confirmed_prices>` : "",
        input.brief.trim() ? `<notes>\n${input.brief.slice(0, 16000)}\n</notes>` : "",
        facts ? `<client facts from Kaizen OS>\n${facts}\n</client facts>` : "",
        "Write the whole document now.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    doc = cleanKDoc(raw, { template, client: client?.name ?? prospect, preparedBy: `${me.fullName}, Kaizen Marketing Agency`, dated, prices: [...rates, ...confirmed], figures: [...dollarsIn(facts), ...dollarsIn(input.ask), ...dollarsIn(input.brief)] });
  }

  const { filedAt, makeGoogleFile } = await import("./google");
  let filed;
  let made;
  try {
    filed = await filedAt(me.email, where.save);
    made = await makeGoogleFile(doc, filed, me);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/unauthorized_client|invalid_scope|access_denied/i.test(m)) return { ok: false, error: "Google won't let Kaizen OS make Docs and Slides as you yet: an admin needs to allow the Drive, Slides and Docs scopes for Kaizen's service account (Google Admin, Security, API controls, Domain-wide delegation)." };
    return { ok: false, error: `Google had a problem making it: ${m.slice(0, 200)}` };
  }

  const id = crypto.randomUUID();
  const name = fileName(doc);
  let path: string | null = null;
  if (made.pdf) {
    path = `${client?.id ?? `people/${me.id}`}/kaizen/${id}/v1.pdf`;
    const up = await admin.storage.from(BUCKET).upload(path, made.pdf, { contentType: "application/pdf", upsert: true });
    if (up.error) path = null;
  }
  const text = docText(doc);
  let clientDocId: string | null = null;
  if (client) {
    const { data: cd } = await admin.from("client_documents").insert({ client_id: client.id, kind: "link", name, url: made.url, path, mime: made.kind === "slides" ? "application/vnd.google-apps.presentation" : "application/vnd.google-apps.document", title: `${TEMPLATES[template].label}: ${doc.title}`.slice(0, 200), summary: doc.sections[0]?.lede || null, text, status: "ready", via: "assistant", uploaded_by: me.id }).select("id").single();
    clientDocId = (cd?.id as string | undefined) ?? null;
  }
  const kind = template === "proposal" ? "proposal" : template === "sow" ? "sow" : template;
  const { error } = await admin.from("kaizen_documents").insert({
    id,
    client_id: client?.id ?? null,
    profile_id: me.id,
    kind,
    title: doc.title,
    template,
    content: { generator: "kaizen_docs", kdoc: doc, ask: input.ask.slice(0, 4000), brief: input.brief.slice(0, 16000), confirmed: input.confirmed ?? [], line: input.line ?? null },
    bucket: BUCKET,
    path,
    file_name: `${name}.pdf`,
    version: 1,
    placeholders: doc.placeholders,
    client_document_id: clientDocId,
    google_id: made.id,
    google_url: made.url,
    google_kind: made.kind,
    folder_id: filed.folderId,
    folder_place: filed.place,
    prospect_name: prospect,
  });
  if (error) return { ok: false, error: `It was made in Google (${made.url}) but couldn't be kept in Kaizen OS: ${error.message}` };
  const { rememberDestination } = await import("@/lib/drive-destination");
  const { savedLine } = await import("@/lib/drive-destination-core");
  await rememberDestination(admin, where.key, where.save).catch(() => undefined);
  const { rateCardEmpty } = await storedRates(admin);
  return { ok: true, id, template, title: doc.title, url: made.url, kind: made.kind, place: filed.place, folderUrl: filed.folderUrl, saved: savedLine(made.url, where.save), placeholders: doc.placeholders, pdf: path ? `/api/documents/${id}?download=1` : null, footerSet: made.footer, rateCardEmpty };
}

/**
 * Prospects' documents, moved once they're a client (matched by name), only into the folder that person confirmed for
 * this client and kind of document (the Drive rule: no one to ask in a cron, so never a guess). With none remembered,
 * the person is asked in the app to move it (making a new document for the client says the folder back for a yes).
 * Run by the cron.
 */
export async function fileProspectDocs(admin: SupabaseClient): Promise<{ moved: number; asked: number }> {
  const { data: docs } = await admin.from("kaizen_documents").select("id, title, template, prospect_name, google_id, google_url, profile_id").is("client_id", null).not("prospect_name", "is", null).not("google_id", "is", null).limit(50);
  if (!docs?.length) return { moved: 0, asked: 0 };
  const { data: clients } = await admin.from("clients").select("id, name, slug").is("archived_at", null);
  const { looseKey } = await import("@/lib/copy-docs/hq-path");
  const { backgroundDestination, moveToDestination } = await import("@/lib/drive-destination");
  const { pathText } = await import("@/lib/drive-destination-core");
  let moved = 0;
  let asked = 0;
  for (const d of docs) {
    const c = (clients ?? []).find((x) => looseKey(x.name as string) === looseKey(d.prospect_name as string));
    if (!c) continue;
    try {
      const dest = await backgroundDestination(admin, { profileId: d.profile_id as string, clientId: c.id as string, docType: String(d.template ?? "doc") });
      if (!dest) {
        // Attached to the client in Kaizen OS; the file stays where it is until they say where it goes
        await admin.from("kaizen_documents").update({ client_id: c.id, updated_at: new Date().toISOString() }).eq("id", d.id);
        await admin.from("notifications").upsert([{ profile_id: d.profile_id, kind: "assistant", title: `${c.name} is a client now: where should "${String(d.title).slice(0, 80)}" go in Drive?`, body: `It's still in Kaizen Sales › Prospects. Tell your assistant the folder (their Headquarters › Proposals & SOWs, or another) and it will move it.`, href: d.google_url, client_id: c.id, key: `prospect-doc-move:${d.id}`, priority: "normal" }], { onConflict: "profile_id,key", ignoreDuplicates: true });
        asked++;
        continue;
      }
      const { data: who } = await admin.from("profiles").select("email").eq("id", d.profile_id as string).maybeSingle();
      if (!who?.email) continue;
      const m = await moveToDestination(who.email as string, d.google_id as string, dest);
      await admin.from("kaizen_documents").update({ client_id: c.id, folder_id: m.dest.id, folder_place: pathText(m.dest.path), updated_at: new Date().toISOString() }).eq("id", d.id);
      moved++;
    } catch {
      // tried again next run
    }
  }
  return { moved, asked };
}
