import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Destination, DestinationKey } from "@/lib/drive-destination-core";
import { folderIdOf } from "@/lib/creative-drive-paths";
import type { TemplateKey } from "./templates";

// Where a Kaizen document goes in Drive, under the Drive rule (src/lib/drive-destination.ts): the folder the person
// named or linked in this conversation; else the one they confirmed last time for this client (or prospect) and kind
// of document, said back for a quick yes; else Kaizen's default said back for a yes (a client's Headquarters ›
// "Proposals & SOWs", a prospect's Kaizen Sales › Prospects › <name>); never a guess and never My Drive's root. Asked
// before the document is written, so the minute of writing isn't wasted on a folder they'd change.

export const PROPOSALS_FOLDER = "Proposals & SOWs";

export type DocWhere = { save: Destination; key: DestinationKey } | { reply: Record<string, unknown> };

/** The client's Headquarters folder id (found, never made), or null */
async function hqOf(admin: SupabaseClient, email: string, clientId: string): Promise<string | null> {
  const [{ clientFacts }, { findHq }, { googleFor, folderHelpers }] = await Promise.all([import("@/lib/copy-docs/server"), import("@/lib/copy-docs/hq-path"), import("./google")]);
  const facts = await clientFacts(admin as never, clientId);
  const root = process.env.GOOGLE_SHARED_DRIVE_ID ?? null;
  const probe = [...facts.hqLinks, facts.clientFolder, root].map((x) => (x ? folderIdOf(x) : null)).find(Boolean) ?? null;
  if (!probe) return null;
  try {
    const look = await googleFor(email, probe);
    const hq = await findHq(folderHelpers(look.g), { client: { name: facts.name, kaizenId: facts.kaizenId }, stored: facts.hqLinks, clientFolder: facts.clientFolder, root });
    return hq.ok ? hq.id : null;
  } catch {
    return null;
  }
}

/**
 * The folder for a document, or what to say first. `folder` is what they named or linked; `confirmed` is their yes to
 * the folder said back last time (the remembered one, or Kaizen's default).
 */
export async function docDestination(o: { admin: SupabaseClient; me: { id: string; email: string }; template: TemplateKey; client: { id: string; name: string } | null; prospect: string | null; folder?: string | null; confirmed?: boolean }): Promise<DocWhere> {
  const { findDestination, recallDestination, ensureDestination } = await import("@/lib/drive-destination");
  const { confirmLine, pathText } = await import("@/lib/drive-destination-core");
  const key: DestinationKey = { profileId: o.me.id, clientId: o.client?.id ?? null, prospect: o.client ? null : o.prospect, docType: o.template };
  const found = async (named: string, below: string | null, mode: "find" | "preview"): Promise<DocWhere | Destination> => {
    const f = await findDestination(o.me.email, named, below, mode);
    if ("dest" in f) return f.dest;
    if ("ask" in f) return { reply: { made: false, candidates: f.ask.map((d) => ({ path: pathText(d.path), link: d.link })), say: f.say, note: "Ask which one; call make_document again with that folder's link in folder." } };
    return { reply: { made: false, folder_not_found: true, say: f.notFound, note: "Ask for the folder (its Drive link, or its path); call again with it in folder." } };
  };
  const isDest = (x: DocWhere | Destination): x is Destination => "path" in x;

  // 1. The folder they named here: saved there once found (their naming it is the yes)
  const named = String(o.folder ?? "").trim();
  if (named) {
    const r = await found(named, null, "find");
    return isDest(r) ? { save: r, key } : r;
  }
  // 2. The one they confirmed last time, said back for a quick yes
  const remembered = await recallDestination(o.admin, key);
  // 3. Kaizen's default: the client's Headquarters › Proposals & SOWs, a prospect's Kaizen Sales › Prospects › <name>
  let proposed: Destination | null = remembered;
  if (!proposed) {
    if (o.client) {
      const hq = await hqOf(o.admin, o.me.email, o.client.id);
      if (!hq) return { reply: { made: false, needs_folder: true, say: `I couldn't find ${o.client.name}'s Headquarters folder in Drive. Which folder should it go in? Paste its link.`, note: "Ask for the folder; call again with its link in folder. Never save it to My Drive's root." } };
      const r = await found(`id:${hq}`, PROPOSALS_FOLDER, "preview");
      if (!isDest(r)) return r;
      proposed = r;
    } else if (o.prospect && process.env.GOOGLE_SHARED_DRIVE_ID) {
      const r = await found(`id:${process.env.GOOGLE_SHARED_DRIVE_ID}`, `Kaizen Sales/Prospects/${o.prospect.replace(/[\\/:*?"<>|›]+/g, " ").trim().slice(0, 80)}`, "preview");
      if (!isDest(r)) return r;
      proposed = r;
    } else return { reply: { made: false, needs_folder: true, say: "Which Drive folder should it go in? Paste its link or say its path.", note: "Ask for the folder; call again with it in folder. Never save it to My Drive's root." } };
  }
  if (!o.confirmed) return { reply: { made: false, needs_yes: true, destination: { path: pathText(proposed.path), link: proposed.link, new_folder: Boolean(proposed.willCreate) }, say: confirmLine(proposed), note: "Ask exactly that once, before writing anything; on their yes call make_document again with the same content and confirmed: true (or with the folder they name instead)." } };
  return { save: await ensureDestination(o.me.email, proposed), key };
}
