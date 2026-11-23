import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { copyEmailHeading, copyGroupName } from "@/lib/copy-docs/core";

// Client supplies the content (Head of Email, Nov 2026): for clients whose own team provides the weekly campaigns'
// images, copy and CTA links in a Google Sheet, the request is just the sheet: read it (when it's shared with us) so the
// ticket shows a summary of the emails in it and how many there are, then one Asana task straight to the client's email
// designer in Ready for Design (src/lib/deliverables/server.ts createSuppliedRequest). It counts against the allotment
// and runs through the board's stages like any request. The setting is per client (clients.email_supplies_content).

type Db = SupabaseClient;

/** One block of the client's email as their sheet gives it (Section, Event/Promo, Header text, Subheader text, Asset links, Button text, Button link) */
export type SuppliedBlock = { section: string; promo: string; header: string; subheader: string; assets: string; button: string; link: string };
/** One email in the sheet: usually the whole sheet (or one tab) is one newsletter, its rows the email's blocks */
export type SuppliedEmail = { name: string; send: string; notes: string; blocks: SuppliedBlock[] };
export type SheetRead = { ok: true; title: string; url: string; emails: SuppliedEmail[]; summary: string; channel: "email" | "sms" | "mixed" } | { ok: false; say: string };

const BLOCK = {
  type: "object",
  properties: {
    section: { type: "string", description: "Header, Block 1, Block 2…" },
    promo: { type: "string", description: "The event or promo" },
    header: { type: "string", description: "The header text, or the instruction there (KEEP CURRENT IMAGE AND TEXT)" },
    subheader: { type: "string" },
    assets: { type: "string", description: "The asset link(s), as given" },
    button: { type: "string", description: "The button text" },
    link: { type: "string", description: "The button link" },
  },
  required: ["section", "promo", "header", "subheader", "assets", "button", "link"],
  additionalProperties: false,
};
const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One sentence: what this send features (the events or promos)" },
    channel: { type: "string", enum: ["email", "sms", "mixed"] },
    emails: {
      type: "array",
      description: "The emails in the sheet. A sheet (or a tab) whose rows are Header, Block 1, Block 2… is ONE email (a newsletter): its rows are that email's blocks. Only a sheet that clearly holds several separate emails gives several.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "The email's name, e.g. Newsletter 11.25" },
          send: { type: "string", description: "Its send day, YYYY-MM-DD when the sheet or its title says (e.g. 11.25.26 is 2026-11-25)" },
          notes: { type: "string", description: "The sheet's design notes for this email, as written" },
          blocks: { type: "array", items: BLOCK },
        },
        required: ["name", "send", "notes", "blocks"],
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
    maxTokens: 6000,
    override: { model: "sonnet", effort: "low" },
    system: "You read a client's own email sheet for Kaizen's email designer: the client's team fills it with the email's images, copy and CTA links, one row per block (Section, Event/Promo, Header text, Subheader text, Asset links, Button text, Button link), with design notes on top. Such a sheet (or each tab) is ONE email, its rows that email's blocks, in order. Copy every value as written, links whole; a dash or empty cell is empty. Don't rewrite anything. No em dashes.",
    prompt: `<sheet title="${r.title.replace(/"/g, "'")}">\n${r.text.slice(0, 50000)}\n</sheet>`,
  });
  const emails = (out.emails ?? []).slice(0, 5).map((e) => ({ name: String(e.name ?? "").slice(0, 120), send: String(e.send ?? "").slice(0, 20), notes: String(e.notes ?? "").slice(0, 600), blocks: (e.blocks ?? []).slice(0, 20) }));
  return { ok: true, title: r.title, url: r.url, emails, summary: String(out.summary ?? "").slice(0, 400), channel: out.channel === "sms" || out.channel === "mixed" ? out.channel : "email" };
}

/**
 * The ticket's description for the emails in the sheet, in Kaizen's naming convention ("KZN x Gold Rush Cabaret |
 * November Campaigns | Email #1"), then each block: its promo, header, button and link, and the asset link
 */
export function sheetLines(client: string, emails: SuppliedEmail[]): string {
  return emails
    .map((e, i) => {
      const group = copyGroupName({ kind: "campaign", shortName: e.name, brief: { sendDate: /^\d{4}-\d{2}-\d{2}$/.test(e.send) ? e.send : null } });
      const blank = (v: string) => !v || /^[-\s]*$/.test(v);
      const blocks = e.blocks.map((b) =>
        [`${b.section || "Block"}${blank(b.promo) ? "" : `: ${b.promo}`}`, blank(b.header) ? "" : `  Header: ${b.header}`, blank(b.subheader) ? "" : `  Subheader: ${b.subheader}`, blank(b.button) ? "" : `  Button: ${b.button}${blank(b.link) ? "" : ` (${b.link})`}`, blank(b.button) && !blank(b.link) ? `  Link: ${b.link}` : "", blank(b.assets) ? "" : `  Assets: ${b.assets}`].filter(Boolean).join("\n"),
      );
      return [copyEmailHeading(client, group, "campaign", i) + (e.name ? ` (${e.name})` : ""), e.notes ? `Design notes: ${e.notes}` : "", ...blocks].filter(Boolean).join("\n");
    })
    .join("\n\n");
}
