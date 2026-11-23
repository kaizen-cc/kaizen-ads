import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Client supplies the content (Head of Email, Nov 2026): for clients whose own team provides the weekly campaigns'
// images, copy and CTA links in a Google Sheet, the request is just the sheet: read it (when it's shared with us) so the
// ticket shows a summary of the emails in it and how many there are, then one Asana task straight to the client's email
// designer in Ready for Design (src/lib/deliverables/server.ts createSuppliedRequest). It counts against the allotment
// and runs through the board's stages like any request. The setting is per client (clients.email_supplies_content).

type Db = SupabaseClient;

export type SuppliedEmail = { name: string; send: string; subject: string; cta: string };
export type SheetRead = { ok: true; title: string; url: string; emails: SuppliedEmail[]; summary: string; channel: "email" | "sms" | "mixed" } | { ok: false; say: string };

const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One or two sentences: what the sheet's campaigns are (the week, the events or offers)" },
    channel: { type: "string", enum: ["email", "sms", "mixed"] },
    emails: {
      type: "array",
      description: "One entry per email or text in the sheet, in order (the rows the designer builds)",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "The email's name or event, short" },
          send: { type: "string", description: "Its send day as written (YYYY-MM-DD when clear)" },
          subject: { type: "string", description: "Its subject line, or the text's first words" },
          cta: { type: "string", description: "Its button or link, as written" },
        },
        required: ["name", "send", "subject", "cta"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "channel", "emails"],
  additionalProperties: false,
};

/** Does this client supply their own content? */
export async function suppliesContent(db: Db, clientId: string): Promise<{ on: boolean; sheet: string | null }> {
  const { data } = await db.from("clients").select("email_supplies_content, email_supplies_sheet").eq("id", clientId).maybeSingle();
  return { on: Boolean(data?.email_supplies_content), sheet: (data?.email_supplies_sheet as string | null) ?? null };
}

/** Read the client's sheet (as the person, else the Drive user the catalogue reads with) and list the emails in it */
export async function readSuppliedSheet(clientId: string, url: string, as: string | null): Promise<SheetRead> {
  const { readGoogleFile } = await import("@/lib/assistant/read-file");
  const who = as || process.env.GOOGLE_DRIVE_USER || "";
  let r = await readGoogleFile(who, url);
  if (!r.ok && as && process.env.GOOGLE_DRIVE_USER && as !== process.env.GOOGLE_DRIVE_USER) r = await readGoogleFile(process.env.GOOGLE_DRIVE_USER, url);
  if (!r.ok) return { ok: false, say: r.say };
  const { askJson } = await import("@/lib/ai");
  const out = await askJson<{ summary: string; channel: "email" | "sms" | "mixed"; emails: SuppliedEmail[] }>({
    agent: "email_calendar",
    label: "email supplied sheet read",
    clientId,
    schema: SCHEMA,
    maxTokens: 3000,
    override: { model: "sonnet", effort: "low" },
    system: "You read a client's own campaign sheet for Kaizen's email designer: the client's team fills it with each email's images, copy and CTA links. List each email (or text) in it, in order, with its send day, subject and CTA as written. Don't rewrite anything. An empty or template row isn't an email. No em dashes.",
    prompt: `<sheet title="${r.title.replace(/"/g, "'")}">\n${r.text.slice(0, 50000)}\n</sheet>`,
  });
  return { ok: true, title: r.title, url: r.url, emails: (out.emails ?? []).slice(0, 20), summary: String(out.summary ?? "").slice(0, 400), channel: out.channel === "sms" || out.channel === "mixed" ? out.channel : "email" };
}

/** The ticket's description lines for the emails in the sheet */
export function sheetLines(emails: SuppliedEmail[]): string {
  return emails.map((e, i) => `${i + 1}. ${e.name}${e.send ? ` (${e.send})` : ""}${e.subject ? `: "${e.subject}"` : ""}${e.cta ? ` · CTA: ${e.cta}` : ""}`).join("\n");
}
